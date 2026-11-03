// verify-feed.test.ts: harness for src/core/verify-feed.ts (the follower's check after admission).
// No network: a fake NOVA reader serving a group built with the real journal, P&L and listing modules,
// records shaped exactly as contract v0.3.9 builds them.
//
//   npx tsx test/verify-feed.test.ts
//   FEED_MODULE=<path> npx tsx test/verify-feed.test.ts     (the mutation script)
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodeEntry, entryFileHash, computeFingerprint, type JournalEntry } from '../src/core/journal.ts';
import { recomputeCurve } from '../src/core/pnl.ts';
import { checkListing } from '../src/core/listing.ts';

const here = dirname(fileURLToPath(import.meta.url));
const modPath = process.env.FEED_MODULE ? resolve(process.env.FEED_MODULE) : resolve(here, '../src/core/verify-feed.ts');
const F = await import(pathToFileURL(modPath).href);

type Json = any;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function ok(name: string, pass: boolean, detail?: unknown) {
  const d = detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ name, ok: pass, detail: d });
  console.log(`${pass ? '✓' : '✗'} ${name}${!pass && d ? ` — ${d}` : ''}`);
}
async function refusal(f: () => Promise<unknown>): Promise<string> {
  try { await f(); return 'no refusal'; } catch (e) { return e instanceof F.FeedRefused ? (e as Error).message : `not a FeedRefused: ${String(e)}`; }
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const clone = (x: Json): Json => JSON.parse(JSON.stringify(x));

// ── a seller's group ────────────────────────────────────────────────────────────────────────
const G = 'agent-owned-20261030T073943Z';
const SELLER = '5a5d96f384a41ba3d1c90399dcd563ed6f52c34aa28ba5f200902a655d8ab288';
const BASE_MS = 1_762_160_000_000;
const ns = (s: number) => ((BigInt(BASE_MS) + BigInt(s * 1000)) * 1_000_000n).toString();
const iso = (s: number) => new Date(BASE_MS + s * 1000).toISOString();

interface Stored { row: Json; bytes: Uint8Array }
function record(entry: JournalEntry, at: number, n: number, over: Partial<Json> = {}): Stored {
  const bytes = encodeEntry(entry);
  const row: Json = { group_id: G, user_id: SELLER, file_hash: entryFileHash(bytes), ipfs_hash: `fastfs/loc-${n}`,
    backend: 'FastFS', timestamp: ns(at), deleted: null, ...over };
  row.trans_id = sha(`${row.group_id}${row.user_id}${row.file_hash}${row.ipfs_hash}${row.timestamp}`);
  return { row, bytes };
}
const entry = (side: 'buy' | 'sell', size: string, price: string, at: number, over: Partial<JournalEntry> = {}): JournalEntry =>
  ({ v: 1, simulated: true, ts: iso(at - 30), pair: 'NEAR/USDC', side, size, price, reasoning: `${side} ${size}`,
    correlation_id: null, salt: sha(`salt ${at}`), ...over });

const smoke: Stored = { row: { ...record(entry('buy', '1', '1', -5000), -5000, 0).row }, bytes: new Uint8Array([1]) };
smoke.row.user_id = 'other.near';
smoke.row.trans_id = sha(`${smoke.row.group_id}${smoke.row.user_id}${smoke.row.file_hash}${smoke.row.ipfs_hash}${smoke.row.timestamp}`);
const covered = [record(entry('buy', '10', '1', 100), 100, 1), record(entry('sell', '4', '1.5', 200), 200, 2),
  record(entry('sell', '6', '2', 300), 300, 3)]; // +2 at 200, +6 more at 300: 8
const after = record(entry('buy', '1', '2', 900), 900, 4);
const GROUP = [smoke, ...covered, after];

function listingFor(group: Stored[], over: (l: Json) => void = () => {}): Json {
  const rows = group.map((s) => s.row);
  const fp = computeFingerprint(rows, { groupId: G, seller: SELLER, sinceNs: ns(100), asOfNs: ns(300) });
  const curveEntries = covered.map((s) => ({ transId: s.row.trans_id, recordNs: s.row.timestamp, entry: JSON.parse(new TextDecoder().decode(s.bytes)) }));
  const points = recomputeCurve(curveEntries, 'USDC', true, [ns(150), ns(300)]);
  const l = { v: 1, seller: SELLER, groupId: G, proceedsAccount: '1000fans.near',
    token: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', price: '100000',
    openedAtMs: BASE_MS + 400_000, periodMinutes: 1440, range: { sinceNs: ns(100), asOfNs: ns(300) },
    fingerprint: { count: fp.count, root: fp.root }, curve: { quote: 'USDC', simulated: true, points } };
  over(l);
  return checkListing(l);
}
const LISTING = listingFor(GROUP);

function reader(group: Stored[], hooks: { list?: () => Promise<Json[]>; get?: (ref: string) => Promise<Uint8Array> | undefined } = {}) {
  const calls: { method: string; groupId: string; ref?: string }[] = [];
  return {
    calls,
    listRecords: async (groupId: string) => { calls.push({ method: 'list', groupId }); return hooks.list ? hooks.list() : clone(group.map((s) => s.row)); },
    retrieve: async (groupId: string, ref: string) => {
      calls.push({ method: 'retrieve', groupId, ref });
      const hooked = hooks.get?.(ref);
      if (hooked) return hooked;
      const s = group.find((x) => x.row.ipfs_hash === ref);
      if (!s) throw new Error(`no file at ${ref}`);
      return s.bytes;
    },
  };
}
const retrieved = (r: Json) => r.calls.filter((c: Json) => c.method === 'retrieve');

// ── the happy path ──────────────────────────────────────────────────────────────────────────
{
  const r = reader(GROUP);
  const got = await F.verifyFeed(LISTING, r);
  ok('V1 a feed matching its listing verifies: the covered entries in chain order, at their record times',
    got.entries.length === 3 && got.entries.every((e: Json, i: number) => e.transId === covered[i].row.trans_id && e.recordNs === covered[i].row.timestamp) &&
    got.entries[1].entry.side === 'sell' && got.entries[1].entry.price === '1.5', got.entries.map((e: Json) => e.transId.slice(0, 8)));
  ok('V2 the verified curve is the listing\'s (realised 2 then 8 USDC)',
    JSON.stringify(got.curve) === JSON.stringify(LISTING.curve.points) && got.curve[1].realised === '8.000000', got.curve);
  const refs = retrieved(r).map((c: Json) => c.ref);
  ok('V3 only the covered entries are retrieved, each by its own record\'s location, from the listing\'s group',
    JSON.stringify(refs) === JSON.stringify(covered.map((s) => s.row.ipfs_hash)) && r.calls.every((c: Json) => c.groupId === G), refs);
  ok('V4 the group\'s records are listed once, before any retrieve', r.calls[0].method === 'list' && r.calls.filter((c: Json) => c.method === 'list').length === 1);
}

// ── refusals ────────────────────────────────────────────────────────────────────────────────
{
  const r = reader(GROUP);
  const bad = clone(LISTING); bad.price = '0';
  const m = await refusal(() => F.verifyFeed(bad, r));
  ok('V5 an invalid listing → refused before NOVA is asked anything', m === 'feed: listing: price must be a positive integer string' && r.calls.length === 0, m);
}
{
  const r = reader(GROUP);
  const m = await refusal(() => F.verifyFeed(listingFor(GROUP, (l) => { l.fingerprint.root = 'ab'.repeat(32); }), r));
  ok('V6 a fingerprint root that differs from the listing\'s → refused, nothing retrieved',
    m === 'feed: fingerprint root differs from the listing' && retrieved(r).length === 0, m);
}
{
  const extra = record(entry('buy', '1', '1', 250), 250, 9);
  const grown = [smoke, covered[0], covered[1], extra, covered[2], after];
  const r = reader(grown);
  const m = await refusal(() => F.verifyFeed(LISTING, r));
  ok('V7 a record inside the range that the listing does not count → refused by count, nothing retrieved',
    m === 'feed: fingerprint count differs: listing 3, journal 4' && retrieved(r).length === 0, m);
}
{
  const r = reader(GROUP, { list: async () => { const rows = clone(GROUP.map((s) => s.row)); rows[2].deleted = { deleted_at: ns(250), deleted_by: SELLER, reason: 'OwnerRequest' }; return rows; } });
  const m = await refusal(() => F.verifyFeed(LISTING, r));
  ok('V8 a journal rule broken in the range (a tombstoned entry) → refused with the journal\'s own message',
    m === `feed: record ${covered[1].row.trans_id.slice(0, 12)}: deleted` && retrieved(r).length === 0, m);
}
{
  const r = reader(GROUP, { get: (ref) => (ref === covered[1].row.ipfs_hash ? Promise.resolve(encodeEntry(entry('sell', '4', '1.6', 200))) : undefined) });
  const m = await refusal(() => F.verifyFeed(LISTING, r));
  ok('V9 a retrieved file whose plaintext differs from its on-chain hash → refused, naming the entry, no later entry retrieved',
    m === `feed: entry ${covered[1].row.trans_id.slice(0, 12)}: content does not match its on-chain hash` && retrieved(r).length === 2, m);
}
{
  const junk = new TextEncoder().encode('not a journal entry');
  const g = [smoke, covered[0], { row: { ...covered[1].row }, bytes: junk }, covered[2], after];
  g[2].row.file_hash = entryFileHash(junk);
  g[2].row.trans_id = sha(`${g[2].row.group_id}${g[2].row.user_id}${g[2].row.file_hash}${g[2].row.ipfs_hash}${g[2].row.timestamp}`);
  const r = reader(g);
  const m = await refusal(() => F.verifyFeed(listingFor(g), r));
  ok('V10 a file matching its hash that is not a valid entry → refused with the decoder\'s message',
    m === `feed: entry ${g[2].row.trans_id.slice(0, 12)}: entry: not JSON`, m);
}
{
  const r = reader(GROUP);
  const m = await refusal(() => F.verifyFeed(listingFor(GROUP, (l) => { l.curve.points[1].realised = '8.000001'; }), r));
  ok('V11 a claimed curve one micro-USDC off → refused with the P&L check\'s message, after every entry was checked',
    m === `feed: pnl: point at ${ns(300)} claims 8.000001, the journal gives 8.000000` && retrieved(r).length === 3, m);
}
{
  const late = record(entry('sell', '6', '2', 300, { ts: iso(300 - 901) }), 300, 3);
  const g = [smoke, covered[0], covered[1], late, after];
  const r = reader(g);
  const m = await refusal(() => F.verifyFeed(listingFor(g), r));
  ok('V12 an entry recorded more than 15 minutes after its trade → refused (commit-as-you-go)',
    m === `feed: pnl: entry ${late.row.trans_id.slice(0, 12)}: committed late`, m);
}
{
  const r1 = reader(GROUP, { list: async () => { throw new Error('MCP 503'); } });
  const r2 = reader(GROUP, { get: () => Promise.reject(new Error('FastFS timeout')) });
  let e1: unknown, e2: unknown;
  try { await F.verifyFeed(LISTING, r1); } catch (e) { e1 = e; }
  try { await F.verifyFeed(LISTING, r2); } catch (e) { e2 = e; }
  ok('V13 a reader failure is rethrown as it is, never turned into a verdict on the feed',
    e1 instanceof Error && !(e1 instanceof F.FeedRefused) && (e1 as Error).message === 'MCP 503' &&
    e2 instanceof Error && !(e2 instanceof F.FeedRefused) && (e2 as Error).message === 'FastFS timeout', [String(e1), String(e2)]);
}
{
  const r = reader(GROUP, { list: async () => ({ rows: [] }) as unknown as Json[] });
  let e: unknown;
  try { await F.verifyFeed(LISTING, r); } catch (x) { e = x; }
  ok('V14 a malformed reply (records that are not a list) surfaces as an error, never as a verdict on the feed',
    e instanceof Error && !(e instanceof F.FeedRefused), String(e));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log('failed:'); for (const r of failed) console.log(`  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`); process.exit(1); }