// membership.test.ts: harness for src/core/membership.ts (the admissions ledger, admit, revoke at expiry).
// No network: an in-memory ledger and a fake group whose membership the fake NOVA calls change.
//
//   npx tsx test/membership.test.ts
//   MEMBERSHIP_MODULE=<path> npx tsx test/membership.test.ts     (the mutation script)
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const modPath = process.env.MEMBERSHIP_MODULE ? resolve(process.env.MEMBERSHIP_MODULE) : resolve(here, '../src/core/membership.ts');
const M = await import(pathToFileURL(modPath).href);

type Json = any;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function ok(name: string, pass: boolean, detail?: unknown) {
  const d = detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ name, ok: pass, detail: d });
  console.log(`${pass ? '✓' : '✗'} ${name}${!pass && d ? ` — ${d}` : ''}`);
}

const G = 'agent-owned-20261030T073943Z';
const SELLER = '5a5d96f384a41ba3d1c90399dcd563ed6f52c34aa28ba5f200902a655d8ab288';
const BUYER = 'follower-agent.near';
const OTHER = 'other-follower.near';
const LISTING = { listingId: 'ab'.repeat(32), groupId: G, seller: SELLER, periodMinutes: 60 };
const T0 = Date.parse('2026-11-03T10:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

function ledger() {
  const m = new Map<string, Json>();
  const puts: Json[] = [];
  return {
    m, puts,
    get: async (h: string) => (m.has(h) ? JSON.parse(JSON.stringify(m.get(h))) : undefined),
    put: async (r: Json) => { puts.push(JSON.parse(JSON.stringify(r))); m.set(r.intentHash, JSON.parse(JSON.stringify(r))); },
    all: async () => [...m.values()].map((r) => JSON.parse(JSON.stringify(r))),
  };
}
function group(initial: string[] = [SELLER], hooks: { addFails?: boolean; revokeFailsAfterChain?: boolean; isMemberFails?: boolean } = {}) {
  const members = new Set(initial);
  const calls: string[] = [];
  return {
    members, calls,
    isMember: async (g: string, a: string) => { calls.push(`isMember ${g} ${a}`); if (hooks.isMemberFails) throw new Error('RPC 503'); return members.has(a); },
    add: async (g: string, a: string) => {
      calls.push(`add ${g} ${a}`);
      if (hooks.addFails) throw new Error('Agent API 500');
      if (members.has(a)) throw new Error('User already a member');
      members.add(a);
    },
    revoke: async (g: string, a: string) => {
      calls.push(`revoke ${g} ${a}`);
      if (!members.has(a)) throw new Error('User not a member');
      members.delete(a);
      if (hooks.revokeFailsAfterChain) throw new Error('MCP rotate_key failed');
    },
  };
}
const payment = (payer: string, blockMs: number, n = 1) => ({ payer, txHash: `tx${n}`, intentHash: `ih${n}`, amount: '100000',
  token: 'usdc', proceedsAccount: '1000fans.near', blockMs });
async function pay(l: Json, payer: string, blockMs: number, n = 1, listing = LISTING) {
  await M.paymentRecorder(l, listing).add(`ih${n}`, payment(payer, blockMs, n));
}
async function thrown(f: () => Promise<unknown>): Promise<unknown> { try { await f(); return undefined; } catch (e) { return e; } }

// ── recording a verified payment ────────────────────────────────────────────────────────────
{
  const l = ledger();
  const rec = M.paymentRecorder(l, LISTING);
  const before = await rec.has('ih1');
  await rec.add('ih1', payment(BUYER, T0 + 5_000));
  const r = l.m.get('ih1');
  ok('M1 a verified payment is recorded as paid, with every field from the listing and the chain',
    !before && await rec.has('ih1') && r.state === 'paid' && r.member === BUYER && r.groupId === G && r.seller === SELLER &&
    r.listingId === LISTING.listingId && r.txHash === 'tx1' && r.blockMs === T0 + 5_000 && r.periodMinutes === 60, r);
  ok('M2 expiry = payment block time + period (on-chain facts, not the runner\'s clock)', r.expiresAtMs === T0 + 5_000 + HOUR, r.expiresAtMs);
  const e = await thrown(() => rec.add('ih1', payment(BUYER, T0 + 9_000)));
  ok('M3 the same intent hash cannot be recorded twice', e instanceof M.MembershipRefused && (e as Error).message === 'membership: intent hash already recorded' &&
    l.m.get('ih1').blockMs === T0 + 5_000, String(e));
  const e2 = await thrown(() => rec.add('ih2', payment(SELLER, T0, 2)));
  ok('M4 the seller cannot buy its own listing (nothing recorded)', e2 instanceof M.MembershipRefused &&
    (e2 as Error).message === 'membership: the seller cannot buy its own listing' && !l.m.has('ih2'), String(e2));
}
{
  const l = ledger();
  await pay(l, BUYER, T0, 1);                    // expires T0 + 1h
  await pay(l, BUYER, T0 + 20 * MIN, 2);          // renewal while live: from T0 + 1h → T0 + 2h
  await pay(l, BUYER, T0 + 5 * HOUR, 3);          // after expiry: from the block → T0 + 6h
  await pay(l, OTHER, T0 + 30 * MIN, 4);          // another member: its own expiry
  ok('M5 a renewal extends from the member\'s current expiry, a late payment from its own block, members are independent',
    l.m.get('ih2').expiresAtMs === T0 + 2 * HOUR && l.m.get('ih3').expiresAtMs === T0 + 6 * HOUR && l.m.get('ih4').expiresAtMs === T0 + 90 * MIN,
    [l.m.get('ih2').expiresAtMs - T0, l.m.get('ih3').expiresAtMs - T0, l.m.get('ih4').expiresAtMs - T0]);
  const l2 = ledger();
  await pay(l2, BUYER, T0, 1, { ...LISTING, groupId: 'another-group' });
  await pay(l2, BUYER, T0 + 20 * MIN, 2);
  ok('M6 a live record in another group does not extend this group\'s expiry', l2.m.get('ih2').expiresAtMs === T0 + 80 * MIN, l2.m.get('ih2').expiresAtMs - T0);
}

{
  const l = ledger(); const g = group();
  await pay(l, BUYER, T0, 1);                      // period T0 → T0 + 1h
  await M.admitPaid(l, g, T0 + MIN);
  await M.revokeExpired(l, g, T0 + HOUR);          // revoked at T0 + 1h
  await pay(l, BUYER, T0 + 50 * MIN, 2);           // paid at T0 + 50 min (inside the period), verified after the revoke
  ok('M7 a renewal paid inside the period but verified after its revoke still extends from that period\'s end',
    l.m.get('ih2').expiresAtMs === T0 + 2 * HOUR, l.m.get('ih2').expiresAtMs - T0);
}

// ── admit ───────────────────────────────────────────────────────────────────────────────────
{
  const l = ledger(); const g = group();
  await pay(l, BUYER, T0);
  const changed = await M.admitPaid(l, g, T0 + MIN);
  const r = l.m.get('ih1');
  ok('M8 a paid record is admitted: the buyer is added to the listing\'s group and the record says when',
    g.members.has(BUYER) && g.calls.includes(`add ${G} ${BUYER}`) && r.state === 'admitted' && r.admittedAtMs === T0 + MIN &&
    changed.length === 1, { calls: g.calls, r });
  const again = await M.admitPaid(l, g, T0 + 2 * MIN);
  ok('M9 admitting again does nothing (no call, no change)', again.length === 0 && g.calls.filter((c) => c.startsWith('add')).length === 1, g.calls);
}
{
  const l = ledger(); const g = group([SELLER, BUYER]);
  await pay(l, BUYER, T0);
  await M.admitPaid(l, g, T0 + MIN);
  ok('M10 a buyer already in the group (a crash after the on-chain add) is marked admitted without a second add',
    l.m.get('ih1').state === 'admitted' && !g.calls.some((c) => c.startsWith('add')), g.calls);
}
{
  const l = ledger(); const g = group();
  await pay(l, BUYER, T0);
  const changed = await M.admitPaid(l, g, T0 + HOUR);
  ok('M11 a paid record whose period already ended is marked lapsed and never admitted',
    l.m.get('ih1').state === 'lapsed' && !g.members.has(BUYER) && g.calls.length === 0 && changed[0]?.state === 'lapsed', { calls: g.calls, r: l.m.get('ih1') });
}
{
  const l = ledger(); const g = group([SELLER], { addFails: true });
  await pay(l, BUYER, T0);
  const e = await thrown(() => M.admitPaid(l, g, T0 + MIN));
  ok('M12 a failed add is rethrown and the record stays paid (retried on the next pass)',
    e instanceof Error && (e as Error).message === 'Agent API 500' && l.m.get('ih1').state === 'paid', String(e));
}
{
  const l = ledger(); const g = group();
  await l.put({ intentHash: 'ihS', listingId: 'x', groupId: G, seller: SELLER, member: SELLER, txHash: 't', blockMs: T0, periodMinutes: 1,
    expiresAtMs: T0 + MIN, state: 'paid' });
  await M.admitPaid(l, g, T0);
  ok('M13 the seller is never added to its own group, whatever the ledger holds', g.calls.length === 0 && l.m.get('ihS').state === 'paid', g.calls);
}

// ── revoke at expiry ────────────────────────────────────────────────────────────────────────
{
  const l = ledger(); const g = group();
  await pay(l, BUYER, T0);
  await M.admitPaid(l, g, T0 + MIN);
  const early = await M.revokeExpired(l, g, T0 + HOUR - 1);
  ok('M14 nothing is revoked 1 ms before the on-chain expiry', early.length === 0 && g.members.has(BUYER) && !g.calls.some((c) => c.startsWith('revoke')));
  const changed = await M.revokeExpired(l, g, T0 + HOUR);
  const r = l.m.get('ih1');
  ok('M15 at expiry the buyer is revoked (key rotated by the SDK\'s follow-up) and the record says when',
    !g.members.has(BUYER) && g.calls.includes(`revoke ${G} ${BUYER}`) && r.state === 'revoked' && r.revokedAtMs === T0 + HOUR &&
    r.rotation === 'confirmed' && changed.length === 1, { calls: g.calls, r });
  const again = await M.revokeExpired(l, g, T0 + 2 * HOUR);
  ok('M16 revoking again does nothing', again.length === 0 && g.calls.filter((c) => c.startsWith('revoke')).length === 1);
}
{
  const l = ledger(); const g = group();
  await pay(l, BUYER, T0, 1);
  await M.admitPaid(l, g, T0 + MIN);
  await pay(l, BUYER, T0 + 30 * MIN, 2);  // renewal → T0 + 2h
  await M.admitPaid(l, g, T0 + 31 * MIN);
  const atFirst = await M.revokeExpired(l, g, T0 + HOUR);
  ok('M17 a renewed member is kept when its first period ends', atFirst.length === 0 && g.members.has(BUYER) && l.m.get('ih1').state === 'admitted');
  const atSecond = await M.revokeExpired(l, g, T0 + 2 * HOUR);
  ok('M18 when every period has ended, one revoke closes all of the member\'s records',
    g.calls.filter((c) => c.startsWith('revoke')).length === 1 && atSecond.length === 2 &&
    l.m.get('ih1').state === 'revoked' && l.m.get('ih2').state === 'revoked', { calls: g.calls, n: atSecond.length });
}
{
  const l = ledger(); const g = group();
  await pay(l, BUYER, T0, 1);
  await M.admitPaid(l, g, T0 + MIN);
  await pay(l, BUYER, T0 + 30 * MIN, 2);   // paid, not admitted yet, live until T0 + 2h
  const r = await M.revokeExpired(l, g, T0 + HOUR);
  ok('M19 a paid but not yet admitted renewal also keeps the member', r.length === 0 && g.members.has(BUYER));
}
{
  const l = ledger(); const g = group([SELLER], { revokeFailsAfterChain: true });
  await pay(l, BUYER, T0);
  await M.admitPaid(l, g, T0 + MIN);
  const e = await thrown(() => M.revokeExpired(l, g, T0 + HOUR));
  const stillAdmitted = l.m.get('ih1').state === 'admitted';
  await M.revokeExpired(l, g, T0 + HOUR + MIN);
  const r = l.m.get('ih1');
  ok('M20 a revoke whose chain step landed but whose rotation failed: rethrown, then marked revoked with rotation unconfirmed, no second revoke',
    e instanceof Error && stillAdmitted && r.state === 'revoked' && r.rotation === 'unconfirmed' && r.revokedAtMs === T0 + HOUR + MIN &&
    g.calls.filter((c) => c.startsWith('revoke')).length === 1, { e: String(e), r, calls: g.calls });
}
{
  const l = ledger(); const g = group([SELLER], { isMemberFails: true });
  await l.put({ intentHash: 'ih1', listingId: 'x', groupId: G, seller: SELLER, member: BUYER, txHash: 't', blockMs: T0, periodMinutes: 60,
    expiresAtMs: T0 + HOUR, state: 'admitted', admittedAtMs: T0 });
  const e = await thrown(() => M.revokeExpired(l, g, T0 + HOUR));
  ok('M21 a failed chain read is rethrown and the record is left as it was', e instanceof Error && l.m.get('ih1').state === 'admitted' &&
    !g.calls.some((c) => c.startsWith('revoke')), String(e));
}
{
  const l = ledger(); const g = group([SELLER, BUYER, OTHER]);
  await l.put({ intentHash: 'ihS', listingId: 'x', groupId: G, seller: SELLER, member: SELLER, txHash: 't', blockMs: T0, periodMinutes: 1,
    expiresAtMs: T0 + MIN, state: 'admitted', admittedAtMs: T0 });
  await pay(l, OTHER, T0, 2);
  await M.admitPaid(l, g, T0 + MIN);
  await M.revokeExpired(l, g, T0 + 2 * HOUR);
  ok('M22 the seller is never revoked from its own group; members are revoked independently (BUYER, with no record, is left alone)',
    g.members.has(SELLER) && !g.calls.includes(`revoke ${G} ${SELLER}`) && !g.members.has(OTHER) && g.members.has(BUYER), g.calls);
}
{
  const l = ledger(); const g = group();
  await pay(l, BUYER, T0, 1);                       // BUYER until T0 + 1h
  await pay(l, OTHER, T0, 2);                       // OTHER until T0 + 1h ...
  await pay(l, OTHER, T0 + 30 * MIN, 3);            // ... renewed until T0 + 2h
  await M.admitPaid(l, g, T0 + MIN);
  await M.revokeExpired(l, g, T0 + HOUR);
  ok('M23 one member\'s renewal does not keep another member whose period ended',
    !g.members.has(BUYER) && g.members.has(OTHER) && l.m.get('ih1').state === 'revoked' && l.m.get('ih2').state === 'admitted', g.calls);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log('failed:'); for (const r of failed) console.log(`  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`); process.exit(1); }