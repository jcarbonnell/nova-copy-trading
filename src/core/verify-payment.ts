/**
 * verify-payment.ts: the seller's check that a follower paid for a listing, from the chain alone.
 *
 * A follower pays with an Agent Connect withdrawal (NEAR Intents `ft_withdraw`) to the seller's proceeds
 * account. The Agent API names no transaction for a same-chain withdrawal, and its memo never reaches the
 * chain (observed 2026-10-19; Agent API docs, Transparency Proofs). So the follower claims
 * { intent_hash, payer, window } from its own withdrawal status, and the seller:
 *   1. checks the listing, the claim's shape and single use: no chain call before these pass;
 *   2. scans the padded window for intents.near `execute_intents` whose signed NEP-413 message has the
 *      payer as signer_id and an ft_withdraw of exactly the price, token and proceeds account;
 *   3. checks each candidate on chain: final success; dip4 ft_withdraw and intents_executed emitted by
 *      SUCCESSFUL intents.near receipts with this intent hash, payer, receiver, token and exact amount;
 *      the token contract's own ft_transfer to the proceeds account; block time after the listing opened
 *      and inside the padded window;
 *   4. requires exactly one transaction to pass, then records the intent hash as used (last).
 * The caller admits `payer` as returned here: the account the chain names, never one taken from a claim.
 *
 * Roadmap §5.18 "Settlement (revised)", with two accepted divergences (copy-trading handover, 2026-10-30):
 * the seller's runner verifies instead of Shade, and the payer is bound by the dip4 event, not the memo.
 */

export const INTENTS = 'intents.near';
export const MAX_WINDOW_MS = 10 * 60_000;
export const PAD_MS = 10_000;

export interface Listing {
  /** Account the follower pays (the seller's proceeds account). */
  proceedsAccount: string;
  /** Bare token contract id as NEAR Intents names it in ft_withdraw (no `nep141:` prefix). */
  token: string;
  /** Exact price in the token's smallest unit, as a decimal string. */
  price: string;
  /** When the listing opened (ms since epoch): no earlier payment can be claimed for it. */
  openedAtMs: number;
}

export interface PaymentClaim {
  intentHash: string;
  /** The follower's NEAR Intents account (its agent wallet's near_account_id). */
  payer: string;
  /** From the follower's withdrawal status: dispatch_committed_at .. updated_at (ms). */
  windowFromMs: number;
  windowToMs: number;
}

export interface VerifiedPayment {
  payer: string;
  txHash: string;
  intentHash: string;
  amount: string;
  token: string;
  proceedsAccount: string;
  blockMs: number;
}

export interface UsedIntentStore {
  has(intentHash: string): Promise<boolean>;
  add(intentHash: string, record: VerifiedPayment): Promise<void>;
}

type Json = any;

/** The chain, behind one seam. The RPC implementation lives in near-chain.ts. */
export interface ChainReader {
  /** Transactions signed by intents.near in the blocks whose time is in [fromMs, toMs]. */
  scanExecuteIntents(fromMs: number, toMs: number): Promise<Json[]>;
  /** EXPERIMENTAL_tx_status result, waited until FINAL. */
  txStatus(txHash: string, senderAccountId: string): Promise<Json>;
  blockTimeMs(blockHash: string): Promise<number>;
}

export class PaymentRefused extends Error {
  constructor(message: string) { super(message); this.name = 'PaymentRefused'; }
}
const refuse = (m: string): never => { throw new PaymentRefused(m); };

// ── shape checks ────────────────────────────────────────────────────────────────────────────
const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const isAccountId = (s: unknown): s is string => typeof s === 'string' && s.length >= 2 && s.length <= 64 && ACCOUNT_ID.test(s);
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Length(s: unknown): number | null {
  if (typeof s !== 'string' || s.length === 0 || s.length > 64) return null;
  let n = 0n;
  for (const c of s) { const v = B58.indexOf(c); if (v < 0) return null; n = n * 58n + BigInt(v); }
  let len = 0;
  while (n > 0n) { n >>= 8n; len++; }
  let zeros = 0;
  for (const c of s) { if (c === '1') zeros++; else break; }
  return len + zeros;
}

function checkListing(l: Listing) {
  if (typeof l.price !== 'string' || !/^[1-9]\d*$/.test(l.price)) refuse('listing: price must be a positive integer');
  if (!isAccountId(l.proceedsAccount)) refuse('listing: proceedsAccount is not a valid NEAR account id');
  if (!isAccountId(l.token)) refuse('listing: token is not a valid NEAR account id (bare contract id, no nep141: prefix)');
  if (!Number.isFinite(l.openedAtMs)) refuse('listing: openedAtMs must be a time in ms');
}

function checkClaim(c: PaymentClaim, l: Listing, nowMs: number) {
  if (base58Length(c.intentHash) !== 32) refuse('claim: intent_hash is not a 32-byte base58 hash');
  if (!isAccountId(c.payer)) refuse('claim: payer is not a valid NEAR account id');
  if (!Number.isFinite(c.windowFromMs) || !Number.isFinite(c.windowToMs) ||
      c.windowFromMs > c.windowToMs || c.windowToMs - c.windowFromMs > MAX_WINDOW_MS) {
    refuse('claim: window must be ordered and at most 10 minutes');
  }
  if (c.windowToMs > nowMs) refuse('claim: window ends in the future');
  if (c.windowFromMs < l.openedAtMs) refuse('claim: window starts before the listing opened');
}

// ── reading a transaction ───────────────────────────────────────────────────────────────────
function executeIntentsMessages(tx: Json): Json[] {
  const out: Json[] = [];
  for (const a of tx?.actions ?? []) {
    const fc = a?.FunctionCall;
    if (fc?.method_name !== 'execute_intents') continue;
    let args: Json;
    try { args = JSON.parse(Buffer.from(fc.args, 'base64').toString()); } catch { continue; }
    for (const s of args?.signed ?? []) {
      try { out.push(JSON.parse(s?.payload?.message ?? '')); } catch { /* not a NEP-413 message */ }
    }
  }
  return out;
}

/** Discovery only: the signed message asks for exactly this payment. Everything is re-checked on chain. */
function signedForThisPayment(tx: Json, c: PaymentClaim, l: Listing): boolean {
  return executeIntentsMessages(tx).some((m) => m?.signer_id === c.payer && (m.intents ?? []).some((i: Json) =>
    i?.intent === 'ft_withdraw' && i?.receiver_id === l.proceedsAccount && i?.token === l.token && i?.amount === l.price));
}

const receiptSucceeded = (o: Json) => !!o?.outcome?.status && typeof o.outcome.status === 'object' &&
  ('SuccessValue' in o.outcome.status || 'SuccessReceiptId' in o.outcome.status);

/** Events from successful receipts only, each with the account that executed the receipt. */
function eventsOf(st: Json): { executor: string; ev: Json }[] {
  const out: { executor: string; ev: Json }[] = [];
  for (const o of st?.receipts_outcome ?? []) {
    if (!receiptSucceeded(o)) continue;
    for (const l of o.outcome.logs ?? []) {
      if (typeof l !== 'string' || !l.startsWith('EVENT_JSON:')) continue;
      try { out.push({ executor: o.outcome.executor_id, ev: JSON.parse(l.slice('EVENT_JSON:'.length)) }); } catch { /* skip */ }
    }
  }
  return out;
}
const eventData = (events: { executor: string; ev: Json }[], executor: string, standard: string, name: string): Json[] =>
  events.filter((e) => e.executor === executor && e.ev?.standard === standard && e.ev?.event === name)
    .flatMap((e) => (Array.isArray(e.ev.data) ? e.ev.data : []));

async function checkCandidate(chain: ChainReader, hash: string, c: PaymentClaim, l: Listing): Promise<VerifiedPayment> {
  const st = await chain.txStatus(hash, INTENTS);
  if (!st?.status || typeof st.status !== 'object' || !('SuccessValue' in st.status)) refuse('transaction did not succeed');
  const t = st.transaction;
  if (t?.hash !== hash || t?.signer_id !== INTENTS || t?.receiver_id !== INTENTS ||
      !(t.actions ?? []).some((a: Json) => a?.FunctionCall?.method_name === 'execute_intents')) {
    refuse('transaction is not intents.near execute_intents');
  }

  const events = eventsOf(st);
  const withdraws = eventData(events, INTENTS, 'dip4', 'ft_withdraw').filter((d) => d?.intent_hash === c.intentHash);
  if (withdraws.length !== 1) refuse('no ft_withdraw from intents.near for this intent');
  const w = withdraws[0];
  if (w.account_id !== c.payer) refuse('ft_withdraw payer differs');
  if (w.receiver_id !== l.proceedsAccount) refuse('ft_withdraw receiver differs');
  if (w.token !== l.token) refuse('ft_withdraw token differs');
  if (w.amount !== l.price) refuse('ft_withdraw amount differs');

  const executed = eventData(events, INTENTS, 'dip4', 'intents_executed')
    .some((d) => d?.intent_hash === c.intentHash && d?.account_id === c.payer);
  if (!executed) refuse('no intents_executed from intents.near for this intent and payer');

  const delivered = eventData(events, l.token, 'nep141', 'ft_transfer')
    .some((d) => d?.old_owner_id === INTENTS && d?.new_owner_id === l.proceedsAccount && d?.amount === l.price);
  if (!delivered) refuse('no ft_transfer from the token contract to the proceeds account for this amount');

  const blockMs = await chain.blockTimeMs(st.transaction_outcome?.block_hash);
  if (!(blockMs >= l.openedAtMs)) refuse('payment block is before the listing opened');
  if (!(blockMs >= c.windowFromMs - PAD_MS && blockMs <= c.windowToMs + PAD_MS)) refuse('payment block is outside the claimed window');

  return { payer: w.account_id, txHash: hash, intentHash: c.intentHash, amount: w.amount, token: w.token,
    proceedsAccount: w.receiver_id, blockMs };
}

// ── the check ───────────────────────────────────────────────────────────────────────────────
export async function verifyPayment(
  deps: { chain: ChainReader; used: UsedIntentStore; now?: () => number },
  listing: Listing,
  claim: PaymentClaim,
): Promise<VerifiedPayment> {
  const nowMs = (deps.now ?? Date.now)();
  checkListing(listing);
  checkClaim(claim, listing, nowMs);
  if (await deps.used.has(claim.intentHash)) refuse('intent hash already used');

  const scanned = await deps.chain.scanExecuteIntents(claim.windowFromMs - PAD_MS, claim.windowToMs + PAD_MS);
  const candidates = [...new Set(scanned.filter((tx) => signedForThisPayment(tx, claim, listing)).map((tx) => tx.hash as string))];
  if (candidates.length === 0) refuse('payment not found in the claimed window');

  const passed: VerifiedPayment[] = [];
  const refusals: string[] = [];
  for (const hash of candidates) {
    try { passed.push(await checkCandidate(deps.chain, hash, claim, listing)); }
    catch (e) {
      if (!(e instanceof PaymentRefused)) throw e;  // a chain/RPC error is not a verdict
      refusals.push(`candidate ${hash}: ${e.message}`);
    }
  }
  if (passed.length > 1) refuse('more than one transaction matches this claim');
  if (passed.length === 0) refuse(refusals.join('; '));

  await deps.used.add(claim.intentHash, passed[0]);  // last: only a verified payment is recorded
  return passed[0];
}