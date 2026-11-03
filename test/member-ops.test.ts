// member-ops.test.ts: harness for src/adapters/member-ops.ts (the seller's MemberOps over nova-sdk-js).
// No network: a fake NovaSdk that behaves like the contract (is_authorized, "User already a member",
// "User not a member") and a fake signer whose resolvePending is recorded or made to throw.
//
//   npx tsx test/member-ops.test.ts
//   MEMBER_OPS_MODULE=<path> npx tsx test/member-ops.test.ts     (the mutation script)
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { paymentRecorder, admitPaid, revokeExpired } from '../src/core/membership.ts';

const here = dirname(fileURLToPath(import.meta.url));
const modPath = process.env.MEMBER_OPS_MODULE ? resolve(process.env.MEMBER_OPS_MODULE) : resolve(here, '../src/adapters/member-ops.ts');
const M = await import(pathToFileURL(modPath).href);

type Json = any;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function ok(name: string, pass: boolean, detail?: unknown) {
  const d = detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ name, ok: pass, detail: d });
  console.log(`${pass ? '✓' : '✗'} ${name}${!pass && d ? ` — ${d}` : ''}`);
}
async function thrown(f: () => Promise<unknown>): Promise<unknown> { try { await f(); return undefined; } catch (e) { return e; } }

const G = 'agent-owned-20261030T073943Z';
const SELLER = '5a5d96f384a41ba3d1c90399dcd563ed6f52c34aa28ba5f200902a655d8ab288';
const BUYER = '9a45ea1ce599c5df4143001cddc0dd80e6a0a897f8665d0b6570a70c3ac93b35';

function fakeNova(opts: { authorizedReply?: unknown; failAdd?: Error } = {}) {
  const members = new Set([SELLER]);
  const calls: Json[] = [];
  return {
    members, calls,
    // nova-sdk-js 1.4.0: isAuthorized(groupId, userId?) defaults userId to the SDK's own account (the seller).
    isAuthorized: async (...args: Json[]) => {
      calls.push({ m: 'isAuthorized', args });
      if ('authorizedReply' in opts) return opts.authorizedReply;
      return members.has(args[1] ?? SELLER);
    },
    addGroupMember: async (...args: Json[]) => {
      calls.push({ m: 'addGroupMember', args });
      if (opts.failAdd) throw opts.failAdd;
      if (members.has(args[1])) throw new Error("Wallet transaction 'add_group_member' failed or was rejected: User already a member");
      members.add(args[1]);
      return `Added ${args[1]}`;
    },
    revokeGroupMember: async (...args: Json[]) => {
      calls.push({ m: 'revokeGroupMember', args });
      if (!members.has(args[1])) throw new Error("Wallet transaction 'revoke_group_member' failed or was rejected: User not a member");
      members.delete(args[1]);
      return `Revoked ${args[1]}`;
    },
  };
}
function fakeSigner(order: string[], pending?: Error) {
  return { resolvePending: async () => { order.push('resolvePending'); if (pending) throw pending; return null; } };
}

// ── reads ───────────────────────────────────────────────────────────────────────────────────
{
  const nova = fakeNova();
  const ops = M.memberOps(nova, fakeSigner([]));
  const no = await ops.isMember(G, BUYER);
  nova.members.add(BUYER);
  const yes = await ops.isMember(G, BUYER);
  ok('O1 isMember asks is_authorized for that group and that account', no === false && yes === true &&
    nova.calls.every((c: Json) => c.m === 'isAuthorized' && c.args[0] === G && c.args[1] === BUYER), nova.calls);
  const before = nova.calls.length;
  const errs = await Promise.all([thrown(() => ops.isMember(G, '')), thrown(() => ops.isMember(G, undefined as Json)), thrown(() => ops.isMember('', BUYER))]);
  ok('O2 an empty or missing account (which the SDK would replace with the seller, always a member) or group is refused before any call',
    errs.every((e) => e instanceof Error && /member-ops: an? (account|group id) is required/.test((e as Error).message)) && nova.calls.length === before,
    errs.map(String));
  const e = await thrown(() => M.memberOps(fakeNova({ authorizedReply: 'true' }), fakeSigner([])).isMember(G, BUYER));
  ok('O3 an is_authorized reply that is not a boolean is an error, never read as membership',
    e instanceof Error && (e as Error).message === 'member-ops: is_authorized did not return a boolean', String(e));
}

// ── writes ──────────────────────────────────────────────────────────────────────────────────
{
  const order: string[] = [];
  const nova = fakeNova();
  const realAdd = nova.addGroupMember;
  nova.addGroupMember = async (...a: Json[]) => { order.push('add'); return realAdd(...a); };
  const realRevoke = nova.revokeGroupMember;
  nova.revokeGroupMember = async (...a: Json[]) => { order.push('revoke'); return realRevoke(...a); };
  const ops = M.memberOps(nova, fakeSigner(order));
  await ops.add(G, BUYER);
  const addCall = nova.calls.find((c: Json) => c.m === 'addGroupMember');
  ok('O4 add settles any pending write first, then adds that account to that group, with no access window',
    order.join() === 'resolvePending,add' && addCall.args.length === 2 && addCall.args[0] === G && addCall.args[1] === BUYER && nova.members.has(BUYER),
    { order, args: addCall.args });
  await ops.revoke(G, BUYER);
  const revokeCall = nova.calls.find((c: Json) => c.m === 'revokeGroupMember');
  ok('O5 revoke settles any pending write first, then revokes that account from that group',
    order.join() === 'resolvePending,add,resolvePending,revoke' && revokeCall.args[0] === G && revokeCall.args[1] === BUYER && !nova.members.has(BUYER),
    order);
}
{
  const order: string[] = [];
  const pending = Object.assign(new Error('a NOVA write may have been sent (op_x): call resolvePending() later'), { name: 'NativeCallPendingError' });
  const nova = fakeNova();
  const ops = M.memberOps(nova, fakeSigner(order, pending));
  const e1 = await thrown(() => ops.add(G, BUYER));
  const e2 = await thrown(() => ops.revoke(G, SELLER));
  ok('O6 while an earlier write is unsettled, add and revoke send nothing and rethrow the pending error itself',
    e1 === pending && e2 === pending && !nova.calls.some((c: Json) => c.m !== 'isAuthorized'), nova.calls);
  const before = nova.calls.length;
  const e3 = await Promise.all([thrown(() => ops.add(G, '')), thrown(() => ops.revoke('', BUYER))]);
  ok('O7 a write with an empty account or group is refused before anything, the pending check included',
    e3.every((e) => e instanceof Error && /required/.test((e as Error).message)) && nova.calls.length === before && order.length === 2, { order });
  const sdkErr = new Error("Wallet transaction 'add_group_member' failed or was rejected: policy_denied");
  const e4 = await thrown(() => M.memberOps(fakeNova({ failAdd: sdkErr }), fakeSigner([])).add(G, BUYER));
  ok('O8 an SDK or Agent API refusal is rethrown unchanged', e4 === sdkErr);
}

// ── the seller's signing scope ──────────────────────────────────────────────────────────────
{
  const store = { get: async () => null, put: async () => {}, clear: async () => {} };
  const o = M.sellerSignerOptions(store);
  ok('O9 the seller may sign exactly upload, add and revoke (never register, retention, join)',
    JSON.stringify(o.methods) === JSON.stringify(['record_transaction', 'add_group_member', 'revoke_group_member']), o.methods);
  ok('O10 each call is capped at 0.01 NEAR, under revision 5\'s 0.06 NEAR wNEAR cap, with no per-method exception',
    o.maxDepositYocto === 10n ** 22n && o.maxDepositYocto < 6n * 10n ** 22n && o.maxDepositByMethod === undefined && o.store === store);
}

// ── with the membership core ────────────────────────────────────────────────────────────────
{
  const m = new Map<string, Json>();
  const ledger = { get: async (h: string) => m.get(h), put: async (r: Json) => { m.set(r.intentHash, r); }, all: async () => [...m.values()] };
  const listing = { listingId: 'ab'.repeat(32), groupId: G, seller: SELLER, periodMinutes: 60 };
  const nova = fakeNova();
  const ops = M.memberOps(nova, fakeSigner([]));
  await paymentRecorder(ledger, listing).add('ih1', { payer: BUYER, txHash: 't', intentHash: 'ih1', amount: '100000', token: 'u', proceedsAccount: 'p', blockMs: 0 });
  await admitPaid(ledger, ops, 1000);
  const admitted = nova.members.has(BUYER) && m.get('ih1').state === 'admitted';
  await revokeExpired(ledger, ops, 3_600_000);
  ok('O11 with the membership core: a verified payment admits the buyer, and its expiry revokes it (key rotated by the SDK)',
    admitted && !nova.members.has(BUYER) && m.get('ih1').state === 'revoked' && m.get('ih1').rotation === 'confirmed' && nova.members.has(SELLER),
    m.get('ih1'));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log('failed:'); for (const r of failed) console.log(`  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`); process.exit(1); }