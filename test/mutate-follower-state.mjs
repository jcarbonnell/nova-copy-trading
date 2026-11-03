// mutate-follower-state.mjs: every mutant of src/adapters/follower-state.ts must be caught by the harness.
// Same scheme as mutate-pnl.mjs: one anchored string replacement per mutant, written to a temporary directory,
// run through test/follower-state.test.ts with FSTATE_MODULE pointing at it. The module's project imports are
// type-only (erased), so a mutant runs from the temporary directory as is.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const MODULE = join(root, 'src/adapters/follower-state.ts');
const HARNESS = join(root, 'test/follower-state.test.ts');
const TSX = join(root, 'node_modules/.bin/tsx');
const src = readFileSync(MODULE, 'utf8');

/** [id, what it breaks, anchor, replacement] */
const MUTANTS = [
  ['H1', 'the directory readable by others', 'await fsp.mkdir(root, { recursive: true, mode: 0o700 });', 'await fsp.mkdir(root, { recursive: true, mode: 0o755 });'],
  ['H2', 'no lock', "try { await fsp.writeFile(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 }); break; } catch (e) {", "try { await fsp.writeFile(lockPath, String(process.pid), { mode: 0o600 }); break; } catch (e) {"],
  ['H3', 'a live lock taken over', 'if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) fail(', 'if (false) fail('],
  ['H4', 'a dead lock not taken over', '      await fsp.unlink(lockPath);\n    }', '    }'],
  ['H5', 'a closed state still answers', "if (closed) fail('follower state: closed');", ''],
  ['H6', 'calls not serialised', "const next = queue.then(() => {", "const next = Promise.resolve().then(() => {"],
  ['H7', 'any read error read as no payment', "if (code(e) === 'ENOENT') return null;\n      throw e;", 'return null;'],
  ['H8', 'a damaged payment read as none', "try { doc = JSON.parse(text); } catch { return fail(`follower state: ${paymentPath}", "try { doc = JSON.parse(text); } catch { return null; fail(`follower state: ${paymentPath}"],
  ['H9', 'the version unchecked', 'if (doc?.v !== PAYMENT_VERSION) fail(', 'if (false) fail('],
  ['H10', 'a loaded payment unchecked', "if (why) fail(`follower state: ${paymentPath}: the payment ${why}`);", ''],
  ['H11', 'a saved payment unchecked', "if (why) fail(`follower state: refusing to save a payment that ${why}`);", ''],
  ['H12', 'extra fields accepted', "for (const k of Object.keys(p)) if (!['listingId', 'idempotencyKey', 'correlationId', 'claim'].includes(k)) return", 'for (const k of Object.keys(p)) if (false) return'],
  ['H13', 'any listing id accepted', "if (typeof p.listingId !== 'string' || !HEX64.test(p.listingId)) return 'has no listingId';", ''],
  ['H14', 'no key accepted', "if (!nonEmpty(p.idempotencyKey)) return 'has no idempotencyKey';", ''],
  ['H15', 'an empty correlation id accepted', "if ('correlationId' in p && !nonEmpty(p.correlationId)) return 'has an empty correlationId';", ''],
  ['H16', 'a claim before a correlation id accepted', "if (!('correlationId' in p)) return 'has a claim without a correlationId';", ''],
  ['H17', 'a claim without a window accepted', '!Number.isFinite(c.windowFromMs) || !Number.isFinite(c.windowToMs) ||', ''],
  ['H18', 'a claim with extra fields accepted', '\n        Object.keys(c).length !== 4) return', ' false) return'],
  ['H19', 'a sent payment cleared', "if (current?.correlationId) fail('follower state: a payment that may have been sent cannot be cleared');", ''],
  ['H20', 'clearing errors swallowed', "await fsp.unlink(paymentPath).catch((e) => { if (code(e) !== 'ENOENT') throw e; });", 'await fsp.unlink(paymentPath).catch(() => {});'],
  ['H21', 'the key may change', "if (current.listingId !== p.listingId || current.idempotencyKey !== p.idempotencyKey) fail(", 'if (current.listingId !== p.listingId) fail('],
  ['H22', 'the listing may change', "if (current.listingId !== p.listingId || current.idempotencyKey", 'if (current.idempotencyKey'],
  ['H23', 'the correlation id may change', "if (current.correlationId && current.correlationId !== p.correlationId) fail(", 'if (false) fail('],
  ['H24', 'the claim may change', "if (current.claim && !same(current.claim, p.claim)) fail(", 'if (false) fail('],
  ['H25', 'no fsync before the rename', "await h.writeFile(JSON.stringify({ v: PAYMENT_VERSION, payment: p }, null, 2) + '\\n', 'utf8'); await h.sync();", "await h.writeFile(JSON.stringify({ v: PAYMENT_VERSION, payment: p }, null, 2) + '\\n', 'utf8');"],
  ['H26', 'written in place', 'await fsp.rename(tmp, paymentPath);', 'await fsp.copyFile(tmp, paymentPath);'],
  ['H27', 'temp files kept', '        await fsp.unlink(tmp).catch(() => {});\n', ''],
  ['H28', 'payment readable by others', "const h = await fsp.open(tmp, 'wx', 0o600);", "const h = await fsp.open(tmp, 'wx', 0o644);"],
  ['H29', 'an unfinished copies line accepted', "if (lines.at(-1) !== '') fail(", 'if (false) fail('],
  ['H30', 'a copies line that is not JSON skipped', "try { c = JSON.parse(line); } catch { return fail(", "try { c = JSON.parse(line); } catch { return { transId: '', outcome: 'skipped' } as CopyRecord; fail("],
  ['H31', 'a loaded copy unchecked', "if (why) fail(`follower state: ${copiesPath} line ${i + 1} ${why}`);", ''],
  ['H32', 'a saved copy unchecked', "if (why) fail(`follower state: refusing to record a copy that ${why}`);", ''],
  ['H33', 'any outcome accepted', "if (!['copied', 'refused', 'skipped'].includes(c.outcome as string)) return 'has no outcome';", ''],
  ['H34', 'an entry recorded twice', "if ((await readCopies()).some((x) => x.transId === c.transId)) fail(", 'if (false) fail('],
  ['H35', 'copies readable by others', "await fsp.appendFile(copiesPath, `${JSON.stringify(c)}\\n`, { encoding: 'utf8', mode: 0o600 });", "await fsp.appendFile(copiesPath, `${JSON.stringify(c)}\\n`, { encoding: 'utf8', mode: 0o644 });"],
  ['H36', 'close leaves the lock', '      await fsp.unlink(lockPath).catch(() => {});\n    },', '    },'],
];



const run = (modulePath) => spawnSync(TSX, [HARNESS], {
  cwd: root, encoding: 'utf8', timeout: 60_000, env: { ...process.env, FSTATE_MODULE: modulePath },
});

const base = run(MODULE);
if (base.status !== 0) { console.error('baseline harness fails:\n' + base.stdout + base.stderr); process.exit(1); }

const dir = mkdtempSync(join(tmpdir(), 'fstate-mutants-'));
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
