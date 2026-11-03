/**
 * follower-service.ts: the follower's logic, every dependency injected (approved 2026-11-03). runner.ts wires it.
 *
 *   1. approve: the listing is fetched by the id its owner approved (never the seller's latest) and parsed against
 *      that id; its token must be USDC and its price at most the owner's maxPrice. The proceeds account is not
 *      checked here: the owner's policy is the guard (beat 2).
 *   2. preview: a dry withdraw of the price to the listing's proceeds account (memo from config). A policy_*
 *      warning or would_succeed: false refuses the listing, naming the codes; nothing is paid.
 *   3. pay: the idempotency key is saved BEFORE the withdraw is sent and reused after a crash, so a payment is
 *      never sent twice; a refusal documented as sending nothing clears it. The status is polled to a final
 *      state: SUCCESS gives the claim (intent hash, payer, window); anything else stops.
 *   4. claim: POST /claim. 200 → admitted; 202 or "intent hash already used" → wait until is_authorized (bounded);
 *      503 → send again (bounded); any other refusal stops, with the seller's message. Never pays again.
 *   5. verify: verifyFeed (fingerprint, each entry's hash, the recomputed P&L); a refusal stops before any copy.
 *   6. copy tick: verifyLiveEntries on what is new; each new entry not yet handled goes to the decider; the copy
 *      is a dry confidential swap (H5, simulated). A policy_* warning or would_succeed: false is a refused copy
 *      (beat 5). Buys spend USDC 1:1 with the seller's (size × price); sells are capped at the follower's position.
 *      What was handled is saved by trans_id, so a restart never copies twice; an entry recorded more than
 *      maxCopyAgeMs ago (default 15 min) is skipped as stale.
 *   7. end of access: once is_authorized is false, access_ended is logged once and copying stops (beat 6).
 *   8. events: metadata only (ids, hashes, codes, the follower's own amounts), never an entry's reasoning.
 */
import { parseListing, ListingRefused, type Listing } from '../core/listing.ts';
import { verifyFeed, FeedRefused, type FeedReader, type VerifiedEntry } from '../core/verify-feed.ts';
import { verifyLiveEntries } from '../core/live-feed.ts';
import type { PaymentClaim } from '../core/verify-payment.ts';

export { FeedRefused };

export const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
export const WNEAR = 'nep141:wrap.near';
const USDC_CONTRACT = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const MOVING = new Set(['PENDING_SIGNATURE', 'QUEUED', 'PENDING_APPROVAL', 'PENDING_DEPOSIT', 'PROCESSING', 'UNCERTAIN']);
const ATOMIC = /^[1-9]\d*$/;

export interface Reply { status: number; body: any }
export interface SellerClient { get(path: string): Promise<Reply>; post(path: string, body: string): Promise<Reply> }
export interface WithdrawRequest { asset: string; amount: string; chain: 'near'; recipient: string; memo: string }
export interface SwapQuoteRequest { origin_asset: string; destination_asset: string; amount: string }
/** The follower's Agent Connect calls, bound to its agent (runner.ts adapts the SDK). */
export interface FollowerAgent {
  previewWithdraw(req: WithdrawRequest): Promise<any>;
  withdraw(req: WithdrawRequest, idempotencyKey: string): Promise<any>;
  status(correlationId: string): Promise<any>;
  quoteSwap(req: SwapQuoteRequest): Promise<any>;
}
export interface PaymentRecord {
  listingId: string;
  idempotencyKey: string;
  correlationId?: string;
  claim?: PaymentClaim;
}
export interface CopyRecord { transId: string; outcome: 'copied' | 'refused' | 'skipped'; side?: 'buy' | 'sell'; amount?: string; amountOut?: string; codes?: string[] }
export interface FollowerState {
  getPayment(): Promise<PaymentRecord | null>;
  setPayment(p: PaymentRecord | null): Promise<void>;
  copies(): Promise<CopyRecord[]>;
  addCopy(c: CopyRecord): Promise<void>;
  appendEvent(e: Record<string, unknown>): Promise<void>;
}
export interface CopyDecision { side: 'buy' | 'sell'; amount: string }
export interface CopyDecider { decide(e: VerifiedEntry, ctx: { positionYocto: bigint }): Promise<CopyDecision | null> }
export interface FollowerDeps {
  seller: SellerClient;
  agent: FollowerAgent;
  reader: FeedReader;
  isMember(groupId: string): Promise<boolean>;
  decider: CopyDecider;
  state: FollowerState;
  newKey(): string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
export interface FollowerConfig {
  approvedId: string;
  maxPrice: string;
  memo: string;
  /** How long to wait for an admission after a 202 (default 5 min). */
  admitWaitMs?: number;
  /** How long to keep polling a payment's status (default 5 min). */
  payWaitMs?: number;
  pollMs?: number;
  /** An entry recorded longer ago than this is not copied (default 15 min): a stale trade is not a signal. */
  maxCopyAgeMs?: number;
}

/** The listing or the payment is refused; nothing (more) is spent. */
export class FollowerRefused extends Error { constructor(m: string) { super(m); this.name = 'FollowerRefused'; } }
const refuse = (m: string): never => { throw new FollowerRefused(m); };
const msg = (e: unknown) => String((e as Error)?.message ?? e);

/** Why a dry quote refuses (empty: accepted). Warning codes are read as strings. */
export function quoteRefusals(reply: any): string[] {
  const out: string[] = [];
  for (const w of Array.isArray(reply?.warnings) ? reply.warnings : []) {
    const code = String(w?.code ?? '');
    if (code.startsWith('policy_')) out.push(code);
  }
  if (reply?.quote?.would_succeed === false) out.push('would_succeed: false');
  return out;
}

/** USDC spent by a buy (size × price), atomic, rounded half up. */
export function usdcOf(size: string, price: string): bigint {
  const dec = (s: string) => { const [i, f = ''] = s.split('.'); return { n: BigInt(i + f), d: 10n ** BigInt(f.length) }; };
  const a = dec(size); const b = dec(price);
  const num = a.n * b.n * 1_000_000n; const den = a.d * b.d;
  return (2n * num + den) / (2n * den);
}
export const yoctoOf = (size: string): bigint => { const [i, f = ''] = size.split('.'); return BigInt(i + f.padEnd(24, '0').slice(0, 24)); };

/** The mock decider: copy every entry 1:1 (buys in USDC spent, sells in NEAR, capped at the position). */
export const mirrorDecider: CopyDecider = {
  decide: async ({ entry }, { positionYocto }) => {
    if (entry.side === 'buy') return { side: 'buy', amount: usdcOf(entry.size, entry.price).toString() };
    const n = yoctoOf(entry.size) < positionYocto ? yoctoOf(entry.size) : positionYocto;
    return n > 0n ? { side: 'sell', amount: n.toString() } : null;
  },
};

export function createFollowerService(deps: FollowerDeps, cfg: FollowerConfig) {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const poll = cfg.pollMs ?? 3000;
  const maxAge = cfg.maxCopyAgeMs ?? 15 * 60_000;
  const event = (kind: string, fields: Record<string, unknown> = {}) => deps.state.appendEvent({ at: now(), kind, ...fields });
  let known: VerifiedEntry[] | null = null;
  let ended = false;
  let stopped: string | null = null;

  async function approve(): Promise<Listing> {
    const r = await deps.seller.get(`/listings/${cfg.approvedId}`);
    if (r.status !== 200) refuse(`follower: the seller does not serve listing ${cfg.approvedId.slice(0, 12)} (HTTP ${r.status})`);
    let l: Listing;
    try { l = parseListing(JSON.stringify(r.body.listing), cfg.approvedId); } catch (e) {
      if (e instanceof ListingRefused) return refuse(`follower: ${e.message}`);
      throw e;
    }
    if (l.token !== USDC_CONTRACT) refuse('follower: the listing is not priced in USDC');
    if (BigInt(l.price) > BigInt(cfg.maxPrice)) refuse(`follower: the price ${l.price} is above the owner's maximum ${cfg.maxPrice}`);
    await event('listing_approved', { listingId: cfg.approvedId, price: l.price, count: l.fingerprint.count });
    return l;
  }

  const withdrawOf = (l: Listing): WithdrawRequest => ({ asset: USDC, amount: l.price, chain: 'near', recipient: l.proceedsAccount, memo: cfg.memo });

  async function preview(l: Listing): Promise<any> {
    const q = await deps.agent.previewWithdraw(withdrawOf(l));
    if (q?.dry !== true) throw new Error('follower: the withdraw preview is not a dry quote; stop and inspect');
    const codes = quoteRefusals(q);
    if (codes.length) {
      await event('payment_refused_by_policy', { listingId: cfg.approvedId, recipient: l.proceedsAccount, codes });
      refuse(`follower: the owner's policy refuses paying this listing (${codes.join(', ')})`);
    }
    return q;
  }

  async function pay(l: Listing): Promise<PaymentClaim> {
    let p = await deps.state.getPayment();
    if (p && p.listingId !== cfg.approvedId) refuse(`follower: a payment for another listing (${p.listingId.slice(0, 12)}) is on record`);
    if (p?.claim) return p.claim;
    if (!p) { p = { listingId: cfg.approvedId, idempotencyKey: deps.newKey() }; await deps.state.setPayment(p); }  // BEFORE sending
    let st: any;
    if (!p.correlationId) {
      try {
        st = await deps.agent.withdraw(withdrawOf(l), p.idempotencyKey);
      } catch (e) {
        const x = e as any;
        if (x?.name === 'AgentApiError' && x.status >= 400 && x.status < 500 && x.retryable === false) {
          await deps.state.setPayment(null);
          await event('payment_refused', { listingId: cfg.approvedId, code: x.code });
          return refuse(`follower: the Agent API refused the payment: ${x.status} ${x.code}`);
        }
        throw e;   // maybe sent: the key stays, the next run replays it
      }
      if (typeof st?.correlation_id !== 'string' || st.correlation_id.length === 0) throw new Error('follower: the withdraw reply has no correlation_id');
      p = { ...p, correlationId: st.correlation_id };
      await deps.state.setPayment(p);
      await event('payment_sent', { listingId: cfg.approvedId, correlationId: p.correlationId });
    }
    const end = now() + (cfg.payWaitMs ?? 300_000);
    if (!st || MOVING.has(st.status)) {
      for (;;) {
        st = await deps.agent.status(p.correlationId!);
        if (!MOVING.has(st?.status) || now() >= end) break;
        await sleep(poll);
      }
    }
    if (MOVING.has(st?.status)) refuse(`follower: the payment is not settled (${st.status}); run again to resume it`);
    if (st?.status !== 'SUCCESS') {
      await event('payment_failed', { listingId: cfg.approvedId, status: st?.status, failureCode: st?.failure_code ?? null });
      refuse(`follower: the payment ended ${st?.status}${st?.failure_code ? ` (${st.failure_code})` : ''}`);
    }
    const d = st.details ?? {};
    const claim: PaymentClaim = { intentHash: d.intent_hash, payer: d.near_account_id,
      windowFromMs: Date.parse(st.dispatch_committed_at), windowToMs: Date.parse(st.updated_at) };
    if (typeof claim.intentHash !== 'string' || typeof claim.payer !== 'string' || !Number.isFinite(claim.windowFromMs) || !Number.isFinite(claim.windowToMs)) {
      refuse('follower: the payment succeeded but its status has no intent hash, account or window');
    }
    await deps.state.setPayment({ ...p, claim });
    await event('payment_settled', { listingId: cfg.approvedId, intentHash: claim.intentHash, payer: claim.payer });
    return claim;
  }

  async function waitMember(groupId: string): Promise<void> {
    const end = now() + (cfg.admitWaitMs ?? 300_000);
    for (;;) {
      if (await deps.isMember(groupId)) return;
      if (now() >= end) refuse('follower: paid, but not admitted yet; run again later (nothing will be paid again)');
      await sleep(poll);
    }
  }

  async function claim(l: Listing, c: PaymentClaim): Promise<void> {
    if (await deps.isMember(l.groupId)) { await event('admitted', { listingId: cfg.approvedId, already: true }); return; }
    const body = JSON.stringify({ listingId: cfg.approvedId, ...c });
    for (let attempt = 0; ; attempt++) {
      const r = await deps.seller.post('/claim', body);
      if (r.status === 200) break;
      if (r.status === 202 || (r.status === 422 && r.body?.error === 'intent hash already used')) { await waitMember(l.groupId); break; }
      if (r.status === 503 && attempt < 5) { await sleep(poll * 2 ** attempt); continue; }
      await event('claim_refused', { listingId: cfg.approvedId, status: r.status, message: r.body?.error ?? null });
      refuse(`follower: the seller refused the claim (HTTP ${r.status}): ${r.body?.error ?? 'no message'}`);
    }
    await event('admitted', { listingId: cfg.approvedId });
  }

  async function verify(l: Listing): Promise<VerifiedEntry[]> {
    try {
      const f = await verifyFeed(l, deps.reader);
      known = f.entries;
      await event('feed_verified', { listingId: cfg.approvedId, count: f.entries.length, root: l.fingerprint.root, realised: f.curve.at(-1)!.realised });
      return f.entries;
    } catch (e) {
      if (e instanceof FeedRefused) { stopped = e.message; await event('feed_refused', { listingId: cfg.approvedId, message: e.message }); }
      throw e;
    }
  }

  async function copyTick(l: Listing): Promise<void> {
    if (ended || stopped || !known) return;
    if (!(await deps.isMember(l.groupId))) { ended = true; await event('access_ended', { listingId: cfg.approvedId }); return; }
    let update;
    try { update = await verifyLiveEntries(l, deps.reader, known); } catch (e) {
      if (e instanceof FeedRefused) { stopped = e.message; await event('live_refused', { message: e.message }); return; }
      if (!(await deps.isMember(l.groupId))) { ended = true; await event('access_ended', { listingId: cfg.approvedId }); return; }
      throw e;
    }
    const done = new Set((await deps.state.copies()).map((c) => c.transId));
    for (const e of update.entries) {
      if (done.has(e.transId)) continue;
      if (BigInt(e.recordNs) / 1_000_000n < BigInt(now() - maxAge)) {
        await deps.state.addCopy({ transId: e.transId, outcome: 'skipped' });
        await event('copy_skipped', { transId: e.transId, reason: 'stale' });
        continue;
      }
      const position = await positionYocto();
      const d = await deps.decider.decide(e, { positionYocto: position });
      if (!d || !ATOMIC.test(d.amount) || (d.side === 'sell' && BigInt(d.amount) > position)) {
        await deps.state.addCopy({ transId: e.transId, outcome: 'skipped' });
        await event('copy_skipped', { transId: e.transId, reason: 'no copy' });
        continue;
      }
      const req = d.side === 'buy' ? { origin_asset: USDC, destination_asset: WNEAR, amount: d.amount }
        : { origin_asset: WNEAR, destination_asset: USDC, amount: d.amount };
      const q = await deps.agent.quoteSwap(req);
      if (q?.dry !== true) throw new Error('follower: the swap reply is not a dry quote; stop and inspect');
      const codes = quoteRefusals(q);
      if (codes.length) {
        await deps.state.addCopy({ transId: e.transId, outcome: 'refused', side: d.side, amount: d.amount, codes });
        await event('copy_refused', { transId: e.transId, side: d.side, amount: d.amount, codes });
        continue;
      }
      const out = q?.quote?.amount_out;
      if (typeof out !== 'string' || !ATOMIC.test(out)) throw new Error('follower: the quote has no amount_out');
      await deps.state.addCopy({ transId: e.transId, outcome: 'copied', side: d.side, amount: d.amount, amountOut: out });
      await event('copy_done', { transId: e.transId, side: d.side, amount: d.amount, amountOut: out, simulated: true });
    }
    known = [...known, ...update.entries];   // only once all are handled: an entry whose copy failed is retried next tick
  }

  /** NEAR held from the follower's own copies, yocto. */
  async function positionYocto(): Promise<bigint> {
    let n = 0n;
    for (const c of await deps.state.copies()) {
      if (c.outcome !== 'copied') continue;
      n += c.side === 'buy' ? BigInt(c.amountOut!) : -BigInt(c.amount!);
    }
    return n;
  }

  return { approve, preview, pay, claim, verify, copyTick, positionYocto, ended: () => ended, stoppedReason: () => stopped };
}