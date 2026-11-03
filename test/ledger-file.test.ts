// ledger-file.test.ts: harness for src/adapters/ledger-file.ts (the admissions ledger as one JSON file).
// Real files in a fresh temporary directory per case; failures injected through a wrapped fs/promises.
//
//   npx tsx test/ledger-file.test.ts
//   LEDGER_MODULE=<path> npx tsx test/ledger-file.test.ts     (the mutation script)
import { promises as fsp, mkdtempSync, rmSync, statSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { paymentRecorder, admitPaid } from '../src/core/membership.ts';

const here = dirname(fileURLToPath(import.meta.url));
const modPath = process.env.LEDGER_MODULE ? resolve(process.env.LEDGER_MODULE) : resolve(here, '../src/adapters/ledger-file.ts');
const L = await import(pathToFileURL(modPath).href);

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
const fresh = () => { const d = mkdtempSync(join(tmpdir(), 'ledger-')); dirs.push(d); return d; };
const rec = (h: string, over: Json = {}) => ({ intentHash: h, listingId: 'ab'.repeat(32), groupId: 'g', seller: 's.near', member: 'm.near',
  txHash: `tx-${h}`, blockMs: 1, periodMinutes: 60, expiresAtMs: 3_600_001, state: 'paid', ...over });

// ── persistence ─────────────────────────────────────────────────────────────────────────────
{
  const d = fresh(); const p = join(d, 'ledger.json');
  const l = await L.openLedger(p);
  ok('D1 a missing ledger opens empty', (await l.all()).length === 0 && (await l.get('x')) === undefined);
  await l.put(rec('a')); await l.put(rec('b'));
  await l.put(rec('a', { state: 'admitted', admittedAtMs: 5 }));
  await l.close();
  const l2 = await L.openLedger(p);
  const a = await l2.get('a');
  ok('D2 records survive a reopen; a put replaces the record under the same intent hash and leaves the others',
    (await l2.all()).length === 2 && a?.state === 'admitted' && a?.admittedAtMs === 5 && (await l2.get('b'))?.state === 'paid', await l2.all());
  const doc = JSON.parse(readFileSync(p, 'utf8'));
  ok('D3 the file is { v: 1, records: { <intentHash>: record } }, readable by the owner only (0600)',
    doc.v === 1 && Object.keys(doc.records).sort().join() === 'a,b' && doc.records.a.intentHash === 'a' && (statSync(p).mode & 0o777) === 0o600,
    { v: doc.v, mode: (statSync(p).mode & 0o777).toString(8) });
  const got = await l2.get('a'); got.state = 'revoked';
  const all = await l2.all(); all[0].member = 'thief.near';
  const rec0 = rec('c'); await l2.put(rec0); rec0.state = 'revoked';
  ok('D4 records go in and come out as copies: changing one never changes the ledger',
    (await l2.get('a')).state === 'admitted' && !(await l2.all()).some((r: Json) => r.member === 'thief.near') && (await l2.get('c')).state === 'paid');
  await l2.close();
}

// ── refusals: a ledger is never silently reset ───────────────────────────────────────────────
{
  const cases: [string, string, RegExp][] = [
    ['not JSON', '{"v":1,"records":', /is not valid JSON \(refusing to treat it as empty\)/],
    ['another version', JSON.stringify({ v: 2, records: {} }), /has version 2, expected 1/],
    ['no records object', JSON.stringify({ v: 1, records: [] }), /has no records object/],
    ['a record under another key', JSON.stringify({ v: 1, records: { a: rec('b') } }), /holds a record under a whose intentHash is "b"/],
  ];
  const failures: string[] = [];
  for (const [what, body, re] of cases) {
    const d = fresh(); const p = join(d, 'ledger.json');
    writeFileSync(p, body);
    const m = await thrown(() => L.openLedger(p));
    if (!/^LedgerError: /.test(m) || !re.test(m)) failures.push(`${what}: ${m}`);
    if (readFileSync(p, 'utf8') !== body) failures.push(`${what}: the file was changed`);
    if (readdirSync(d).includes('ledger.json.lock')) failures.push(`${what}: the lock was left behind`);
  }
  ok(`R1 a damaged ledger is refused, left untouched, and its lock released (${cases.length} cases)`, failures.length === 0, failures);
  const d = fresh(); const l = await L.openLedger(join(d, 'ledger.json'));
  ok('R2 a record without an intent hash is refused', /a record needs an intentHash/.test(await thrown(() => l.put({ ...rec('x'), intentHash: '' }))));
  await l.close();
  ok('R3 a closed ledger refuses every call', [await thrown(() => l.get('x')), await thrown(() => l.all()), await thrown(() => l.put(rec('y')))]
    .every((m) => /ledger: closed/.test(m)));
}

// ── atomic writes ───────────────────────────────────────────────────────────────────────────
{
  const d = fresh(); const p = join(d, 'ledger.json');
  const l = await L.openLedger(p); await l.put(rec('a')); await l.close();
  const before = readFileSync(p, 'utf8');
  const failing: Json = { ...fsp, rename: async () => { throw Object.assign(new Error('EIO on rename'), { code: 'EIO' }); } };
  const l2 = await L.openLedger(p, { fsp: failing });
  const m = await thrown(() => l2.put(rec('b')));
  ok('A1 a write that fails before the rename leaves the old ledger byte for byte, no temp file, and the record unwritten',
    /EIO on rename/.test(m) && readFileSync(p, 'utf8') === before && readdirSync(d).every((f) => !f.endsWith('.tmp')) &&
    (await l2.get('b')) === undefined, { m, files: readdirSync(d) });
  let syncs = 0;
  const counting: Json = { ...fsp, open: async (...a: Json[]) => { const h = await (fsp.open as Json)(...a); const s = h.sync.bind(h); h.sync = async () => { syncs++; return s(); }; return h; } };
  await l2.close();
  const l3 = await L.openLedger(p, { fsp: counting });
  await l3.put(rec('c'));
  ok('A2 each write is fsynced before it replaces the ledger', syncs === 1 && (await l3.get('c'))?.intentHash === 'c', syncs);
  await l3.close();
}
{
  const d = fresh(); const p = join(d, 'ledger.json');
  const l = await L.openLedger(p);
  await Promise.all(Array.from({ length: 25 }, (_, i) => l.put(rec(`k${i}`))));
  await l.close();
  const l2 = await L.openLedger(p);
  ok('A3 25 concurrent puts are serialised: all 25 are on disk', (await l2.all()).length === 25, (await l2.all()).length);
  await l2.close();
}

// ── one runner per ledger ───────────────────────────────────────────────────────────────────
{
  const d = fresh(); const p = join(d, 'ledger.json');
  const l = await L.openLedger(p);
  const m = await thrown(() => L.openLedger(p));
  ok('K1 a second runner on the same ledger is refused while the first holds it', new RegExp(`is held by pid ${process.pid}$`).test(m), m);
  await l.close();
  const l2 = await L.openLedger(p);
  ok('K2 after close, the ledger opens again', (await l2.all()).length === 0);
  await l2.close();
  writeFileSync(`${p}.lock`, '999999');
  const l3 = await L.openLedger(p, { isAlive: (pid: number) => pid !== 999999 });
  ok('K3 a lock left by a runner that is no longer running is taken over', readFileSync(`${p}.lock`, 'utf8') === String(process.pid));
  await l3.close();
  writeFileSync(`${p}.lock`, '424242');
  const m2 = await thrown(() => L.openLedger(p, { isAlive: () => true }));
  ok('K4 a lock held by another running pid is respected', /is held by pid 424242$/.test(m2) && readFileSync(`${p}.lock`, 'utf8') === '424242', m2);
}

// ── with the membership core ────────────────────────────────────────────────────────────────
{
  const d = fresh(); const p = join(d, 'ledger.json');
  const listing = { listingId: 'cd'.repeat(32), groupId: 'g', seller: 'seller.near', periodMinutes: 60 };
  const l = await L.openLedger(p);
  await paymentRecorder(l, listing).add('ih1', { payer: 'buyer.near', txHash: 't', intentHash: 'ih1', amount: '1', token: 'u', proceedsAccount: 'p', blockMs: 1000 });
  const members = new Set<string>();
  await admitPaid(l, { isMember: async (_g, a) => members.has(a), add: async (_g, a) => { members.add(a); }, revoke: async () => {} }, 2000);
  await l.close();
  const l2 = await L.openLedger(p);
  const r = await l2.get('ih1');
  ok('M1 verifyPayment\'s used-intent store and the admission survive a restart (paid → admitted, on disk)',
    r?.state === 'admitted' && r?.admittedAtMs === 2000 && await paymentRecorder(l2, listing).has('ih1'), r);
  await l2.close();
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log('failed:'); for (const r of failed) console.log(`  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`); process.exit(1); }