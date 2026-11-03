// mutate-verify-feed.mjs: every mutant of src/core/verify-feed.ts must be caught by the harness.
// Same scheme as mutate-listing.mjs: one anchored string replacement per mutant, written to a temporary
// directory, run through test/verify-feed.test.ts with FEED_MODULE pointing at it. The module's imports of
// sibling modules (./journal.ts, ./pnl.ts, ./listing.ts) are pointed at the real files, so the harness and
// the mutant share one copy of each refusal class.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const MODULE = join(root, 'src/core/verify-feed.ts');
const HARNESS = join(root, 'test/verify-feed.test.ts');
const TSX = join(root, 'node_modules/.bin/tsx');
const src = readFileSync(MODULE, 'utf8');
const relocated = src.replace(/from '\.\/([a-z-]+\.ts)'/g, (_, f) => `from '${pathToFileURL(join(root, 'src/core', f)).href}'`);
if (relocated.includes("from './")) { console.error('a relative import was not relocated'); process.exit(1); }

/** [id, what it breaks, anchor, replacement] */
const MUTANTS = [
  ['F1', 'listing not checked first', `as('feed: ', () => checkListing(listing));`, ``],
  ['F2', 'fingerprint count not compared', `if (fp.count !== listing.fingerprint.count) refuse`, `if (false) refuse`],
  ['F3', 'fingerprint root not compared', `if (fp.root !== listing.fingerprint.root) refuse`, `if (false) refuse`],
  ['F4', 'fingerprint over another range', `asOfNs: range.asOfNs }));`, `asOfNs: listing.curve.points[0].atNs }));`],
  ['F5', 'content hash not checked', `if (entryFileHash(bytes) !== row.file_hash) refuse`, `if (false) refuse`],
  ['F6', 'entries not decoded strictly', `const entry = as(\`feed: entry \${id}: \`, () => decodeEntry(bytes));`,
    `const entry = JSON.parse(new TextDecoder().decode(bytes));`],
  ['F7', 'curve not checked', `const curve = as('feed: ', () => checkClaimedCurve(entries, listing.curve));`, `const curve = listing.curve.points;`],
  ['F8', 'every record retrieved, not only the covered ones', `for (const transId of fp.transIds) {`, `for (const transId of rows.map((r) => r.trans_id)) {`],
  ['F9', 'retrieved from the wrong location', `await reader.retrieve(groupId, row.ipfs_hash);`, `await reader.retrieve(groupId, row.trans_id);`],
  ['F10', 'record time from the entry, not the chain', `recordNs: row.timestamp as string, entry });`, `recordNs: (BigInt(Date.parse(entry.ts)) * 1_000_000n).toString(), entry });`],
  ['F11', 'unexpected errors inside a check turned into verdicts', `    throw e;\n  }\n}`, `    return refuse(String(e));\n  }\n}`],
  ['F12', 'refusals of other modules not wrapped', `if (e instanceof JournalRefused || e instanceof PnlRefused || e instanceof ListingRefused) return refuse(\`\${prefix}\${e.message}\`);`, ``],
];

const run = (modulePath) => spawnSync(TSX, [HARNESS], {
  cwd: root, encoding: 'utf8', timeout: 60_000, env: { ...process.env, FEED_MODULE: modulePath },
});

const dir = mkdtempSync(join(tmpdir(), 'feed-mutants-'));
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