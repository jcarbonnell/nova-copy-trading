// mutate-live-feed.mjs: every mutant of src/core/live-feed.ts must be caught by the harness.
// Same scheme as mutate-verify-feed.mjs: one anchored string replacement per mutant, written to a temporary
// directory, run through test/live-feed.test.ts with LIVE_MODULE pointing at it. The module's imports of
// sibling modules are pointed at the real files; the harness checks refusals against the module's own
// re-exported FeedRefused.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const MODULE = join(root, 'src/core/live-feed.ts');
const HARNESS = join(root, 'test/live-feed.test.ts');
const TSX = join(root, 'node_modules/.bin/tsx');
const src = readFileSync(MODULE, 'utf8');
const relocated = src.replace(/from '\.\/([a-z-]+\.ts)'/g, (_, f) => `from '${pathToFileURL(join(root, 'src/core', f)).href}'`);
if (relocated.includes("from './")) { console.error('a relative import was not relocated'); process.exit(1); }

/** [id, what it breaks, anchor, replacement] */
const MUTANTS = [
  ['E1', 'runs without verified entries', `if (known.length === 0) refuse`, `if (false) refuse`],
  ['E2', 'a vanished last entry accepted', `if (at < 0) refuse`, `if (false) refuse`],
  ['E3', 'new records read from the start of the group', `const tail = rows.slice(at + 1);`, `const tail = rows.slice(Math.max(at, 0));`],
  ['E4', 'a record without upload time at the tail accepted', `if (typeof r.timestamp !== 'string') refuse`, `if (false) refuse`],
  ['E5', 'records dated before the last known one accepted', `if (BigInt(r.timestamp as string) < prev) refuse`, `if (false) refuse`],
  ['E6', 'journal record rules skipped', `as('live: ', () => computeFingerprint(tail,`, `(() => 0)(tail,`],
  ['E7', 'content hash not checked', `if (entryFileHash(bytes) !== r.file_hash) refuse`, `if (false) refuse`],
  ['E8', 'entries not decoded strictly', `const entry = as(\`live: entry \${id}: \`, () => decodeEntry(bytes));`, `const entry = JSON.parse(new TextDecoder().decode(bytes));`],
  ['E9', 'retrieved from the wrong location', `await reader.retrieve(groupId, r.ipfs_hash);`, `await reader.retrieve(groupId, r.trans_id);`],
  ['E10', 'P&L rules applied to new entries only', `const all = [...known, ...entries];`, `const all = entries.length ? entries : known;`],
  ['E11', 'P&L rules skipped', `as('live: ', () => recomputeCurve(all, listing.curve.quote, listing.curve.simulated, [atNs]));`,
    `[{ realised: '0.000000' }];`],
  ['E12', 'the curve’s simulated flag ignored', `listing.curve.quote, listing.curve.simulated, [atNs]`, `listing.curve.quote, true, [atNs]`],
  ['E13', 'record time taken from the entry', `entries.push({ transId: r.trans_id, recordNs: r.timestamp as string, entry });`,
    `entries.push({ transId: r.trans_id, recordNs: (BigInt(Date.parse(entry.ts)) * 1_000_000n).toString(), entry });`],
  ['E14', 'unexpected errors turned into verdicts', `    throw e;\n  }\n}`, `    return refuse(String(e));\n  }\n}`],
];

const run = (modulePath) => spawnSync(TSX, [HARNESS], {
  cwd: root, encoding: 'utf8', timeout: 60_000, env: { ...process.env, LIVE_MODULE: modulePath },
});

const dir = mkdtempSync(join(tmpdir(), 'live-mutants-'));
let caught = 0;
const survived = [];
try {
  const baseFile = join(dir, 'baseline.ts');
  writeFileSync(baseFile, relocated);
  const base = run(baseFile);
  if (base.status !== 0) { console.error('baseline harness fails:\n' + base.stdout + base.stderr); process.exit(1); }

  for (const [id, what, anchor, repl] of MUTANTS) {
    const n = relocated.split(anchor).length - 1;
    if (n !== 1) { console.error(`${id} anchor occurs ${n} times, expected 1: ${anchor}`); process.exit(1); }
    const file = join(dir, `mutant-${id}.ts`);
    writeFileSync(file, relocated.replace(anchor, () => repl));
    const r = run(file);
    if (r.status !== 0) { caught++; console.log(`✓ ${id} caught: ${what}`); }
    else { survived.push(id); console.log(`✗ ${id} SURVIVED: ${what}`); }
  }
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log(`\n${caught}/${MUTANTS.length} mutants caught`);
if (survived.length) { console.log('survived: ' + survived.join(', ')); process.exit(1); }