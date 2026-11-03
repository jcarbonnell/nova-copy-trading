// mutate-listing-builder.mjs: every mutant of src/seller/listing-builder.ts must be caught by the harness.
// Same scheme as mutate-live-feed.mjs: one anchored string replacement per mutant, written to a temporary
// directory, run through test/listing-builder.test.ts with BUILDER_MODULE pointing at it. The module's runtime
// imports of ../core/*.ts are pointed at the real files, so the harness and a mutant share the core's classes.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const MODULE = join(root, 'src/seller/listing-builder.ts');
const HARNESS = join(root, 'test/listing-builder.test.ts');
const TSX = join(root, 'node_modules/.bin/tsx');
const src = readFileSync(MODULE, 'utf8');
const relocated = src.replace(/from '\.\.\/core\/([a-z-]+\.ts)'/g, (_, f) => `from '${pathToFileURL(join(root, 'src/core', f)).href}'`);
if (/from '\.\.?\//.test(relocated)) { console.error('a relative import was not relocated'); process.exit(1); }

/** [id, what it breaks, anchor, replacement] */
const MUTANTS = [
  ['B1', 'an empty group not refused', "if (timed.length === 0) refuse(", 'if (false) refuse('],
  ['B2', 'legacy records (no time) taken as range bounds', "rows.filter((r) => typeof r.timestamp === 'string' && NS.test(r.timestamp))", 'rows.filter((r) => r.timestamp !== undefined)'],
  ['B3', 'sinceNs ignored', 'opts.sinceNs ?? (timed[0].timestamp as string)', '(timed[0].timestamp as string)'],
  ['B4', 'the range ends at the first record', 'const asOfNs = timed[timed.length - 1].timestamp as string;', 'const asOfNs = timed[0].timestamp as string;'],
  ['B5', 'the fingerprint taken for the first uploader', '{ groupId, seller, sinceNs, asOfNs }', '{ groupId, seller: rows[0]?.user_id ?? seller, sinceNs, asOfNs }'],
  ['B6', 'another location retrieved', 'reader.retrieve(groupId, row.ipfs_hash)', 'reader.retrieve(groupId, row.trans_id)'],
  ['B7', 'every record read, not only the covered ones', 'for (const transId of fp.transIds) {', 'for (const transId of rows.map((r) => r.trans_id)) {'],
  ['B8', 'entries timed at the range end', 'entries.push({ transId, recordNs: row.timestamp as string, entry });', 'entries.push({ transId, recordNs: asOfNs, entry });'],
  ['B9', 'no sampling', 'const points = samplePoints(entries.map((e) => e.recordNs));', 'const points = entries.map((e) => e.recordNs);'],
  ['B10', 'equal times not merged', 'const distinct = times.filter((t, i) => i === times.length - 1 || t !== times[i + 1]);', 'const distinct = times;'],
  ['B11', 'the step rounded down', 'const k = Math.ceil(distinct.length / max);', 'const k = Math.max(1, Math.floor(distinct.length / max));'],
  ['B12', 'sampling counts from the first point', '(n - 1 - i) % k === 0', 'i % k === 0'],
  ['B13', 'another point bound', 'max: number = MAX_CURVE_POINTS', 'max: number = 50'],
  ['B14', 'the curve recomputed as simulated', 'recomputeCurve(entries, QUOTE, terms.simulated, points)', 'recomputeCurve(entries, QUOTE, true, points)'],
  ['B15', 'the listing always says simulated', 'curve: { quote: QUOTE, simulated: terms.simulated, points: curvePoints }', 'curve: { quote: QUOTE, simulated: true, points: curvePoints }'],
  ['B16', 'opened at the range end, not now', 'openedAtMs: now(),', 'openedAtMs: Number(BigInt(asOfNs) / 1_000_000n) + 1,'],
  ['B17', 'no self-check', '  await as(() => verifyFeed(listing, same));\n', ''],
  ['B18', 'core refusals rethrown raw', 'return refuse(`listing-builder: ${e.message}`);', 'throw e;'],
  ['B19', 'every error turned into a refusal', 'if (e instanceof JournalRefused || e instanceof PnlRefused || e instanceof ListingRefused || e instanceof FeedRefused) {', 'if (true) {'],
  ['B20', 'journal refusals not converted', 'if (e instanceof JournalRefused || e instanceof PnlRefused', 'if (e instanceof PnlRefused'],
  ['B21', 'P&L refusals not converted', 'e instanceof PnlRefused || e instanceof ListingRefused', 'e instanceof ListingRefused'],
  ['B22', 'listing refusals not converted', 'e instanceof ListingRefused || e instanceof FeedRefused', 'e instanceof FeedRefused'],
  ['B23', 'feed refusals not converted', ' || e instanceof FeedRefused) {', ') {'],
];


const run = (modulePath) => spawnSync(TSX, [HARNESS], {
  cwd: root, encoding: 'utf8', timeout: 60_000, env: { ...process.env, BUILDER_MODULE: modulePath },
});

const dir = mkdtempSync(join(tmpdir(), 'builder-mutants-'));
let caught = 0;
const survived = [];
try {
  const baseFile = join(dir, 'baseline.ts');
  writeFileSync(baseFile, relocated);
  const base = run(baseFile);
  if (base.status !== 0) { console.error('baseline harness fails on the relocated module:\n' + base.stdout + base.stderr); process.exit(1); }
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
