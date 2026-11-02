// near-chain.test.ts: harness for src/core/near-chain.ts, the RPC ChainReader behind verifyPayment.
// No network: a scripted fake NEAR JSON-RPC (blocks, chunks, tx status) and a fake clock.
// The last two checks run verifyPayment end to end over the reader, with the real 57r1 fixture
// placed in the fake chain.
//
//   npx tsx test/near-chain.test.ts
//   NC_MODULE=<path> npx tsx test/near-chain.test.ts     (the mutation script)
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyPayment, PaymentRefused, type VerifiedPayment } from '../src/core/verify-payment.ts';

const here = dirname(fileURLToPath(import.meta.url));
const modPath = process.env.NC_MODULE ? resolve(process.env.NC_MODULE) : resolve(here, '../src/core/near-chain.ts');
const { createNearChain, NearRpcError } = await import(pathToFileURL(modPath).href);

type Json = any;
const INTENTS = 'intents.near';
const RPC_URL = 'https://rpc.example/archival';
const BASE = 170_000_000;
const T0 = Date.parse('2026-10-19T10:34:20.000Z');
const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();

const results: { name: string; ok: boolean; detail?: string }[] = [];
function ok(name: string, pass: boolean, detail?: unknown) {
  const d = detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ name, ok: pass, detail: d });
  console.log(`${pass ? '✓' : '✗'} ${name}${!pass && d ? ` — ${d}` : ''}`);
}
async function failure(f: () => Promise<unknown>): Promise<unknown> {
  try { await f(); return new Error('no error thrown'); } catch (e) { return e; }
}
const msg = (e: unknown) => String((e as Error)?.message ?? e);

// ── a scripted chain ────────────────────────────────────────────────────────────────────────
interface ChunkSpec { shard: number; txs?: Json[]; missing?: boolean }
interface BlockSpec { height: number; ms: number; hash?: string; chunks: ChunkSpec[] }
const tx = (hash: string, signer = INTENTS, receiver = INTENTS) =>
  ({ hash, signer_id: signer, receiver_id: receiver, actions: [{ FunctionCall: { method_name: 'execute_intents', args: '' } }] });

/** Blocks every 600 ms from T0 at heights BASE.., minus `skip`; two shards (intents.near on shard 1) unless overridden. */
function blocks(n: number, opts: { skip?: number[]; put?: Record<number, ChunkSpec[]>; extra?: BlockSpec[] } = {}): BlockSpec[] {
  const out: BlockSpec[] = [];
  for (let i = 0; i < n; i++) {
    const height = BASE + i;
    if (opts.skip?.includes(height)) continue;
    out.push({ height, ms: T0 + 600 * i, chunks: opts.put?.[height] ?? [{ shard: 0 }, { shard: 1 }] });
  }
  for (const b of opts.extra ?? []) { const i = out.findIndex((x) => x.height === b.height); if (i >= 0) out[i] = b; }
  return out;
}

type Intercept = (method: string, params: Json, n: number) => Response | undefined;
function fakeRpc(spec: BlockSpec[], txStatus: Record<string, Json> = {}, intercept?: Intercept) {
  let clock = spec[spec.length - 1].ms + 300_000;
  const sleeps: number[] = [];
  const calls: { method: string; params: Json; at: number; url: string }[] = [];
  const byHeight = new Map<number, Json>();
  const byHash = new Map<string, Json>();
  const chunks = new Map<string, Json>();
  let prevIncluded = new Map<number, Json>();
  for (const b of spec) {
    const hash = b.hash ?? `B${b.height}`;
    const included = new Map<number, Json>();
    const headers = b.chunks.map((c) => {
      if (c.missing && prevIncluded.has(c.shard)) return prevIncluded.get(c.shard);
      const h = { chunk_hash: `C${b.height}-${c.shard}`, shard_id: c.shard, height_included: b.height };
      chunks.set(h.chunk_hash, { header: { chunk_hash: h.chunk_hash, shard_id: c.shard }, transactions: c.txs ?? [] });
      included.set(c.shard, h);
      return h;
    });
    prevIncluded = new Map([...prevIncluded, ...included]);
    const view = { header: { height: b.height, hash, timestamp_nanosec: ns(b.ms) }, chunks: headers };
    byHeight.set(b.height, view);
    byHash.set(hash, view);
  }
  const head = byHeight.get(spec[spec.length - 1].height);
  const reply = (body: Json, status = 200) => new Response(JSON.stringify(body), { status });
  const rpcError = (name: string) => reply({ jsonrpc: '2.0', id: 'x', error: { name: 'HANDLER_ERROR', cause: { name, info: {} }, code: -32000 } });
  const fetchFn = async (url: string, init: Json) => {
    const { method, params } = JSON.parse(init.body);
    calls.push({ method, params, at: clock, url });
    const hit = intercept?.(method, params, calls.length);
    if (hit) return hit;
    if (method === 'block') {
      if (params.finality === 'final') return reply({ result: head });
      const b = typeof params.block_id === 'number' ? byHeight.get(params.block_id) : byHash.get(params.block_id);
      return b ? reply({ result: b }) : rpcError('UNKNOWN_BLOCK');
    }
    if (method === 'chunk') { const c = chunks.get(params.chunk_id); return c ? reply({ result: c }) : rpcError('UNKNOWN_CHUNK'); }
    if (method === 'EXPERIMENTAL_tx_status') { const t = txStatus[params.tx_hash]; return t ? reply({ result: t }) : rpcError('UNKNOWN_TRANSACTION'); }
    return rpcError('METHOD_NOT_FOUND');
  };
  const reader = createNearChain({
    rpcUrl: RPC_URL, fetch: fetchFn, now: () => clock, sleep: async (ms: number) => { sleeps.push(ms); clock += ms; },
  });
  return { reader, calls, sleeps, chunkCalls: () => calls.filter((c) => c.method === 'chunk').map((c) => c.params.chunk_id) };
}
const msAt = (i: number) => T0 + 600 * i;
const hashes = (txs: Json[]) => txs.map((t) => t.hash);

// ── scan ────────────────────────────────────────────────────────────────────────────────────
{
  const f = fakeRpc(blocks(60, { put: {
    [BASE + 9]: [{ shard: 0 }, { shard: 1, txs: [tx('before')] }],
    [BASE + 10]: [{ shard: 0 }, { shard: 1, txs: [tx('first'), tx('other-signer', 'alice.near')] }],
    [BASE + 15]: [{ shard: 0, txs: [tx('not-intents', 'bob.near', INTENTS)] }, { shard: 1, txs: [tx('middle')] }],
    [BASE + 20]: [{ shard: 0 }, { shard: 1, txs: [tx('last')] }],
    [BASE + 21]: [{ shard: 0 }, { shard: 1, txs: [tx('after')] }],
  } }));
  const got = await f.reader.scanExecuteIntents(msAt(10), msAt(20));
  ok('N1 the scan returns the intents.near transactions of the window, in chain order',
    JSON.stringify(hashes(got)) === JSON.stringify(['first', 'middle', 'last']), hashes(got));
  ok('N2 blocks exactly at the window\'s start and end are included', hashes(got).includes('first') && hashes(got).includes('last'), hashes(got));
  ok('N3 blocks one block outside the window are not read', !hashes(got).includes('before') && !hashes(got).includes('after') &&
    !f.chunkCalls().includes(`C${BASE + 9}-1`) && !f.chunkCalls().includes(`C${BASE + 21}-1`), f.chunkCalls());
  ok('N4 transactions signed by other accounts are not returned', !hashes(got).includes('other-signer') && !hashes(got).includes('not-intents'), hashes(got));
  ok('N5 once intents.near\'s shard is known, other shards\' chunks are not read',
    f.chunkCalls().includes(`C${BASE + 10}-0`) && !f.chunkCalls().some((c) => c.endsWith('-0') && c > `C${BASE + 10}-0`), f.chunkCalls());
  ok('N6 every call goes to the configured RPC URL', f.calls.every((c) => c.url === RPC_URL));
}
{
  const f = fakeRpc(blocks(60, { skip: [BASE + 12, BASE + 13], put: {
    [BASE + 11]: [{ shard: 0 }, { shard: 1, txs: [tx('a')] }],
    [BASE + 14]: [{ shard: 0 }, { shard: 1, txs: [tx('b')] }],
  } }));
  const got = await f.reader.scanExecuteIntents(msAt(10), msAt(20));
  ok('N7 skipped heights inside the window are tolerated', JSON.stringify(hashes(got)) === '["a","b"]', hashes(got));
}
{
  const f = fakeRpc(blocks(60, { put: {
    [BASE + 10]: [{ shard: 0 }, { shard: 1 }],
    [BASE + 11]: [{ shard: 0 }, { shard: 1, missing: true }],
  } }));
  await f.reader.scanExecuteIntents(msAt(10), msAt(12));
  const c10 = f.chunkCalls().filter((c) => c === `C${BASE + 10}-1`).length;
  ok('N8 a missing chunk (the header repeats an older chunk) is not read again', c10 === 1, f.chunkCalls());
}
{
  const three = [{ shard: 0 }, { shard: 1 }, { shard: 2 }];
  const put: Record<number, ChunkSpec[]> = { [BASE + 10]: [{ shard: 0 }, { shard: 1, txs: [tx('old-layout')] }] };
  for (let i = 12; i < 60; i++) put[BASE + i] = three;
  put[BASE + 14] = [{ shard: 0 }, { shard: 1 }, { shard: 2, txs: [tx('new-layout')] }];
  const f = fakeRpc(blocks(60, { put }));
  const got = await f.reader.scanExecuteIntents(msAt(10), msAt(16));
  ok('N9 a shard layout change resets the learned shard', JSON.stringify(hashes(got)) === '["old-layout","new-layout"]', hashes(got));
}
{
  const f = fakeRpc(blocks(30));
  const e = await failure(() => f.reader.scanExecuteIntents(msAt(20), msAt(29) + 1));
  ok('N10 a window ending after the last final block → refused, no chunk read',
    /scan: window ends after the last final block/.test(msg(e)) && f.chunkCalls().length === 0, msg(e));
}
{
  const f = fakeRpc(blocks(60), {}, (m, p) => m === 'chunk' ? new Response(JSON.stringify({ result: { header: { chunk_hash: 'Cforged', shard_id: 1 }, transactions: [tx('forged')] } })) : undefined);
  const e = await failure(() => f.reader.scanExecuteIntents(msAt(10), msAt(12)));
  ok('N11 a chunk reply for another chunk → error', /rpc chunk: reply is for another chunk/.test(msg(e)), msg(e));
}
{
  const f = fakeRpc(blocks(60), {}, (m, p) => m === 'block' && p.block_id === BASE + 11
    ? new Response(JSON.stringify({ result: { header: { height: BASE + 40, hash: 'Bx', timestamp_nanosec: ns(msAt(11)) }, chunks: [] } })) : undefined);
  const e = await failure(() => f.reader.scanExecuteIntents(msAt(10), msAt(12)));
  ok('N12 a block reply for another height → error', /rpc block: reply is for another block/.test(msg(e)), msg(e));
}

// ── txStatus and blockTimeMs ────────────────────────────────────────────────────────────────
{
  const st = { status: { SuccessValue: '' }, transaction: tx('T1'), receipts_outcome: [] };
  const f = fakeRpc(blocks(5), { T1: st });
  const got = await f.reader.txStatus('T1', 'sender.near');
  const c = f.calls.at(-1)!;
  ok('N13 txStatus asks EXPERIMENTAL_tx_status for the hash and sender, waited until FINAL, and returns the result',
    c.method === 'EXPERIMENTAL_tx_status' && c.params.tx_hash === 'T1' && c.params.sender_account_id === 'sender.near' &&
    c.params.wait_until === 'FINAL' && got?.transaction?.hash === 'T1', c);
}
{
  const f = fakeRpc(blocks(5), { T1: { status: { SuccessValue: '' }, transaction: tx('T2') } });
  const e = await failure(() => f.reader.txStatus('T1', INTENTS));
  ok('N14 a tx status reply for another transaction → error', /rpc EXPERIMENTAL_tx_status: reply is for another transaction/.test(msg(e)), msg(e));
}
{
  const f = fakeRpc(blocks(5));
  const e = await failure(() => f.reader.txStatus('nope', INTENTS));
  ok('N15 an RPC error surfaces its cause', /rpc EXPERIMENTAL_tx_status: UNKNOWN_TRANSACTION/.test(msg(e)), msg(e));
}
{
  const f = fakeRpc([{ height: BASE, ms: T0, chunks: [] }], {}, (m, p) => m === 'block' && p.block_id === 'Hns'
    ? new Response(JSON.stringify({ result: { header: { height: BASE, hash: 'Hns', timestamp_nanosec: '1760870085123999999' }, chunks: [] } })) : undefined);
  const got = await f.reader.blockTimeMs('Hns');
  ok('N16 blockTimeMs reads the block by hash and truncates nanoseconds to ms exactly', got === 1760870085123 && f.calls.at(-1)!.params.block_id === 'Hns', got);
}
{
  const f = fakeRpc(blocks(5));
  const e = await failure(() => f.reader.blockTimeMs(`B${BASE + 9}`));
  const g = fakeRpc(blocks(5), {}, (m) => m === 'block' ? new Response(JSON.stringify({ result: { header: { height: BASE, hash: 'Bother', timestamp_nanosec: ns(T0) }, chunks: [] } })) : undefined);
  const e2 = await failure(() => g.reader.blockTimeMs(`B${BASE + 1}`));
  ok('N17 blockTimeMs: an unknown block or a reply for another block → error',
    /rpc block: UNKNOWN_BLOCK/.test(msg(e)) && /rpc block: reply is for another block/.test(msg(e2)), [msg(e), msg(e2)]);
}

// ── transport ───────────────────────────────────────────────────────────────────────────────
const tooMany = () => new Response('Too Many Requests', { status: 429 });
{
  const f = fakeRpc(blocks(5), {}, (m, p, n) => (n <= 2 ? tooMany() : undefined));
  const got = await f.reader.blockTimeMs(`B${BASE + 1}`);
  ok('N18 429 twice, then an answer → the answer, after backoffs of 1 s and 2 s',
    got === msAt(1) && f.calls.length === 3 && f.sleeps.includes(1000) && f.sleeps.includes(2000) && !f.sleeps.includes(4000), { got, sleeps: f.sleeps });
}
{
  const f = fakeRpc(blocks(5), {}, () => tooMany());
  const e = await failure(() => f.reader.blockTimeMs(`B${BASE + 1}`));
  ok('N19 429 every time → error after 6 retries (7 requests)', /rpc block: HTTP 429 after 6 retries/.test(msg(e)) && f.calls.length === 7, { e: msg(e), n: f.calls.length });
}
{
  const html = fakeRpc(blocks(5), {}, () => new Response('<html>bad gateway</html>', { status: 502 }));
  const e1 = await failure(() => html.reader.blockTimeMs(`B${BASE + 1}`));
  const withResult = fakeRpc(blocks(5), {}, () => new Response(JSON.stringify({ result: { header: { height: BASE + 1, hash: `B${BASE + 1}`, timestamp_nanosec: ns(T0) } } }), { status: 500 }));
  const e2 = await failure(() => withResult.reader.blockTimeMs(`B${BASE + 1}`));
  const empty = fakeRpc(blocks(5), {}, () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 'x' })));
  const e3 = await failure(() => empty.reader.blockTimeMs(`B${BASE + 1}`));
  ok('N20 a malformed or non-2xx reply → error, no retry (HTML 502; 500 carrying a result; 200 without a result)',
    /rpc block: HTTP 502/.test(msg(e1)) && /rpc block: HTTP 500/.test(msg(e2)) && /rpc block: no result/.test(msg(e3)) &&
    html.calls.length === 1 && withResult.calls.length === 1 && empty.calls.length === 1, [msg(e1), msg(e2), msg(e3)]);
}
{
  const reader = createNearChain({ rpcUrl: RPC_URL, fetch: async () => { throw new TypeError('fetch failed'); }, now: () => 0, sleep: async () => {} });
  const e = await failure(() => reader.blockTimeMs(`B${BASE + 1}`));
  ok('N21 a transport failure → error naming it', /rpc block: fetch failed/.test(msg(e)), msg(e));
}
{
  const f = fakeRpc(blocks(60, { put: { [BASE + 10]: [{ shard: 0 }, { shard: 1, txs: [tx('x')] }] } }));
  await f.reader.scanExecuteIntents(msAt(10), msAt(20));
  const gaps = f.calls.slice(1).map((c, i) => c.at - f.calls[i].at);
  ok('N22 no two requests closer than 200 ms', f.calls.length > 10 && gaps.every((g) => g >= 200), { n: f.calls.length, min: Math.min(...gaps) });
}
{
  const f = fakeRpc(blocks(5));
  const e = await failure(() => f.reader.txStatus('nope', INTENTS));
  ok('N23 an RPC failure is an RpcError, never a PaymentRefused (never a verdict)', e instanceof NearRpcError && !(e instanceof PaymentRefused), (e as Error)?.name);
}

// ── end to end: verifyPayment over the reader, the real fixture in the fake chain ───────────
const FIXTURE = resolve(here, 'fixtures/withdrawal-57r1.tx.json');
const raw = readFileSync(FIXTURE);
const FIXTURE_SHA = 'a075acf5527013f7c4ed479170bff597a6415fe24b7438d92f42d1788aa171f8';
if (createHash('sha256').update(raw).digest('hex') !== FIXTURE_SHA) { console.error('fixture sha256 mismatch'); process.exit(1); }
const fx = JSON.parse(raw.toString());
const PAYER = '5a5d96f384a41ba3d1c90399dcd563ed6f52c34aa28ba5f200902a655d8ab288';
const listing = { proceedsAccount: '1000fans.near', token: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', price: '100000',
  openedAtMs: Date.parse('2026-10-19T10:00:00.000Z') };
const claim = { intentHash: 'B2btEHKa3W2DcSo51dYoEAMghbmHqEUKg78BwSPK3UbY', payer: PAYER,
  windowFromMs: Date.parse('2026-10-19T10:34:42.845Z'), windowToMs: Date.parse('2026-10-19T10:34:48.248Z') };
const FX_INDEX = 41; // 10:34:44.600, inside the window
const fxChain = () => blocks(100, { extra: [{ height: BASE + FX_INDEX, ms: msAt(FX_INDEX), hash: fx.transaction_outcome.block_hash,
  chunks: [{ shard: 0 }, { shard: 1, txs: [fx.transaction] }] }] });
const memUsed = () => { const m = new Map<string, VerifiedPayment>(); return { m, has: async (h: string) => m.has(h), add: async (h: string, r: VerifiedPayment) => { m.set(h, r); } }; };
{
  const f = fakeRpc(fxChain(), { [fx.transaction.hash]: fx });
  const used = memUsed();
  const got = await verifyPayment({ chain: f.reader, used, now: () => Date.parse('2026-10-19T10:40:00.000Z') }, listing, claim)
    .catch((e) => ({ error: msg(e) }) as Json);
  ok('N24 end to end: verifyPayment over the RPC reader accepts the real 57r1 payment',
    got?.txHash === fx.transaction.hash && got?.payer === PAYER && got?.blockMs === msAt(FX_INDEX) && used.m.size === 1, got);
}
{
  const f = fakeRpc(fxChain(), { [fx.transaction.hash]: fx }, (m) => m === 'EXPERIMENTAL_tx_status' ? new Response('', { status: 503 }) : undefined);
  const used = memUsed();
  const e = await failure(() => verifyPayment({ chain: f.reader, used, now: () => Date.parse('2026-10-19T10:40:00.000Z') }, listing, claim));
  ok('N25 end to end: an RPC failure mid-check is rethrown as an RPC error, nothing recorded',
    e instanceof NearRpcError && /rpc EXPERIMENTAL_tx_status: HTTP 503/.test(msg(e)) && used.m.size === 0, msg(e));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log('failed:'); for (const r of failed) console.log(`  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`); process.exit(1); }