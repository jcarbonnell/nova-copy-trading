// follower-service.test.ts: harness for src/follower/follower-service.ts (the follower's logic, dependencies injected).
// No network. The world: a seller journal faked as nova-reader returns it, listings built by the seller's own
// listing builder and served by a fake seller endpoint, a fake follower agent (dry withdraw previews refused for
// any recipient but 1000fans.near, withdrawals that settle, dry swap quotes refused above 0.15 USDC), and
// in-memory follower state. The core checks (parseListing, verifyFeed, verifyLiveEntries) run for real.
//
//   npx tsx test/follower-service.test.ts
//   FOLLOWER_MODULE=<path> npx tsx test/follower-service.test.ts     (the mutation script)
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodeEntry, decodeEntry, type JournalEntry, type TxRow } from '../src/core/journal.ts';
import { buildListing } from '../src/seller/listing-builder.ts';

const here = dirname(fileURLToPath(import.meta.url));
const modPath = process.env.FOLLOWER_MODULE ? resolve(process.env.FOLLOWER_MODULE) : resolve(here, '../src/follower/follower-service.ts');
const F = await import(pathToFileURL(modPath).href);

type Json = any;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function ok(name: string, pass: boolean, detail?: unknown) {
  const d = detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail, (_k, v) => typeof v === 'bigint' ? `${v}n` : v);
  results.push({ name, ok: pass, detail: d });
  console.log(`${pass ? '✓' : '✗'} ${name}${!pass && d ? ` — ${d}` : ''}`);
}
async function thrown(f: () => Promise<unknown>): Promise<Json> { try { await f(); return { name: 'none', message: 'no error' }; } catch (e) { return e; } }
const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');

const G = 'agent-owned-20261030T073943Z';
const SELLER = 'aa'.repeat(32);
const PAYER = '9a45ea1ce599c5df4143001cddc0dd80e6a0a897f8665d0b6570a70c3ac93b35';
const USDC_C = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const T0 = Date.parse('2026-11-09T10:00:00.000Z');
const nsOf = (ms: number) => (BigInt(ms) * 1_000_000n).toString();
const SECRET = 'seller-secret-reasoning';
const TERMS = { seller: SELLER, groupId: G, proceedsAccount: '1000fans.near', token: USDC_C, price: '100000', periodMinutes: 60, simulated: true };
const IH = 'B2btEHKa3W2DcSo51dYoEAMghbmHqEUKg78BwSPK3UbY';

function world() {
  const w: Json = { clock: T0, rows: [] as TxRow[], files: {} as Record<string, Uint8Array>, members: new Set<string>([SELLER]), listings: new Map<string, Json>(),
    calls: [] as string[], payment: null, copies: [] as Json[], feed: [] as Json[], events: [] as Json[], keys: 0, statusSeq: ['PROCESSING', 'SUCCESS'], posts: [] as Json[] };
  w.add = (side: 'buy' | 'sell', size: string, price: string, user = SELLER) => {
    const e: JournalEntry = { v: 1, simulated: true, ts: new Date(w.clock - 1000).toISOString(), pair: 'NEAR/USDC', side, size, price,
      reasoning: SECRET, correlation_id: null, salt: sha(`${w.clock}${side}${size}`) };
    const bytes = encodeEntry(e);
    const r: Json = { group_id: G, user_id: user, file_hash: sha(bytes), ipfs_hash: `fastfs/e-${w.rows.length}`, timestamp: nsOf(w.clock), deleted: null };
    r.trans_id = sha(`${r.group_id}${r.user_id}${r.file_hash}${r.ipfs_hash}${r.timestamp}`);
    w.rows.push(r); w.files[r.ipfs_hash] = bytes; w.clock += 60_000;
    return r;
  };
  w.reader = {
    listRecords: async () => { if (w.revokedReads && !w.members.has(PAYER)) throw new Error('not a member'); return w.rows.map((r: Json) => ({ ...r })); },
    retrieve: async (_g: string, ref: string) => { w.retrieves = (w.retrieves ?? 0) + 1; if (!w.members.has(PAYER) && w.guardRetrieve) throw new Error('not a member'); return new Uint8Array(w.files[ref]); },
  };
  w.publish = async (terms: Json = TERMS) => { const b = await buildListing(w.reader, terms, { now: () => w.clock }); w.listings.set(b.id, b.listing); return b; };
  w.seller = {
    get: async (path: string) => { w.calls.push(`GET ${path}`); const m = /^\/listings\/(.+)$/.exec(path); const l = m && w.listings.get(m[1]);
      if (l && w.swapTo) return { status: 200, body: { id: w.swapTo, listing: w.listings.get(w.swapTo) } };
      return l ? { status: 200, body: { id: m![1], listing: w.tamper ? { ...l, price: '1' } : l } } : { status: 404, body: { error: 'unknown listing' } }; },
    post: async (path: string, body: string) => { w.calls.push(`POST ${path}`); w.posts.push(JSON.parse(body));
      const r = w.claimReplies?.length ? w.claimReplies.shift() : { status: 200, body: { member: PAYER, state: 'admitted' } };
      if (r.admit) w.members.add(PAYER);
      if (r.status === 200) w.members.add(PAYER);
      return r; },
  };
  w.agent = {
    previewWithdraw: async (req: Json) => { w.calls.push(`preview ${req.recipient} ${req.amount} ${req.memo}`);
      if (w.previewReply) return w.previewReply;
      return req.recipient === '1000fans.near' ? { dry: true, warnings: [], quote: { would_succeed: true } }
        : { dry: true, warnings: [{ code: 'policy_destination_denied' }], quote: { would_succeed: false } }; },
    withdraw: async (req: Json, key: string) => { w.calls.push(`withdraw ${key}`); w.keyAtSend = w.payment?.idempotencyKey;
      if (w.withdrawFail) { const e = w.withdrawFail; w.withdrawFail = null; throw e; }
      return { correlation_id: 'corr-1', status: 'PROCESSING', idempotencyKey: key }; },
    status: async (c: string) => { w.calls.push(`status ${c}`);
      if (w.statusFail) { const e = w.statusFail; w.statusFail = null; throw e; }
      const s = w.statusSeq.length > 1 ? w.statusSeq.shift() : w.statusSeq[0];
      return { correlation_id: c, status: s, failure_code: s === 'FAILED' ? 'insufficient_balance' : null,
        dispatch_committed_at: new Date(T0 + 3_600_000).toISOString(), updated_at: new Date(T0 + 3_605_000).toISOString(),
        details: w.noIntent ? { near_account_id: PAYER } : { intent_hash: IH, near_account_id: PAYER } }; },
    quoteSwap: async (req: Json) => { w.calls.push(`swap ${req.origin_asset === F.USDC ? 'buy' : 'sell'} ${req.amount}`);
      if (w.swapReply) return w.swapReply;
      if (req.origin_asset === F.USDC && BigInt(req.amount) > 150000n) return { dry: true, warnings: [{ code: 'policy_transaction_limit_exceeded' }], quote: { would_succeed: false, amount_out: '1' } };
      return { dry: true, warnings: [], quote: { would_succeed: true,
        amount_out: req.origin_asset === F.USDC ? (BigInt(req.amount) * 4n * 10n ** 17n).toString() : (BigInt(req.amount) / (4n * 10n ** 17n)).toString() } }; },
  };
  w.state = {
    getPayment: async () => (w.payment ? JSON.parse(JSON.stringify(w.payment)) : null),
    setPayment: async (p: Json) => { w.payment = p ? JSON.parse(JSON.stringify(p)) : null; },
    copies: async () => w.copies.map((c: Json) => ({ ...c })),
    addCopy: async (c: Json) => { w.copies.push({ ...c }); },
    addFeed: async (es: Json[]) => { for (const e of es) if (!w.feed.some((f: Json) => f.transId === e.transId)) w.feed.push(JSON.parse(JSON.stringify(e))); },
    appendEvent: async (e: Json) => { w.events.push(e); },
  };
  return w;
}
const start = (w: Json, cfg: Json = {}) => F.createFollowerService({ seller: w.seller, agent: w.agent, reader: w.reader,
  isMember: async () => { w.calls.push('isMember'); return w.members.has(PAYER); }, decider: F.mirrorDecider, state: w.state,
  newKey: () => `key-${++w.keys}`, now: () => w.clock, sleep: async (ms: number) => { w.clock += ms; w.calls.push(`sleep ${ms}`); } },
  { approvedId: cfg.approvedId, maxPrice: '150000', memo: 'copytrade', pollMs: 1000, ...cfg });
const kinds = (w: Json) => w.events.map((e: Json) => e.kind);
const since = (w: Json, n: number) => w.calls.slice(n);

// ── approve ─────────────────────────────────────────────────────────────────────────────────
async function listed() {
  const w = world();
  w.add('buy', '0.04', '2.5'); w.add('buy', '0.04', '2.5'); w.add('sell', '0.02', '3');
  const b = await w.publish();
  return { w, b };
}
{
  const { w, b } = await listed();
  w.add('buy', '1', '2'); const later = await w.publish();
  const s = start(w, { approvedId: b.id });
  const l = await s.approve();
  ok('A1 the listing is fetched by the approved id (not the seller\'s latest) and parsed against it',
    w.calls[0] === `GET /listings/${b.id}` && l.fingerprint.count === 3 && later.id !== b.id && kinds(w).join() === 'listing_approved', w.calls);
  const e1 = await thrown(() => start(w, { approvedId: 'cd'.repeat(32) }).approve());
  w.tamper = true;
  const e2 = await thrown(() => start(w, { approvedId: b.id }).approve());
  w.tamper = false;
  w.swapTo = later.id;
  const e5 = await thrown(() => start(w, { approvedId: b.id }).approve());
  w.swapTo = undefined;
  ok('A2b a seller answering with another (valid) listing under its own id is refused: only the approved id counts',
    e5 instanceof F.FollowerRefused && e5.message === 'follower: listing: id differs from the approved one', e5.message);
  ok('A2 a listing the seller does not serve, or one that does not hash to the approved id, is refused',
    e1 instanceof F.FollowerRefused && e1.message === `follower: the seller does not serve listing ${'cd'.repeat(6)} (HTTP 404)` &&
    e2 instanceof F.FollowerRefused && e2.message === 'follower: listing: id differs from the approved one', [e1.message, e2.message]);
  const usdt = await w.publish({ ...TERMS, token: 'usdt.tether-token.near' });
  const pricey = await w.publish({ ...TERMS, price: '150001' });
  const atMax = await w.publish({ ...TERMS, price: '150000' });
  const e3 = await thrown(() => start(w, { approvedId: usdt.id }).approve());
  const e4 = await thrown(() => start(w, { approvedId: pricey.id }).approve());
  const okMax = await start(w, { approvedId: atMax.id }).approve();
  ok('A3 a listing not priced in USDC, or above the owner\'s maximum, is refused; exactly the maximum is accepted',
    e3.message === 'follower: the listing is not priced in USDC' && e4.message === "follower: the price 150001 is above the owner's maximum 150000" &&
    okMax.price === '150000', [e3.message, e4.message]);
}

// ── preview (beat 2) ────────────────────────────────────────────────────────────────────────
{
  const { w, b } = await listed();
  const hostile = await w.publish({ ...TERMS, proceedsAccount: 'listing-99.near' });
  const s = start(w, { approvedId: hostile.id });
  const l = await s.approve();
  const e = await thrown(() => s.preview(l));
  ok('P1 a listing paying another account is refused by the owner\'s policy on the dry preview, naming the codes; nothing is paid',
    e instanceof F.FollowerRefused && e.message === "follower: the owner's policy refuses paying this listing (policy_destination_denied, would_succeed: false)" &&
    w.calls.includes('preview listing-99.near 100000 copytrade') && !w.calls.some((c: string) => c.startsWith('withdraw')) &&
    w.events.at(-1).kind === 'payment_refused_by_policy' && w.events.at(-1).recipient === 'listing-99.near', { e: e.message, calls: w.calls });
  const s2 = start(w, { approvedId: b.id });
  const q = await s2.preview(await s2.approve());
  ok('P2 the real listing\'s preview (its price, to 1000fans.near, memo copytrade) passes', q.dry === true && w.calls.includes('preview 1000fans.near 100000 copytrade'));
  const l2 = await s2.approve();
  w.previewReply = { dry: false, correlation_id: 'x' };
  const e2 = await thrown(() => s2.preview(l2));
  w.previewReply = { dry: true, warnings: [{ code: 'insufficient_balance' }], quote: { would_succeed: true } };
  const q2 = await s2.preview(l2);
  ok('P3 a preview that is not a dry quote is an error; a non-policy warning alone does not refuse',
    !(e2 instanceof F.FollowerRefused) && e2.message === 'follower: the withdraw preview is not a dry quote; stop and inspect' && q2.dry === true, e2.message);
}

// ── pay ─────────────────────────────────────────────────────────────────────────────────────
{
  const { w, b } = await listed();
  const s = start(w, { approvedId: b.id });
  const l = await s.approve();
  const c = await s.pay(l);
  ok('Y1 the key is saved before the withdraw is sent; the status is polled to SUCCESS; the claim comes from it',
    w.keyAtSend === 'key-1' && w.calls.filter((x: string) => x.startsWith('withdraw')).join() === 'withdraw key-1' &&
    JSON.stringify(c) === JSON.stringify({ intentHash: IH, payer: PAYER, windowFromMs: T0 + 3_600_000, windowToMs: T0 + 3_605_000 }) &&
    w.payment.claim.intentHash === IH && w.payment.correlationId === 'corr-1' && kinds(w).slice(-2).join() === 'payment_sent,payment_settled', { c, calls: w.calls });
  const n = w.calls.length;
  const again = await start(w, { approvedId: b.id }).pay(l);
  ok('Y2 a payment already settled is never sent again: its claim is returned', since(w, n).length === 0 && again.intentHash === IH, since(w, n));
}
{
  const { w, b } = await listed();
  const l = await start(w, { approvedId: b.id }).approve();
  w.withdrawFail = new Error('socket hang up');
  const e = await thrown(() => start(w, { approvedId: b.id }).pay(l));
  const key = w.payment?.idempotencyKey;
  const c = await start(w, { approvedId: b.id }).pay(l);
  ok('Y3 a withdraw that may have gone out keeps its key; the next run replays it under the same key, never a new one',
    e.message === 'socket hang up' && key === 'key-1' && w.calls.filter((x: string) => x.startsWith('withdraw')).join() === 'withdraw key-1,withdraw key-1' &&
    w.keys === 1 && c.intentHash === IH, w.calls);
}
{
  const { w, b } = await listed();
  const l = await start(w, { approvedId: b.id }).approve();
  w.statusFail = new Error('timeout');
  await thrown(() => start(w, { approvedId: b.id }).pay(l));
  const n = w.calls.length;
  const c = await start(w, { approvedId: b.id }).pay(l);
  ok('Y4 once the correlation id is saved, a later run only polls the status', !since(w, n).some((x: string) => x.startsWith('withdraw')) &&
    since(w, n).includes('status corr-1') && c.intentHash === IH, since(w, n));
}
{
  const { w, b } = await listed();
  const l = await start(w, { approvedId: b.id }).approve();
  w.withdrawFail = Object.assign(new Error('denied'), { name: 'AgentApiError', status: 409, code: 'policy_denied', retryable: false });
  const e = await thrown(() => start(w, { approvedId: b.id }).pay(l));
  ok('Y5 a refusal documented as sending nothing clears the key and refuses', e instanceof F.FollowerRefused &&
    e.message === 'follower: the Agent API refused the payment: 409 policy_denied' && w.payment === null && w.events.at(-1).kind === 'payment_refused', e.message);
  w.withdrawFail = Object.assign(new Error('slow down'), { name: 'AgentApiError', status: 429, code: 'rate_limited', retryable: true });
  const e2 = await thrown(() => start(w, { approvedId: b.id }).pay(l));
  w.withdrawFail = Object.assign(new Error('boom'), { name: 'AgentApiError', status: 502, code: 'upstream', retryable: false });
  const k1 = w.payment?.idempotencyKey;
  const e3 = await thrown(() => start(w, { approvedId: b.id }).pay(l));
  ok('Y6 a retryable refusal or a server error keeps the key (maybe sent)', e2.message === 'slow down' && e3.message === 'boom' &&
    w.payment?.idempotencyKey === k1 && k1 === 'key-2', { k1, p: w.payment });
}
{
  const { w, b } = await listed();
  const l = await start(w, { approvedId: b.id }).approve();
  w.statusSeq = ['FAILED'];
  const e = await thrown(() => start(w, { approvedId: b.id }).pay(l));
  ok('Y7 a payment that ends FAILED stops, with its status and code', e instanceof F.FollowerRefused &&
    e.message === 'follower: the payment ended FAILED (insufficient_balance)' && w.events.at(-1).kind === 'payment_failed', e.message);
  const v = world(); v.add('buy', '0.04', '2.5'); const vb = await v.publish(); const vl = await start(v, { approvedId: vb.id }).approve();
  v.statusSeq = ['PROCESSING'];
  const e2 = await thrown(() => start(v, { approvedId: vb.id, payWaitMs: 5000 }).pay(vl));
  ok('Y8 a payment still moving after payWaitMs is left to resume, not failed', e2.message === 'follower: the payment is not settled (PROCESSING); run again to resume it' &&
    v.payment.correlationId === 'corr-1' && !v.payment.claim && v.calls.filter((x: string) => x === 'status corr-1').length >= 5, e2.message);
  const x = world(); x.add('buy', '0.04', '2.5'); const xb = await x.publish(); const xl = await start(x, { approvedId: xb.id }).approve();
  x.noIntent = true;
  const e3 = await thrown(() => start(x, { approvedId: xb.id }).pay(xl));
  ok('Y9 a SUCCESS without an intent hash cannot be claimed: refused', e3.message === 'follower: the payment succeeded but its status has no intent hash, account or window', e3.message);
  x.payment = { listingId: 'ee'.repeat(32), idempotencyKey: 'k' };
  const e4 = await thrown(() => start(x, { approvedId: xb.id }).pay(xl));
  ok('Y10 a payment on record for another listing is refused', e4.message === `follower: a payment for another listing (${'ee'.repeat(6)}) is on record`, e4.message);
}

// ── claim ───────────────────────────────────────────────────────────────────────────────────
async function paid(replies?: Json[]) {
  const { w, b } = await listed();
  const s = start(w, { approvedId: b.id, admitWaitMs: 10_000 });
  const l = await s.approve(); const c = await s.pay(l);
  if (replies) w.claimReplies = replies;
  return { w, b, s, l, c };
}
{
  const { w, s, l, c, b } = await paid();
  await s.claim(l, c);
  ok('C1 a claim names the listing and the payment; 200 → admitted', JSON.stringify(w.posts[0]) === JSON.stringify({ listingId: b.id, ...c }) &&
    w.members.has(PAYER) && w.events.at(-1).kind === 'admitted', w.posts[0]);
  const n = w.calls.length;
  await s.claim(l, c);
  ok('C2 already a member: no claim is sent', since(w, n).join() === 'isMember' && w.events.at(-1).already === true, since(w, n));
}
{
  const fails = [];
  for (const reply of [{ status: 202, body: { state: 'paid' } }, { status: 422, body: { error: 'intent hash already used' } }]) {
    const { w, s, l, c } = await paid([reply]);
    setTimeout(() => {}, 0);
    let polls = 0;
    const orig = w.members.has.bind(w.members);
    w.members.has = (a: string) => { if (a === PAYER && ++polls >= 3) w.members.add(PAYER); return orig(a); };
    await s.claim(l, c);
    if (w.posts.length !== 1 || w.events.at(-1).kind !== 'admitted' || !w.calls.some((x: string) => x.startsWith('sleep'))) fails.push(`${reply.status}: ${JSON.stringify(w.calls.slice(-6))}`);
  }
  ok('C3 202 or "intent hash already used" → wait until a member, never claim or pay again', fails.length === 0, fails);
}
{
  const { w, s, l, c } = await paid([{ status: 503, body: {} }, { status: 503, body: {} }, { status: 200, body: {} }]);
  await s.claim(l, c);
  ok('C4 503 → the claim is sent again with backoff', w.posts.length === 3 && w.calls.includes('sleep 1000') && w.calls.includes('sleep 2000') && w.members.has(PAYER), w.calls.slice(-8));
  const p2 = await paid(Array.from({ length: 6 }, () => ({ status: 503, body: {} })));
  const e = await thrown(() => p2.s.claim(p2.l, p2.c));
  ok('C5 503 six times → stops', p2.w.posts.length === 6 && e.message === 'follower: the seller refused the claim (HTTP 503): no message', e.message);
}
{
  const { w, s, l, c } = await paid([{ status: 422, body: { error: 'payment not found in the claimed window' } }]);
  const e = await thrown(() => s.claim(l, c));
  ok('C6 any other refusal stops with the seller\'s message', e instanceof F.FollowerRefused &&
    e.message === 'follower: the seller refused the claim (HTTP 422): payment not found in the claimed window' && w.events.at(-1).kind === 'claim_refused', e.message);
  const p2 = await paid([{ status: 202, body: {} }]);
  const e2 = await thrown(() => p2.s.claim(p2.l, p2.c));
  ok('C7 202 and never admitted within admitWaitMs → stops, saying nothing will be paid again',
    e2.message === 'follower: paid, but not admitted yet; run again later (nothing will be paid again)' && p2.w.posts.length === 1, e2.message);
}

// ── verify and copy ─────────────────────────────────────────────────────────────────────────
async function admitted(cfg: Json = {}) {
  const { w, b } = await listed();
  const s = start(w, { approvedId: b.id, ...cfg });
  const l = await s.approve(); await s.claim(l, await s.pay(l)); await s.verify(l);
  return { w, b, s, l };
}
{
  const { w, b } = await listed();
  const s0 = start(w, { approvedId: b.id });
  const l0 = await s0.approve(); await s0.claim(l0, await s0.pay(l0));
  w.add('buy', '0.02', '2.5');
  const n0 = w.calls.length;
  await s0.copyTick(l0);
  ok('K0 nothing is copied before the feed is verified', since(w, n0).length === 0 && w.copies.length === 0, since(w, n0));
}
{
  const { w, s, l } = await admitted();
  ok('V1 the feed verifies: count, root and realised P&L are logged', w.events.at(-1).kind === 'feed_verified' && w.events.at(-1).count === 3 &&
    w.events.at(-1).root === l.fingerprint.root && w.events.at(-1).realised === '0.010000', w.events.at(-1));
  ok('B1 the verified entries are kept in the follower\'s feed, in chain order, as decoded (option A)',
    w.feed.map((f: Json) => f.transId).join() === w.rows.slice(0, 3).map((r: Json) => r.trans_id).join() &&
    w.feed.every((f: Json, i: number) => f.recordNs === w.rows[i].timestamp && f.entry.reasoning === SECRET && f.entry.size === ['0.04', '0.04', '0.02'][i]), w.feed.length);
  w.add('buy', '0.02', '2.5');          // 0.05 USDC
  w.add('buy', '0.06', '3');            // 0.18 USDC: above the follower's 0.15
  w.add('sell', '0.03', '3');
  const n = w.calls.length;
  await s.copyTick(l);
  const pos = await s.positionYocto();
  ok('B2 each new live entry joins the feed once verified, including the one whose copy is refused', w.feed.length === 6 &&
    w.feed.slice(3).map((f: Json) => f.transId).join() === w.rows.slice(3, 6).map((r: Json) => r.trans_id).join(), w.feed.length);
  ok('K1 a new buy is copied 1:1 in USDC (size × price) as a dry swap', since(w, n).includes('swap buy 50000') && w.copies[0].outcome === 'copied', since(w, n));
  ok('K2 a buy above the follower\'s cap is a refused copy, with the policy code', w.copies[1].outcome === 'refused' &&
    JSON.stringify(w.copies[1].codes) === JSON.stringify(['policy_transaction_limit_exceeded', 'would_succeed: false']) &&
    w.events.some((e: Json) => e.kind === 'copy_refused' && e.amount === '180000'), w.copies[1]);
  ok('K3 a sell is capped at the follower\'s own position (0.02 NEAR from its one copy, not the seller\'s 0.03)',
    since(w, n).includes('swap sell 20000000000000000000000') && w.copies[2].outcome === 'copied' && pos === 0n, { pos, calls: since(w, n) });
  const n2 = w.calls.length; const r0 = w.retrieves;
  await s.copyTick(l);
  ok('K3b once handled, entries are known: the next tick retrieves nothing again', w.retrieves === r0, { before: r0, after: w.retrieves });
  const s2 = start(w, { approvedId: w.payment.listingId });
  const l2 = await s2.approve(); await s2.claim(l2, await s2.pay(l2)); await s2.verify(l2);
  await s2.copyTick(l2);
  ok('K4 nothing is copied twice: not on the next tick, not after a restart', !since(w, n2).some((x: string) => x.startsWith('swap')) && w.copies.length === 3, since(w, n2));
}
{
  const { w, s, l } = await admitted();
  w.add('buy', '0.02', '2.5');
  w.clock += 15 * 60_000 + 1;
  w.add('buy', '0.02', '2.5');
  await s.copyTick(l);
  ok('K5 an entry recorded more than 15 minutes ago is skipped as stale; a fresh one is copied',
    w.copies[0].outcome === 'skipped' && w.events.some((e: Json) => e.kind === 'copy_skipped' && e.reason === 'stale') && w.copies[1].outcome === 'copied', w.copies);
}
{
  const { w, s, l } = await admitted({ maxCopyAgeMs: 120_000 });
  w.add('buy', '0.02', '2.5'); w.clock += 60_000;   // recorded exactly 120 s ago
  await s.copyTick(l);
  ok('K6 maxCopyAgeMs sets the staleness bound (an entry exactly at the bound is still copied)', w.copies[0]?.outcome === 'copied', w.copies);
}
{
  const { w, s, l } = await admitted();
  w.members.delete(PAYER);
  w.add('buy', '0.02', '2.5');
  const n = w.calls.length;
  await s.copyTick(l); await s.copyTick(l);
  ok('K7 once not a member, access_ended is logged once and nothing more is read or copied',
    kinds(w).filter((k: string) => k === 'access_ended').length === 1 && s.ended() && !since(w, n).some((x: string) => x.startsWith('swap')) && since(w, n).join() === 'isMember', since(w, n));
}
{
  const { w, s, l } = await admitted();
  w.revokedReads = true;
  w.add('buy', '0.02', '2.5');
  let calls = 0;
  const orig = w.members.has.bind(w.members);
  w.members.has = (a: string) => (a === PAYER ? ++calls === 1 : orig(a));
  await s.copyTick(l);
  ok('K8 a read refused because the revoke landed mid-tick is access_ended, not an error', s.ended() && w.events.at(-1).kind === 'access_ended', kinds(w));
}
{
  const { w, s, l } = await admitted();
  w.add('buy', '0.02', '2.5', PAYER);
  await s.copyTick(l);
  w.add('buy', '0.02', '2.5');
  const n = w.calls.length;
  await s.copyTick(l);
  ok('B4 nothing is kept from live records that fail the checks', w.feed.length === 3, w.feed.length);
  ok('K9 a live record that fails the checks (another uploader) stops copying for good', w.events.some((e: Json) => e.kind === 'live_refused' && /not the seller/.test(e.message)) &&
    s.stoppedReason() !== null && !since(w, n).some((x: string) => x.startsWith('swap')), kinds(w));
}
{
  const { w, b } = await listed();
  w.files[w.rows[1].ipfs_hash] = encodeEntry({ ...decodeEntry(w.files[w.rows[1].ipfs_hash]), price: '9' });
  const s = start(w, { approvedId: b.id });
  const l = await s.approve(); await s.claim(l, await s.pay(l));
  const e = await thrown(() => s.verify(l));
  w.add('buy', '0.02', '2.5');
  await s.copyTick(l);
  ok('B3 nothing is kept from a feed that does not verify', w.feed.length === 0, w.feed.length);
  ok('V2 a feed that does not verify is refused (FeedRefused) and nothing is ever copied', e instanceof F.FeedRefused && /does not match its on-chain hash/.test(e.message) &&
    w.events.at(-1).kind === 'feed_refused' && w.copies.length === 0 && s.stoppedReason() === e.message, e.message);
}
{
  const { w, s, l } = await admitted();
  w.add('buy', '0.02', '2.5');
  w.swapReply = { dry: false };
  const e = await thrown(() => s.copyTick(l));
  w.swapReply = { dry: true, warnings: [], quote: { would_succeed: true } };
  const e2 = await thrown(() => s.copyTick(l));
  w.swapReply = undefined;
  await s.copyTick(l);
  ok('K10 a swap reply that is not a dry quote, or has no amount_out, is an error and nothing is recorded; the entry is retried on the next tick',
    e.message === 'follower: the swap reply is not a dry quote; stop and inspect' && e2.message === 'follower: the quote has no amount_out' &&
    w.copies.length === 1 && w.copies[0].outcome === 'copied', [e.message, e2.message, w.copies]);
  const z = await admitted();
  z.w.add('buy', '0.02', '2.5');
  const s2 = F.createFollowerService({ seller: z.w.seller, agent: z.w.agent, reader: z.w.reader, isMember: async () => true, state: z.w.state,
    decider: { decide: async () => ({ side: 'sell', amount: '1' }) }, newKey: () => 'k', now: () => z.w.clock, sleep: async () => {} },
    { approvedId: z.b.id, maxPrice: '150000', memo: 'copytrade' });
  const l2 = await s2.approve(); await s2.verify(l2); await s2.copyTick(l2);
  ok('K11 a decision to sell more than the follower holds is skipped, never quoted', z.w.copies.at(-1).outcome === 'skipped' &&
    !z.w.calls.some((x: string) => x.startsWith('swap sell')), z.w.copies);
}

// ── arithmetic, mirror, events ──────────────────────────────────────────────────────────────
{
  ok('U1 usdcOf is size × price in atomic USDC, half up; yoctoOf is exact',
    F.usdcOf('0.02', '2.5') === 50000n && F.usdcOf('0.06', '3') === 180000n && F.usdcOf('0.0000001', '5') === 1n && F.usdcOf('0.0000001', '4') === 0n &&
    F.usdcOf('1', '3.8371297435') === 3837130n && F.yoctoOf('0.03') === 3n * 10n ** 22n && F.yoctoOf('1') === 10n ** 24n);
  const e = (side: string, size: string, price: string) => ({ transId: 't', recordNs: '0', entry: { side, size, price } });
  const m = [await F.mirrorDecider.decide(e('buy', '0.02', '2.5'), { positionYocto: 0n }), await F.mirrorDecider.decide(e('sell', '0.03', '3'), { positionYocto: 10n ** 22n }),
    await F.mirrorDecider.decide(e('sell', '0.01', '3'), { positionYocto: 3n * 10n ** 22n }), await F.mirrorDecider.decide(e('sell', '0.01', '3'), { positionYocto: 0n })];
  ok('U2 the mirror decider: buys 1:1 in USDC, sells capped at the position, nothing to sell → null',
    JSON.stringify(m) === JSON.stringify([{ side: 'buy', amount: '50000' }, { side: 'sell', amount: '10000000000000000000000' }, { side: 'sell', amount: '10000000000000000000000' }, null]), m);
  const { w, s, l } = await admitted();
  w.add('buy', '0.02', '2.5'); await s.copyTick(l);
  ok('E1 events never hold the seller\'s reasoning', !JSON.stringify(w.events).includes(SECRET) && w.events.every((x: Json) => typeof x.at === 'number'));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log('failed:'); for (const r of failed) console.log(`  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`); process.exit(1); }
