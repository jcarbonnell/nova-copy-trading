// mutate-script-decider.mjs: every mutant of src/seller/script-decider.ts must be caught by the harness.
// Same scheme as mutate-live-feed.mjs: one anchored string replacement per mutant, written to a temporary
// directory, run through test/script-decider.test.ts with SCRIPT_MODULE pointing at it. The module's runtime
// imports (../core/*.ts and ./*.ts) are pointed at the real files, so a mutant runs from the temporary directory.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const MODULE = join(root, 'src/seller/script-decider.ts');
const HARNESS = join(root, 'test/script-decider.test.ts');
const TSX = join(root, 'node_modules/.bin/tsx');
const src = readFileSync(MODULE, 'utf8');
const relocated = src
  .replace(/from '\.\.\/core\/([a-z-]+\.ts)'/g, (_, f) => `from '${pathToFileURL(join(root, 'src/core', f)).href}'`)
  .replace(/from '\.\/([a-z-]+\.ts)'/g, (_, f) => `from '${pathToFileURL(join(root, 'src/seller', f)).href}'`);
if (/from '\.\.?\//.test(relocated)) { console.error('a relative import was not relocated'); process.exit(1); }

/** [id, what it breaks, anchor, replacement] */
const MUTANTS = [
  ['D1', 'not-JSON thrown raw', "try { doc = JSON.parse(json); } catch { return refuse('script: not JSON'); }", 'doc = JSON.parse(json);'],
  ['D2', 'a non-list accepted', "if (!Array.isArray(doc) || doc.length < 1 ||", 'if (false || doc.length < 1 ||'],
  ['D3', 'an empty script accepted', 'doc.length < 1 || doc.length > MAX_SCRIPT_DECISIONS', 'doc.length > MAX_SCRIPT_DECISIONS'],
  ['D4', 'scripts of any length accepted', '|| doc.length > MAX_SCRIPT_DECISIONS) refuse(', ') refuse('],
  ['D5', 'another length bound', 'export const MAX_SCRIPT_DECISIONS = 100;', 'export const MAX_SCRIPT_DECISIONS = 101;'],
  ['D6', 'a non-object decision accepted', "if (typeof d !== 'object' || d === null || Array.isArray(d)) refuse(", 'if (false) refuse('],
  ['D7', 'a list decision accepted', "|| d === null || Array.isArray(d)) refuse(", '|| d === null) refuse('],
  ['D8', 'extra fields accepted', 'for (const k of Object.keys(o)) if (!KEYS.includes(k)) refuse(', 'for (const k of Object.keys(o)) if (false) refuse('],
  ['D9', 'any side accepted', "if (o.side !== 'buy' && o.side !== 'sell') refuse(", 'if (false) refuse('],
  ['D10', 'the amount unchecked', "if (typeof o.amount !== 'string' || !ATOMIC.test(o.amount)) refuse(", 'if (false) refuse('],
  ['D11', 'zero and leading zeros accepted', 'const ATOMIC = /^[1-9]\\d*$/;', 'const ATOMIC = /^\\d+$/;'],
  ['D12', 'empty reasoning accepted', 'o.reasoning.length < 1 || ', ''],
  ['D13', 'over-long reasoning accepted', ' || o.reasoning.length > MAX_REASONING) {', ') {'],
  ['D14', 'the decisions not copied', 'const queue = decisions.map((d) => ({ ...d }));', 'const queue = decisions as TradeDecision[];'],
  ['D15', 'the list copied, not the decisions', 'const queue = decisions.map((d) => ({ ...d }));', 'const queue = [...decisions];'],
  ['D16', 'played from the end', 'next: async () => queue.shift() ?? null,', 'next: async () => queue.pop() ?? null,'],
  ['D17', 'played forever', 'next: async () => queue.shift() ?? null,', 'next: async () => queue[0] ?? null,'],
  ['D18', 'remaining miscounted', 'get remaining() { return queue.length; }', 'get remaining() { return decisions.length; }'],
];


const run = (modulePath) => spawnSync(TSX, [HARNESS], {
  cwd: root, encoding: 'utf8', timeout: 60_000, env: { ...process.env, SCRIPT_MODULE: modulePath },
});

const dir = mkdtempSync(join(tmpdir(), 'script-mutants-'));
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
