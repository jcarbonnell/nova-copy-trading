// mutate-pnl.mjs: every mutant of src/core/pnl.ts must be caught by the harness.
// Same scheme as mutate-verify-payment.mjs: one anchored string replacement per mutant, written to a
// temporary directory, run through test/pnl.test.ts with PNL_MODULE pointing at it. The module's only
// import is type-only (erased), so a mutant runs from the temporary directory as is.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const MODULE = join(root, 'src/core/pnl.ts');
const HARNESS = join(root, 'test/pnl.test.ts');
const TSX = join(root, 'node_modules/.bin/tsx');
const src = readFileSync(MODULE, 'utf8');

/** [id, what it breaks, anchor, replacement] */
const MUTANTS = [
  // arithmetic
  ['P1', 'average cost from the last buy only', `avg: div(add(mul(pos.size, pos.avg), mul(size, price)), total)`, `avg: price`],
  ['P2', 'realised against the sell price only', `realised = add(realised, mul(size, sub(price, pos.avg)));`, `realised = add(realised, mul(size, price));`],
  ['P3', 'position not reduced by a sell', `positions.set(base, { size: sub(pos.size, size), avg: pos.avg });`, ``],
  ['P4', 'one position for every pair', `const [base, quoteOf] = e.pair.split('/');`, `const [, quoteOf] = e.pair.split('/'); const base = 'ALL';`],
  ['P5', 'decimals read as integers', `return q(BigInt(i + f), 10n ** BigInt(f.length));`, `return q(BigInt(i));`],
  ['P6', 'rounding toward zero', `if (2n * (m % x.d) >= x.d) units += 1n;`, ``],
  ['P7', 'rounding half down', `if (2n * (m % x.d) >= x.d) units += 1n;`, `if (2n * (m % x.d) > x.d) units += 1n;`],
  ['P8', 'negative zero printed', `const neg = x.n < 0n && units > 0n;`, `const neg = x.n < 0n;`],
  ['P9', 'sign dropped', `\${neg ? '-' : ''}`, ``],
  ['P10', 'fewer decimals', `export const DECIMALS = 6;`, `export const DECIMALS = 5;`],
  ['P11', 'floating point', `const size = dec(e.size);`, `const size = q(BigInt(Math.round(Number(e.size) * 1e6)), 1_000_000n);`],
  // sampling
  ['P12', 'point bound exclusive', `for (const s of steps) if (s.at <= at) value = s.realised;`, `for (const s of steps) if (s.at < at) value = s.realised;`],
  ['P13', 'sampled by the entry ts', `steps.push({ at: recorded, realised });`, `steps.push({ at: traded, realised });`],
  ['P14', 'sample time not carried', `return { atNs: p, realised: formatQuote(value) };`, `return { atNs: '0', realised: formatQuote(value) };`],
  // rules
  ['P15', 'shorting allowed', `if (cmp(size, pos.size) > 0) refuse`, `if (false) refuse`],
  ['P16', 'sell limit off by one (selling exactly the position refused)', `if (cmp(size, pos.size) > 0) refuse`, `if (cmp(size, pos.size) >= 0) refuse`],
  ['P17', 'any quote asset', `if (quoteOf !== QUOTE) refuse`, `if (false) refuse`],
  ['P18', 'curve quote unchecked', `if (quote !== QUOTE) refuse`, `if (false) refuse`],
  ['P19', 'simulated flag unchecked', `if (e.simulated !== simulated) refuse`, `if (false) refuse`],
  ['P20', 'late commits accepted', `if (recorded - traded > MAX_COMMIT_DELAY_NS) refuse`, `if (false) refuse`],
  ['P21', 'commit bound off by one', `if (recorded - traded > MAX_COMMIT_DELAY_NS) refuse`, `if (recorded - traded >= MAX_COMMIT_DELAY_NS) refuse`],
  ['P22', 'future trade times accepted', `if (traded > recorded) refuse`, `if (false) refuse`],
  ['P23', 'record time unchecked', `if (!NS.test(recordNs)) refuse`, `if (false) refuse`],
  ['P24', 'points order unchecked', ` ||\n      pointsNs.some((p, i) => i > 0 && BigInt(p) <= BigInt(pointsNs[i - 1]))`, ``],
  ['P25', 'repeated points accepted', `BigInt(p) <= BigInt(pointsNs[i - 1])`, `BigInt(p) < BigInt(pointsNs[i - 1])`],
  // the follower's check
  ['P26', 'claimed curve not compared', `if (r.realised !== claimed.points[i].realised) {`, `if (false) {`],
  ['P27', 'claimed value format unchecked', `if (typeof p.realised !== 'string' || !VALUE.test(p.realised)) refuse`, `if (false) refuse`],
  ['P28', 'claimed simulated flag ignored', `recomputeCurve(entries, claimed.quote, claimed.simulated,`, `recomputeCurve(entries, claimed.quote, true,`],
];

const run = (modulePath) => spawnSync(TSX, [HARNESS], {
  cwd: root, encoding: 'utf8', timeout: 60_000, env: { ...process.env, PNL_MODULE: modulePath },
});

const base = run(MODULE);
if (base.status !== 0) { console.error('baseline harness fails:\n' + base.stdout + base.stderr); process.exit(1); }

const dir = mkdtempSync(join(tmpdir(), 'pnl-mutants-'));
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