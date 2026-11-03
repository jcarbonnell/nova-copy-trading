// mutate-journal-writer.mjs: every mutant of src/seller/journal-writer.ts must be caught by the harness.
// Same scheme as mutate-live-feed.mjs: one anchored string replacement per mutant, written to a temporary
// directory, run through test/journal-writer.test.ts with WRITER_MODULE pointing at it. The module's runtime
// import of ../core/journal.ts is pointed at the real file, so a mutant runs from the temporary directory.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const MODULE = join(root, 'src/seller/journal-writer.ts');
const HARNESS = join(root, 'test/journal-writer.test.ts');
const TSX = join(root, 'node_modules/.bin/tsx');
const src = readFileSync(MODULE, 'utf8');
const relocated = src.replace(/from '\.\.\/core\/([a-z-]+\.ts)'/g, (_, f) => `from '${pathToFileURL(join(root, 'src/core', f)).href}'`);
if (/from '\.\.?\//.test(relocated)) { console.error('a relative import was not relocated'); process.exit(1); }

/** [id, what it breaks, anchor, replacement] */
const MUTANTS = [
  ['W1', 'any side accepted', "if (d?.side !== 'buy' && d?.side !== 'sell') refuse(", 'if (false) refuse('],
  ['W2', 'the amount unchecked', "if (typeof d.amount !== 'string' || !ATOMIC.test(d.amount)) refuse(", 'if (false) refuse('],
  ['W3', 'zero and leading zeros accepted as atomic', 'const ATOMIC = /^[1-9]\\d*$/;', 'const ATOMIC = /^\\d+$/;'],
  ['W4', 'over-long reasoning reaches the quote', '|| d.reasoning.length > MAX_REASONING) {', ') {'],
  ['W5', 'empty reasoning reaches the quote', "d.reasoning.length === 0 || d.reasoning", 'd.reasoning'],
  ['W6', 'oversold check removed', "if (d.side === 'sell' && amountIn > held()) refuse(", 'if (false) refuse('],
  ['W7', 'selling exactly what is held refused', "amountIn > held()) refuse(", "amountIn >= held()) refuse("],
  ['W8', 'sells ignored in the position', "(e.side === 'buy' ? 1n : -1n)", '1n'],
  ['W9', 'a buy quoted the wrong way round', '{ origin_asset: USDC, destination_asset: WNEAR, amount: d.amount,', '{ origin_asset: WNEAR, destination_asset: USDC, amount: d.amount,'],
  ['W10', 'a sell quoted the wrong way round', ': { origin_asset: WNEAR, destination_asset: USDC, amount: d.amount,', ': { origin_asset: USDC, destination_asset: WNEAR, amount: d.amount,'],
  ['W11', 'a real (not dry) swap requested', 'destination_asset: WNEAR, amount: d.amount, dry: true as const', 'destination_asset: WNEAR, amount: d.amount, dry: false as const'],
  ['W12', 'quoted from another account', 'deps.quotes.swap(cfg.agentId, request)', 'deps.quotes.swap(cfg.groupId, request)'],
  ['W13', 'a reply that is not dry accepted', "if (reply?.dry !== true) throw new Error(", 'if (false) throw new Error('],
  ['W14', 'a reply that is not dry treated as a refused trade', "throw new Error('journal: the swap reply is not a dry quote", "throw new TradeRefused('journal: the swap reply is not a dry quote"],
  ['W15', 'amount_out unchecked', "if (typeof out !== 'string' || !ATOMIC.test(out)) throw new Error(", 'if (false) throw new Error('],
  ['W16', 'a missing amount_out treated as a refused trade', "throw new Error('journal: the quote has no amount_out')", "throw new TradeRefused('journal: the quote has no amount_out')"],
  ['W17', 'policy warnings ignored', "if (code.startsWith('policy_')) problems.push(code);", 'if (false) problems.push(code);'],
  ['W18', 'insufficient_balance refused for a simulated trade', "code === 'insufficient_balance' && !simulated", "code === 'insufficient_balance'"],
  ['W19', 'insufficient_balance accepted for a real trade', "else if (code === 'insufficient_balance' && !simulated) problems.push(code);", ''],
  ['W20', 'would_succeed: false ignored', "if (reply?.quote?.would_succeed === false) problems.push('would_succeed: false');", ''],
  ['W21', 'quote problems not acted on', 'if (problems.length) refuse(', 'if (false) refuse('],
  ['W22', 'the price truncated', 'if (2n * (num % near) >= near) units += 1n;', ''],
  ['W23', 'an exact half rounded down', '2n * (num % near) >= near', '2n * (num % near) > near'],
  ['W24', 'the NEAR side taken from amount_out for a sell too', "const near = side === 'buy' ? amountOut : amountIn;", 'const near = amountOut;'],
  ['W25', 'the price scaled wrong', 'NEAR_DECIMALS - USDC_DECIMALS + PRICE_DECIMALS', 'NEAR_DECIMALS - USDC_DECIMALS'],
  ['W26', 'trailing zeros kept', ".replace(/0+$/, '')", ''],
  ['W27', 'ts taken at upload time', 'ts: new Date(quotedAt).toISOString()', 'ts: new Date(now()).toISOString()'],
  ['W28', 'simulated hard-coded', 'simulated: cfg.simulated, ts:', 'simulated: true, ts:'],
  ['W29', 'freshness unchecked', 'if (now() - quotedAt > MAX_QUOTE_AGE_MS) refuse(', 'if (false) refuse('],
  ['W30', 'a quote exactly 10 minutes old dropped', 'now() - quotedAt > MAX_QUOTE_AGE_MS', 'now() - quotedAt >= MAX_QUOTE_AGE_MS'],
  ['W31', 'the freshness bound widened to 15 minutes', 'export const MAX_QUOTE_AGE_MS = 10 * 60_000;', 'export const MAX_QUOTE_AGE_MS = 15 * 60_000;'],
  ['W32', 'uploaded to another group', 'deps.nova.upload(cfg.groupId,', 'deps.nova.upload(cfg.agentId,'],
  ['W33', 'failed uploads not counted', '} finally {\n      uploads += 1;\n    }', '}\n    uploads += 1;'],
  ['W34', 'the cause dropped', '?.message ?? e}`, e);', '?.message ?? e}`);'],
  ['W35', 'a missing trans_id accepted', "if (typeof res?.trans_id !== 'string' || res.trans_id.length === 0) throw new UploadFailed(", 'if (false) throw new UploadFailed('],
  ['W36', 'an empty trans_id accepted', " || res.trans_id.length === 0) throw", ') throw'],
  ['W37', 'NOVA\'s file_hash unchecked', 'if (res.file_hash !== fileHash) throw new UploadFailed(', 'if (false) throw new UploadFailed('],
  ['W38', 'written entries not tracked', '    entries.push(entry);\n', ''],
  ['W39', 'the caller\'s history modified', 'const entries = [...history];', 'const entries = history;'],
  ['W40', 'the default filename not random', "randomBytes(8).toString('hex')", "'0'.repeat(16)"],
  ['W41', 'one salt reused for every entry', 'const salt = deps.salt ?? newSalt;', 'const fixed = newSalt(); const salt = deps.salt ?? (() => fixed);'],
];

const run = (modulePath) => spawnSync(TSX, [HARNESS], {
  cwd: root, encoding: 'utf8', timeout: 60_000, env: { ...process.env, WRITER_MODULE: modulePath },
});

const dir = mkdtempSync(join(tmpdir(), 'writer-mutants-'));
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
