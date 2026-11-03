// mutate-ledger-file.mjs: every mutant of src/adapters/ledger-file.ts must be caught by the harness.
// Same scheme as mutate-pnl.mjs: one anchored string replacement per mutant, written to a temporary directory,
// run through test/ledger-file.test.ts with LEDGER_MODULE pointing at it. The module's only project import is
// type-only (erased), so a mutant runs from the temporary directory as is.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const MODULE = join(root, 'src/adapters/ledger-file.ts');
const HARNESS = join(root, 'test/ledger-file.test.ts');
const TSX = join(root, 'node_modules/.bin/tsx');
const src = readFileSync(MODULE, 'utf8');

/** [id, what it breaks, anchor, replacement] */
const MUTANTS = [
  // never silently reset
  ['G1', 'a ledger that does not parse treated as empty', 'try { doc = JSON.parse(text); } catch { throw', 'try { doc = JSON.parse(text); } catch { return new Map(); throw'],
  ['G2', 'version unchecked', 'if (doc?.v !== LEDGER_VERSION) throw', 'if (false) throw'],
  ['G3', 'records object unchecked', "if (typeof doc.records !== 'object' || doc.records === null || Array.isArray(doc.records)) {", 'if (false) {'],
  ['G4', 'a record under another key accepted', 'if (r?.intentHash !== key) throw', 'if (false) throw'],
  ['G5', 'any read error treated as a missing ledger', "if ((e as NodeJS.ErrnoException).code === 'ENOENT') records = new Map();", 'if (true) records = new Map();'],
  ['G6', 'lock kept after a refused load', 'else { await fsp.unlink(lockPath).catch(() => {}); throw e; }', 'else { throw e; }'],
  // atomic writes
  ['G7', 'no fsync before the rename', 'await h.sync();', ''],
  ['G8', 'written in place, not renamed', 'await fsp.rename(tmp, ledgerPath);', 'await fsp.copyFile(tmp, ledgerPath); await fsp.unlink(tmp);'],
  ['G9', 'temp file left after a failed write', 'await fsp.unlink(tmp).catch(() => {});\n      throw e;', 'throw e;'],
  ['G10', 'memory updated before the file', 'await persist(next);\n      records = next;', 'records = next;\n      await persist(next);'],
  ['G11', 'writes not serialised', 'const next = queue.then(f, f);', 'const next = f();'],
  ['G12', 'readable by others', "await fsp.open(tmp, 'w', 0o600)", "await fsp.open(tmp, 'w', 0o644)"],
  // copies
  ['G13', 'get returns the stored record itself', 'const r = records.get(intentHash); return r ? copy(r) : undefined;', 'return records.get(intentHash);'],
  ['G14', 'put stores the caller’s object', 'next.set(record.intentHash, copy(record));', 'next.set(record.intentHash, record);'],
  ['G15', 'all returns the stored records', 'return [...records.values()].map(copy);', 'return [...records.values()];'],
  // one runner per ledger
  ['G16', 'a running holder ignored', 'if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) throw', 'if (false) throw'],
  ['G17', 'a stale lock never taken over', 'await fsp.unlink(lockPath);\n    }\n  }', 'throw e;\n    }\n  }'],
  ['G18', 'close keeps the lock', "closed = true;\n      await fsp.unlink(lockPath).catch(() => {});", 'closed = true;'],
  ['G19', 'a closed ledger still answers', 'const live = () => { if (closed) throw', 'const live = () => { if (false) throw'],
  ['G20', 'a record without an intent hash accepted', "if (typeof record?.intentHash !== 'string' || record.intentHash.length === 0) throw", "if (typeof record?.intentHash !== 'string') throw"],
];

const run = (modulePath) => spawnSync(TSX, [HARNESS], {
  cwd: root, encoding: 'utf8', timeout: 60_000, env: { ...process.env, LEDGER_MODULE: modulePath },
});

const base = run(MODULE);
if (base.status !== 0) { console.error('baseline harness fails:\n' + base.stdout + base.stderr); process.exit(1); }

const dir = mkdtempSync(join(tmpdir(), 'ledger-mutants-'));
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