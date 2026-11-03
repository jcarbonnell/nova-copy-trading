// seller-service.test.ts: harness for src/seller/seller-service.ts (the seller's logic, dependencies injected).
// No network. The world: a group whose records and files are faked as nova-reader returns them (with two
// Deliverable 2 records before the journal), the real journal writer over fake dry quotes and a fake upload
// that records like the contract, a fake ChainReader serving the real 57r1 withdrawal (verifyPayment runs
// for real), an in-memory ledger, members and state, and a scripted decider.
//
//   npx tsx test/seller-service.test.ts
//   SERVICE_MODULE=<path> npx tsx test/seller-service.test.ts     (the mutation script)
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodeEntry, decodeEntry, type TxRow } from '../src/core/journal.ts';
import { verifyFeed } from '../src/core/verify-feed.ts';
import { createJournalWriter } from '../src/seller/journal-writer.ts';

const here = dirname(fileURLToPath(import.meta.url));
const modPath = process.env.SERVICE_MODULE ? resolve(process.env.SERVICE_MODULE) : resolve(here, '../src/seller/seller-service.ts');
const S = await import(pathToFileURL(modPath).href);

type Json = any;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function ok(name: string, pass: boolean, detail?: unknown) {
  const d = detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ name, ok: pass, detail: d });
  console.log(`${pass ? '✓' : '✗'} ${name}${!pass && d ? ` — ${d}` : ''}`);
}
async function thrown(f: () => Promise<unknown>): Promise<Json> { try { await f(); return { name: 'none', message: 'no error' }; } catch (e) { return e; } }
const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const tick = () => new Promise((r) => setTimeout(r, 2));

// ── the real 57r1 payment (0.10 USDC to 1000fans.near, 2026-10-19) ───────────────────────────
const raw = readFileSync(resolve(here, 'fixtures/withdrawal-57r1.tx.json'));
if (sha(raw) !== 'a075acf5527013f7c4ed479170bff597a6415fe24b7438d92f42d1788aa171f8') { console.error('fixture sha256 mismatch'); process.exit(1); }
const fx = JSON.parse(raw.toString());
const PAYER = '5a5d96f384a41ba3d1c90399dcd563ed6f52c34aa28ba5f200902a655d8ab288';
const PAID_MS = Date.parse('2026-10-19T10:34:44.600Z');
const CLAIM = { intentHash: 'B2btEHKa3W2DcSo51dYoEAMghbmHqEUKg78BwSPK3UbY', payer: PAYER,
  windowFromMs: Date.parse('2026-10-19T10:34:42.845Z'), windowToMs: Date.parse('2026-10-19T10:34:48.248Z') };

const G = 'agent-owned-20261030T073943Z';
const SELLER = 'aa'.repeat(32);
const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const TERMS = { seller: SELLER, groupId: G, proceedsAccount: '1000fans.near', token: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  price: '100000', periodMinutes: 60, simulated: true };
const at = (iso: string) => Date.parse(`2026-10-19T${iso}Z`);
const nsOf = (ms: number) => (BigInt(ms) * 1_000_000n).toString();
const REASONING = 'secret-reasoning-text';

function world(seller = SELLER) {
  const w: Json = { clock: at('10:00:00.000'), rows: [] as TxRow[], files: {} as Record<string, Uint8Array>, members: new Set<string>([seller]),
    ledger: new Map<string, Json>(), events: [] as Json[], sinceNs: null as string | null, saved: new Map<string, string>(),
    decisions: [] as Json[], inFlight: 0, maxInFlight: 0, calls: [] as string[], seller };
  const record = (data: Uint8Array, user: string, ms: number, ref: string) => {
    const r: Json = { group_id: G, user_id: user, file_hash: sha(data), ipfs_hash: ref, timestamp: nsOf(ms), deleted: null };
    r.trans_id = sha(`${r.group_id}${r.user_id}${r.file_hash}${r.ipfs_hash}${r.timestamp}`);
    w.rows.push(r); w.files[ref] = data;
    return r;
  };
  w.record = record;
  // Deliverable 2's uploads, before the journal: not journal entries.
  record(new TextEncoder().encode('deliverable 2 test file'), seller, at('09:00:00.000'), 'fastfs/d2-a');
  record(new TextEncoder().encode('{"hello":"nova"}'), seller, at('09:05:00.000'), 'fastfs/d2-b');
  const write = async <T>(name: string, f: () => Promise<T>) => {
    w.calls.push(name); w.inFlight++; w.maxInFlight = Math.max(w.maxInFlight, w.inFlight);
    try { await tick(); return await f(); } finally { w.inFlight--; }
  };
  w.reader = {
    listRecords: async (g: string) => { w.calls.push('list'); if (w.failList) throw w.failList; return w.rows.filter((r: Json) => r.group_id === g).map((r: Json) => ({ ...r })); },
    retrieve: async (_g: string, ref: string) => { if (!(ref in w.files)) throw new Error(`not found ${ref}`); return new Uint8Array(w.files[ref]); },
  };
  w.nova = {
    upload: (_g: string, data: Buffer, filename: string) => write('upload', async () => {
      if (w.failUpload) throw w.failUpload;
      const ms = w.clock;
      const r = w.dropRecord ? { trans_id: sha('nowhere'), file_hash: sha(data) } : record(new Uint8Array(data), seller, ms, `fastfs/${filename}`);
      w.clock += 2000;
      return { cid: 'c', trans_id: r.trans_id, file_hash: r.file_hash };
    }),
  };
  w.quotes = { swap: async (_a: string, req: Json) => ({ dry: true, warnings: [], quote: { would_succeed: true,
    amount_out: req.origin_asset === USDC ? (BigInt(req.amount) * 4n * 10n ** 17n).toString() : (BigInt(req.amount) * 3n / 10n ** 18n).toString() } }) };
  w.chain = {
    scanExecuteIntents: async () => { w.calls.push('scan'); if (w.failScan) throw w.failScan; await tick(); return [fx.transaction]; },
    txStatus: async () => fx,
    blockTimeMs: async (h: string) => { if (h !== fx.transaction_outcome.block_hash) throw new Error(`unknown block ${h}`); return PAID_MS; },
  };
  w.ledgerStore = { get: async (h: string) => w.ledger.get(h), put: async (r: Json) => { w.ledger.set(r.intentHash, r); }, all: async () => [...w.ledger.values()] };
  w.ops = {
    isMember: async (_g: string, a: string) => w.members.has(a),
    add: (_g: string, a: string) => write('add', async () => { if (w.failAdd) throw w.failAdd; w.members.add(a); }),
    revoke: (_g: string, a: string) => write('revoke', async () => { w.members.delete(a); }),
  };
  w.signer = { resolvePending: async () => { w.calls.push('resolve'); if (w.pending) throw w.pending; return null; } };
  w.decider = { next: async (ctx: Json) => { w.calls.push(`decide ${ctx.position}`); return w.decisions.length ? w.decisions.shift() : null; } };
  w.state = {
    getSinceNs: async () => w.sinceNs, setSinceNs: async (ns: string) => { w.sinceNs = ns; },
    saveListing: async (id: string, json: string) => { w.saved.set(id, json); },
    loadListings: async () => [...w.saved].map(([id, json]) => ({ id, json })),
    appendEvent: async (e: Json) => { w.events.push(e); },
  };
  return w;
}
const start = (w: Json, cfg: Json = {}) => S.createSellerService({ reader: w.reader, chain: w.chain, ledger: w.ledgerStore, ops: w.ops, signer: w.signer,
  decider: w.decider, state: w.state, now: () => w.clock,
  makeWriter: (history: Json[]) => createJournalWriter({ quotes: w.quotes, nova: w.nova, now: () => w.clock }, { agentId: 'seller', groupId: G, simulated: true }, history),
}, { terms: { ...TERMS, seller: w.seller }, ...cfg });
const buy = { side: 'buy', amount: '10000000', reasoning: REASONING };          // 10 USDC → 4 NEAR at 2.5
const sell = (near: string) => ({ side: 'sell', amount: (BigInt(near) * 10n ** 24n).toString(), reasoning: REASONING }); // at 3
const kinds = (w: Json, from = 0) => w.events.slice(from).map((e: Json) => e.kind);
const claimBody = (listingId: string, over: Json = {}) => JSON.stringify({ listingId, ...CLAIM, ...over });

// ── start, first entries, listings ──────────────────────────────────────────────────────────
const w = world();
const svc = await start(w);
{
  const l = await svc.handle({ method: 'GET', path: '/listing' });
  const h = await svc.handle({ method: 'GET', path: '/health' });
  ok('S1 a fresh start: a pending write is settled first, no listing yet (404), trading on',
    w.calls[0] === 'resolve' && l.status === 404 && l.body.error === 'no listing yet' && h.status === 200 &&
    JSON.stringify(h.body) === JSON.stringify({ ok: true, trading: true, latest: null }), { calls: w.calls, l, h });
}
let first: Json;
{
  w.clock = at('10:20:00.000'); w.decisions.push(buy);
  const n = w.events.length; const c = w.calls.length;
  await svc.tradeTick();
  const l = await svc.handle({ method: 'GET', path: '/listing' });
  first = l.body;
  const entryRow = w.rows[2];
  ok('S2 a trade: settle pending, decide, upload; sinceNs becomes that entry\'s record time; the listing covers it alone (Deliverable 2\'s records left out)',
    w.calls.slice(c, c + 3).join() === 'resolve,decide 0,upload' && w.sinceNs === entryRow.timestamp && l.status === 200 &&
    l.body.listing.range.sinceNs === entryRow.timestamp && l.body.listing.fingerprint.count === 1 &&
    kinds(w, n).join() === 'entry_written,listing_published' && w.events[n].transId === entryRow.trans_id &&
    w.events[n + 1].listingId === l.body.id && w.saved.has(l.body.id), { calls: w.calls.slice(c), ev: kinds(w, n), since: w.sinceNs });
  ok('S3 the published listing is what a follower verifies', (await verifyFeed(l.body.listing, w.reader)).entries.length === 1);
}
{
  w.clock = at('10:25:00.000'); w.decisions.push(sell('2'));
  await svc.tradeTick();
  const l = await svc.handle({ method: 'GET', path: '/listing' });
  const old = await svc.handle({ method: 'GET', path: `/listings/${first.id}` });
  ok('S4 the next trade publishes a new listing (two entries, realised 1 USDC); the first is still served by its id',
    l.body.id !== first.id && l.body.listing.fingerprint.count === 2 && l.body.listing.curve.points.at(-1).realised === '1.000000' &&
    old.status === 200 && old.body.id === first.id && JSON.stringify(old.body.listing) === JSON.stringify(first.listing) && w.saved.size === 2,
    { l: l.body.listing?.curve, old: old.status });
}

// ── claims ──────────────────────────────────────────────────────────────────────────────────
{
  w.clock = at('10:40:00.000');
  const n = w.events.length;
  const r = await svc.handle({ method: 'POST', path: '/claim', body: claimBody(first.id) });
  const rec = w.ledger.get(CLAIM.intentHash);
  ok('S5 a claim for the first listing: verified on chain against that listing\'s terms, the payer admitted (200)',
    r.status === 200 && r.body.member === PAYER && r.body.state === 'admitted' && r.body.expiresAtMs === PAID_MS + 3_600_000 &&
    r.body.txHash === fx.transaction.hash && w.members.has(PAYER) && rec.listingId === first.id &&
    kinds(w, n).join() === 'payment_verified,member_admitted' && w.events[n].payer === PAYER, { r, ev: kinds(w, n) });
  const again = await svc.handle({ method: 'POST', path: '/claim', body: claimBody(first.id) });
  ok('S6 the same claim again → 422 "intent hash already used", nothing changed',
    again.status === 422 && again.body.error === 'intent hash already used' && w.ledger.size === 1 && w.events.at(-1).kind === 'payment_refused', again);
}
{
  const cases: [string, Json, number, string][] = [
    ['not JSON', 'nope', 400, 'claim: not JSON'],
    ['no listing id', JSON.stringify(CLAIM), 400, 'claim: listingId must be 64 lowercase hex'],
    ['an unknown listing', claimBody('cd'.repeat(32)), 404, 'claim: unknown listing'],
  ];
  const fails = [];
  const c0 = w.calls.length;
  for (const [what, body, status, error] of cases) {
    const r = await svc.handle({ method: 'POST', path: '/claim', body });
    if (r.status !== status || r.body.error !== error) fails.push(`${what}: ${r.status} ${r.body.error}`);
  }
  const routes: [string, string, number][] = [['GET', '/claim', 405], ['POST', '/listing', 405], ['DELETE', `/listings/${first.id}`, 405],
    ['GET', '/listings/xyz', 404], ['GET', `/listings/${'ef'.repeat(32)}`, 404], ['GET', '/admin', 404]];
  for (const [method, path, status] of routes) {
    const r = await svc.handle({ method, path });
    if (r.status !== status) fails.push(`${method} ${path}: ${r.status}`);
  }
  ok('S7 malformed claims and other routes (400, 404, 405) are answered without a chain call', fails.length === 0 && w.calls.length === c0, { fails, calls: w.calls.slice(c0) });
}

{
  const v = world();
  const s = await start(v);
  v.clock = at('10:20:00.000'); v.decisions.push(buy); await s.tradeTick();
  const early = (await s.handle({ method: 'GET', path: '/listing' })).body.id;
  v.clock = at('10:36:00.000'); v.decisions.push(buy); await s.tradeTick();
  const late = (await s.handle({ method: 'GET', path: '/listing' })).body.id;
  v.clock = at('10:40:00.000');
  const r = await s.handle({ method: 'POST', path: '/claim', body: claimBody(early) });
  const r2 = await s.handle({ method: 'POST', path: '/claim', body: claimBody(late) });
  ok('S5b a claim is checked against the listing it names: paid at 10:34, the 10:20 listing accepts it, the 10:36 one could not have',
    early !== late && r.status === 200 && v.ledger.get(CLAIM.intentHash).listingId === early && r2.status === 422, { r, r2 });
  v.clock = PAID_MS + 3_600_000;
  await start(v);
  ok('S28 a restart after a member\'s expiry revokes it at start', !v.members.has(PAYER) && v.ledger.get(CLAIM.intentHash).state === 'revoked');
}

// ── refusals and failures in a second world ─────────────────────────────────────────────────
async function withListing(seller = SELLER) {
  const v = world(seller);
  const s = await start(v);
  v.clock = at('10:20:00.000'); v.decisions.push(buy);
  await s.tradeTick();
  const id = (await s.handle({ method: 'GET', path: '/listing' })).body.id;
  v.clock = at('10:40:00.000');
  return { v, s, id };
}
{
  const { v, s, id } = await withListing();
  const r = await s.handle({ method: 'POST', path: '/claim', body: claimBody(id, { windowToMs: at('10:45:00.000'), windowFromMs: at('10:40:00.000') }) });
  ok('S8 a refused payment → 422 with verifyPayment\'s message; nothing recorded, nobody added',
    r.status === 422 && r.body.error === 'claim: window ends in the future' && v.ledger.size === 0 && !v.members.has(PAYER) &&
    v.events.at(-1).kind === 'payment_refused' && v.events.at(-1).message === 'claim: window ends in the future', r);
  v.failScan = new Error('rpc down');
  const r2 = await s.handle({ method: 'POST', path: '/claim', body: claimBody(id) });
  ok('S9 a chain failure → 503, nothing recorded (the follower sends the claim again)',
    r2.status === 503 && r2.body.error === 'claim: the payment could not be checked now; send the claim again' && v.ledger.size === 0 &&
    v.events.at(-1).kind === 'payment_check_failed' && v.events.at(-1).message === 'rpc down', r2);
  v.failScan = undefined;
  v.failAdd = new Error('NOVA busy');
  const r3 = await s.handle({ method: 'POST', path: '/claim', body: claimBody(id) });
  ok('S10 verified but the admit fails → 202, the record stays paid',
    r3.status === 202 && r3.body.state === 'paid' && r3.body.member === PAYER && v.ledger.get(CLAIM.intentHash).state === 'paid' &&
    !v.members.has(PAYER) && v.events.at(-1).kind === 'admission_deferred', r3);
  v.failAdd = undefined;
  await s.maintenanceTick();
  v.failAdd = new Error('NOVA busy again');
  v.ledger.set('x', { ...v.ledger.get(CLAIM.intentHash), intentHash: 'x', member: 'other.near', state: 'paid' });
  await s.maintenanceTick();
  ok('S11a a maintenance failure is logged and the tick still resolves', v.events.at(-1).kind === 'maintenance_failed' &&
    v.events.at(-1).message === 'NOVA busy again', v.events.at(-1));
  v.ledger.delete('x'); v.failAdd = undefined;
  await s.maintenanceTick();
  ok('S11 a later maintenance tick admits it', v.members.has(PAYER) && v.ledger.get(CLAIM.intentHash).state === 'admitted' &&
    v.events.some((e: Json) => e.kind === 'member_admitted' && e.member === PAYER), v.events.slice(-3));
  v.clock = PAID_MS + 3_600_000;
  await s.maintenanceTick();
  const rec = v.ledger.get(CLAIM.intentHash);
  ok('S12 at expiry the maintenance tick revokes it (key rotated)', !v.members.has(PAYER) && rec.state === 'revoked' && rec.rotation === 'confirmed' &&
    v.events.at(-1).kind === 'member_revoked' && v.events.at(-1).rotation === 'confirmed' && v.events.at(-1).member === PAYER, v.events.at(-1));
}
{
  const { v, s, id } = await withListing(PAYER);
  const r = await s.handle({ method: 'POST', path: '/claim', body: claimBody(id) });
  ok('S13 a membership refusal (the seller paying its own listing) → 422 with its message',
    r.status === 422 && r.body.error === 'membership: the seller cannot buy its own listing' && v.ledger.size === 0, r);
}
{
  const v = world();
  const s = await start(v);
  v.clock = at('10:20:00.000');
  v.decisions.push(sell('1'));
  const n = v.events.length;
  await s.tradeTick();
  v.decisions.push(buy);
  await s.tradeTick();
  ok('S14 a refused trade is logged and skipped; the next one goes through',
    kinds(v, n).join() === 'entry_refused,entry_written,listing_published' && v.events[n].message === 'journal: sells more NEAR than held' &&
    s.stoppedReason() === null, kinds(v, n));
  v.pending = Object.assign(new Error('pending'), { name: 'NativeCallPendingError' });
  v.decisions.push(buy);
  const c = v.calls.length;
  await s.tradeTick();
  ok('S15 a write still pending skips the tick before asking the decider', v.events.at(-1).reason === 'a write is still pending' &&
    !v.calls.slice(c).some((x: string) => x.startsWith('decide')) && v.decisions.length === 1 && s.stoppedReason() === null, v.calls.slice(c));
  v.pending = undefined;
  v.failUpload = new Error('finalize failed');
  await s.tradeTick();
  const h = await s.handle({ method: 'GET', path: '/health' });
  v.failUpload = undefined; v.decisions.push(buy);
  const c2 = v.calls.length;
  await s.tradeTick();
  ok('S16 a failed upload stops trading for good (health says so); later ticks do nothing',
    s.stoppedReason() === 'journal: upload failed: finalize failed' && h.body.trading === false && v.events.some((e: Json) => e.kind === 'trading_stopped') &&
    v.calls.length === c2 && v.decisions.length === 1, { reason: s.stoppedReason(), calls: v.calls.slice(c2) });
  v.pending = new Error('signer exploded');
  const v2 = world(); const s2 = await start(v2); v2.pending = new Error('signer exploded'); v2.decisions.push(buy);
  await s2.tradeTick();
  ok('S17 any other resolvePending failure stops trading', s2.stoppedReason() === 'signer exploded' && v2.decisions.length === 1);
}
{
  const v = world();
  const s = await start(v, { maxUploadsPerHour: 2 });
  v.clock = at('10:00:00.000');
  for (let i = 0; i < 3; i++) { v.decisions.push(buy); await s.tradeTick(); v.clock += 60_000; }
  const uploadsAfter3 = v.calls.filter((x: string) => x === 'upload').length;
  v.clock = at('11:00:02.000'); // an hour after the first upload landed
  await s.tradeTick();
  ok('S18 at most maxUploadsPerHour uploads per rolling hour; the hour after, trading resumes',
    uploadsAfter3 === 2 && v.events.some((e: Json) => e.kind === 'trade_skipped' && e.reason === 'upload budget') &&
    v.calls.filter((x: string) => x === 'upload').length === 3, { uploadsAfter3 });
  const d = world(); const ds = await start(d);
  for (let i = 0; i < 9; i++) { d.decisions.push(buy); await ds.tradeTick(); d.clock += 60_000; }
  ok('S19 the default budget is 8 uploads an hour', d.calls.filter((x: string) => x === 'upload').length === 8 && S.DEFAULT_MAX_UPLOADS_PER_HOUR === 8);
}
{
  const v = world();
  const s = await start(v);
  v.dropRecord = true; v.decisions.push(buy); v.clock = at('10:20:00.000');
  await s.tradeTick();
  ok('S20 if the first entry\'s record is not on chain, trading stops and no sinceNs is saved',
    s.stoppedReason() === 'service: the first entry\'s record was not found' && v.sinceNs === null, s.stoppedReason());
}
{
  const { v, s, id } = await withListing();
  v.record(new TextEncoder().encode('intruder'), PAYER, at('10:30:00.000'), 'fastfs/intruder');
  v.decisions.push(buy); v.clock = at('10:35:00.000');
  await s.tradeTick();
  const l = await s.handle({ method: 'GET', path: '/listing' });
  ok('S21 a failed rebuild (another uploader in the range) keeps the previous listing; the entry is still written',
    l.body.id === id && v.events.at(-2).kind === 'entry_written' && v.events.at(-1).kind === 'listing_build_failed' &&
    /uploaded by .*, not the seller/.test(v.events.at(-1).message) && s.stoppedReason() === null, v.events.slice(-2));
  const c = v.calls.length; const n = v.events.length;
  await s.tradeTick();
  ok('S22 no decision, nothing done (no write, no event)', v.calls.slice(c).join() === 'resolve,decide 8' && v.events.length === n, v.calls.slice(c));
}

// ── one write at a time ─────────────────────────────────────────────────────────────────────
{
  const { v, s, id } = await withListing();
  v.ledger.clear(); v.members.delete(PAYER); v.maxInFlight = 0;
  v.decisions.push(buy);
  v.clock = at('10:40:00.000');
  const [, r] = await Promise.all([s.tradeTick(), s.handle({ method: 'POST', path: '/claim', body: claimBody(id) }), s.maintenanceTick()]);
  ok('S23 a trade, a claim and a maintenance tick sent together never overlap their writes', v.maxInFlight === 1 && r.status === 200, { max: v.maxInFlight });
}

// ── restart ─────────────────────────────────────────────────────────────────────────────────
{
  w.clock = at('10:50:00.000');
  const n = w.events.length;
  const again = await start(w);
  const l = await again.handle({ method: 'GET', path: '/listing' });
  const old = await again.handle({ method: 'GET', path: `/listings/${first.id}` });
  w.decisions.push(sell('2'));
  await again.tradeTick();
  const last = decodeEntry(w.files[w.rows.at(-1)!.ipfs_hash]);
  ok('S24 a restart reloads every saved listing, publishes a fresh one from the chain, and the writer\'s position comes from the chain',
    old.status === 200 && l.status === 200 && l.body.listing.fingerprint.count === 2 && w.calls.includes('decide 2') &&
    last.side === 'sell' && last.size === '2' && kinds(w, n)[0] === 'listing_published', { ev: kinds(w, n) });
}
{
  const v = world();
  const s = await start(v);
  v.clock = at('10:20:00.000'); v.decisions.push(buy); await s.tradeTick();
  const [[id, json]] = [...v.saved];
  v.saved.set(id, json.replace('"price":"100000"', '"price":"1"'));
  const e = await thrown(() => start(v));
  ok('S25 a saved listing that does not match its id stops the start', e.name === 'ListingRefused' && e.message === 'listing: id differs from the approved one', e.message);
  v.saved.clear();
  const ref = v.rows[2].ipfs_hash;
  v.files[ref] = encodeEntry({ ...decodeEntry(v.files[ref]), price: '9' });
  const e2 = await thrown(() => start(v));
  ok('S26 a journal that does not verify stops the start', e2.message === 'service: the journal does not verify; not starting' &&
    v.events.at(-1).kind === 'listing_build_failed', e2.message);
}

// ── what the events never hold ──────────────────────────────────────────────────────────────
{
  const all = JSON.stringify(w.events);
  ok('S27 events hold no trade content: no reasoning, side, size or price', !all.includes(REASONING) && !/"(side|size|price|reasoning)"/.test(all) &&
    w.events.every((e: Json) => typeof e.at === 'number' && typeof e.kind === 'string'), all.slice(0, 300));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log('failed:'); for (const r of failed) console.log(`  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`); process.exit(1); }