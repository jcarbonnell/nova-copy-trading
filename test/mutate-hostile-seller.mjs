// mutate-hostile-seller.mjs: every mutant of src/demo/hostile-seller.ts must be caught by the harness.
// Same scheme as mutate-live-feed.mjs: one anchored string replacement per mutant, written to a temporary
// directory as .mts (so its top-level await runs as ESM), run through test/hostile-seller.test.ts with
// HOSTILE_MODULE pointing at it. The module's runtime import of ../core/listing.ts is pointed at the real file.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const MODULE = join(root, 'src/demo/hostile-seller.ts');
const HARNESS = join(root, 'test/hostile-seller.test.ts');
const TSX = join(root, 'node_modules/.bin/tsx');
const src = readFileSync(MODULE, 'utf8');
const relocated = src.replace(/from '\.\.\/core\/([a-z-]+\.ts)'/g, (_, f) => `from '${pathToFileURL(join(root, 'src/core', f)).href}'`);
if (/from '\.\.?\//.test(relocated)) { console.error('a relative import was not relocated'); process.exit(1); }

/** [id, what it breaks, anchor, replacement] */
const MUTANTS = [
  ['X1', 'another default account', "export const HOSTILE_PROCEEDS = 'listing-99.near';", "export const HOSTILE_PROCEEDS = '1000fans.near';"],
  ['X2', 'the real listing unchecked', '  const l = checkListing(real);\n', '  const l = real as Listing;\n'],
  ['X3', 'the same account accepted', "if (l.proceedsAccount === proceedsAccount) throw", 'if (false) throw'],
  ['X4', 'the id not recomputed', 'return { id: listingId(listing), listing,', 'return { id: listingId(l), listing,'],
  ['X5', 'more than the account changed', 'const listing: Listing = { ...l, proceedsAccount };', "const listing: Listing = { ...l, proceedsAccount, price: '1' };"],
  ['X6', 'any host accepted', "if (!host || !hosts.has(host)) return json(403", 'if (false) return json(403'],
  ['X7', 'a claim taken', "json(403, { error: 'this stub never takes a claim' })", "json(200, { state: 'admitted' })"],
  ['X8', 'any method served', "return method === 'GET' ? json(200, { id: h.id, listing: h.listing }) : json(405", "return true ? json(200, { id: h.id, listing: h.listing }) : json(405"],
  ['X9', 'any listing id served', "if (p === '/listing' || p === `/listings/${h.id}`)", "if (p === '/listing' || p.startsWith('/listings/'))"],
  ['X10', 'cacheable replies', "'cache-control': 'no-store'", "'cache-control': 'max-age=60'"],
  ['X11', 'listening on every interface', "server.listen(port, '127.0.0.1', () => ok())", 'server.listen(port, () => ok())'],
];


const run = (modulePath) => spawnSync(TSX, [HARNESS], {
  cwd: root, encoding: 'utf8', timeout: 60_000, env: { ...process.env, HOSTILE_MODULE: modulePath },
});

const dir = mkdtempSync(join(tmpdir(), 'hostile-mutants-'));
let caught = 0;
const survived = [];
try {
  const baseFile = join(dir, 'baseline.mts');
  writeFileSync(baseFile, relocated);
  const base = run(baseFile);
  if (base.status !== 0) { console.error('baseline harness fails on the relocated module:\n' + base.stdout + base.stderr); process.exit(1); }
  for (const [id, what, anchor, repl] of MUTANTS) {
    const n = relocated.split(anchor).length - 1;
    if (n !== 1) { console.error(`${id} anchor occurs ${n} times, expected 1: ${anchor}`); process.exit(1); }
    const file = join(dir, `mutant-${id}.mts`);
    writeFileSync(file, relocated.replace(anchor, () => repl));
    const r = run(file);
    if (r.status !== 0) { caught++; console.log(`✓ ${id} caught: ${what}`); }
    else { survived.push(id); console.log(`✗ ${id} SURVIVED: ${what}`); }
  }
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log(`\n${caught}/${MUTANTS.length} mutants caught`);
if (survived.length) { console.log('survived: ' + survived.join(', ')); process.exit(1); }
