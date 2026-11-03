// pnl.test.ts: harness for src/core/pnl.ts (the public P&L curve, recomputed exactly from the journal).
// Pure: no network. Expected values are worked by hand in the comments.
//
//   npx tsx test/pnl.test.ts
//   PNL_MODULE=<path> npx tsx test/pnl.test.ts     (the mutation script)
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const modPath = process.env.PNL_MODULE ? resolve(process.env.PNL_MODULE) : resolve(here, '../src/core/pnl.ts');
const P = await import(pathToFileURL(modPath).href);

type Json = any;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function ok(name: string, pass: boolean, detail?: unknown) {
  const d = detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ name, ok: pass, detail: d });
  console.log(`${pass ? '✓' : '✗'} ${name}${!pass && d ? ` — ${d}` : ''}`);
}
function refusal(f: () => unknown): string {
  try { f(); return 'no refusal'; } catch (e) { return e instanceof P.PnlRefused ? (e as Error).message : `not a PnlRefused: ${String(e)}`; }
}

// Record times: seconds after a base, in ns. Each entry's trade time is 30 s before its record.
const BASE_MS = 1_762_160_000_000;
const ns = (s: number) => ((BigInt(BASE_MS) + BigInt(s * 1000)) * 1_000_000n).toString();
const iso = (s: number) => new Date(BASE_MS + s * 1000).toISOString();
let n = 0;
function e(side: 'buy' | 'sell', size: string, price: string, at: number, over: Partial<Json> = {}): Json {
  n += 1;
  const id = `${String(n).padStart(4, '0')}${'0'.repeat(60)}`;
  const { recordNs, ...entryOver } = over;
  return { transId: id, recordNs: recordNs ?? ns(at),
    entry: { v: 1, simulated: true, ts: iso(at - 30), pair: 'NEAR/USDC', side, size, price,
      reasoning: 'r', correlation_id: null, salt: 'ab'.repeat(32), ...entryOver } };
}
const curve = (entries: Json[], points: number[], simulated = true) =>
  P.recomputeCurve(entries, 'USDC', simulated, points.map(ns)).map((p: Json) => p.realised);
const last = (entries: Json[]) => curve(entries, [10_000])[0];

// ── arithmetic ──────────────────────────────────────────────────────────────────────────────
// buy 10 @ 2, sell 4 @ 2.5 → 4 × (2.5 − 2) = 2
ok('P1 a sell above cost realises size × (price − average cost)', last([e('buy', '10', '2', 10), e('sell', '4', '2.5', 20)]) === '2.000000',
  last([e('buy', '10', '2', 10), e('sell', '4', '2.5', 20)]));
// buy 1 @ 1, buy 2 @ 4 → avg 3; sell 3 @ 5 → 3 × 2 = 6
ok('P2 the average cost covers every buy', last([e('buy', '1', '1', 10), e('buy', '2', '4', 20), e('sell', '3', '5', 30)]) === '6.000000');
// buy 3 @ 2, sell 3 @ 1.5 → −1.5
ok('P3 a loss is negative', last([e('buy', '3', '2', 10), e('sell', '3', '1.5', 20)]) === '-1.500000');
// buy 1 @ 1, buy 2 @ 2 → avg 5/3 (1.666…); sell 3 @ 2 → 3 × 1/3 = 1 exactly (a rounded average would give 0.999999)
ok('P4 a repeating average cost stays exact', last([e('buy', '1', '1', 10), e('buy', '2', '2', 20), e('sell', '3', '2', 30)]) === '1.000000',
  last([e('buy', '1', '1', 10), e('buy', '2', '2', 20), e('sell', '3', '2', 30)]));
{
  const up = last([e('buy', '1', '1', 10), e('sell', '1', '1.0000005', 20)]);   // +0.0000005 → 0.000001
  const down = last([e('buy', '1', '1', 10), e('sell', '1', '0.9999995', 20)]); // −0.0000005 → −0.000001
  const below = last([e('buy', '1', '1', 10), e('sell', '1', '1.00000049', 20)]); // +0.00000049 → 0.000000
  ok('P5 each point is rounded once, half away from zero, to 6 decimals', up === '0.000001' && down === '-0.000001' && below === '0.000000', [up, down, below]);
}
{
  const flat = last([e('buy', '5', '3', 10)]);
  const tinyLoss = last([e('buy', '1', '1', 10), e('sell', '1', '0.9999996', 20)]); // −0.0000004 → 0, not −0
  ok('P6 zero is "0.000000", never "-0.000000"', flat === '0.000000' && tinyLoss === '0.000000', [flat, tinyLoss]);
}
// NEAR: buy 2 @ 3; ETH: buy 1 @ 100; NEAR: sell 2 @ 4 → +2; ETH: sell 1 @ 90 → −10; total −8.
// After the NEAR sell (point at 35) a single pooled position would give 2 × (4 − 106/3) = −62.666667, not +2.
{
  const c = curve([e('buy', '2', '3', 10), e('buy', '1', '100', 20, { pair: 'ETH/USDC' }), e('sell', '2', '4', 30),
    e('sell', '1', '90', 40, { pair: 'ETH/USDC' })], [35, 10_000]);
  ok('P7 each base asset keeps its own position and average cost', JSON.stringify(c) === '["2.000000","-8.000000"]', c);
}
// buy 2 @ 1, sell 1 @ 3 (+2), buy 1 @ 4 → avg (1×1 + 1×4)/2 = 2.5; sell 2 @ 3 → +1; total 3
ok('P8 the average cost carries over a partial sell into later buys',
  last([e('buy', '2', '1', 10), e('sell', '1', '3', 20), e('buy', '1', '4', 30), e('sell', '2', '3', 40)]) === '3.000000');
{
  const big = last([e('buy', '123456789012.123456789', '0.000001', 10), e('sell', '123456789012.123456789', '0.000002', 20)]);
  ok('P9 large sizes and tiny prices stay exact (no floating point)', big === '123456.789012', big);
}

// ── sampling ────────────────────────────────────────────────────────────────────────────────
{
  const J = [e('buy', '10', '1', 100), e('sell', '5', '2', 200), e('sell', '5', '3', 300)]; // +5 at 200, then 5 × (3 − 1) = +10 more: 15 at 300
  const c = curve(J, [50, 199, 200, 299, 300, 1000]);
  ok('P10 a point covers the entries recorded at or before it (inclusive), in chain order',
    JSON.stringify(c) === JSON.stringify(['0.000000', '0.000000', '5.000000', '5.000000', '15.000000', '15.000000']), c);
  const oneNs = P.recomputeCurve(J, 'USDC', true, [(BigInt(ns(200)) - 1n).toString(), ns(200)]).map((p: Json) => p.realised);
  ok('P11 one ns before a record does not cover it', JSON.stringify(oneNs) === '["0.000000","5.000000"]', oneNs);
  // The sell's trade time (ts) is 10 s before the point, but its record lands 5 s after it.
  const lateRecord = [e('buy', '1', '1', 100), e('sell', '1', '2', 205, { ts: iso(190) })];
  ok('P12 points use the record (block) time, never the entry\'s own ts', curve(lateRecord, [200])[0] === '0.000000', curve(lateRecord, [200]));
  const pts = P.recomputeCurve(J, 'USDC', true, [ns(200), ns(300)]);
  ok('P13 each point carries its sample time', pts[0].atNs === ns(200) && pts[1].atNs === ns(300), pts);
}

// ── refusals ────────────────────────────────────────────────────────────────────────────────
{
  const m = refusal(() => last([e('buy', '1', '1', 10), e('sell', '1.0000001', '2', 20)]));
  ok('P14 a sell above the held position → refused (long-only)', /^pnl: entry \d{4}0{8}: sells more than held$/.test(m), m);
  const m2 = refusal(() => last([e('sell', '1', '2', 10)]));
  ok('P15 a sell with nothing held → refused', /: sells more than held$/.test(m2), m2);
}
{
  const m = refusal(() => last([e('buy', '1', '1', 10, { pair: 'NEAR/USDT' })]));
  ok('P16 a pair not quoted in USDC → refused', /^pnl: entry \d{4}0{8}: NEAR\/USDT is not quoted in USDC$/.test(m), m);
  const m2 = refusal(() => P.recomputeCurve([], 'USDT', true, [ns(1)]));
  ok('P17 a curve in another quote asset → refused', m2 === 'pnl: quote must be USDC', m2);
}
{
  const m = refusal(() => curve([e('buy', '1', '1', 10, { simulated: false })], [100], true));
  const m2 = refusal(() => curve([e('buy', '1', '1', 10)], [100], false));
  ok('P18 an entry whose simulated flag differs from the curve\'s → refused, both ways',
    /: simulated is false, the curve says true$/.test(m) && /: simulated is true, the curve says false$/.test(m2), [m, m2]);
}
{
  const at = 1000;
  const fifteen = e('buy', '1', '1', at, { ts: iso(at - 900) });
  const tooLate = e('buy', '1', '1', at, { ts: iso(at - 900), recordNs: (BigInt(ns(at)) + 1n).toString() });
  const m = refusal(() => last([tooLate]));
  ok('P19 a record exactly 15 minutes after the trade is accepted; 1 ns more → refused as committed late',
    last([fifteen]) === '0.000000' && /^pnl: entry \d{4}0{8}: committed late$/.test(m), m);
  const future = e('buy', '1', '1', at, { ts: iso(at + 1) });
  const m2 = refusal(() => last([future]));
  ok('P20 a trade time after its own record → refused', /: trade time is after its record$/.test(m2), m2);
  const m3 = refusal(() => last([e('buy', '1', '1', at, { recordNs: '1.7e18' })]));
  ok('P21 a record time that is not ns → refused', /: record time is not ns$/.test(m3), m3);
}
{
  const J = [e('buy', '1', '1', 10)];
  const bad = [[], [ns(20), ns(10)], [ns(10), ns(10)], ['12.5']].map((pts) => refusal(() => P.recomputeCurve(J, 'USDC', true, pts)));
  ok('P22 points that are empty, descending, repeated or not ns → refused',
    bad.every((m) => m === 'pnl: points must be ascending ns times'), bad);
}

// ── the follower's check ────────────────────────────────────────────────────────────────────
{
  const J = [e('buy', '10', '1', 100), e('sell', '5', '2', 200), e('sell', '5', '3', 300)];
  const claimed = { quote: 'USDC', simulated: true, points: [{ atNs: ns(150), realised: '0.000000' }, { atNs: ns(250), realised: '5.000000' },
    { atNs: ns(350), realised: '15.000000' }] };
  const got = P.checkClaimedCurve(J, claimed);
  ok('P23 a claimed curve equal to the journal\'s passes and returns the recomputed points',
    JSON.stringify(got) === JSON.stringify(claimed.points), got);
  const off = { ...claimed, points: claimed.points.map((p, i) => (i === 2 ? { ...p, realised: '15.000001' } : p)) };
  const m = refusal(() => P.checkClaimedCurve(J, off));
  ok('P24 one micro-USDC off at one point → refused, naming the point and both values',
    m === `pnl: point at ${ns(350)} claims 15.000001, the journal gives 15.000000`, m);
  const loose = { ...claimed, points: claimed.points.map((p, i) => (i === 1 ? { ...p, realised: '5' } : p)) };
  const m2 = refusal(() => P.checkClaimedCurve(J, loose));
  const m3 = refusal(() => P.checkClaimedCurve(J, { ...claimed, points: [{ atNs: ns(350), realised: '+15.000000' }] }));
  ok('P25 a claimed value not written with exactly 6 decimals → refused (no "close enough")',
    m2 === `pnl: claimed value at ${ns(250)} must have exactly 6 decimals` && /must have exactly 6 decimals$/.test(m3), [m2, m3]);
  const m4 = refusal(() => P.checkClaimedCurve(J, { ...claimed, simulated: false }));
  ok('P26 the claimed curve\'s simulated flag is checked against every entry', /: simulated is true, the curve says false$/.test(m4), m4);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log('failed:'); for (const r of failed) console.log(`  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`); process.exit(1); }