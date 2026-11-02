// mutate-verify-payment.mjs: every mutant of src/core/verify-payment.ts must be caught by the harness.
// Each mutant is one string replacement, anchored on text that must occur exactly once in the module.
// The mutant is written to a temporary directory (never into src/) and run through
// test/verify-payment.test.ts with VP_MODULE pointing at it. A mutant is caught when the harness exits non-zero.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const MODULE = join(root, 'src/core/verify-payment.ts');
const HARNESS = join(root, 'test/verify-payment.test.ts');
const TSX = join(root, 'node_modules/.bin/tsx');
const src = readFileSync(MODULE, 'utf8');

/** [id, what it breaks, anchor, replacement] */
const MUTANTS = [
  // claim and listing shape (no chain call before these)
  ['M1', 'price accepts zero', `/^[1-9]\\d*$/.test(l.price)`, `/^\\d+$/.test(l.price)`],
  ['M2', 'intent hash length unchecked', `base58Length(c.intentHash) !== 32`, `base58Length(c.intentHash) === null`],
  ['M3', 'payer id unchecked', `if (!isAccountId(c.payer)) refuse`, `if (false) refuse`],
  ['M4', 'reversed window allowed', `c.windowFromMs > c.windowToMs ||`, ``],
  ['M5', 'window limit off by one', `c.windowToMs - c.windowFromMs > MAX_WINDOW_MS`, `c.windowToMs - c.windowFromMs > MAX_WINDOW_MS + 1`],
  ['M6', 'future window allowed', `if (c.windowToMs > nowMs) refuse`, `if (false) refuse`],
  ['M7', 'window before listing allowed', `if (c.windowFromMs < l.openedAtMs) refuse`, `if (false) refuse`],
  ['M8', 'single use not checked', `if (await deps.used.has(claim.intentHash)) refuse`, `if (false) refuse`],
  // discovery and selection
  ['M9', 'scan not padded', `export const PAD_MS = 10_000;`, `export const PAD_MS = 0;`],
  ['M10', 'ambiguity accepted', `if (passed.length > 1) refuse`, `if (false) refuse`],
  ['M11', 'first failing candidate aborts', `refusals.push(\`candidate \${hash}: \${e.message}\`);`, `throw e;`],
  ['M12', 'recorded before verification', `if (candidates.length === 0) refuse('payment not found in the claimed window');`,
    `if (candidates.length === 0) refuse('payment not found in the claimed window');\n  await deps.used.add(claim.intentHash, {} as VerifiedPayment);`],
  ['M13', 'never recorded', `await deps.used.add(claim.intentHash, passed[0]);`, ``],
  // the transaction
  ['M14', 'tx fetched with the payer as sender', `chain.txStatus(hash, INTENTS)`, `chain.txStatus(hash, c.payer)`],
  ['M15', 'failed tx accepted', `|| !('SuccessValue' in st.status)) refuse`, `) refuse`],
  ['M16', 'any tx accepted', `refuse('transaction is not intents.near execute_intents');`, `void 0;`],
  ['M17', 'failed receipts read', `if (!receiptSucceeded(o)) continue;`, ``],
  ['M18', 'event executor ignored', `e.executor === executor && `, ``],
  // the dip4 ft_withdraw
  ['M19', 'ft_withdraw intent hash ignored', `.filter((d) => d?.intent_hash === c.intentHash);`, `;`],
  ['M20', 'ft_withdraw payer ignored', `if (w.account_id !== c.payer) refuse`, `if (false) refuse`],
  ['M21', 'ft_withdraw receiver ignored', `if (w.receiver_id !== l.proceedsAccount) refuse`, `if (false) refuse`],
  ['M22', 'ft_withdraw token ignored', `if (w.token !== l.token) refuse`, `if (false) refuse`],
  ['M23', 'ft_withdraw amount ignored', `if (w.amount !== l.price) refuse`, `if (false) refuse`],
  ['M24', 'intents_executed account ignored', `d?.intent_hash === c.intentHash && d?.account_id === c.payer`, `d?.intent_hash === c.intentHash`],
  // the token contract's transfer
  ['M25', 'ft_transfer not required', `if (!delivered) refuse`, `if (false) refuse`],
  ['M26', 'ft_transfer amount ignored', ` && d?.amount === l.price);`, `);`],
  // block time
  ['M27', 'block before listing accepted', `if (!(blockMs >= l.openedAtMs)) refuse`, `if (false) refuse`],
  ['M28', 'window end exclusive', `blockMs <= c.windowToMs + PAD_MS`, `blockMs < c.windowToMs + PAD_MS`],
  ['M29', 'window start exclusive', `blockMs >= c.windowFromMs - PAD_MS`, `blockMs > c.windowFromMs - PAD_MS`],
  ['M30', 'window end unbounded', `blockMs <= c.windowToMs + PAD_MS`, `true`],
  ['M31', 'window start unbounded', `blockMs >= c.windowFromMs - PAD_MS`, `true`],
];

const run = (modulePath) => spawnSync(TSX, [HARNESS], {
  cwd: root, encoding: 'utf8', timeout: 60_000, env: { ...process.env, VP_MODULE: modulePath },
});

// The unmutated module must pass first, or a "caught" mutant means nothing.
const base = run(MODULE);
if (base.status !== 0) { console.error('baseline harness fails:\n' + base.stdout + base.stderr); process.exit(1); }

const dir = mkdtempSync(join(tmpdir(), 'vp-mutants-'));
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