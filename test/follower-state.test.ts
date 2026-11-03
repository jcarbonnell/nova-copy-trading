// follower-state.test.ts: harness for src/adapters/follower-state.ts (the follower's state, incl. its payment record).
// Real files in a fresh temporary directory per case; failures injected through a wrapped fs/promises. The last
// check runs the follower service's pay() over it across a "crash".
//
//   npx tsx test/follower-state.test.ts
//   FSTATE_MODULE=<path> npx tsx test/follower-state.test.ts     (the mutation script)
import { promises as fsp, mkdtempSync, rmSync, statSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const modPath = process.env.FSTATE_MODULE ? resolve(process.env.FSTATE_MODULE) : resolve(here, '../src/adapters/follower-state.ts');
const S = await import(pathToFileURL(modPath).href);
const { createFollowerService } = await import(pathToFileURL(resolve(here, '../src/follower/follower-service.ts')).href);

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
const fresh = () => { const d = mkdtempSync(join(tmpdir(), 'fstate-')); dirs.push(d); return join(d, 'follower'); };
const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);
const L = 'ab'.repeat(32);
const T = (n: number) => n.toString(16).padStart(64, '0');
const claim = { intentHash: 'B2btEHKa3W2DcSo51dYoEAMghbmHqEUKg78BwSPK3UbY', payer: 'p.near', windowFromMs: 1, windowToMs: 2 };
const p0 = { listingId: L, idempotencyKey: 'key-1' };
const p1 = { ...p0, correlationId: 'corr-1' };
const p2 = { ...p1, claim };

// ── payment ─────────────────────────────────────────────────────────────────────────────────
{
  const root = fresh();
  const s = await S.openFollowerState(root);
  ok('F1 a fresh state has no payment and no copies; the directory is 0700, the lock holds this pid',
    (await s.getPayment()) === null && (await s.copies()).length === 0 && mode(root) === '700' && readFileSync(join(root, 'lock'), 'utf8') === String(process.pid));
  await s.setPayment(p0); await s.setPayment(p1); await s.setPayment(p2);
  await s.close();
  const s2 = await S.openFollowerState(root);
  const doc = JSON.parse(readFileSync(join(root, 'payment.json'), 'utf8'));
  ok('F2 a payment moves forward (key → correlation id → claim) and survives a reopen; the file is { v: 1, payment }, 0600',
    JSON.stringify(await s2.getPayment()) === JSON.stringify(p2) && doc.v === 1 && mode(join(root, 'payment.json')) === '600');
  ok('F3 saving the same record again is fine', (await thrown(() => s2.setPayment(p2))) === 'no error');
  const refusals = await Promise.all([
    thrown(() => s2.setPayment({ ...p2, idempotencyKey: 'key-2' })),
    thrown(() => s2.setPayment({ ...p2, listingId: 'cd'.repeat(32) })),
    thrown(() => s2.setPayment({ ...p2, correlationId: 'corr-2' })),
    thrown(() => s2.setPayment({ ...p2, claim: { ...claim, intentHash: 'other' } })),
    thrown(() => s2.setPayment(p1)),
    thrown(() => s2.setPayment(null)),
  ]);
  ok('F4 once saved, the key and listing never change, nor the correlation id or the claim once set; a sent payment is never cleared',
    JSON.stringify(refusals) === JSON.stringify([
      "FollowerStateError: follower state: the payment's listing and key cannot change",
      "FollowerStateError: follower state: the payment's listing and key cannot change",
      "FollowerStateError: follower state: the payment's correlation id cannot change",
      "FollowerStateError: follower state: the payment's claim cannot change",
      "FollowerStateError: follower state: the payment's claim cannot change",
      'FollowerStateError: follower state: a payment that may have been sent cannot be cleared']) &&
    JSON.stringify(await s2.getPayment()) === JSON.stringify(p2), refusals);
  await s2.close();
}
{
  const root = fresh();
  const s = await S.openFollowerState(root);
  await s.setPayment(p0);
  await s.setPayment(null);
  ok('F5 a payment not yet sent (no correlation id) can be cleared, then a new one saved', (await s.getPayment()) === null && !existsSync(join(root, 'payment.json')) &&
    (await thrown(() => s.setPayment({ ...p0, idempotencyKey: 'key-2' }))) === 'no error' && (await thrown(() => s.setPayment(null))) === 'no error' &&
    (await thrown(() => s.setPayment(null))) === 'no error');
  await s.close();
}
{
  const root = fresh();
  const s = await S.openFollowerState(root);
  const bad: [string, Json, string][] = [
    ['null-like', 'x', 'is not an object'],
    ['an extra field', { ...p0, amount: '1' }, 'has an unexpected field amount'],
    ['a bad listing id', { ...p0, listingId: 'AB' }, 'has no listingId'],
    ['no key', { listingId: L }, 'has no idempotencyKey'],
    ['an empty correlation id', { ...p0, correlationId: '' }, 'has an empty correlationId'],
    ['a claim before a correlation id', { ...p0, claim }, 'has a claim without a correlationId'],
    ['a claim without a window', { ...p1, claim: { ...claim, windowToMs: undefined } }, 'has a malformed claim'],
    ['a claim with an extra field', { ...p1, claim: { ...claim, x: 1 } }, 'has a malformed claim'],
    ['a claim without an intent hash', { ...p1, claim: { ...claim, intentHash: '' } }, 'has a malformed claim'],
  ];
  const fails = [];
  for (const [what, p, want] of bad) {
    const m = await thrown(() => s.setPayment(p));
    if (m !== `FollowerStateError: follower state: refusing to save a payment that ${want}`) fails.push(`${what}: ${m}`);
  }
  ok(`F6 a malformed payment is refused before anything is written (${bad.length} cases)`, fails.length === 0 && !existsSync(join(root, 'payment.json')), fails);
  const pp = join(root, 'payment.json');
  const damaged: [string, string, string][] = [
    ['not JSON', '{"v":1', `${pp} is not valid JSON (refusing to treat it as no payment)`],
    ['empty', '', `${pp} is not valid JSON (refusing to treat it as no payment)`],
    ['another version', JSON.stringify({ v: 2, payment: p0 }), `${pp} has version 2, expected 1`],
    ['no payment', JSON.stringify({ v: 1 }), `${pp}: the payment is not an object`],
    ['a bad record', JSON.stringify({ v: 1, payment: { ...p0, idempotencyKey: '' } }), `${pp}: the payment has no idempotencyKey`],
  ];
  const fails2 = [];
  for (const [what, text, want] of damaged) {
    writeFileSync(pp, text);
    const m = await thrown(() => s.getPayment());
    const m2 = await thrown(() => s.setPayment(p0));
    if (m !== `FollowerStateError: follower state: ${want}` || m2 !== m) fails2.push(`${what}: ${m} / ${m2}`);
  }
  ok(`F7 a damaged payment file is refused on read and on write, never read as no payment (${damaged.length} cases)`, fails2.length === 0, fails2);
  await s.close();
}

// ── atomic writes ───────────────────────────────────────────────────────────────────────────
{
  const root = fresh();
  const s = await S.openFollowerState(root);
  await s.setPayment(p0);
  await s.close();
  const before = readFileSync(join(root, 'payment.json'));
  const failing = { ...fsp, rename: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } };
  const f = await S.openFollowerState(root, { fsp: failing as Json });
  const m = await thrown(() => f.setPayment(p1));
  ok('W1 a failed write leaves the old record byte for byte and no temp file', m === 'Error: disk full' && Buffer.compare(before, readFileSync(join(root, 'payment.json'))) === 0 &&
    readdirSync(root).sort().join() === 'lock,payment.json', readdirSync(root));
  await f.close();
  const order: string[] = [];
  const watched = { ...fsp,
    open: async (...a: Json[]) => { const h = await (fsp.open as Json)(...a); const sync = h.sync.bind(h); h.sync = async () => { order.push('sync'); return sync(); }; return h; },
    rename: async (a: string, b: string) => { order.push('rename'); return fsp.rename(a, b); } };
  const w = await S.openFollowerState(root, { fsp: watched as Json });
  await w.setPayment(p1);
  ok('W2 each payment write is fsynced before it replaces the record', order.join() === 'sync,rename' && (await w.getPayment()).correlationId === 'corr-1', order);
  const denied = { ...fsp, readFile: async (p: string, ...r: Json[]) => { if (String(p).endsWith('payment.json')) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return (fsp.readFile as Json)(p, ...r); } };
  await w.close();
  const d = await S.openFollowerState(root, { fsp: denied as Json });
  ok('W3 a read error other than "no file" is thrown, never read as no payment', (await thrown(() => d.getPayment())) === 'Error: denied');
  await d.close();
  const r2 = fresh();
  const u0 = await S.openFollowerState(r2); await u0.setPayment(p0); await u0.close();
  const ro = { ...fsp, unlink: async (p: string) => { if (String(p).endsWith('payment.json')) throw Object.assign(new Error('read-only'), { code: 'EROFS' }); return fsp.unlink(p); } };
  const u = await S.openFollowerState(r2, { fsp: ro as Json });
  ok('W4 a clear that cannot remove the record is thrown, and the record stays', (await thrown(() => u.setPayment(null))) === 'Error: read-only' &&
    (await u.getPayment())?.idempotencyKey === 'key-1');
  await u.close();
}

// ── lock ────────────────────────────────────────────────────────────────────────────────────
{
  const root = fresh();
  const s = await S.openFollowerState(root);
  const m = await thrown(() => S.openFollowerState(root));
  ok('K1 a second follower on the same state is refused while the first holds it', m === `FollowerStateError: follower state: ${resolve(root)} is held by pid ${process.pid}`, m);
  await s.close();
  ok('K2 after close it opens again, and a closed state refuses every call', (await thrown(() => s.getPayment())) === 'FollowerStateError: follower state: closed' &&
    (await thrown(async () => (await S.openFollowerState(root)).close())) === 'no error');
  writeFileSync(join(root, 'lock'), '999999');
  const t = await S.openFollowerState(root, { isAlive: () => false });
  ok('K3 a lock left by a follower that is no longer running is taken over', readFileSync(join(root, 'lock'), 'utf8') === String(process.pid));
  await t.close();
  writeFileSync(join(root, 'lock'), '424242');
  const m2 = await thrown(() => S.openFollowerState(root, { isAlive: (pid: number) => pid === 424242 }));
  ok('K4 a lock held by another running pid is respected', m2.endsWith('is held by pid 424242') && readFileSync(join(root, 'lock'), 'utf8') === '424242', m2);
}

// ── copies and events ───────────────────────────────────────────────────────────────────────
{
  const root = fresh();
  const s = await S.openFollowerState(root);
  await s.addCopy({ transId: T(1), outcome: 'copied', side: 'buy', amount: '50000', amountOut: '2' });
  await s.addCopy({ transId: T(2), outcome: 'refused', side: 'buy', amount: '180000', codes: ['policy_x'] });
  await s.close();
  const s2 = await S.openFollowerState(root);
  const got = await s2.copies();
  ok('C1 copies are appended one per line (0600) and read back by a reopened state', got.length === 2 && got[1].codes[0] === 'policy_x' &&
    mode(join(root, 'copies.jsonl')) === '600', got);
  ok('C2 an entry is recorded once', (await thrown(() => s2.addCopy({ transId: T(1), outcome: 'skipped' }))) ===
    `FollowerStateError: follower state: entry ${T(1).slice(0, 12)} is already recorded` && (await s2.copies()).length === 2);
  const bad = await Promise.all([thrown(() => s2.addCopy({ transId: 'x', outcome: 'copied' })), thrown(() => s2.addCopy({ transId: T(3), outcome: 'maybe' }))]);
  ok('C3 a malformed copy is refused', JSON.stringify(bad) === JSON.stringify(['FollowerStateError: follower state: refusing to record a copy that has no transId',
    'FollowerStateError: follower state: refusing to record a copy that has no outcome']), bad);
  const cp = join(root, 'copies.jsonl');
  const good = readFileSync(cp, 'utf8');
  const cases: [string, string, string][] = [
    ['an unfinished line', good + '{"transId"', `${cp} ends with an unfinished line`],
    ['a line that is not JSON', good + 'nope\n', `${cp} line 3 is not JSON`],
    ['a bad record', good + JSON.stringify({ transId: T(9) }) + '\n', `${cp} line 3 has no outcome`],
  ];
  const fails = [];
  for (const [what, text, want] of cases) {
    writeFileSync(cp, text);
    const m = await thrown(() => s2.copies());
    if (m !== `FollowerStateError: follower state: ${want}`) fails.push(`${what}: ${m}`);
  }
  ok('C4 a damaged copies file is refused (3 cases)', fails.length === 0, fails);
  writeFileSync(cp, good);
  await Promise.all(Array.from({ length: 10 }, (_, i) => s2.appendEvent({ at: i, kind: 'k' })));
  const lines = readFileSync(join(root, 'events.jsonl'), 'utf8').split('\n');
  const race = await Promise.all([s2.addCopy({ transId: T(7), outcome: 'skipped' }), s2.addCopy({ transId: T(7), outcome: 'skipped' })].map((p) => p.then(() => 'ok', (e: Error) => e.message)));
  ok('C6 two records for one entry sent at once: one is kept, the other refused (calls are serialised)',
    race.filter((r) => r === 'ok').length === 1 && (await s2.copies()).filter((c: Json) => c.transId === T(7)).length === 1, race);
  ok('C5 events are appended one per line, in order, 0600', lines.length === 11 && lines.slice(0, 10).every((l, i) => JSON.parse(l).at === i) &&
    mode(join(root, 'events.jsonl')) === '600');
  await s2.close();
}

// ── the bought feed (option A) ──────────────────────────────────────────────────────────────
{
  const root = fresh();
  const s = await S.openFollowerState(root);
  const entry = (n: number) => ({ v: 1, simulated: true, ts: new Date(1_762_000_000_000 + n * 1000).toISOString(), pair: 'NEAR/USDC', side: 'buy',
    size: '0.01', price: '3.9', reasoning: `reason ${n}`, correlation_id: null, salt: 'ab'.repeat(32) });
  const fe = (n: number) => ({ transId: T(n), recordNs: String(1_762_000_000_000_000_000 + n), entry: entry(n) });
  ok('B1 a fresh state has an empty feed', (await s.feed()).length === 0);
  await s.addFeed([fe(1), fe(2)]);
  await s.addFeed([fe(2), fe(3), fe(3)]);
  await s.close();
  const s2 = await S.openFollowerState(root);
  const got = await s2.feed();
  ok('B2 bought entries are kept in order, each once, 0600, and read back by a reopened state',
    got.map((f: Json) => f.transId).join() === [T(1), T(2), T(3)].join() && got[2].entry.reasoning === 'reason 3' &&
    mode(join(root, 'feed.jsonl')) === '600' && readFileSync(join(root, 'feed.jsonl'), 'utf8').split('\n').length === 4, got.map((f: Json) => f.transId.slice(-2)));
  const bad: [string, Json, string][] = [
    ['an extra field', { ...fe(4), note: 'x' }, 'must hold exactly transId, recordNs and entry'],
    ['a bad trans id', { ...fe(4), transId: 'x' }, 'has no transId'],
    ['a bad record time', { ...fe(4), recordNs: '1.5' }, 'has no recordNs'],
    ['an invalid entry', { ...fe(4), entry: { ...entry(4), side: 'hold' } }, 'holds an invalid entry (entry: side must be buy or sell)'],
  ];
  const fails = [];
  for (const [what, f, want] of bad) {
    const m = await thrown(() => s2.addFeed([fe(5), f]));
    if (m !== `FollowerStateError: follower state: refusing to keep a feed entry that ${want}`) fails.push(`${what}: ${m}`);
  }
  ok(`B3 a malformed feed entry is refused, and nothing of that batch is kept (${bad.length} cases)`, fails.length === 0 && (await s2.feed()).length === 3, fails);
  const fp = join(root, 'feed.jsonl');
  const good = readFileSync(fp, 'utf8');
  const damaged: [string, string, string][] = [
    ['an unfinished line', good + '{"transId"', `${fp} ends with an unfinished line`],
    ['a line that is not JSON', good + 'nope\n', `${fp} line 4 is not JSON`],
    ['a tampered entry', good + JSON.stringify({ ...fe(6), entry: { ...entry(6), price: '-1' } }) + '\n', `${fp} line 4 holds an invalid entry (entry: price must be a positive decimal string)`],
  ];
  const fails2 = [];
  for (const [what, text, want] of damaged) {
    writeFileSync(fp, text);
    const m = await thrown(() => s2.feed());
    if (m !== `FollowerStateError: follower state: ${want}`) fails2.push(`${what}: ${m}`);
  }
  ok('B4 a damaged feed file is refused (3 cases)', fails2.length === 0, fails2);
  writeFileSync(fp, good);
  await s2.close();
  const denied = { ...fsp, readFile: async (p: string, ...r: Json[]) => { if (String(p).endsWith('feed.jsonl')) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return (fsp.readFile as Json)(p, ...r); } };
  const s3 = await S.openFollowerState(root, { fsp: denied as Json });
  ok('B5 a feed read error other than "no file" is thrown, never read as an empty feed', (await thrown(() => s3.feed())) === 'Error: denied');
  await s3.close();
}

// ── with the follower service: a crash after the key was saved ────────────────────────────────
{
  const root = fresh();
  const sent: string[] = [];
  const agent = (fail: boolean) => ({
    previewWithdraw: async () => ({ dry: true, warnings: [] }),
    withdraw: async (_r: Json, key: string) => { sent.push(key); if (fail) throw new Error('socket hang up'); return { correlation_id: 'corr-1', status: 'SUCCESS',
      dispatch_committed_at: '2026-11-09T10:00:00.000Z', updated_at: '2026-11-09T10:00:05.000Z', details: { intent_hash: 'IH', near_account_id: 'p.near' } }; },
    status: async () => { throw new Error('not reached'); }, quoteSwap: async () => ({}),
  });
  let n = 0;
  const svc = (state: Json, fail: boolean) => createFollowerService({ seller: {} as Json, agent: agent(fail), reader: {} as Json, isMember: async () => false,
    decider: {} as Json, state, newKey: () => `key-${++n}` }, { approvedId: L, maxPrice: '1', memo: 'm' });
  const listing = { proceedsAccount: '1000fans.near', price: '100000' };
  const s1 = await S.openFollowerState(root);
  const e = await thrown(() => svc(s1, true).pay(listing as Json));
  await s1.close();
  const s2 = await S.openFollowerState(root);
  const c = await svc(s2, false).pay(listing as Json);
  const s3p = await s2.getPayment();
  await s2.close();
  ok('I1 with the follower service: after a crash mid-send, a restarted follower replays the same key (one payment), and the claim is kept',
    e === 'Error: socket hang up' && JSON.stringify(sent) === '["key-1","key-1"]' && n === 1 && c.intentHash === 'IH' && s3p.claim.intentHash === 'IH', { sent, e });
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log('failed:'); for (const r of failed) console.log(`  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`); process.exit(1); }
