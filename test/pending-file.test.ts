// pending-file.test.ts: harness for src/adapters/pending-file.ts (the signer's one in-flight NOVA write as a file).
// Real files in a fresh temporary directory per case; failures injected through a wrapped fs/promises. The last
// checks run the vendored agentConnectSigner over the store with a fake Agent API: a crash after the call was
// saved is settled after a "restart" under the same idempotency key.
//
//   npx tsx test/pending-file.test.ts
//   PENDING_MODULE=<path> npx tsx test/pending-file.test.ts     (the mutation script)
import { promises as fsp, mkdtempSync, rmSync, statSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { agentConnectSigner } from '../src/vendor/nova-agent-connect.ts';

const here = dirname(fileURLToPath(import.meta.url));
const modPath = process.env.PENDING_MODULE ? resolve(process.env.PENDING_MODULE) : resolve(here, '../src/adapters/pending-file.ts');
const P = await import(pathToFileURL(modPath).href);

type Json = any;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function ok(name: string, pass: boolean, detail?: unknown) {
  const d = detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ name, ok: pass, detail: d });
  console.log(`${pass ? '✓' : '✗'} ${name}${!pass && d ? ` — ${d}` : ''}`);
}
async function thrown(f: () => Promise<unknown>): Promise<string> {
  try { await f(); return 'no error'; } catch (e) { return `${(e as Error).name}: ${(e as Error).message}`; }
}
const dirs: string[] = [];
const fresh = () => { const d = mkdtempSync(join(tmpdir(), 'pending-')); dirs.push(d); return d; };
const call = (over: Json = {}, body: Json = {}) => ({ idempotencyKey: 'nova-1111', savedAt: '2026-11-03T13:00:00.000Z',
  body: { receiver_id: 'nova-sdk.near', method_name: 'record_transaction', args: { group_id: 'g', file_hash: 'h' }, gas: '100000000000000', deposit: '25600000000000000000', ...body },
  ...over });

// ── persistence ─────────────────────────────────────────────────────────────────────────────
{
  const d = fresh(); const p = join(d, 'pending.json');
  const s = P.filePendingStore(p);
  ok('F1 a missing file is "nothing pending"', (await s.load()) === null && s.path === p);
  await s.save(call());
  const again = await P.filePendingStore(p).load();
  ok('F2 a saved call is read back by a new store on the same file (a restart), field for field',
    JSON.stringify(again) === JSON.stringify(call()), again);
  const doc = JSON.parse(readFileSync(p, 'utf8'));
  ok('F3 the file is { v: 1, pending: call }, readable by the owner only (0600)',
    doc.v === 1 && JSON.stringify(doc.pending) === JSON.stringify(call()) && (statSync(p).mode & 0o777) === 0o600, (statSync(p).mode & 0o777).toString(8));
  const got = await s.load(); got.body.method_name = 'add_group_member';
  ok('F4 load returns a fresh object: changing it never changes the store', (await s.load()).body.method_name === 'record_transaction');
  await s.save(call({ correlationId: 'corr-1' }));
  ok('F5 a second save (with the correlation id) replaces the first', (await s.load()).correlationId === 'corr-1');
  await s.clear();
  ok('F6 clear removes it; clearing again is fine', (await s.load()) === null && !existsSync(p) && (await thrown(() => s.clear())) === 'no error');
}

// ── refusals: a damaged store is never read as "nothing pending" ─────────────────────────────
{
  const d = fresh(); const p = join(d, 'pending.json');
  const doc = (pending: Json) => JSON.stringify({ v: 1, pending });
  const cases: [string, string, string][] = [
    ['not JSON', '{"v":1,"pending":', `pending: ${p} is not valid JSON (refusing to treat it as empty)`],
    ['empty file', '', `pending: ${p} is not valid JSON (refusing to treat it as empty)`],
    ['another version', JSON.stringify({ v: 2, pending: call() }), `pending: ${p} has version 2, expected 1`],
    ['no version', JSON.stringify({ pending: call() }), `pending: ${p} has version undefined, expected 1`],
    ['pending null', doc(null), `pending: ${p}: the saved call is not an object`],
    ['an extra field', doc({ ...call(), extra: 1 }), `pending: ${p}: the saved call has an unexpected field extra`],
    ['no key', doc(call({ idempotencyKey: '' })), `pending: ${p}: the saved call has no idempotencyKey`],
    ['no savedAt', doc((({ savedAt, ...c }) => c)(call())), `pending: ${p}: the saved call has no savedAt`],
    ['an empty correlation id', doc(call({ correlationId: '' })), `pending: ${p}: the saved call has an empty correlationId`],
    ['no body', doc(call({ body: 'x' })), `pending: ${p}: the saved call has no body`],
    ['an extra body field', doc(call({}, { extra: 1 })), `pending: ${p}: the saved call has an unexpected body field extra`],
    ['no receiver', doc(call({}, { receiver_id: '' })), `pending: ${p}: the saved call has no body.receiver_id`],
    ['no method', doc(call({}, { method_name: 7 })), `pending: ${p}: the saved call has no body.method_name`],
    ['args a list', doc(call({}, { args: [] })), `pending: ${p}: the saved call has no body.args object`],
    ['gas a number', doc(call({}, { gas: 100 })), `pending: ${p}: the saved call has no body.gas integer string`],
    ['deposit a decimal', doc(call({}, { deposit: '1.5' })), `pending: ${p}: the saved call has no body.deposit integer string`],
  ];
  const fails = [];
  for (const [what, text, want] of cases) {
    writeFileSync(p, text);
    const m = await thrown(() => P.filePendingStore(p).load());
    if (m !== `PendingStoreError: ${want}`) fails.push(`${what}: ${m}`);
  }
  ok(`D1 a damaged store is refused with a message naming the problem (${cases.length} cases)`, fails.length === 0, fails);
}
{
  const d = fresh(); const p = join(d, 'pending.json');
  const s = P.filePendingStore(p);
  await s.save(call());
  const before = readFileSync(p);
  const bad: [string, Json, string][] = [
    ['without a key', call({ idempotencyKey: undefined }), 'has no idempotencyKey'],
    ['with a bigint gas', call({}, { gas: 1n }), 'has no body.gas integer string'],
    ['that is null', null, 'is not an object'],
  ];
  const fails = [];
  for (const [what, c, want] of bad) {
    const m = await thrown(() => s.save(c));
    if (m !== `PendingStoreError: pending: refusing to save a call that ${want}`) fails.push(`${what}: ${m}`);
  }
  ok('D2 a call that is not well-formed is refused before anything is written', fails.length === 0 &&
    Buffer.compare(before, readFileSync(p)) === 0 && readdirSync(d).join() === 'pending.json', fails);
}

// ── atomic writes and failures ──────────────────────────────────────────────────────────────
{
  const d = fresh(); const p = join(d, 'pending.json');
  await P.filePendingStore(p).save(call());
  const before = readFileSync(p);
  const failing = { ...fsp, rename: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } };
  const m = await thrown(() => P.filePendingStore(p, { fsp: failing as Json }).save(call({ correlationId: 'c2' })));
  ok('A1 a save that fails before the rename leaves the old call byte for byte and no temp file',
    m === 'Error: disk full' && Buffer.compare(before, readFileSync(p)) === 0 && readdirSync(d).join() === 'pending.json', { m, files: readdirSync(d) });
  const order: string[] = [];
  const watched = { ...fsp,
    open: async (...a: Json[]) => { const h = await (fsp.open as Json)(...a); const sync = h.sync.bind(h); h.sync = async () => { order.push('sync'); return sync(); }; return h; },
    rename: async (a: string, b: string) => { order.push('rename'); return fsp.rename(a, b); } };
  await P.filePendingStore(p, { fsp: watched as Json }).save(call({ correlationId: 'c3' }));
  ok('A2 each save is fsynced before it replaces the store', order.join() === 'sync,rename' && (await P.filePendingStore(p).load()).correlationId === 'c3', order);
  const s = P.filePendingStore(p);
  const ops = [s.save(call({ correlationId: 'a' })), s.clear(), s.save(call({ correlationId: 'b' })), s.load(), s.clear(), s.save(call({ correlationId: 'c' })), s.load()];
  const out = await Promise.all(ops);
  ok('A3 load, save and clear are serialised in the order called', out[3]?.correlationId === 'b' && out[6]?.correlationId === 'c' &&
    (await s.load()).correlationId === 'c', { l1: out[3]?.correlationId, l2: out[6]?.correlationId });
  const denied = { ...fsp, readFile: async () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); },
    unlink: async () => { throw Object.assign(new Error('read-only'), { code: 'EROFS' }); } };
  const ds = P.filePendingStore(p, { fsp: denied as Json });
  ok('A4 a read or remove error other than "no file" is thrown, never read as nothing pending or as cleared',
    (await thrown(() => ds.load())) === 'Error: permission denied' && (await thrown(() => ds.clear())) === 'Error: read-only');
}

// ── with the vendored signer: a crash after the save is settled after a restart ───────────────
{
  const d = fresh(); const p = join(d, 'pending.json');
  const sent: Json[] = [];
  const crashing: Json = { nativeNearCall: async (_a: string, body: Json, o: Json) => { sent.push({ body, key: o.idempotencyKey }); throw new Error('socket hang up'); },
    getStatus: async () => { throw new Error('not reached'); } };
  const opts = (store: Json) => ({ store, maxDepositYocto: 10n ** 22n, methods: ['record_transaction'] as const });
  const s1 = agentConnectSigner(crashing, 'seller', 'acc', opts(P.filePendingStore(p)));
  const e = await thrown(() => s1.signAndSendFunctionCall({ receiverId: 'nova-sdk.near', methodName: 'record_transaction',
    args: { group_id: 'g' }, gas: 10n ** 14n, deposit: 256n * 10n ** 17n }));
  const saved = await P.filePendingStore(p).load();
  ok('I1 a send that may have gone out stays pending on disk under its key', e.startsWith('NativeCallPendingError') &&
    saved?.idempotencyKey === sent[0].key && saved?.body.method_name === 'record_transaction', { e, saved });
  const replayed: Json[] = [];
  const healthy: Json = { nativeNearCall: async (_a: string, body: Json, o: Json) => { replayed.push({ body, key: o.idempotencyKey });
    return { status: 'SUCCESS', correlation_id: 'corr-9', type: 'native', details: { tx_hash: 'TX9' } }; },
    getStatus: async () => { throw new Error('not reached'); } };
  const s2 = agentConnectSigner(healthy, 'seller', 'acc', opts(P.filePendingStore(p)));
  const blocked = await thrown(() => s2.signAndSendFunctionCall({ receiverId: 'nova-sdk.near', methodName: 'record_transaction', args: {}, gas: 1n, deposit: 0n }));
  const r = await s2.resolvePending();
  ok('I2 after the restart a new write is refused until resolvePending settles the saved call with the same key and body; then nothing is pending',
    /is pending: call resolvePending\(\) first/.test(blocked) && replayed.length === 1 && replayed[0].key === sent[0].key &&
    JSON.stringify(replayed[0].body) === JSON.stringify(sent[0].body) && r?.status === 'SUCCESS' && r?.txHash === 'TX9' &&
    (await P.filePendingStore(p).load()) === null, { blocked, replayed, r });
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log('failed:'); for (const r of failed) console.log(`  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`); process.exit(1); }