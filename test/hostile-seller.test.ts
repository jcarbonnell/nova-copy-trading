// hostile-seller.test.ts: harness for src/demo/hostile-seller.ts (beat 2 in a live run).
// The hostile listing is derived from a real one built by the seller's listing builder; the last checks run the
// real follower service against the stub's handler, with an agent whose policy refuses any recipient but
// 1000fans.near, as the follower's does.
//
//   npx tsx test/hostile-seller.test.ts
//   HOSTILE_MODULE=<path> npx tsx test/hostile-seller.test.ts     (the mutation script)
import { createHash } from 'node:crypto';
import http from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodeEntry, type JournalEntry, type TxRow } from '../src/core/journal.ts';
import { listingId, canonicalListing, parseListing } from '../src/core/listing.ts';
import { buildListing } from '../src/seller/listing-builder.ts';
import { createFollowerService } from '../src/follower/follower-service.ts';

const here = dirname(fileURLToPath(import.meta.url));
const modPath = process.env.HOSTILE_MODULE ? resolve(process.env.HOSTILE_MODULE) : resolve(here, '../src/demo/hostile-seller.ts');
const H = await import(pathToFileURL(modPath).href);

type Json = any;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function ok(name: string, pass: boolean, detail?: unknown) {
  const d = detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ name, ok: pass, detail: d });
  console.log(`${pass ? '✓' : '✗'} ${name}${!pass && d ? ` — ${d}` : ''}`);
}
async function thrown(f: () => unknown): Promise<string> { try { await f(); return 'no error'; } catch (e) { return (e as Error).message; } }
const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');

// a real listing, from the seller's own builder
const G = 'agent-owned-20261030T073943Z';
const SELLER = 'aa'.repeat(32);
const BASE = 1_762_160_000_000;
const rows: TxRow[] = []; const files: Record<string, Uint8Array> = {};
for (let i = 0; i < 3; i++) {
  const e: JournalEntry = { v: 1, simulated: true, ts: new Date(BASE + i * 60_000 - 1000).toISOString(), pair: 'NEAR/USDC', side: i === 2 ? 'sell' : 'buy',
    size: '0.01', price: String(3.8 + i / 10), reasoning: `entry ${i}`, correlation_id: null, salt: sha(`s${i}`) };
  const bytes = encodeEntry(e);
  const r: Json = { group_id: G, user_id: SELLER, file_hash: sha(bytes), ipfs_hash: `fastfs/e-${i}`, timestamp: String(BigInt(BASE + i * 60_000) * 1_000_000n), deleted: null };
  r.trans_id = sha(`${r.group_id}${r.user_id}${r.file_hash}${r.ipfs_hash}${r.timestamp}`);
  rows.push(r); files[r.ipfs_hash] = bytes;
}
const reader = { listRecords: async () => rows, retrieve: async (_g: string, ref: string) => files[ref] };
const real = await buildListing(reader, { seller: SELLER, groupId: G, proceedsAccount: '1000fans.near', token: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  price: '100000', periodMinutes: 60, simulated: true }, { now: () => BASE + 600_000 });

// ── the hostile listing ─────────────────────────────────────────────────────────────────────
{
  const h = H.hostileListing(real.listing);
  const strip = (l: Json) => JSON.stringify({ ...l, proceedsAccount: null });
  ok('H1 the hostile listing is the real one with only the proceeds account changed (listing-99.near by default)',
    h.listing.proceedsAccount === 'listing-99.near' && H.HOSTILE_PROCEEDS === 'listing-99.near' && strip(h.listing) === strip(real.listing), h.listing.proceedsAccount);
  ok('H2 its id is recomputed from its content; it parses as a valid listing under that id, and differs from the real id',
    h.id === listingId(h.listing) && h.json === canonicalListing(h.listing) && JSON.stringify(parseListing(h.json, h.id)) === JSON.stringify(h.listing) && h.id !== real.id);
  ok('H3 another account can be named', H.hostileListing(real.listing, 'evil.near').listing.proceedsAccount === 'evil.near');
  const e1 = await thrown(() => H.hostileListing(real.listing, '1000fans.near'));
  const e2 = await thrown(() => H.hostileListing({ ...real.listing, price: '0' }));
  const e3 = await thrown(() => H.hostileListing(real.listing, 'NOT VALID'));
  const e4 = await thrown(() => H.hostileListing(null));
  ok('H4 refused: the same account, an invalid listing, an invalid account, no listing at all', e1 === 'hostile: the listing already pays that account' &&
    e2 === 'listing: price must be a positive integer string' && e3 === 'listing: proceedsAccount is not a valid NEAR account id' &&
    e4 === 'listing: listing must be an object', [e1, e2, e3, e4]);
  ok('H5 the real listing is not modified', real.listing.proceedsAccount === '1000fans.near' && listingId(real.listing) === real.id);
}

// ── the handler ─────────────────────────────────────────────────────────────────────────────
{
  const h = H.hostileListing(real.listing);
  const handle = H.hostileHandler(h, 8788);
  const A = '127.0.0.1:8788';
  const a = await handle('GET', '/listing', A);
  const b = await handle('GET', `/listings/${h.id}`, 'localhost:8788');
  ok('S1 GET /listing and GET /listings/<its id> serve the hostile listing as the seller does ({ id, listing })',
    a.status === 200 && b.status === 200 && JSON.parse(a.body).id === h.id && JSON.parse(b.body).listing.proceedsAccount === 'listing-99.near' &&
    a.headers['content-type'] === 'application/json' && a.headers['cache-control'] === 'no-store');
  const c = await handle('POST', '/claim', A);
  ok('S2 a claim is never taken', c.status === 403 && JSON.parse(c.body).error === 'this stub never takes a claim');
  const others = await Promise.all([handle('GET', `/listings/${real.id}`, A), handle('GET', '/health', A), handle('GET', '/', A)]);
  const methods = await Promise.all([handle('POST', '/listing', A), handle('DELETE', `/listings/${h.id}`, A), handle('GET', '/claim', A)]);
  const hosts = await Promise.all([handle('GET', '/listing', 'evil.example:8788'), handle('GET', '/listing', '127.0.0.1:9999'), handle('GET', '/listing', undefined)]);
  ok('S3 any other path is 404 (the real listing included), other methods 405, another host 403',
    others.every((r: Json) => r.status === 404) && methods.every((r: Json) => r.status === 405) && hosts.every((r: Json) => r.status === 403),
    [others, methods, hosts].map((x: Json[]) => x.map((r) => r.status)));
}

// ── with the real follower service ──────────────────────────────────────────────────────────
{
  const h = H.hostileListing(real.listing);
  const handle = H.hostileHandler(h, 8788);
  const calls: string[] = []; const events: Json[] = [];
  const seller = { get: async (p: string) => { const r = await handle('GET', p, '127.0.0.1:8788'); return { status: r.status, body: JSON.parse(r.body) }; },
    post: async (p: string) => { const r = await handle('POST', p, '127.0.0.1:8788'); return { status: r.status, body: JSON.parse(r.body) }; } };
  const agent = {
    previewWithdraw: async (req: Json) => { calls.push(`preview ${req.recipient}`);
      return req.recipient === '1000fans.near' ? { dry: true, warnings: [], quote: { would_succeed: true } } : { dry: true, warnings: [{ code: 'policy_destination_denied' }], quote: { would_succeed: false } }; },
    withdraw: async () => { calls.push('withdraw'); throw new Error('never'); }, status: async () => ({}), quoteSwap: async () => ({}),
  };
  const state = { getPayment: async () => null, setPayment: async () => { calls.push('setPayment'); }, copies: async () => [], addCopy: async () => {}, addFeed: async () => {},
    appendEvent: async (e: Json) => { events.push(e); } };
  const f = createFollowerService({ seller, agent, reader: reader as Json, isMember: async () => false, decider: {} as Json, state: state as Json, newKey: () => 'k' },
    { approvedId: h.id, maxPrice: '150000', memo: 'copytrade' });
  const l = await f.approve();
  const e = await thrown(() => f.preview(l));
  ok('F1 the real follower service approves the stub\'s listing by its id, and its owner\'s policy refuses paying it; nothing is paid or saved',
    l.proceedsAccount === 'listing-99.near' && e === "follower: the owner's policy refuses paying this listing (policy_destination_denied, would_succeed: false)" &&
    calls.join() === 'preview listing-99.near' && events.some((x) => x.kind === 'payment_refused_by_policy'), { e, calls });
}

// ── a real server ───────────────────────────────────────────────────────────────────────────
{
  const h = H.hostileListing(real.listing);
  const port = 18788 + Math.floor(Math.random() * 1000);
  const server = await H.startHostile(h, port);
  const addr = server.address() as Json;
  const got = await new Promise<Json>((done) => http.get({ host: '127.0.0.1', port, path: '/listing' }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => done({ s: res.statusCode, b })); }));
  ok('L1 the stub listens on 127.0.0.1 only and serves the listing', addr.address === '127.0.0.1' && got.s === 200 && JSON.parse(got.b).id === h.id, addr);
  await new Promise<void>((r) => server.close(() => r()));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log('failed:'); for (const r of failed) console.log(`  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`); process.exit(1); }
