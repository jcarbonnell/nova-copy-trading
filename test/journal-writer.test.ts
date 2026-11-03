// journal-writer.test.ts: harness for src/seller/journal-writer.ts (the seller's trade → entry → NOVA upload).
// No network: a fake QuoteClient returning dry swap quotes shaped like the Agent API's (H2: 0.05 USDC →
// 13030573198836294747843 yocto wNEAR) and a fake Uploader that answers like nova-sdk-js upload
// ({ trans_id, file_hash = SHA-256 of the plaintext }). The last check runs the entries through recomputeCurve.
//
//   npx tsx test/journal-writer.test.ts
//   WRITER_MODULE=<path> npx tsx test/journal-writer.test.ts     (the mutation script)
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodeEntry, decodeEntry, type JournalEntry } from '../src/core/journal.ts';
import { recomputeCurve } from '../src/core/pnl.ts';

const here = dirname(fileURLToPath(import.meta.url));
const modPath = process.env.WRITER_MODULE ? resolve(process.env.WRITER_MODULE) : resolve(here, '../src/seller/journal-writer.ts');
const W = await import(pathToFileURL(modPath).href);

type Json = any;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function ok(name: string, pass: boolean, detail?: unknown) {
  const d = detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail, (_k, v) => typeof v === 'bigint' ? `${v}n` : v);
  results.push({ name, ok: pass, detail: d });
  console.log(`${pass ? '✓' : '✗'} ${name}${!pass && d ? ` — ${d}` : ''}`);
}
async function thrown(f: () => Promise<unknown>): Promise<Json> { try { await f(); return { name: 'none', message: 'no error' }; } catch (e) { return e; } }
const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');

const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const WNEAR = 'nep141:wrap.near';
const G = 'agent-owned-20261030T073943Z';
const AGENT = 'seller-agent-id';
const T0 = Date.parse('2026-11-03T12:00:00.000Z');
const SALT = 'ab'.repeat(32);
const CFG = { agentId: AGENT, groupId: G, simulated: true };

const dryReply = (amountOut: unknown, over: Json = {}) => ({ dry: true, quote: { amount_out: amountOut, would_succeed: true }, warnings: [], ...over });

function fakeQuotes(reply: (req: Json) => unknown) {
  const calls: Json[] = [];
  return { calls, swap: async (agentId: string, req: Json) => { calls.push({ agentId, req }); return reply(req); } };
}
function fakeNova(opts: { answer?: (data: Buffer) => unknown; fail?: Error } = {}) {
  const calls: Json[] = [];
  return {
    calls,
    upload: async (groupId: string, data: Buffer, filename: string) => {
      calls.push({ groupId, data, filename });
      if (opts.fail) throw opts.fail;
      if (opts.answer) return opts.answer(data);
      return { trans_id: sha(`t${calls.length}`), file_hash: sha(data) };
    },
  };
}
function clock(...times: number[]) { let i = 0; return () => times[Math.min(i++, times.length - 1)]; }
const deps = (quotes: Json, nova: Json, over: Json = {}) => ({ quotes, nova, now: () => T0, filename: () => 'e-0000000000000000.json', salt: () => SALT, ...over });
const buyH2 = { side: 'buy', amount: '50000', reasoning: 'momentum up' };

// ── a buy and a sell ────────────────────────────────────────────────────────────────────────
{
  const quotes = fakeQuotes((req) => dryReply(req.origin_asset === USDC ? '13030573198836294747843' : '50100'));
  const nova = fakeNova();
  const w = W.createJournalWriter(deps(quotes, nova, { now: clock(T0, T0 + 1, T0 + 60_000, T0 + 60_001) }), CFG);
  const r = await w.write(buyH2);
  const want: JournalEntry = { v: 1, simulated: true, ts: new Date(T0).toISOString(), pair: 'NEAR/USDC', side: 'buy',
    size: '0.013030573198836294747843', price: '3.837129744', reasoning: 'momentum up', correlation_id: null, salt: SALT };
  ok('J1 a buy is quoted as a dry swap of that USDC amount into wNEAR, from the seller\'s agent',
    quotes.calls.length === 1 && quotes.calls[0].agentId === AGENT &&
    JSON.stringify(quotes.calls[0].req) === JSON.stringify({ origin_asset: USDC, destination_asset: WNEAR, amount: '50000', dry: true }), quotes.calls);
  ok('J2 its entry: size = NEAR out (exact), price = USDC per NEAR (9 decimals), ts = when the quote arrived, simulated, no correlation id',
    JSON.stringify(r.entry) === JSON.stringify(want), r.entry);
  const bytes = encodeEntry(want);
  ok('J3 the canonical entry bytes are uploaded to the seller\'s group, and the result carries NOVA\'s trans_id and the entry\'s hash',
    nova.calls.length === 1 && nova.calls[0].groupId === G && Buffer.compare(nova.calls[0].data, Buffer.from(bytes)) === 0 &&
    nova.calls[0].filename === 'e-0000000000000000.json' && r.fileHash === sha(bytes) && r.transId === sha('t1') &&
    JSON.stringify(decodeEntry(new Uint8Array(nova.calls[0].data))) === JSON.stringify(want), { r, call: nova.calls[0]?.groupId });
  ok('J4 the position follows the entries', w.position() === '0.013030573198836294747843', w.position());
  const s = await w.write({ side: 'sell', amount: '13030573198836294747843', reasoning: 'take profit' });
  ok('J5 a sell is quoted as a dry swap of that wNEAR amount into USDC, priced from the USDC out',
    JSON.stringify(quotes.calls[1].req) === JSON.stringify({ origin_asset: WNEAR, destination_asset: USDC, amount: '13030573198836294747843', dry: true }) &&
    s.entry.side === 'sell' && s.entry.size === '0.013030573198836294747843' && s.entry.price === '3.844804003' &&
    s.entry.ts === new Date(T0 + 60_000).toISOString() && w.position() === '0' && w.uploads === 2, { req: quotes.calls[1]?.req, entry: s.entry });
}

// ── arithmetic ──────────────────────────────────────────────────────────────────────────────
{
  const half = W.priceFromQuote('buy', 1n, 4n * 10n ** 26n);        // 0.000001 USDC for 400 NEAR: 2.5 units of 10^-9
  const below = W.priceFromQuote('buy', 1n, 4n * 10n ** 26n + 1n);  // just under 2.5
  const above = W.priceFromQuote('sell', 4n * 10n ** 26n - 1n, 1n); // just over 2.5, a sell
  ok('J6 the price is rounded once, half away from zero (2.5 → 3, 2.49… → 2, 2.50…1 → 3)',
    half.price === '0.000000003' && below.price === '0.000000002' && above.price === '0.000000003', { half, below, above });
  ok('J7 the size is the NEAR side, exact, trailing zeros trimmed',
    half.size === '400' && below.size === '400.000000000000000000000001' && above.size === '399.999999999999999999999999' &&
    W.priceFromQuote('buy', 10_000000n, 4n * 10n ** 24n).price === '2.5', { half, below, above });
  ok('J8 atomicToDecimal pads small amounts and trims zeros',
    W.atomicToDecimal(5n, 6) === '0.000005' && W.atomicToDecimal(1_500000n, 6) === '1.5' && W.atomicToDecimal(1_000000n, 6) === '1' &&
    W.atomicToDecimal(0n, 6) === '0');
}

// ── the default filename ────────────────────────────────────────────────────────────────────
{
  const nova = fakeNova();
  const w = W.createJournalWriter({ quotes: fakeQuotes(() => dryReply('4000000000000000000000000')), nova }, CFG);
  await w.write({ side: 'buy', amount: '10000000', reasoning: 'a' });
  await w.write({ side: 'buy', amount: '10000000', reasoning: 'b' });
  const [a, b] = nova.calls.map((c: Json) => c.filename);
  const [ea, eb] = nova.calls.map((c: Json) => decodeEntry(new Uint8Array(c.data)));
  ok('J9 by default the filename is neutral and random (e-<16 hex>.json), and each entry gets a fresh salt',
    /^e-[0-9a-f]{16}\.json$/.test(a) && /^e-[0-9a-f]{16}\.json$/.test(b) && a !== b &&
    /^[0-9a-f]{64}$/.test(ea.salt) && ea.salt !== eb.salt, { a, b });
}

// ── upload failures stop the runner ─────────────────────────────────────────────────────────
{
  const quotes = () => fakeQuotes(() => dryReply('13030573198836294747843'));
  const boom = new Error('boom');
  const w1 = W.createJournalWriter(deps(quotes(), fakeNova({ fail: boom })), CFG);
  const e1 = await thrown(() => w1.write(buyH2));
  ok('J10 an upload that throws → UploadFailed carrying the cause; the attempt is counted, the position is not moved',
    e1 instanceof W.UploadFailed && e1.name === 'UploadFailed' && e1.message === 'journal: upload failed: boom' && e1.cause === boom &&
    w1.uploads === 1 && w1.position() === '0', { name: e1.name, message: e1.message, uploads: w1.uploads });
  const w2 = W.createJournalWriter(deps(quotes(), fakeNova({ answer: () => ({ trans_id: 't', file_hash: 'f'.repeat(64) }) })), CFG);
  const e2 = await thrown(() => w2.write(buyH2));
  const h = sha(encodeEntry({ v: 1, simulated: true, ts: new Date(T0).toISOString(), pair: 'NEAR/USDC', side: 'buy',
    size: '0.013030573198836294747843', price: '3.837129744', reasoning: 'momentum up', correlation_id: null, salt: SALT }));
  ok('J11 NOVA recording another hash → UploadFailed naming both, position unchanged',
    e2 instanceof W.UploadFailed && e2.message === `journal: NOVA recorded hash ${'f'.repeat(64)}, the entry's is ${h}` &&
    w2.position() === '0' && w2.uploads === 1, e2.message);
  const fails = [];
  for (const [what, ans] of [['no trans_id', (d: Buffer) => ({ file_hash: sha(d) })], ['an empty trans_id', (d: Buffer) => ({ trans_id: '', file_hash: sha(d) })],
    ['a numeric trans_id', (d: Buffer) => ({ trans_id: 7, file_hash: sha(d) })], ['nothing', () => undefined]] as const) {
    const w = W.createJournalWriter(deps(quotes(), fakeNova({ answer: ans as Json })), CFG);
    const e = await thrown(() => w.write(buyH2));
    if (!(e instanceof W.UploadFailed) || e.message !== 'journal: NOVA returned no trans_id' || w.position() !== '0') fails.push(`${what}: ${e.name} ${e.message}`);
  }
  ok('J12 a reply without a trans_id → UploadFailed (4 cases)', fails.length === 0, fails);
}

// ── the quote ───────────────────────────────────────────────────────────────────────────────
{
  const fails = [];
  for (const [what, reply] of [['dry: false', dryReply('1', { dry: false })], ['dry missing', (({ dry, ...r }) => r)(dryReply('1'))],
    ['dry as "true"', dryReply('1', { dry: 'true' })], ['nothing', undefined]] as const) {
    const nova = fakeNova();
    const e = await thrown(() => W.createJournalWriter(deps(fakeQuotes(() => reply), nova), CFG).write(buyH2));
    if (e instanceof W.TradeRefused || e.message !== 'journal: the swap reply is not a dry quote; stop and inspect' || nova.calls.length) fails.push(`${what}: ${e.name} ${e.message}`);
  }
  ok('J13 a reply that is not a dry quote is an error (not a refused trade), and nothing is uploaded (4 cases)', fails.length === 0, fails);
}
{
  const fails = [];
  for (const [what, out] of [['missing', undefined], ['a number', 13030573198836294747843], ['zero', '0'], ['a decimal', '1.5'], ['leading zero', '01'], ['negative', '-5']] as const) {
    const nova = fakeNova();
    const e = await thrown(() => W.createJournalWriter(deps(fakeQuotes(() => dryReply(out)), nova), CFG).write(buyH2));
    if (e instanceof W.TradeRefused || e.message !== 'journal: the quote has no amount_out' || nova.calls.length) fails.push(`${what}: ${e.name} ${e.message}`);
  }
  ok('J14 a quote without a positive atomic amount_out is an error, nothing uploaded (6 cases)', fails.length === 0, fails);
}
{
  const cases: [string, Json, boolean, string | null][] = [
    ['policy_transaction_limit_exceeded (not in SDK 0.7.2)', { warnings: [{ code: 'policy_transaction_limit_exceeded' }] }, true, '(policy_transaction_limit_exceeded)'],
    ['policy_action_denied with would_succeed false', { warnings: [{ code: 'policy_action_denied' }], quote: { amount_out: '13030573198836294747843', would_succeed: false } }, true,
      '(policy_action_denied, would_succeed: false)'],
    ['would_succeed false alone', { quote: { amount_out: '13030573198836294747843', would_succeed: false } }, true, '(would_succeed: false)'],
    ['insufficient_balance, real trade', { warnings: [{ code: 'insufficient_balance' }] }, false, '(insufficient_balance)'],
    ['insufficient_balance, simulated', { warnings: [{ code: 'insufficient_balance' }] }, true, null],
    ['another warning', { warnings: [{ code: 'price_impact_high' }, { message: 'no code' }] }, true, null],
    ['warnings not a list', { warnings: { code: 'policy_action_denied' } }, true, null],
  ];
  const fails = [];
  for (const [what, over, simulated, want] of cases) {
    const nova = fakeNova();
    const w = W.createJournalWriter(deps(fakeQuotes(() => dryReply('13030573198836294747843', over)), nova), { ...CFG, simulated });
    const e = await thrown(() => w.write(buyH2));
    if (want === null) { if (e.name !== 'none' || nova.calls.length !== 1) fails.push(`${what}: ${e.name} ${e.message}`); }
    else if (!(e instanceof W.TradeRefused) || e.name !== 'TradeRefused' || e.message !== `journal: the quote refuses this trade ${want}` || nova.calls.length || w.uploads !== 0) {
      fails.push(`${what}: ${e.name} ${e.message}`);
    }
  }
  ok(`J15 policy_* warnings and would_succeed: false refuse the trade; insufficient_balance only for a real trade (${cases.length} cases)`, fails.length === 0, fails);
}

// ── before the quote ────────────────────────────────────────────────────────────────────────
{
  const history: JournalEntry[] = [{ v: 1, simulated: true, ts: new Date(T0 - 3_600_000).toISOString(), pair: 'NEAR/USDC', side: 'buy', size: '2.5',
    price: '3', reasoning: 'earlier', correlation_id: null, salt: SALT },
  { v: 1, simulated: true, ts: new Date(T0 - 1_800_000).toISOString(), pair: 'NEAR/USDC', side: 'sell', size: '0.5', price: '3.2', reasoning: 'earlier', correlation_id: null, salt: SALT }];
  const copy = JSON.stringify(history);
  const quotes = fakeQuotes(() => dryReply('6000000'));
  const nova = fakeNova();
  const w = W.createJournalWriter(deps(quotes, nova), CFG, history);
  ok('J16 the position starts from the seller\'s own earlier entries', w.position() === '2', w.position());
  const e = await thrown(() => w.write({ side: 'sell', amount: (2n * 10n ** 24n + 1n).toString(), reasoning: 'too much' }));
  ok('J17 a sell above the NEAR held is refused before any quote', e instanceof W.TradeRefused && e.message === 'journal: sells more NEAR than held' &&
    quotes.calls.length === 0 && nova.calls.length === 0, e.message);
  const r = await w.write({ side: 'sell', amount: (2n * 10n ** 24n).toString(), reasoning: 'all of it' });
  ok('J18 selling exactly what is held is allowed; the history passed in is not modified',
    r.entry.size === '2' && r.entry.price === '3' && w.position() === '0' && JSON.stringify(history) === copy && history.length === 2, r.entry);
  const e2 = await thrown(() => W.createJournalWriter(deps(fakeQuotes(() => dryReply('1')), fakeNova()), CFG).write({ side: 'sell', amount: '1', reasoning: 'x' }));
  ok('J19 with no history nothing can be sold', e2 instanceof W.TradeRefused && e2.message === 'journal: sells more NEAR than held', e2.message);
}
{
  const bad: [string, Json, string][] = [
    ['side hold', { side: 'hold', amount: '1', reasoning: 'x' }, 'journal: side must be buy or sell'],
    ['no decision', undefined, 'journal: side must be buy or sell'],
    ['amount 0', { side: 'buy', amount: '0', reasoning: 'x' }, 'journal: amount must be a positive atomic integer string'],
    ['amount 01', { side: 'buy', amount: '01', reasoning: 'x' }, 'journal: amount must be a positive atomic integer string'],
    ['amount 1.5', { side: 'buy', amount: '1.5', reasoning: 'x' }, 'journal: amount must be a positive atomic integer string'],
    ['amount as a number', { side: 'buy', amount: 50000, reasoning: 'x' }, 'journal: amount must be a positive atomic integer string'],
    ['amount with a suffix', { side: 'buy', amount: '5e4', reasoning: 'x' }, 'journal: amount must be a positive atomic integer string'],
    ['no reasoning', { side: 'buy', amount: '1', reasoning: '' }, 'journal: reasoning must be 1-280 characters'],
    ['reasoning not a string', { side: 'buy', amount: '1', reasoning: 5 }, 'journal: reasoning must be 1-280 characters'],
    ['reasoning of 281', { side: 'buy', amount: '1', reasoning: 'x'.repeat(281) }, 'journal: reasoning must be 1-280 characters'],
  ];
  const fails = [];
  for (const [what, d, want] of bad) {
    const quotes = fakeQuotes(() => dryReply('1'));
    const e = await thrown(() => W.createJournalWriter(deps(quotes, fakeNova()), CFG).write(d));
    if (!(e instanceof W.TradeRefused) || e.message !== want || quotes.calls.length) fails.push(`${what}: ${e.name} ${e.message}`);
  }
  const quotes = fakeQuotes(() => dryReply('1'));
  const r = await W.createJournalWriter(deps(quotes, fakeNova()), CFG).write({ side: 'buy', amount: '1', reasoning: 'x'.repeat(280) });
  ok(`J20 an invalid decision is refused before any quote (${bad.length} cases); 280 characters of reasoning are accepted`,
    fails.length === 0 && r.entry.reasoning.length === 280, fails);
}

// ── freshness ───────────────────────────────────────────────────────────────────────────────
{
  const run = async (later: number) => {
    const nova = fakeNova();
    const w = W.createJournalWriter(deps(fakeQuotes(() => dryReply('13030573198836294747843')), nova, { now: clock(T0, T0 + later) }), CFG);
    return { e: await thrown(() => w.write(buyH2)), nova, w };
  };
  const at = await run(10 * 60_000);
  const late = await run(10 * 60_000 + 1);
  ok('J21 a quote exactly 10 minutes old is still used; ts is the quote\'s time, not the upload\'s',
    at.e.name === 'none' && at.nova.calls.length === 1 && decodeEntry(new Uint8Array(at.nova.calls[0].data)).ts === new Date(T0).toISOString(), at.e);
  ok('J22 one millisecond later the trade is refused and nothing is uploaded or counted',
    late.e instanceof W.TradeRefused && late.e.message === 'journal: the quote is more than 10 minutes old' && late.nova.calls.length === 0 &&
    late.w.uploads === 0 && W.MAX_QUOTE_AGE_MS === 600_000, late.e.message);
}

// ── a real-trade writer ─────────────────────────────────────────────────────────────────────
{
  const nova = fakeNova();
  const r = await W.createJournalWriter(deps(fakeQuotes(() => dryReply('13030573198836294747843')), nova), { ...CFG, simulated: false }).write(buyH2);
  ok('J24 a writer configured for real trades writes simulated: false',
    r.entry.simulated === false && decodeEntry(new Uint8Array(nova.calls[0].data)).simulated === false, r.entry);
}

// ── with the P&L core ───────────────────────────────────────────────────────────────────────
{
  const quotes = fakeQuotes((req) => dryReply(req.origin_asset === USDC ? '4000000000000000000000000' : '12000000'));
  const nova = fakeNova();
  const w = W.createJournalWriter(deps(quotes, nova, { now: clock(T0, T0, T0 + 60_000, T0 + 60_000) }), CFG);
  const a = await w.write({ side: 'buy', amount: '10000000', reasoning: 'in' });
  const b = await w.write({ side: 'sell', amount: '4000000000000000000000000', reasoning: 'out' });
  const recNs = (e: JournalEntry) => ((BigInt(Date.parse(e.ts)) + 30_000n) * 1_000_000n).toString();
  const curve = recomputeCurve([a, b].map((x) => ({ transId: x.transId, recordNs: recNs(x.entry), entry: x.entry })), 'USDC', true, [recNs(b.entry)]);
  ok('J23 with the P&L core: buy 4 NEAR for 10 USDC, sell them for 12 → realised 2 USDC',
    a.entry.price === '2.5' && b.entry.price === '3' && curve[0].realised === '2.000000', { a: a.entry, b: b.entry, curve });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log('failed:'); for (const r of failed) console.log(`  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`); process.exit(1); }