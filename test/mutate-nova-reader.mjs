// mutate-nova-reader.mjs: every mutant of src/adapters/nova-reader.ts must be caught by the harness.
// Same scheme as mutate-pnl.mjs: one anchored string replacement per mutant, written to a temporary directory,
// run through test/nova-reader.test.ts with READER_MODULE pointing at it. The module's project imports are
// type-only (erased), so a mutant runs from the temporary directory as is.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const MODULE = join(root, 'src/adapters/nova-reader.ts');
const HARNESS = join(root, 'test/nova-reader.test.ts');
const TSX = join(root, 'node_modules/.bin/tsx');
const src = readFileSync(MODULE, 'utf8');

/** [id, what it breaks, anchor, replacement] */
const MUTANTS = [
  ['N1', 'a reply that is not a list accepted', 'if (!Array.isArray(rows)) return fail(', 'if (false) return fail('],
  ['N2', 'a row that is not an object accepted', "if (typeof r !== 'object' || r === null || Array.isArray(r)) fail(", 'if (false) fail('],
  ['N3', 'string fields unchecked', "for (const f of STRING_FIELDS) if (typeof r[f] !== 'string') fail(", 'for (const f of STRING_FIELDS) if (false) fail('],
  ['N4', 'user_id left out of the checked fields', "const STRING_FIELDS = ['trans_id', 'group_id', 'user_id', 'file_hash', 'ipfs_hash'] as const;",
    "const STRING_FIELDS = ['trans_id', 'group_id', 'file_hash', 'ipfs_hash'] as const;"],
  ['N5', 'timestamp unchecked', "if (r.timestamp !== null && typeof r.timestamp !== 'string') fail(", 'if (false) fail('],
  ['N6', 'a legacy row (timestamp null) refused', "if (r.timestamp !== null && typeof r.timestamp !== 'string') fail(", "if (typeof r.timestamp !== 'string') fail("],
  ['N7', 'deleted unchecked', "if (r.deleted !== null && (typeof r.deleted !== 'object' || Array.isArray(r.deleted))) fail(", 'if (false) fail('],
  ['N8', 'deleted as a list accepted', "(typeof r.deleted !== 'object' || Array.isArray(r.deleted))", "(typeof r.deleted !== 'object')"],
  ['N9', 'extra fields passed on', 'return { trans_id: r.trans_id, group_id: r.group_id,', 'return { ...r, trans_id: r.trans_id, group_id: r.group_id,'],
  ['N10', 'rows reordered', 'return rows.map(toRow);', 'return rows.map(toRow).reverse();'],
  ['N11', 'a reply without bytes accepted', "if (!(r?.data instanceof Uint8Array)) fail('nova: retrieve returned no bytes');", ''],
  ['N12', 'a reply for another file accepted', "if (r.group_id !== groupId || r.ipfs_hash !== ref) fail(", 'if (false) fail('],
  ['N13', 'only the group echoed back is checked', 'r.group_id !== groupId || r.ipfs_hash !== ref', 'r.group_id !== groupId'],
  ['N14', 'another location retrieved', 'await sdk.retrieve(groupId, ref);', 'await sdk.retrieve(groupId, groupId);'],
];

const run = (modulePath) => spawnSync(TSX, [HARNESS], {
  cwd: root, encoding: 'utf8', timeout: 60_000, env: { ...process.env, READER_MODULE: modulePath },
});

const base = run(MODULE);
if (base.status !== 0) { console.error('baseline harness fails:\n' + base.stdout + base.stderr); process.exit(1); }

const dir = mkdtempSync(join(tmpdir(), 'reader-mutants-'));
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