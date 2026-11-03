// mutate-mock-world.mjs: every mutant of src/mock/mock-world.ts must be caught by the harness.
// Same scheme as mutate-pnl.mjs: one anchored string replacement per mutant, written to a temporary directory,
// run through test/mock-world.test.ts with MOCK_MODULE pointing at it. The module's project imports are
// type-only (erased), so a mutant runs from the temporary directory as is.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const MODULE = join(root, 'src/mock/mock-world.ts');
const HARNESS = join(root, 'test/mock-world.test.ts');
const TSX = join(root, 'node_modules/.bin/tsx');
const src = readFileSync(MODULE, 'utf8');

/** [id, what it breaks, anchor, replacement] */
const MUTANTS = [
  ['W1', 'records not at block time', 'let ns = BigInt(t) * 1_000_000n;', 'let ns = BigInt(t);'],
  ['W2', 'ties not separated', 'if (ns <= lastNs) ns = lastNs + 1n;', ''],
  ['W3', 'another trans_id', 'r.trans_id = sha(`${r.group_id}${r.user_id}${r.file_hash}${r.ipfs_hash}${r.timestamp}`);', 'r.trans_id = sha(`${r.group_id}${r.file_hash}${r.ipfs_hash}${r.timestamp}`);'],
  ['W4', 'a non-member may upload', "if (!member(groupId)) throw new MockNovaError('Wallet transaction \\'record_transaction\\'", "if (false) throw new MockNovaError('Wallet transaction \\'record_transaction\\'"],
  ['W5', 'uploads recorded under another account', 'const r = record(groupId, account, new Uint8Array(data), `fastfs/${filename}`);', 'const r = record(groupId, group(groupId).owner, new Uint8Array(data), `fastfs/${filename}`);'],
  ['W6', 'a non-member may retrieve', "if (!member(groupId)) throw new MockNovaError('MCP tool \\'prepare_retrieve\\'", "if (false) throw new MockNovaError('MCP tool \\'prepare_retrieve\\'"],
  ['W7', 'a non-member may list', "if (!member(groupId)) throw new MockNovaError('MCP tool \\'get_group_transactions\\'", "if (false) throw new MockNovaError('MCP tool \\'get_group_transactions\\'"],
  ['W8', 'retrieve echoes another group', 'return { data: Buffer.from(data), ipfs_hash: ref, group_id: groupId };', "return { data: Buffer.from(data), ipfs_hash: ref, group_id: 'x' };"],
  ['W9', 'is_authorized ignores the account asked about', 'return group(groupId).members.has(userId ?? account);', 'return group(groupId).members.has(account);'],
  ['W10', 'anyone may add', "if (g.owner !== account) throw new MockNovaError('Wallet transaction \\'add_group_member\\'", "if (false) throw new MockNovaError('Wallet transaction \\'add_group_member\\'"],
  ['W11', 'anyone may revoke', "if (g.owner !== account) throw new MockNovaError('Wallet transaction \\'revoke_group_member\\'", "if (false) throw new MockNovaError('Wallet transaction \\'revoke_group_member\\'"],
  ['W12', 'a duplicate add accepted', "if (g.members.has(memberId)) throw new MockNovaError(", 'if (false) throw new MockNovaError('],
  ['W13', 'revoke leaves the member', '        g.members.delete(memberId);\n', ''],
  ['W14', 'quotes priced the wrong way', 'const out = req.origin_asset === USDC ? (amount * NEAR_SCALE * PRICE_SCALE) / p : (amount * p) / (NEAR_SCALE * PRICE_SCALE);',
    'const out = req.origin_asset === USDC ? (amount * p) / (NEAR_SCALE * PRICE_SCALE) : (amount * NEAR_SCALE * PRICE_SCALE) / p;'],
  ['W15', 'the price never moves', 'Math.floor((ms - o.startMs) / step)', '0'],
  ['W16', 'the price path runs off its end', 'Math.min(prices.length - 1, Math.max(0, Math.floor((ms - o.startMs) / step)))', 'Math.max(0, Math.floor((ms - o.startMs) / step))'],
  ['W17', 'caps ignored', '(BigInt(amount) > capOf(asset) ? [{', '(false ? [{'],
  ['W18', 'the cap itself refused', 'BigInt(amount) > capOf(asset)', 'BigInt(amount) >= capOf(asset)'],
  ['W19', 'a refused quote said to succeed', 'quote: { amount_out: out.toString(), would_succeed: warnings.length === 0 }', 'quote: { amount_out: out.toString(), would_succeed: true }'],
  ['W20', 'live swaps allowed', "if (req?.dry !== true) throw new Error('mock: only dry swaps", "if (false) throw new Error('mock: only dry swaps"],
  ['W21', 'any recipient allowed', "...(policy.withdrawTo.includes(req.recipient) ? [] : [{ code: 'policy_destination_denied' }])", '...[]'],
  ['W22', 'a withdrawal key not idempotent', '        if (seen) return { ...seen };\n', ''],
  ['W23', 'a refused withdrawal sent', "if (!policy.withdrawTo.includes(req.recipient) || BigInt(req.amount) > policy.capUsdc) {", 'if (false) {'],
  ['W24', 'any withdrawal settles as the recorded one', "const settles = req.recipient === RECORDED.recipient && req.amount === RECORDED.amount && req.asset === RECORDED.asset;", 'const settles = true;'],
  ['W25', 'the claim\'s window from the wrong field', 'dispatch_committed_at: new Date(RECORDED.windowFromMs).toISOString()', 'dispatch_committed_at: new Date(RECORDED.blockMs).toISOString()'],
  ['W26', 'the payment shown at any time', 'RECORDED.blockMs >= fromMs && RECORDED.blockMs <= toMs ? [fx.transaction] : []', '[fx.transaction]'],
  ['W27', 'any tx served', "if (hash !== fx.transaction.hash) throw new Error(", 'if (false) throw new Error('],
];



const run = (modulePath) => spawnSync(TSX, [HARNESS], {
  cwd: root, encoding: 'utf8', timeout: 60_000, env: { ...process.env, MOCK_MODULE: modulePath },
});

const base = run(MODULE);
if (base.status !== 0) { console.error('baseline harness fails:\n' + base.stdout + base.stderr); process.exit(1); }

const dir = mkdtempSync(join(tmpdir(), 'mock-mutants-'));
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
