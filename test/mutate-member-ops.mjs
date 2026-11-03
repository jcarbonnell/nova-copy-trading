// mutate-member-ops.mjs: every mutant of src/adapters/member-ops.ts must be caught by the harness.
// Same scheme as mutate-pnl.mjs: one anchored string replacement per mutant, written to a temporary directory,
// run through test/member-ops.test.ts with MEMBER_OPS_MODULE pointing at it. The module's project imports are
// type-only (erased), so a mutant runs from the temporary directory as is.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const MODULE = join(root, 'src/adapters/member-ops.ts');
const HARNESS = join(root, 'test/member-ops.test.ts');
const TSX = join(root, 'node_modules/.bin/tsx');
const src = readFileSync(MODULE, 'utf8');

/** [id, what it breaks, anchor, replacement] */
const MUTANTS = [
  ['A1', 'the SDK left to default the account to the seller', 'const v = await nova.isAuthorized(groupId, account);', 'const v = await nova.isAuthorized(groupId);'],
  ['A2', 'an empty account accepted', "if (typeof account !== 'string' || account.length === 0) throw", "if (typeof account !== 'string') throw"],
  ['A3', 'an empty group accepted', "if (typeof groupId !== 'string' || groupId.length === 0) throw", "if (typeof groupId !== 'string') throw"],
  ['A4', 'reads not checked for arguments', '    async isMember(groupId, account) {\n      need(groupId, account);', '    async isMember(groupId, account) {'],
  ['A5', 'a non-boolean read taken as membership', "if (typeof v !== 'boolean') throw", 'if (false) throw'],
  ['A6', 'add without settling a pending write', '      need(groupId, account);\n      await signer.resolvePending();\n      await nova.addGroupMember(groupId, account);',
    '      need(groupId, account);\n      await nova.addGroupMember(groupId, account);'],
  ['A7', 'revoke without settling a pending write', '      need(groupId, account);\n      await signer.resolvePending();\n      await nova.revokeGroupMember(groupId, account);',
    '      need(groupId, account);\n      await nova.revokeGroupMember(groupId, account);'],
  ['A8', 'add with an access window', 'await nova.addGroupMember(groupId, account);', 'await nova.addGroupMember(groupId, account, { accessMinutes: 60 });'],
  ['A9', 'add sent to revoke', 'await nova.addGroupMember(groupId, account);', 'await nova.revokeGroupMember(groupId, account);'],
  ['A10', 'writes not checked for arguments', '    async add(groupId, account) {\n      need(groupId, account);', '    async add(groupId, account) {'],
  ['A11', 'a pending error swallowed', '    async revoke(groupId, account) {\n      need(groupId, account);\n      await signer.resolvePending();',
    '    async revoke(groupId, account) {\n      need(groupId, account);\n      await signer.resolvePending().catch(() => null);'],
  ['A12', 'the seller may register groups', "['record_transaction', 'add_group_member', 'revoke_group_member']", "['record_transaction', 'register_group', 'add_group_member', 'revoke_group_member']"],
  ['A13', 'the deposit cap ten times higher', 'export const SELLER_MAX_DEPOSIT_YOCTO = 10n ** 22n;', 'export const SELLER_MAX_DEPOSIT_YOCTO = 10n ** 23n;'],
  ['A14', 'another store', 'return { store, maxDepositYocto', 'return { store: { ...store }, maxDepositYocto'],
];

const run = (modulePath) => spawnSync(TSX, [HARNESS], {
  cwd: root, encoding: 'utf8', timeout: 60_000, env: { ...process.env, MEMBER_OPS_MODULE: modulePath },
});

const base = run(MODULE);
if (base.status !== 0) { console.error('baseline harness fails:\n' + base.stdout + base.stderr); process.exit(1); }

const dir = mkdtempSync(join(tmpdir(), 'member-ops-mutants-'));
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