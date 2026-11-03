/**
 * pnl.ts: the seller's public P&L curve, recomputed exactly from the journal.
 *
 * The teaser shows a "claimed realised P&L, verifiable after purchase" curve (roadmap §5.18; handover).
 * After admission the follower recomputes it from the decrypted entries and requires exact equality.
 * It proves the curve comes from the trades the seller committed on chain when it made them; it does NOT
 * prove the trades were good or the prices real (§5.18: delivery of exactly what was listed).
 *
 * Rules (approved 2026-11-03):
 *   - realised P&L only, average-cost method, long-only spot (a sell above the held position is refused);
 *     no price feed, so nothing outside the journal is trusted;
 *   - one quote asset per curve (USDC): every pair is BASE/USDC;
 *   - exact rational arithmetic; each point is rounded once, to 6 decimals, half away from zero;
 *   - points are sampled at listed times by RECORD time (block time, ns), never by the entry's own ts;
 *   - commit-as-you-go is enforced: an entry's trade time is at most 15 minutes before its record;
 *   - the curve declares `simulated`, and every entry must match it.
 */
import type { JournalEntry } from './journal.ts';

export const QUOTE = 'USDC';
export const DECIMALS = 6;
export const MAX_COMMIT_DELAY_NS = 15n * 60n * 1_000_000_000n;

export interface CurveEntry {
  transId: string;
  /** Block time of the entry's on-chain record, ns, decimal string (the contract's TxMeta timestamp). */
  recordNs: string;
  entry: JournalEntry;
}

export interface CurvePoint {
  /** Sample time, ns decimal string; the point covers entries whose record time is <= atNs. */
  atNs: string;
  /** Realised P&L in USDC, exactly 6 decimals, e.g. "12.500000", "-0.250000". */
  realised: string;
}

export interface ClaimedCurve {
  quote: string;
  simulated: boolean;
  points: CurvePoint[];
}

export class PnlRefused extends Error {
  constructor(message: string) { super(message); this.name = 'PnlRefused'; }
}
const refuse = (m: string): never => { throw new PnlRefused(m); };

// ── exact rationals ─────────────────────────────────────────────────────────────────────────
interface Q { n: bigint; d: bigint } // d > 0, reduced
const abs = (x: bigint) => (x < 0n ? -x : x);
const gcd = (a: bigint, b: bigint): bigint => { a = abs(a); b = abs(b); while (b) [a, b] = [b, a % b]; return a || 1n; };
const q = (n: bigint, d: bigint = 1n): Q => { const g = gcd(n, d); return { n: n / g, d: d / g }; };
const add = (a: Q, b: Q) => q(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a: Q, b: Q) => q(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a: Q, b: Q) => q(a.n * b.n, a.d * b.d);
const div = (a: Q, b: Q) => q(a.n * b.d, a.d * b.n);
const cmp = (a: Q, b: Q) => { const x = a.n * b.d - b.n * a.d; return x < 0n ? -1 : x > 0n ? 1 : 0; };
const ZERO = q(0n);

/** A journal decimal string ("12.5") as an exact rational. Entries are already validated by journal.ts. */
function dec(s: string): Q {
  const [i, f = ''] = s.split('.');
  return q(BigInt(i + f), 10n ** BigInt(f.length));
}

/** Round once, half away from zero, to DECIMALS; never "-0.000000". */
function formatQuote(x: Q): string {
  const scale = 10n ** BigInt(DECIMALS);
  const m = abs(x.n) * scale;
  let units = m / x.d;
  if (2n * (m % x.d) >= x.d) units += 1n;
  const neg = x.n < 0n && units > 0n;
  const s = units.toString().padStart(DECIMALS + 1, '0');
  return `${neg ? '-' : ''}${s.slice(0, -DECIMALS)}.${s.slice(-DECIMALS)}`;
}

const NS = /^(0|[1-9]\d*)$/;
const VALUE = new RegExp(`^-?(0|[1-9]\\d*)\\.\\d{${DECIMALS}}$`);

// ── the curve ───────────────────────────────────────────────────────────────────────────────
/** Realised P&L at each sample time, from the covered entries in chain order. */
export function recomputeCurve(entries: CurveEntry[], quote: string, simulated: boolean, pointsNs: string[]): CurvePoint[] {
  if (quote !== QUOTE) refuse(`pnl: quote must be ${QUOTE}`);
  if (pointsNs.length === 0 || !pointsNs.every((p) => NS.test(p)) ||
      pointsNs.some((p, i) => i > 0 && BigInt(p) <= BigInt(pointsNs[i - 1]))) {
    refuse('pnl: points must be ascending ns times');
  }

  const positions = new Map<string, { size: Q; avg: Q }>();
  let realised = ZERO;
  const steps: { at: bigint; realised: Q }[] = [];
  for (const { transId, recordNs, entry: e } of entries) {
    const id = String(transId).slice(0, 12);
    if (!NS.test(recordNs)) refuse(`pnl: entry ${id}: record time is not ns`);
    const recorded = BigInt(recordNs);
    const traded = BigInt(Date.parse(e.ts)) * 1_000_000n;
    if (traded > recorded) refuse(`pnl: entry ${id}: trade time is after its record`);
    if (recorded - traded > MAX_COMMIT_DELAY_NS) refuse(`pnl: entry ${id}: committed late`);
    if (e.simulated !== simulated) refuse(`pnl: entry ${id}: simulated is ${e.simulated}, the curve says ${simulated}`);
    const [base, quoteOf] = e.pair.split('/');
    if (quoteOf !== QUOTE) refuse(`pnl: entry ${id}: ${e.pair} is not quoted in ${QUOTE}`);

    const size = dec(e.size);
    const price = dec(e.price);
    const pos = positions.get(base) ?? { size: ZERO, avg: ZERO };
    if (e.side === 'buy') {
      const total = add(pos.size, size);
      positions.set(base, { size: total, avg: div(add(mul(pos.size, pos.avg), mul(size, price)), total) });
    } else {
      if (cmp(size, pos.size) > 0) refuse(`pnl: entry ${id}: sells more than held`);
      realised = add(realised, mul(size, sub(price, pos.avg)));
      positions.set(base, { size: sub(pos.size, size), avg: pos.avg });
    }
    steps.push({ at: recorded, realised });
  }

  return pointsNs.map((p) => {
    const at = BigInt(p);
    let value = ZERO;
    for (const s of steps) if (s.at <= at) value = s.realised;
    return { atNs: p, realised: formatQuote(value) };
  });
}

/** The follower's check: the claimed curve must equal the recomputed one, point for point, exactly. */
export function checkClaimedCurve(entries: CurveEntry[], claimed: ClaimedCurve): CurvePoint[] {
  for (const p of claimed.points) {
    if (typeof p.realised !== 'string' || !VALUE.test(p.realised)) refuse(`pnl: claimed value at ${p.atNs} must have exactly ${DECIMALS} decimals`);
  }
  const recomputed = recomputeCurve(entries, claimed.quote, claimed.simulated, claimed.points.map((p) => p.atNs));
  recomputed.forEach((r, i) => {
    if (r.realised !== claimed.points[i].realised) {
      refuse(`pnl: point at ${r.atNs} claims ${claimed.points[i].realised}, the journal gives ${r.realised}`);
    }
  });
  return recomputed;
}