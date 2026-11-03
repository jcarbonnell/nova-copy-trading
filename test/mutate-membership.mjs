// mutate-membership.mjs: every mutant of src/core/membership.ts must be caught by the harness.
// Same scheme as mutate-pnl.mjs: one anchored string replacement per mutant, written to a temporary directory,
// run through test/membership.test.ts with MEMBERSHIP_MODULE pointing at it. The module's only import is
// type-only (erased), so a mutant runs from the temporary directory as is.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const MODULE = join(root, 'src/core/membership.ts');
const HARNESS = join(root, 'test/membership.test.ts');
const TSX = join(root, 'node_modules/.bin/tsx');
const src = readFileSync(MODULE, 'utf8');

/** [id, what it breaks, anchor, replacement] */
const MUTANTS = [
  // recording
  ['B1', 'the seller may buy its own listing', `if (p.payer === listing.seller) throw`, `if (false) throw`],
  ['B2', 'an intent hash recorded twice', `if (await ledger.get(intentHash)) throw`, `if (false) throw`],
  ['B3', 'used-intent lookup always empty', `has: async (intentHash) => (await ledger.get(intentHash)) !== undefined,`, `has: async () => false,`],
  ['B4', 'renewal ignored', `Math.max(p.blockMs, current)`, `p.blockMs`],
  ['B5', 'expiry from the runner’s clock', `Math.max(p.blockMs, current)`, `Math.max(Date.now(), current)`],
  ['B6', 'period in seconds', `listing.periodMinutes * MINUTE_MS`, `listing.periodMinutes * 1000`],
  ['B7', 'renewal across groups', `.filter((r) => r.groupId === listing.groupId && r.member === p.payer)`, `.filter((r) => r.member === p.payer)`],
  ['B8', 'renewal from another member\u2019s payments', `.filter((r) => r.groupId === listing.groupId && r.member === p.payer)`, `.filter((r) => r.groupId === listing.groupId)`],
  // admit
  ['B9', 'lapsed records admitted', `if (r.expiresAtMs <= nowMs) {`, `if (false) {`],
  ['B10', 'lapse bound off by one', `if (r.expiresAtMs <= nowMs) {`, `if (r.expiresAtMs < nowMs) {`],
  ['B11', 'add without checking the chain first', `if (!(await ops.isMember(r.groupId, r.member))) await ops.add(r.groupId, r.member);`, `await ops.add(r.groupId, r.member);`],
  ['B12', 'admitted without being added', `if (!(await ops.isMember(r.groupId, r.member))) await ops.add(r.groupId, r.member);`, ``],
  ['B13', 'the seller admitted', `if (r.state !== 'paid' || r.member === r.seller) continue;`, `if (r.state !== 'paid') continue;`],
  ['B14', 'admission time not recorded', `admittedAtMs: nowMs`, `admittedAtMs: r.blockMs`],
  // revoke
  ['B15', 'revoke bound off by one', `r.expiresAtMs <= nowMs && r.member !== r.seller`, `r.expiresAtMs < nowMs && r.member !== r.seller`],
  ['B16', 'renewals ignored at revoke', `if (stillLive) continue;`, ``],
  ['B17', 'a period ending now counted as live', `o.member === r.member && o.expiresAtMs > nowMs`, `o.member === r.member && o.expiresAtMs >= nowMs`],
  ['B18', 'another member’s renewal keeps this one', `live(o) && o.groupId === r.groupId && o.member === r.member && o.expiresAtMs > nowMs`, `live(o) && o.groupId === r.groupId && o.expiresAtMs > nowMs`],
  ['B19', 'revoke without checking the chain first', `if (await ops.isMember(r.groupId, r.member)) {`, `if (true) {`],
  ['B20', 'an unseen rotation reported as confirmed', `rotation = 'unconfirmed';`, `rotation = 'confirmed';`],
  ['B21', 'the seller revoked', `r.expiresAtMs <= nowMs && r.member !== r.seller);`, `r.expiresAtMs <= nowMs);`],
  ['B22', 'only one of the member’s records closed', `for (const o of due.filter((x) => x.groupId === r.groupId && x.member === r.member)) {`, `for (const o of [r]) {`],
  ['B23', 'revoke time not recorded', `revokedAtMs: nowMs`, `revokedAtMs: r.expiresAtMs`],
];

const run = (modulePath) => spawnSync(TSX, [HARNESS], {
  cwd: root, encoding: 'utf8', timeout: 60_000, env: { ...process.env, MEMBERSHIP_MODULE: modulePath },
});

const base = run(MODULE);
if (base.status !== 0) { console.error('baseline harness fails:\n' + base.stdout + base.stderr); process.exit(1); }

const dir = mkdtempSync(join(tmpdir(), 'membership-mutants-'));
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