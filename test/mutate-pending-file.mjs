// mutate-pending-file.mjs: every mutant of src/adapters/pending-file.ts must be caught by the harness.
// Same scheme as mutate-pnl.mjs: one anchored string replacement per mutant, written to a temporary directory,
// run through test/pending-file.test.ts with PENDING_MODULE pointing at it. The module's project imports are
// type-only (erased), so a mutant runs from the temporary directory as is.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const MODULE = join(root, 'src/adapters/pending-file.ts');
const HARNESS = join(root, 'test/pending-file.test.ts');
const TSX = join(root, 'node_modules/.bin/tsx');
const src = readFileSync(MODULE, 'utf8');

/** [id, what it breaks, anchor, replacement] */
const MUTANTS = [
  ['P1', 'a damaged file read as nothing pending', "try { doc = JSON.parse(text); } catch { throw new PendingStoreError(", "try { doc = JSON.parse(text); } catch { return null; throw new PendingStoreError("],
  ['P2', 'any read error read as nothing pending', "if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;\n        throw e;", 'return null;'],
  ['P3', 'the version unchecked', 'if (doc?.v !== PENDING_VERSION) throw', 'if (false) throw'],
  ['P4', 'a loaded call unchecked', "if (why) throw new PendingStoreError(`pending: ${storePath}: the saved call ${why}`);", ''],
  ['P5', 'a saved call unchecked', "if (why) throw new PendingStoreError(`pending: refusing to save a call that ${why}`);", ''],
  ['P6', 'extra fields accepted', "for (const k of Object.keys(p)) if (!CALL_KEYS.includes(k)) return", 'for (const k of Object.keys(p)) if (false) return'],
  ['P7', 'an empty key accepted', "typeof p.idempotencyKey !== 'string' || p.idempotencyKey.length === 0", "typeof p.idempotencyKey !== 'string'"],
  ['P8', 'savedAt unchecked', "if (typeof p.savedAt !== 'string' || p.savedAt.length === 0) return 'has no savedAt';", ''],
  ['P9', 'an empty correlation id accepted', "|| p.correlationId.length === 0)) return", ')) return'],
  ['P10', 'the body unchecked', "if (!isObject(b)) return 'has no body';", "if (!b) return 'has no body';"],
  ['P11', 'extra body fields accepted', 'for (const k of Object.keys(b)) if (!BODY_KEYS.includes(k)) return', 'for (const k of Object.keys(b)) if (false) return'],
  ['P12', 'the receiver unchecked', "if (typeof b.receiver_id !== 'string' || b.receiver_id.length === 0) return 'has no body.receiver_id';", ''],
  ['P13', 'the method unchecked', "if (typeof b.method_name !== 'string' || b.method_name.length === 0) return 'has no body.method_name';", ''],
  ['P14', 'args as a list accepted', "if (!isObject(b.args)) return", "if (typeof b.args !== 'object') return"],
  ['P15', 'gas unchecked', "if (typeof b.gas !== 'string' || !UINT.test(b.gas)) return 'has no body.gas integer string';", ''],
  ['P16', 'a decimal deposit accepted', 'const UINT = /^(0|[1-9]\\d*)$/;', 'const UINT = /^[0-9.]+$/;'],
  ['P17', 'saved in place, not via a temp file', 'await fsp.rename(tmp, storePath);', 'await fsp.copyFile(tmp, storePath); await fsp.unlink(tmp);'],
  ['P18', 'no fsync before the rename', 'await h.writeFile(body, \'utf8\'); await h.sync();', 'await h.writeFile(body, \'utf8\');'],
  ['P19', 'a failed save leaves its temp file', '        await fsp.unlink(tmp).catch(() => {});\n', ''],
  ['P20', 'readable by others', "await fsp.open(tmp, 'w', 0o600)", "await fsp.open(tmp, 'w', 0o644)"],
  ['P21', 'clear errors swallowed', "if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;", ''],
  ['P22', 'operations not serialised', 'const next = queue.then(f, f);', 'const next = f();'],
  ['P23', 'clear does nothing', 'try { await fsp.unlink(storePath); } catch (e) {', 'try { } catch (e) {'],
];


const run = (modulePath) => spawnSync(TSX, [HARNESS], {
  cwd: root, encoding: 'utf8', timeout: 60_000, env: { ...process.env, PENDING_MODULE: modulePath },
});

const base = run(MODULE);
if (base.status !== 0) { console.error('baseline harness fails:\n' + base.stdout + base.stderr); process.exit(1); }

const dir = mkdtempSync(join(tmpdir(), 'pending-mutants-'));
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
