// mutate-listing.mjs: every mutant of src/core/listing.ts must be caught by the harness.
// Same scheme as mutate-near-chain.mjs: one anchored string replacement per mutant, written to a temporary
// directory, run through test/listing.test.ts with LISTING_MODULE pointing at it. The module's imports of
// sibling modules (./pnl.ts, ./verify-payment.ts) are pointed at the real files.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const MODULE = join(root, 'src/core/listing.ts');
const HARNESS = join(root, 'test/listing.test.ts');
const TSX = join(root, 'node_modules/.bin/tsx');
const src = readFileSync(MODULE, 'utf8');
const relocated = src.replace(/from '\.\/([a-z-]+\.ts)'/g, (_, f) => `from '${pathToFileURL(join(root, 'src/core', f)).href}'`);
if (relocated.includes("from './")) { console.error('a relative import was not relocated'); process.exit(1); }

/** [id, what it breaks, anchor, replacement] */
const MUTANTS = [
  // shape
  ['L1', 'unknown fields accepted', `for (const k of Object.keys(o)) if (!keys.includes(k)) refuse`, `for (const k of Object.keys(o)) if (false) refuse`],
  ['L2', 'missing fields accepted', `for (const k of keys) if (!(k in o)) refuse`, `for (const k of keys) if (false) refuse`],
  ['L3', 'any version', `if (l.v !== 1) refuse`, `if (false) refuse`],
  ['L4', 'seller unchecked', `if (!isAccountId(l.seller)) refuse`, `if (false) refuse`],
  ['L5', 'group id unchecked', `if (typeof l.groupId !== 'string' || !GROUP_ID.test(l.groupId)) refuse`, `if (false) refuse`],
  ['L6', 'group id length unbounded', `const GROUP_ID = /^[A-Za-z0-9._-]{1,64}$/;`, `const GROUP_ID = /^[A-Za-z0-9._-]{1,}$/;`],
  ['L7', 'proceeds account unchecked', `if (!isAccountId(l.proceedsAccount)) refuse`, `if (false) refuse`],
  ['L8', 'token unchecked', `if (!isAccountId(l.token)) refuse`, `if (false) refuse`],
  ['L9', 'zero price accepted', `!/^[1-9]\\d*$/.test(l.price)`, `!/^\\d+$/.test(l.price)`],
  ['L10', 'openedAtMs unchecked', `if (!Number.isSafeInteger(l.openedAtMs) || (l.openedAtMs as number) < 0) refuse`, `if (false) refuse`],
  ['L11', 'period upper bound off by one', `(l.periodMinutes as number) > MAX_PERIOD_MINUTES`, `(l.periodMinutes as number) > MAX_PERIOD_MINUTES + 1`],
  ['L12', 'zero period accepted', `(l.periodMinutes as number) < 1 ||`, ``],
  ['L13', 'reversed range accepted', ` ||\n      BigInt(r.sinceNs) > BigInt(r.asOfNs)`, ``],
  ['L14', 'opening before the range ends accepted', `if (BigInt(l.openedAtMs as number) * 1_000_000n < BigInt(r.asOfNs as string)) refuse`, `if (false) refuse`],
  ['L15', 'opening bound off by one', `* 1_000_000n < BigInt(r.asOfNs as string)`, `* 1_000_000n <= BigInt(r.asOfNs as string)`],
  ['L16', 'fingerprint count unchecked', `if (!Number.isSafeInteger(f.count) || (f.count as number) < 1) refuse`, `if (false) refuse`],
  ['L17', 'fingerprint root case unchecked', `const HEX64 = /^[0-9a-f]{64}$/;`, `const HEX64 = /^[0-9a-fA-F]{64}$/;`],
  ['L18', 'curve quote unchecked', `if (c.quote !== QUOTE) refuse`, `if (false) refuse`],
  ['L19', 'simulated unchecked', `if (typeof c.simulated !== 'boolean') refuse`, `if (false) refuse`],
  ['L20', 'point count unbounded', ` || c.points.length > MAX_CURVE_POINTS`, ``],
  ['L21', 'point time unchecked', `if (typeof q.atNs !== 'string' || !NS.test(q.atNs)) refuse`, `if (false) refuse`],
  ['L22', 'point value unchecked', `if (typeof q.realised !== 'string' || !VALUE.test(q.realised)) refuse`, `if (false) refuse`],
  ['L23', 'repeated point times accepted', `BigInt(q.atNs as string) <= BigInt(`, `BigInt(q.atNs as string) < BigInt(`],
  ['L24', 'curve may start before the range', `if (BigInt((points[0] as { atNs: string }).atNs) < BigInt(r.sinceNs as string)) refuse`, `if (false) refuse`],
  ['L25', 'curve may end anywhere', `if ((points[points.length - 1] as { atNs: string }).atNs !== r.asOfNs) refuse`, `if (false) refuse`],
  // id
  ['L26', 'id over the input key order', `createHash('sha256').update(canonicalListing(checkListing(l)))`, `createHash('sha256').update(JSON.stringify(checkListing(l)))`],
  ['L27', 'id omits the curve', `curve: { quote: l.curve.quote, simulated: l.curve.simulated, points:`, `curveX: { quote: l.curve.quote, simulated: l.curve.simulated, points:`],
  ['L28', 'id omits the proceeds account', `proceedsAccount: l.proceedsAccount, token: l.token, price: l.price,\n`, `token: l.token, price: l.price,\n`],
  ['L29', 'id hashes an unvalidated listing', `update(canonicalListing(checkListing(l)))`, `update(canonicalListing(l))`],
  ['L30', 'approved id not compared', `if (listingId(l) !== approvedId) refuse`, `if (false) refuse`],
  ['L31', 'approved id shape unchecked', `if (typeof approvedId !== 'string' || !HEX64.test(approvedId)) refuse`, `if (false) refuse`],
  ['L32', 'payment terms from the wrong field', `({ proceedsAccount: l.proceedsAccount, token: l.token,`, `({ proceedsAccount: l.seller, token: l.token,`],
];

const run = (modulePath) => spawnSync(TSX, [HARNESS], {
  cwd: root, encoding: 'utf8', timeout: 60_000, env: { ...process.env, LISTING_MODULE: modulePath },
});

const dir = mkdtempSync(join(tmpdir(), 'listing-mutants-'));
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