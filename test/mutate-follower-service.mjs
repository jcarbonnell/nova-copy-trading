// mutate-follower-service.mjs: every mutant of src/follower/follower-service.ts must be caught by the harness.
// Same scheme as mutate-live-feed.mjs: one anchored string replacement per mutant, written to a temporary
// directory, run through test/follower-service.test.ts with FOLLOWER_MODULE pointing at it. The module's runtime
// imports of ../core/*.ts are pointed at the real files, so the harness and a mutant share the core's classes.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const MODULE = join(root, 'src/follower/follower-service.ts');
const HARNESS = join(root, 'test/follower-service.test.ts');
const TSX = join(root, 'node_modules/.bin/tsx');
const src = readFileSync(MODULE, 'utf8');
const relocated = src.replace(/from '\.\.\/core\/([a-z-]+\.ts)'/g, (_, f) => `from '${pathToFileURL(join(root, 'src/core', f)).href}'`);
if (/from '\.\.?\//.test(relocated)) { console.error('a relative import was not relocated'); process.exit(1); }

/** [id, what it breaks, anchor, replacement] */
const MUTANTS = [
  ['G1', 'the seller\'s latest listing fetched', 'deps.seller.get(`/listings/${cfg.approvedId}`)', "deps.seller.get('/listing')"],
  ['G3', 'the listing not parsed against the approved id', 'parseListing(JSON.stringify(r.body.listing), cfg.approvedId)', 'parseListing(JSON.stringify(r.body.listing), r.body.id)'],
  ['G4', 'any token accepted', "if (l.token !== USDC_CONTRACT) refuse(", 'if (false) refuse('],
  ['G5', 'any price accepted', 'if (BigInt(l.price) > BigInt(cfg.maxPrice)) refuse(', 'if (false) refuse('],
  ['G6', 'the maximum price itself refused', 'BigInt(l.price) > BigInt(cfg.maxPrice)', 'BigInt(l.price) >= BigInt(cfg.maxPrice)'],
  ['G7', 'paid to another recipient', 'recipient: l.proceedsAccount, memo: cfg.memo', "recipient: '1000fans.near', memo: cfg.memo"],
  ['G8', 'a preview that is not dry accepted', "if (q?.dry !== true) throw new Error('follower: the withdraw preview", "if (false) throw new Error('follower: the withdraw preview"],
  ['G9', 'policy warnings ignored', "if (code.startsWith('policy_')) out.push(code);", ''],
  ['G10', 'would_succeed false ignored', "if (reply?.quote?.would_succeed === false) out.push('would_succeed: false');", ''],
  ['G11', 'a refused preview not acted on', '    if (codes.length) {\n      await event(\'payment_refused_by_policy\'', "    if (false) {\n      await event('payment_refused_by_policy'"],
  ['G12', 'a payment for another listing reused', "if (p && p.listingId !== cfg.approvedId) refuse(", 'if (false) refuse('],
  ['G13', 'a settled payment sent again', '    if (p?.claim) return p.claim;\n', ''],
  ['G14', 'the key saved after sending', "if (!p) { p = { listingId: cfg.approvedId, idempotencyKey: deps.newKey() }; await deps.state.setPayment(p); }",
    "if (!p) { p = { listingId: cfg.approvedId, idempotencyKey: deps.newKey() }; }"],
  ['G15', 'a new key at every send', 'st = await deps.agent.withdraw(withdrawOf(l), p.idempotencyKey);', 'st = await deps.agent.withdraw(withdrawOf(l), deps.newKey());'],
  ['G16', 'a known correlation id resent', 'if (!p.correlationId) {', 'if (true) {'],
  ['G17', 'every refusal taken as not sent', "if (x?.name === 'AgentApiError' && x.status >= 400 && x.status < 500 && x.retryable === false) {", 'if (true) {'],
  ['G18', 'a server error taken as not sent', 'x.status >= 400 && x.status < 500 &&', 'x.status >= 400 &&'],
  ['G19', 'a retryable refusal taken as not sent', ' && x.retryable === false) {', ') {'],
  ['G20', 'a refusal keeps the key', '          await deps.state.setPayment(null);\n', ''],
  ['G21', 'the correlation id not saved', '      p = { ...p, correlationId: st.correlation_id };\n      await deps.state.setPayment(p);', '      p = { ...p, correlationId: st.correlation_id };'],
  ['G22', 'the status not polled', "        st = await deps.agent.status(p.correlationId!);\n", '        st = st ?? {};\n'],
  ['G23', 'polling without end', 'if (!MOVING.has(st?.status) || now() >= end) break;', 'if (!MOVING.has(st?.status)) break;'],
  ['G24', 'a moving payment taken as failed', "if (MOVING.has(st?.status)) refuse(`follower: the payment is not settled", "if (false) refuse(`follower: the payment is not settled"],
  ['G25', 'a failed payment claimed', "if (st?.status !== 'SUCCESS') {", 'if (false) {'],
  ['G26', 'a claim without an intent hash', "if (typeof claim.intentHash !== 'string' || typeof claim.payer", "if (typeof claim.payer"],
  ['G27', 'the claim not saved', '    await deps.state.setPayment({ ...p, claim });\n', ''],
  ['G28', 'the window from the wrong field', 'windowFromMs: Date.parse(st.dispatch_committed_at)', 'windowFromMs: Date.parse(st.created_at)'],
  ['G29', 'a member claims again', "if (await deps.isMember(l.groupId)) { await event('admitted', { listingId: cfg.approvedId, already: true }); return; }", ''],
  ['G30', '202 taken as admitted', "if (r.status === 202 || (r.status === 422 && r.body?.error === 'intent hash already used')) { await waitMember(l.groupId); break; }",
    "if (r.status === 202 || (r.status === 422 && r.body?.error === 'intent hash already used')) { break; }"],
  ['G31', '"already used" taken as refused', " || (r.status === 422 && r.body?.error === 'intent hash already used')", ''],
  ['G32', '503 not retried', 'if (r.status === 503 && attempt < 5) {', 'if (false) {'],
  ['G33', '503 retried forever', 'r.status === 503 && attempt < 5', 'r.status === 503 && attempt < 50'],
  ['G34', 'no backoff', 'await sleep(poll * 2 ** attempt); continue;', 'await sleep(poll); continue;'],
  ['G35', 'waiting for admission without end', "if (now() >= end) refuse('follower: paid, but not admitted yet", "if (false) refuse('follower: paid, but not admitted yet"],
  ['G36', 'a refused feed not stopping the copies', 'if (e instanceof FeedRefused) { stopped = e.message; await event(\'feed_refused\'', "if (e instanceof FeedRefused) { await event('feed_refused'"],
  ['G37', 'copying without a verified feed', 'if (ended || stopped || !known) return;', 'if (ended || stopped) return;'],
  ['G38', 'membership not checked before copying', "if (!(await deps.isMember(l.groupId))) { ended = true; await event('access_ended', { listingId: cfg.approvedId }); return; }\n    let update;",
    '    let update;'],
  ['G39', 'access ended logged at every tick', 'if (ended || stopped || !known) return;', 'if (stopped || !known) return;'],
  ['G40', 'a refused live record not stopping the copies', "if (e instanceof FeedRefused) { stopped = e.message; await event('live_refused'", "if (e instanceof FeedRefused) { await event('live_refused'"],
  ['G41', 'a read refused after a revoke thrown', "      if (!(await deps.isMember(l.groupId))) { ended = true; await event('access_ended', { listingId: cfg.approvedId }); return; }\n      throw e;", '      throw e;'],
  ['G42', 'entries copied twice', '      if (done.has(e.transId)) continue;\n', ''],
  ['G43', 'stale entries copied', '      if (BigInt(e.recordNs) / 1_000_000n < BigInt(now() - maxAge)) {', '      if (false) {'],
  ['G44', 'the staleness bound off by one', 'BigInt(e.recordNs) / 1_000_000n < BigInt(now() - maxAge)', 'BigInt(e.recordNs) / 1_000_000n <= BigInt(now() - maxAge)'],
  ['G45', 'another default staleness', 'const maxAge = cfg.maxCopyAgeMs ?? 15 * 60_000;', 'const maxAge = cfg.maxCopyAgeMs ?? 30 * 60_000;'],
  ['G46', 'an oversized sell quoted', " || (d.side === 'sell' && BigInt(d.amount) > position)) {", ') {'],
  ['G47', 'a buy quoted as a sell', "const req = d.side === 'buy' ? { origin_asset: USDC, destination_asset: WNEAR, amount: d.amount }", "const req = d.side === 'buy' ? { origin_asset: WNEAR, destination_asset: USDC, amount: d.amount }"],
  ['G48', 'a non-dry swap reply accepted', "if (q?.dry !== true) throw new Error('follower: the swap reply", "if (false) throw new Error('follower: the swap reply"],
  ['G49', 'a refused copy recorded as copied', "await deps.state.addCopy({ transId: e.transId, outcome: 'refused', side: d.side, amount: d.amount, codes });\n        await event('copy_refused', { transId: e.transId, side: d.side, amount: d.amount, codes });\n        continue;",
    "await event('copy_refused', { transId: e.transId, side: d.side, amount: d.amount, codes });"],
  ['G50', 'a quote without amount_out accepted', "if (typeof out !== 'string' || !ATOMIC.test(out)) throw new Error(", 'if (false) throw new Error('],
  ['G51', 'known entries advanced before copying', '    const done = new Set(', '    known = [...known, ...update.entries];\n    const done = new Set('],
  ['G52', 'known entries never advanced', "    known = [...known, ...update.entries];   // only once", '    // only once'],
  ['G53', 'sells not subtracted from the position', "n += c.side === 'buy' ? BigInt(c.amountOut!) : -BigInt(c.amount!);", "n += c.side === 'buy' ? BigInt(c.amountOut!) : 0n;"],
  ['G54', 'refused copies counted in the position', "      if (c.outcome !== 'copied') continue;\n", ''],
  ['G55', 'usdcOf truncates', 'return (2n * num + den) / (2n * den);', 'return num / den;'],
  ['G56', 'the mirror sells more than held', 'const n = yoctoOf(entry.size) < positionYocto ? yoctoOf(entry.size) : positionYocto;', 'const n = yoctoOf(entry.size);'],
  ['G58', 'the verified feed not kept', '      await deps.state.addFeed(f.entries);\n', ''],
  ['G59', 'live entries not kept', '    if (update.entries.length) await deps.state.addFeed(update.entries);\n', ''],
  ['G60', 'the feed kept before it verifies', '      const f = await verifyFeed(l, deps.reader);\n      await deps.state.addFeed(f.entries);',
    '      await deps.state.addFeed((await deps.reader.listRecords(l.groupId)).map((r) => ({ transId: r.trans_id, recordNs: r.timestamp ?? \'0\', entry: {} as any })));\n      const f = await verifyFeed(l, deps.reader);'],
  ['G57', 'the mirror sells nothing as zero', "return n > 0n ? { side: 'sell', amount: n.toString() } : null;", "return { side: 'sell', amount: n.toString() };"],
];



const run = (modulePath) => spawnSync(TSX, [HARNESS], {
  cwd: root, encoding: 'utf8', timeout: 120_000, env: { ...process.env, FOLLOWER_MODULE: modulePath },
});

const dir = mkdtempSync(join(tmpdir(), 'follower-mutants-'));
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
