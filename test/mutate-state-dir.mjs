// mutate-state-dir.mjs: every mutant of src/adapters/state-dir.ts must be caught by the harness.
// Same scheme as mutate-pnl.mjs: one anchored string replacement per mutant, written to a temporary directory,
// run through test/state-dir.test.ts with STATE_MODULE pointing at it. The module's project imports are
// type-only (erased), so a mutant runs from the temporary directory as is.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const MODULE = join(root, 'src/adapters/state-dir.ts');
const HARNESS = join(root, 'test/state-dir.test.ts');
const TSX = join(root, 'node_modules/.bin/tsx');
const src = readFileSync(MODULE, 'utf8');

/** [id, what it breaks, anchor, replacement] */
const MUTANTS = [
  ['T1', 'directories readable by others', "await fsp.mkdir(listings, { recursive: true, mode: 0o700 });", "await fsp.mkdir(listings, { recursive: true, mode: 0o755 });"],
  ['T2', 'any read error read as no journal', "if (code(e) === 'ENOENT') return null;\n      throw e;", 'return null;'],
  ['T3', 'a damaged since-ns read as no journal', "if (!NS.test(v)) fail(", 'if (!NS.test(v)) return null; fail('],
  ['T4', 'a damaged since-ns accepted', "if (!NS.test(v)) fail(", 'if (false) fail('],
  ['T5', 'two final newlines accepted', "const v = text.endsWith('\\n') ? text.slice(0, -1) : text;", 'const v = text.trim();'],
  ['T6', 'a malformed sinceNs saved', "if (typeof ns !== 'string' || !NS.test(ns)) fail(", 'if (false) fail('],
  ['T7', 'sinceNs may be changed', "if (current !== null) fail(`state: sinceNs is already", "if (false) fail(`state: sinceNs is already"],
  ['T8', 'the same sinceNs rewritten', '      if (current === ns) return;\n', ''],
  ['T9', 'set ignores a damaged since-ns', 'const current = await readSince();', 'const current = await readSince().catch(() => null);'],
  ['T10', 'no fsync before the name', "try { await h.writeFile(body, 'utf8'); await h.sync(); }", "try { await h.writeFile(body, 'utf8'); }"],
  ['T11', 'temp files kept', '      await fsp.unlink(tmp).catch(() => {});\n', ''],
  ['T12', 'temp files readable by others', "await fsp.open(tmp, 'wx', 0o600)", "await fsp.open(tmp, 'wx', 0o644)"],
  ['T13', 'since-ns written in place', "await viaTemp(sincePath, `${ns}\\n`, (tmp) => fsp.rename(tmp, sincePath));", "await fsp.writeFile(sincePath, `${ns}\\n`, { mode: 0o600 });"],
  ['T14', 'listing ids unchecked', "if (typeof id !== 'string' || !HEX64.test(id)) fail(", 'if (false) fail('],
  ['T15', 'listing content not checked against its id', "if (typeof json !== 'string' || sha(json) !== id) fail(", 'if (false) fail('],
  ['T16', 'listings overwritten', 'try { await fsp.link(tmp, target); } catch (e) {', 'try { await fsp.rename(tmp, target); } catch (e) {'],
  ['T17', 'other content under an id accepted', "if ((await fsp.readFile(target, 'utf8')) !== json) fail(", 'if (false) fail('],
  ['T18', 'every link error read as "already there"', "if (code(e) !== 'EEXIST') throw e;", ''],
  ['T19', 'unexpected files in listings/ accepted', 'if (!m) fail(`state: unexpected file', 'if (!m) continue; fail(`state: unexpected file'],
  ['T20', 'temp files loaded as listings', '        if (TEMP_FILE.test(name)) continue;\n', ''],
  ['T21', 'events not one per line', 'await fsp.appendFile(eventsPath, `${JSON.stringify(e)}\\n`,', 'await fsp.appendFile(eventsPath, `${JSON.stringify(e)}`,'],
  ['T22', 'events readable by others', "{ encoding: 'utf8', mode: 0o600 }", "{ encoding: 'utf8', mode: 0o644 }"],
  ['T23', 'calls not serialised', 'const next = queue.then(f, f);', 'const next = f();'],
];



const run = (modulePath) => spawnSync(TSX, [HARNESS], {
  cwd: root, encoding: 'utf8', timeout: 60_000, env: { ...process.env, STATE_MODULE: modulePath },
});

const base = run(MODULE);
if (base.status !== 0) { console.error('baseline harness fails:\n' + base.stdout + base.stderr); process.exit(1); }

const dir = mkdtempSync(join(tmpdir(), 'state-mutants-'));
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
