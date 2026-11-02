// mutate-journal.mjs: every mutant of src/core/journal.ts must be caught by the harness.
// Same scheme as mutate-verify-payment.mjs: one anchored string replacement per mutant, written to a
// temporary directory, run through test/journal.test.ts with JOURNAL_MODULE pointing at it.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const MODULE = join(root, 'src/core/journal.ts');
const HARNESS = join(root, 'test/journal.test.ts');
const TSX = join(root, 'node_modules/.bin/tsx');
const src = readFileSync(MODULE, 'utf8');

/** [id, what it breaks, anchor, replacement] */
const MUTANTS = [
  // entries
  ['J1', 'unknown fields accepted', `if (!(KEYS as readonly string[]).includes(k)) refuse`, `if (false) refuse`],
  ['J2', 'missing fields accepted', `for (const k of KEYS) if (!(k in e)) refuse`, `for (const k of KEYS) if (false) refuse`],
  ['J3', 'any version accepted', `if (e.v !== 1) refuse`, `if (false) refuse`],
  ['J4', 'simulated not checked', `if (typeof e.simulated !== 'boolean') refuse`, `if (false) refuse`],
  ['J5', 'ts round-trip not required', ` || new Date(Date.parse(e.ts)).toISOString() !== e.ts`, ``],
  ['J6', 'pair not checked', `if (typeof e.pair !== 'string' || !PAIR.test(e.pair)) refuse`, `if (false) refuse`],
  ['J7', 'side not checked', `if (e.side !== 'buy' && e.side !== 'sell') refuse`, `if (false) refuse`],
  ['J8', 'zero accepted', ` && /[1-9]/.test(s);`, `;`],
  ['J9', 'leading zeros accepted', `const DECIMAL = /^(0|[1-9]\\d*)(\\.\\d+)?$/;`, `const DECIMAL = /^\\d+(\\.\\d+)?$/;`],
  ['J10', 'price not checked', `if (!positiveDecimal(e.price)) refuse`, `if (false) refuse`],
  ['J11', 'reasoning length off by one', `e.reasoning.length > MAX_REASONING`, `e.reasoning.length > MAX_REASONING + 1`],
  ['J12', 'empty correlation_id accepted', ` || e.correlation_id.length === 0`, ``],
  ['J13', 'salt case not checked', `const HEX64 = /^[0-9a-f]{64}$/;`, `const HEX64 = /^[0-9a-fA-F]{64}$/;`],
  ['J14', 'salt length not checked', `if (typeof e.salt !== 'string' || !HEX64.test(e.salt)) refuse`, `if (typeof e.salt !== 'string') refuse`],
  ['J15', 'input key order kept', `const canonical = (e: JournalEntry) => JSON.stringify(Object.fromEntries(KEYS.map((k) => [k, e[k]])));`,
    `const canonical = (e: JournalEntry) => JSON.stringify(e);`],
  ['J16', 'non-canonical bytes accepted', `if (canonical(entry) !== text) refuse`, `if (false) refuse`],
  ['J17', 'size limit not checked on decode', `if (bytes.length > MAX_ENTRY_BYTES) refuse('entry: too large');\n  let text`, `let text`],
  ['J18', 'salt from a fixed value', `randomBytes(32).toString('hex')`, `'ab'.repeat(32)`],
  ['J19', 'file hash in base64', `createHash('sha256').update(data).digest('hex')`, `createHash('sha256').update(data).digest('base64')`],
  // fingerprint
  ['K1', 'range bounds not validated', `if (!NS.test(sinceNs) || !NS.test(asOfNs) || BigInt(sinceNs) > BigInt(asOfNs)) {`, `if (false) {`],
  ['K2', 'start bound exclusive', `return t !== null && t >= since;`, `return t !== null && t > since;`],
  ['K3', 'end bound exclusive', `if (t !== null && t <= asOf) last = i;`, `if (t !== null && t < asOf) last = i;`],
  ['K4', 'empty range accepted', `if (first < 0 || last < first) refuse('range: no entries');`, ``],
  ['K5', 'record without time accepted', `if (t === null) refuse`, `if (false) refuse`],
  ['K6', 'other group accepted', `if (r.group_id !== groupId) refuse`, `if (false) refuse`],
  ['K7', 'other uploader accepted', `if (r.user_id !== seller) refuse`, `if (false) refuse`],
  ['K8', 'tombstoned record accepted', `if (r.deleted !== null && r.deleted !== undefined) refuse`, `if (false) refuse`],
  ['K9', 'file_hash shape not checked', `if (typeof r.file_hash !== 'string' || !HEX64.test(r.file_hash)) refuse`, `if (false) refuse`],
  ['K10', 'chain order not checked', `if (prev !== null && t! < prev) refuse`, `if (false) refuse`],
  ['K11', 'trans_id not recomputed', `if (contractTransId(r) !== r.trans_id) refuse`, `if (false) refuse`],
  ['K12', 'trans_id without the timestamp', '`${r.group_id}${r.user_id}${r.file_hash}${r.ipfs_hash}${r.timestamp}`', '`${r.group_id}${r.user_id}${r.file_hash}${r.ipfs_hash}`'],
  ['K13', 'root does not bind the range', '`${FINGERPRINT_DOMAIN}\\n${groupId}\\n${seller}\\n${sinceNs}\\n${asOfNs}\\n`', '`${FINGERPRINT_DOMAIN}\\n${groupId}\\n${seller}\\n`'],
  ['K14', 'root over hashes only', '`${r.trans_id} ${r.file_hash}\\n`', '`${r.file_hash}\\n`'],
  ['K15', 'covered records sorted, not chain order', `const covered = rows.slice(first, last + 1);`,
    `const covered = rows.slice(first, last + 1).sort((a, b) => (a.trans_id < b.trans_id ? -1 : 1));`],
  ['K16', 'time compared as Number', `BigInt(r.timestamp) : null);`, `Number(r.timestamp) as unknown as bigint : null);`],
];

const run = (modulePath) => spawnSync(TSX, [HARNESS], {
  cwd: root, encoding: 'utf8', timeout: 60_000, env: { ...process.env, JOURNAL_MODULE: modulePath },
});

const base = run(MODULE);
if (base.status !== 0) { console.error('baseline harness fails:\n' + base.stdout + base.stderr); process.exit(1); }

const dir = mkdtempSync(join(tmpdir(), 'journal-mutants-'));
let caught = 0;
const survived = [];
try {
  for (const [id, what, anchor, repl] of MUTANTS) {
    const n = src.split(anchor).length - 1;
    if (n !== 1) { console.error(`${id} anchor occurs ${n} times, expected 1: ${anchor}`); process.exit(1); }
    const file = join(dir, `mutant-${id}.ts`);
    writeFileSync(file, src.replace(anchor, () => repl));
    const r = run(file);
    if (r.status !== 0) { caught++; console.log(`✓ ${id} caught: ${what}`); }
    else { survived.push(id); console.log(`✗ ${id} SURVIVED: ${what}`); }
  }
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log(`\n${caught}/${MUTANTS.length} mutants caught`);
if (survived.length) { console.log('survived: ' + survived.join(', ')); process.exit(1); }