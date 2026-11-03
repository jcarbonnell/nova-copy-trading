// mutate-seller-service.mjs: every mutant of src/seller/seller-service.ts must be caught by the harness.
// Same scheme as mutate-live-feed.mjs: one anchored string replacement per mutant, written to a temporary
// directory, run through test/seller-service.test.ts with SERVICE_MODULE pointing at it. The module's runtime
// imports (../core/*.ts and ./*.ts) are pointed at the real files, so the harness and a mutant share their classes.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const MODULE = join(root, 'src/seller/seller-service.ts');
const HARNESS = join(root, 'test/seller-service.test.ts');
const TSX = join(root, 'node_modules/.bin/tsx');
const src = readFileSync(MODULE, 'utf8');
const relocated = src
  .replace(/from '\.\.\/core\/([a-z-]+\.ts)'/g, (_, f) => `from '${pathToFileURL(join(root, 'src/core', f)).href}'`)
  .replace(/from '\.\/([a-z-]+\.ts)'/g, (_, f) => `from '${pathToFileURL(join(root, 'src/seller', f)).href}'`);
if (/from '\.\.?\//.test(relocated)) { console.error('a relative import was not relocated'); process.exit(1); }

/** [id, what it breaks, anchor, replacement] */
const MUTANTS = [
  ['V1', 'writes not queued', 'const run = chain.then(f, f);', 'const run = f();'],
  ['V2', 'the queue never advances', '    chain = run.catch(() => {});\n', ''],
  ['V3', 'no upload budget', 'if (attempts.length >= maxUploads) {', 'if (false) {'],
  ['V4', 'one upload over the budget', 'attempts.length >= maxUploads', 'attempts.length > maxUploads'],
  ['V5', 'the budget never refills', 'while (attempts.length && attempts[0] <= t - HOUR_MS) attempts.shift();', ''],
  ['V6', 'an upload exactly an hour old still counted', 'attempts[0] <= t - HOUR_MS', 'attempts[0] < t - HOUR_MS'],
  ['V7', 'a 12-upload default budget', 'export const DEFAULT_MAX_UPLOADS_PER_HOUR = 8;', 'export const DEFAULT_MAX_UPLOADS_PER_HOUR = 12;'],
  ['V8', 'uploads not counted', 'attempts.push(now()); // a failed', '// a failed'],
  ['V9', 'no resolvePending before an upload', "        await deps.signer.resolvePending();\n      } catch (e) {\n        if (isPending", "      } catch (e) {\n        if (isPending"],
  ['V10', 'a pending write stops trading', "if (isPending(e)) { await event('trade_skipped', { reason: 'a write is still pending' }); return; }", ''],
  ['V11', 'every signer failure taken as pending', "(e as Error)?.name === 'NativeCallPendingError'", 'true'],
  ['V12', 'no decision not handled', '      if (d === null) return;\n', ''],
  ['V13', 'a refused trade stops trading', "if (isTradeRefused(e)) { await event('entry_refused'", "if (false) { await event('entry_refused'"],
  ['V47', 'every failure taken as a refused trade', "(e as Error)?.name === 'TradeRefused'", 'true'],
  ['V14', 'a failed upload does not stop trading', "        stopped = msg(e); await event('trading_stopped', { message: stopped }); return;\n      }\n      attempts.push",
    "        await event('trading_stopped', { message: msg(e) }); return;\n      }\n      attempts.push"],
  ['V15', 'trading goes on once stopped', '      if (stopped) return;\n', ''],
  ['V16', 'sinceNs moved at every upload', 'if ((await deps.state.getSinceNs()) === null) {', 'if (true) {'],
  ['V17', 'sinceNs from another record', '.find((r) => r.trans_id === w.transId)', '.find((r) => r.user_id === terms.seller)'],
  ['V18', 'a missing first record not caught', "if (!row || typeof row.timestamp !== 'string') {", 'if (false) {'],
  ['V19', 'no rebuild after an entry', '      await rebuild();\n    });', '    });'],
  ['V20', 'the build ignores sinceNs', '{ sinceNs, now }', '{ now }'],
  ['V21', 'listings not saved', '      await deps.state.saveListing(b.id, b.json);\n', ''],
  ['V22', 'listings not kept for claims', '      published.set(b.id, b.listing);\n', ''],
  ['V23', 'a failed rebuild thrown', "await event('listing_build_failed', { message: msg(e) });", 'throw e;'],
  ['V24', 'no revoke in maintenance', '        await adminEvents(await revokeExpired(deps.ledger, deps.ops, now()));\n', ''],
  ['V25', 'no admit in maintenance', "        await adminEvents(await admitPaid(deps.ledger, deps.ops, now()));\n      } catch (e) {\n        await event('maintenance_failed'",
    "      } catch (e) {\n        await event('maintenance_failed'"],
  ['V26', 'a maintenance failure thrown', "await event('maintenance_failed', { message: msg(e) });", 'throw e;'],
  ['V27', 'claims not queued', 'return serial(async () => {\n      let p;', 'return (async (f: () => Promise<Reply>) => f())(async () => {\n      let p;'],
  ['V28', 'the listing id unchecked', "if (typeof c?.listingId !== 'string' || !HEX64.test(c.listingId)) return", 'if (false) return'],
  ['V29', 'an unknown listing not refused', 'if (!listing) return', 'if (false) return'],
  ['V30', 'the latest listing\'s terms used', 'paymentTerms(listing)', 'paymentTerms(latest!.listing)'],
  ['V31', 'the payment recorded for the latest listing', 'const ref = { listingId: c.listingId,', 'const ref = { listingId: latest?.id ?? c.listingId,'],
  ['V32', 'a refused payment answered 503', 'if (e instanceof PaymentRefused || e instanceof MembershipRefused) {', 'if (e instanceof MembershipRefused) {'],
  ['V33', 'a membership refusal answered 503', 'e instanceof PaymentRefused || e instanceof MembershipRefused', 'e instanceof PaymentRefused'],
  ['V34', 'no admit after a verified claim', "        await adminEvents(await admitPaid(deps.ledger, deps.ops, now()));\n      } catch (e) {\n        await event('admission_deferred'",
    "      } catch (e) {\n        await event('admission_deferred'"],
  ['V35', 'a failed admit thrown', "await event('admission_deferred', { intentHash: p.intentHash, message: msg(e) });", 'throw e;'],
  ['V36', 'paid answered as admitted', "status: r?.state === 'admitted' ? 200 : 202", 'status: 200'],
  ['V37', 'no listing answered 200', "{ status: 404, body: { error: 'no listing yet' } }", '{ status: 200, body: {} }'],
  ['V38', 'any listing id served the latest', 'const l = published.get(m[1]);', 'const l = latest?.listing;'],
  ['V39', 'wrong methods answered 404', "if (path === '/claim' || path === '/health' || path === '/listing' || m) return", 'if (false) return'],
  ['V40', 'no resolvePending at start', '  // ── start ──\n  await deps.signer.resolvePending();', '  // ── start ──'],
  ['V41', 'saved listings not reloaded', 'for (const { id, json } of await deps.state.loadListings()) published.set(id, parseListing(json, id));', ''],
  ['V42', 'saved listings reloaded unchecked', 'parseListing(json, id)', 'JSON.parse(json)'],
  ['V43', 'the writer starts without history', 'history = (await verifyFeed(built.listing, deps.reader)).entries.map((e) => e.entry);', ''],
  ['V44', 'an unverified journal does not stop the start', "if (!built) throw new Error(", 'if (false) throw new Error('],
  ['V45', 'no maintenance at start', '  const writer = deps.makeWriter(history);\n  await maintenanceTick();', '  const writer = deps.makeWriter(history);'],
  ['V46', 'health always says trading', 'trading: stopped === null', 'trading: true'],
];



const run = (modulePath) => spawnSync(TSX, [HARNESS], {
  cwd: root, encoding: 'utf8', timeout: 120_000, env: { ...process.env, SERVICE_MODULE: modulePath },
});

const dir = mkdtempSync(join(tmpdir(), 'service-mutants-'));
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
