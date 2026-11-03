// state-dir.test.ts: harness for src/adapters/state-dir.ts (the seller service's StateStore in one directory).
// Real files in a fresh temporary directory per case; failures injected through a wrapped fs/promises.
//
//   npx tsx test/state-dir.test.ts
//   STATE_MODULE=<path> npx tsx test/state-dir.test.ts     (the mutation script)
import { promises as fsp, mkdtempSync, rmSync, statSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const modPath = process.env.STATE_MODULE ? resolve(process.env.STATE_MODULE) : resolve(here, '../src/adapters/state-dir.ts');
const D = await import(pathToFileURL(modPath).href);

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
const fresh = () => { const d = mkdtempSync(join(tmpdir(), 'state-')); dirs.push(d); return join(d, 'seller'); };
const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const listing = (n: number) => { const json = JSON.stringify({ v: 1, n }); return { id: sha(json), json }; };
const NS1 = '1762160000000000000';

// ── layout ──────────────────────────────────────────────────────────────────────────────────
{
  const root = fresh();
  const s = await D.openStateDir(root);
  ok('S1 opening creates the directory and listings/ (0700); a fresh state has no sinceNs and no listings',
    s.path === root && mode(root) === '700' && mode(join(root, 'listings')) === '700' && (await s.getSinceNs()) === null &&
    (await s.loadListings()).length === 0, { root: mode(root) });
}

// ── sinceNs ─────────────────────────────────────────────────────────────────────────────────
{
  const root = fresh();
  const s = await D.openStateDir(root);
  await s.setSinceNs(NS1);
  ok('N1 sinceNs is saved (0600, one line) and read back by a reopened state',
    (await (await D.openStateDir(root)).getSinceNs()) === NS1 && readFileSync(join(root, 'since-ns'), 'utf8') === `${NS1}\n` &&
    mode(join(root, 'since-ns')) === '600');
  ok('N2 setting the same value again is a no-op', (await thrown(() => s.setSinceNs(NS1))) === 'no error' && (await s.getSinceNs()) === NS1);
  ok('N3 changing it is refused, and it stays', (await thrown(() => s.setSinceNs('1762160000000000001'))) ===
    `StateError: state: sinceNs is already ${NS1}; refusing to change it` && (await s.getSinceNs()) === NS1);
  const bad = await Promise.all(['', '1.5', '01', 'abc', 17 as Json].map((v) => thrown(() => D.openStateDir(fresh()).then((x: Json) => x.setSinceNs(v)))));
  ok('N4 a value that is not a ns decimal string is refused', bad.every((m) => m === 'StateError: state: sinceNs must be a ns decimal string'), bad);
  const fails = [];
  for (const text of ['', 'abc\n', '1.5\n', `${NS1}\n\n`, ` ${NS1}`, '01\n']) {
    const r = fresh(); const t = await D.openStateDir(r);
    writeFileSync(join(r, 'since-ns'), text);
    const m = await thrown(() => t.getSinceNs());
    if (m !== `StateError: state: ${join(r, 'since-ns')} does not hold a ns time (refusing to treat it as empty)`) fails.push(`${JSON.stringify(text)}: ${m}`);
    const m2 = await thrown(() => t.setSinceNs(NS1));
    if (!m2.includes('does not hold a ns time')) fails.push(`set over ${JSON.stringify(text)}: ${m2}`);
  }
  const r = fresh(); const t = await D.openStateDir(r);
  writeFileSync(join(r, 'since-ns'), NS1);
  ok('N5 a damaged since-ns is refused on read and on set (6 cases); one without the final newline is read', fails.length === 0 && (await t.getSinceNs()) === NS1, fails);
}
{
  const root = fresh();
  const failing = { ...fsp, rename: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } };
  const s = await D.openStateDir(root, { fsp: failing as Json });
  const m = await thrown(() => s.setSinceNs(NS1));
  ok('N6 a failed write leaves no since-ns and no temp file', m === 'Error: disk full' && !existsSync(join(root, 'since-ns')) &&
    readdirSync(root).sort().join() === 'listings', readdirSync(root));
  const order: string[] = [];
  const watched = { ...fsp,
    open: async (...a: Json[]) => { const h = await (fsp.open as Json)(...a); const sync = h.sync.bind(h); h.sync = async () => { order.push('sync'); return sync(); }; return h; },
    rename: async (a: string, b: string) => { order.push('rename'); return fsp.rename(a, b); },
    link: async (a: string, b: string) => { order.push('link'); return fsp.link(a, b); } };
  const w = await D.openStateDir(root, { fsp: watched as Json });
  await w.setSinceNs(NS1);
  await w.saveListing(listing(1).id, listing(1).json);
  ok('N7 sinceNs and listings are fsynced before they take their name', order.join() === 'sync,rename,sync,link', order);
  const e = await thrown(() => D.openStateDir(fresh(), { fsp: { ...fsp, readFile: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } } as Json })
    .then((x: Json) => x.getSinceNs()));
  ok('N8 a read error other than "no file" is thrown, never read as no journal', e === 'Error: denied', e);
}

// ── listings ────────────────────────────────────────────────────────────────────────────────
{
  const root = fresh();
  const s = await D.openStateDir(root);
  const a = listing(1); const b = listing(2);
  await s.saveListing(a.id, a.json); await s.saveListing(b.id, b.json);
  const loaded = await (await D.openStateDir(root)).loadListings();
  ok('L1 listings are saved under their id (0600) and loaded back by a reopened state',
    loaded.length === 2 && loaded.every((l: Json) => sha(l.json) === l.id) && new Set(loaded.map((l: Json) => l.id)).size === 2 &&
    mode(join(root, 'listings', `${a.id}.json`)) === '600' && readdirSync(join(root, 'listings')).length === 2, loaded.map((l: Json) => l.id));
  ok('L2 saving the same listing again is a no-op', (await thrown(() => s.saveListing(a.id, a.json))) === 'no error' &&
    readdirSync(join(root, 'listings')).length === 2);
  ok('L3 content that does not hash to its id is refused, nothing written',
    (await thrown(() => s.saveListing(a.id, b.json))) === `StateError: state: listing ${a.id.slice(0, 12)}: its content does not hash to its id` &&
    readdirSync(join(root, 'listings')).length === 2);
  const badIds = await Promise.all(['', 'AB'.repeat(32), 'ab'.repeat(31), '../x'].map((id) => thrown(() => s.saveListing(id, a.json))));
  ok('L4 an id that is not 64 lowercase hex is refused', badIds.every((m) => m === 'StateError: state: a listing id must be 64 lowercase hex'), badIds);
  writeFileSync(join(root, 'listings', `${a.id}.json`), 'tampered');
  ok('L5 an existing file under the id with other content is never overwritten: refused',
    (await thrown(() => s.saveListing(a.id, a.json))) === `StateError: state: ${join(root, 'listings', `${a.id}.json`)} already holds other content` &&
    readFileSync(join(root, 'listings', `${a.id}.json`), 'utf8') === 'tampered');
  writeFileSync(join(root, 'listings', '.x.json.1.ab.tmp'), 'temp');
  ok('L6 a leftover temp file is skipped at load', (await s.loadListings()).length === 2);
  writeFileSync(join(root, 'listings', 'notes.txt'), 'x');
  ok('L7 any other file in listings/ is refused at load',
    (await thrown(() => s.loadListings())) === `StateError: state: unexpected file ${join(root, 'listings', 'notes.txt')}`);
}
{
  const root = fresh();
  const failing = { ...fsp, link: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } };
  const s = await D.openStateDir(root, { fsp: failing as Json });
  const a = listing(3);
  ok('L8 a failed save leaves no listing and no temp file', (await thrown(() => s.saveListing(a.id, a.json))) === 'Error: disk full' &&
    readdirSync(join(root, 'listings')).length === 0);
  const ok2 = await D.openStateDir(root);
  await ok2.saveListing(a.id, a.json);
  ok('L9 a successful save leaves no temp file', readdirSync(join(root, 'listings')).join() === `${a.id}.json`);
}

// ── events, ordering ────────────────────────────────────────────────────────────────────────
{
  const root = fresh();
  const s = await D.openStateDir(root);
  await Promise.all(Array.from({ length: 20 }, (_, i) => s.appendEvent({ at: i, kind: 'k' })));
  const lines = readFileSync(join(root, 'events.jsonl'), 'utf8').split('\n');
  ok('E1 events are appended one JSON object per line, in the order called (20 at once), 0600',
    lines.length === 21 && lines[20] === '' && lines.slice(0, 20).every((l, i) => JSON.parse(l).at === i) && mode(join(root, 'events.jsonl')) === '600',
    lines.slice(0, 3));
  await (await D.openStateDir(root)).appendEvent({ at: 99, kind: 'later' });
  ok('E2 a reopened state appends after the existing events', readFileSync(join(root, 'events.jsonl'), 'utf8').split('\n').length === 22);
  const out = await Promise.all([s.setSinceNs(NS1), s.getSinceNs(), s.saveListing(listing(5).id, listing(5).json), s.loadListings()]);
  ok('E3 calls are serialised in the order made', out[1] === NS1 && out[3].length === 1, { since: out[1], n: out[3]?.length });
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log('failed:'); for (const r of failed) console.log(`  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`); process.exit(1); }