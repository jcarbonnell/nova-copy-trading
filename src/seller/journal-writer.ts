/**
 * journal-writer.ts: the seller's trade → journal entry → NOVA upload (approved 2026-11-03).
 *
 *   1. A decision names the side, the amount SPENT in atomic units (USDC for a buy, wNEAR for a sell) and one
 *      line of reasoning: exactly what a swap request takes, so H6 executes the same request instead of quoting it.
 *   2. The trade is priced by a real DRY swap quote from the seller's Agent Connect account (nothing signed, spent
 *      or counted against the action cap): size = the NEAR amount, exact; price = USDC per NEAR from amount_out,
 *      rounded once to 9 decimals, half away from zero. The entry says simulated: true (H5).
 *   3. A quote with a policy_* warning or would_succeed: false refuses the trade; insufficient_balance is accepted
 *      only for a simulated trade. Warning codes are read as strings (the server's are not all in SDK 0.7.2).
 *   4. Long-only before upload: a sell above the position held (from the seller's own entries) is refused, since
 *      an entry followers would reject cannot be taken back without breaking the fingerprint.
 *   5. ts is when the quote arrived; if more than 10 minutes pass before the upload starts, the trade is dropped
 *      (followers refuse entries recorded more than 15 minutes after their trade).
 *   6. The upload's filename is neutral and random (its storage location is public in record_transaction's args),
 *      and NOVA's file_hash must equal the entry's SHA-256.
 *   7. Any upload failure is an UploadFailed: the runner stops. A record_transaction that landed before a failed
 *      finalize leaves a record without bytes that the seller cannot repair (roadmap: resumable finalize in the SDK).
 *   8. Each upload is one native call against the seller's 12 per hour; `uploads` counts them.
 */
import { randomBytes } from 'node:crypto';
import { encodeEntry, entryFileHash, newSalt, MAX_REASONING, type JournalEntry } from '../core/journal.ts';

export const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
export const WNEAR = 'nep141:wrap.near';
export const PAIR = 'NEAR/USDC';
export const MAX_QUOTE_AGE_MS = 10 * 60_000;
const USDC_DECIMALS = 6;
const NEAR_DECIMALS = 24;
const PRICE_DECIMALS = 9;

export interface TradeDecision { side: 'buy' | 'sell'; amount: string; reasoning: string }
export interface QuoteClient { swap(agentId: string, request: { origin_asset: string; destination_asset: string; amount: string; dry: true }): Promise<unknown> }
export interface Uploader { upload(groupId: string, data: Buffer, filename: string): Promise<unknown> }

export interface WriterConfig { agentId: string; groupId: string; simulated: boolean }
export interface WriterDeps {
  quotes: QuoteClient;
  nova: Uploader;
  now?: () => number;
  filename?: () => string;
  salt?: () => string;
}
export interface Written { entry: JournalEntry; transId: string; fileHash: string }

/** The trade is not made (nothing uploaded); the runner may try another. */
export class TradeRefused extends Error { constructor(m: string) { super(m); this.name = 'TradeRefused'; } }
/** The upload failed or NOVA recorded something else: the runner stops. */
export class UploadFailed extends Error {
  constructor(m: string, readonly cause?: unknown) { super(m); this.name = 'UploadFailed'; }
}
const refuse = (m: string): never => { throw new TradeRefused(m); };

const ATOMIC = /^[1-9]\d*$/;

/** An atomic amount as a decimal string, trailing zeros trimmed. */
export function atomicToDecimal(atomic: bigint, decimals: number): string {
  const s = atomic.toString().padStart(decimals + 1, '0');
  const int = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}
const decimalToAtomic = (d: string, decimals: number): bigint => {
  const [i, f = ''] = d.split('.');
  return BigInt(i + f.padEnd(decimals, '0').slice(0, decimals));
};

/** Size (NEAR, exact) and price (USDC per NEAR, 9 decimals, half away from zero) from a swap's in and out. */
export function priceFromQuote(side: 'buy' | 'sell', amountIn: bigint, amountOut: bigint): { size: string; price: string } {
  const near = side === 'buy' ? amountOut : amountIn;
  const usdc = side === 'buy' ? amountIn : amountOut;
  // price = (usdc / 10^6) / (near / 10^24), scaled by 10^9 and rounded once.
  const num = usdc * 10n ** BigInt(NEAR_DECIMALS - USDC_DECIMALS + PRICE_DECIMALS);
  let units = num / near;
  if (2n * (num % near) >= near) units += 1n;
  return { size: atomicToDecimal(near, NEAR_DECIMALS), price: atomicToDecimal(units, PRICE_DECIMALS) };
}

/** Why a quote refuses the trade (empty: accepted). */
export function quoteProblems(reply: any, simulated: boolean): string[] {
  const problems: string[] = [];
  for (const w of Array.isArray(reply?.warnings) ? reply.warnings : []) {
    const code = String(w?.code ?? '');
    if (code.startsWith('policy_')) problems.push(code);
    else if (code === 'insufficient_balance' && !simulated) problems.push(code);
  }
  if (reply?.quote?.would_succeed === false) problems.push('would_succeed: false');
  return problems;
}

export function createJournalWriter(deps: WriterDeps, cfg: WriterConfig, history: JournalEntry[] = []) {
  const now = deps.now ?? Date.now;
  const filename = deps.filename ?? (() => `e-${randomBytes(8).toString('hex')}.json`);
  const salt = deps.salt ?? newSalt;
  const entries = [...history];
  let uploads = 0;

  /** NEAR held, atomic, from the seller's own entries. */
  const held = () => entries.filter((e) => e.pair === PAIR).reduce((n, e) =>
    n + (e.side === 'buy' ? 1n : -1n) * decimalToAtomic(e.size, NEAR_DECIMALS), 0n);

  async function write(d: TradeDecision): Promise<Written> {
    if (d?.side !== 'buy' && d?.side !== 'sell') refuse('journal: side must be buy or sell');
    if (typeof d.amount !== 'string' || !ATOMIC.test(d.amount)) refuse('journal: amount must be a positive atomic integer string');
    if (typeof d.reasoning !== 'string' || d.reasoning.length === 0 || d.reasoning.length > MAX_REASONING) {
      refuse(`journal: reasoning must be 1-${MAX_REASONING} characters`);
    }
    const amountIn = BigInt(d.amount);
    if (d.side === 'sell' && amountIn > held()) refuse('journal: sells more NEAR than held');

    const request = d.side === 'buy'
      ? { origin_asset: USDC, destination_asset: WNEAR, amount: d.amount, dry: true as const }
      : { origin_asset: WNEAR, destination_asset: USDC, amount: d.amount, dry: true as const };
    const reply: any = await deps.quotes.swap(cfg.agentId, request);
    const quotedAt = now();
    if (reply?.dry !== true) throw new Error('journal: the swap reply is not a dry quote; stop and inspect');
    const out = reply?.quote?.amount_out;
    if (typeof out !== 'string' || !ATOMIC.test(out)) throw new Error('journal: the quote has no amount_out');
    const problems = quoteProblems(reply, cfg.simulated);
    if (problems.length) refuse(`journal: the quote refuses this trade (${problems.join(', ')})`);

    const { size, price } = priceFromQuote(d.side, amountIn, BigInt(out));
    const entry: JournalEntry = { v: 1, simulated: cfg.simulated, ts: new Date(quotedAt).toISOString(), pair: PAIR, side: d.side,
      size, price, reasoning: d.reasoning, correlation_id: null, salt: salt() };
    const bytes = encodeEntry(entry);
    const fileHash = entryFileHash(bytes);

    if (now() - quotedAt > MAX_QUOTE_AGE_MS) refuse('journal: the quote is more than 10 minutes old');
    let res: any;
    try {
      res = await deps.nova.upload(cfg.groupId, Buffer.from(bytes), filename());
    } catch (e) {
      throw new UploadFailed(`journal: upload failed: ${(e as Error)?.message ?? e}`, e);
    } finally {
      uploads += 1;
    }
    if (typeof res?.trans_id !== 'string' || res.trans_id.length === 0) throw new UploadFailed('journal: NOVA returned no trans_id');
    if (res.file_hash !== fileHash) throw new UploadFailed(`journal: NOVA recorded hash ${res.file_hash}, the entry's is ${fileHash}`);
    entries.push(entry);
    return { entry, transId: res.trans_id, fileHash };
  }

  return {
    write,
    /** NEAR held, as a decimal string. */
    position: () => atomicToDecimal(held(), NEAR_DECIMALS),
    /** Upload attempts so far (each is one native call against the action cap). */
    get uploads() { return uploads; },
  };
}