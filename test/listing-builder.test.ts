// listing-builder.test.ts: harness for src/seller/listing-builder.ts (the seller's listing from its own records).
// No network: a fake FeedReader serving contract-shaped rows (trans_id computed as v0.3.9 does) and the entries'
// plaintext, as nova-reader.ts returns them. Built listings are checked with the follower's own code
// (parseListing, verifyFeed) over a fresh reader.
//
//   npx tsx test/listing-builder.test.ts
//   BUILDER_MODULE=<path> npx tsx test/listing-builder.test.ts     (the mutation script)
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodeEntry, entryFileHash, computeFingerprint, type JournalEntry, type TxRow } from '../src/core/journal.ts';
import { listingId, canonicalListing, parseListing } from '../src/core/listing.ts';
import { verifyFeed } from '../src/core/verify-feed.ts';

const here = dirname(fileURLToPath(import.meta.url));
const modPath = process.env.BUILDER_MODULE ? resolve(process.env.BUILDER_MODULE) : resolve(here, '../src/seller/listing-builder.ts');
const B = await import(pathToFileURL(modPath).href);

type Json = any;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function ok(name: string, pass: boolean, detail?: unknown) {
  const d = detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ name, ok: pass, detail: d });
  console.log(`${pass ? '✓' : '✗'} ${name}${!pass && d ? ` — ${d}` : ''}`);
}
async function thrown(f: () => Promise<unknown>): Promise<Json> { try { await f(); return { name: 'none', message: 'no error' }; } catch (e) { return e; } }
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const G = 'agent-owned-20261030T073943Z';
const SELLER = '5a5d96f384a41ba3d1c90399dcd563ed6f52c34aa28ba5f200902a655d8ab288';
const OTHER = '9a45ea1ce599c5df4143001cddc0dd80e6a0a897f8665d0b6570a70c3ac93b35';
const BASE_MS = 1_762_160_000_000;
const ns = (s: number) => ((BigInt(BASE_MS) + BigInt(s) * 1000n) * 1_000_000n).toString();
const NOW = () => BASE_MS + 10_000_000;
const TERMS = { seller: SELLER, groupId: G, proceedsAccount: '1000fans.near', token: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  price: '100000', periodMinutes: 60, simulated: true };

const entry = (side: 'buy' | 'sell', size: string, price: string, at: number, over: Partial<JournalEntry> = {}): JournalEntry => ({ v: 1, simulated: true,
  ts: new Date(BASE_MS + (at - 30) * 1000).toISOString(), pair: 'NEAR/USDC', side, size, price, reasoning: `${side} ${size}`,
  correlation_id: null, salt: sha(`salt ${side} ${size} ${at} ${price}`), ...over });

/** One stored record: [entry, record time in s, uploader?, bytes override?] */
type Spec = [JournalEntry | null, number, string?, Uint8Array?];
function journal(specs: Spec[]) {
  const files: Record<string, Uint8Array> = {};
  const rows: TxRow[] = specs.map(([e, at, user = SELLER, override], i) => {
    const bytes = e ? encodeEntry(e) : new TextEncoder().encode('legacy');
    const ref = `fastfs/e-${i}-${at}`;
    files[ref] = override ?? bytes;
    const r: Json = { group_id: G, user_id: user, file_hash: entryFileHash(bytes), ipfs_hash: ref, timestamp: e ? ns(at) : null, deleted: null };
    r.trans_id = sha(`${r.group_id}${r.user_id}${r.file_hash}${r.ipfs_hash}${r.timestamp}`);
    return r;
  });
  return { rows, files };
}
function fakeReader(j: { rows: TxRow[]; files: Record<string, Uint8Array> }, fail: { list?: Error; retrieve?: Error } = {}) {
  const calls: string[] = [];
  return {
    calls,
    listRecords: async (g: string) => { calls.push(`list ${g}`); if (fail.list) throw fail.list; return j.rows.map((r) => ({ ...r })); },
    retrieve: async (g: string, ref: string) => {
      calls.push(`retrieve ${g} ${ref}`);
      if (fail.retrieve) throw fail.retrieve;
      if (!(ref in j.files)) throw new Error(`not found ${ref}`);
      return new Uint8Array(j.files[ref]);
    },
  };
}
const THREE: Spec[] = [[entry('buy', '10', '1', 100), 100], [entry('buy', '10', '2', 200), 200], [entry('sell', '5', '3', 300), 300]];

// ── the default build ───────────────────────────────────────────────────────────────────────
{
  const j = journal(THREE);
  const reader = fakeReader(j);
  const b = await B.buildListing(reader, TERMS, { now: NOW });
  const fp = computeFingerprint(j.rows, { groupId: G, seller: SELLER, sinceNs: ns(100), asOfNs: ns(300) });
  ok('L1 the range runs from the first record\'s time to the last one\'s, and the fingerprint covers all three entries',
    b.listing.range.sinceNs === ns(100) && b.listing.range.asOfNs === ns(300) && b.listing.fingerprint.count === 3 &&
    b.listing.fingerprint.root === fp.root, b.listing.range);
  ok('L2 one curve point per entry, at its record time, with the realised P&L (buy 10@1, buy 10@2, sell 5@3 → 7.5)',
    JSON.stringify(b.listing.curve) === JSON.stringify({ quote: 'USDC', simulated: true,
      points: [{ atNs: ns(100), realised: '0.000000' }, { atNs: ns(200), realised: '0.000000' }, { atNs: ns(300), realised: '7.500000' }] }), b.listing.curve);
  ok('L3 the terms are the caller\'s and openedAtMs is now()',
    b.listing.v === 1 && b.listing.seller === SELLER && b.listing.groupId === G && b.listing.proceedsAccount === '1000fans.near' &&
    b.listing.token === TERMS.token && b.listing.price === '100000' && b.listing.periodMinutes === 60 && b.listing.openedAtMs === NOW(), b.listing);
  ok('L4 id and json are the listing\'s content-addressed id and canonical JSON, and a follower parses them',
    b.id === listingId(b.listing) && b.json === canonicalListing(b.listing) && JSON.stringify(parseListing(b.json, b.id)) === JSON.stringify(b.listing));
  ok('L5 reads only, once: one list of the group, then each covered entry at its own location',
    reader.calls.join('|') === [`list ${G}`, ...j.rows.map((r) => `retrieve ${G} ${r.ipfs_hash}`)].join('|'), reader.calls);
  const feed = await verifyFeed(parseListing(b.json, b.id), fakeReader(j));
  ok('L6 the follower\'s verifyFeed accepts it over a fresh reader', feed.entries.length === 3 && feed.curve[2].realised === '7.500000');
}
{
  const j = journal(THREE);
  const b = await B.buildListing(fakeReader(j), TERMS, { now: NOW, sinceNs: ns(200) });
  ok('L7 sinceNs starts the range later: two entries, buy 10@2 then sell 5@3 → 5',
    b.listing.range.sinceNs === ns(200) && b.listing.fingerprint.count === 2 &&
    b.listing.curve.points.map((p: Json) => p.realised).join() === '0.000000,5.000000', b.listing);
  const l1 = await B.buildListing(fakeReader(journal(THREE.slice(0, 2))), TERMS, { now: NOW });
  const l2 = await B.buildListing(fakeReader(j), TERMS, { now: NOW });
  const old = await verifyFeed(l1.listing, fakeReader(j));
  ok('L8 a rebuild after a new entry is another listing (new id, one more entry); the earlier one still verifies against the grown group',
    l1.id !== l2.id && l1.listing.fingerprint.count === 2 && l2.listing.fingerprint.count === 3 && old.entries.length === 2);
}
{
  const j = journal([[entry('buy', '10', '1', 100), 100], [entry('buy', '10', '2', 200), 200], [entry('sell', '5', '3', 199), 200]]);
  const b = await B.buildListing(fakeReader(j), TERMS, { now: NOW });
  ok('L9 two records with the same block time make one point, after both',
    b.listing.fingerprint.count === 3 && JSON.stringify(b.listing.curve.points) ===
    JSON.stringify([{ atNs: ns(100), realised: '0.000000' }, { atNs: ns(200), realised: '7.500000' }]), b.listing.curve.points);
}

// ── sampling ────────────────────────────────────────────────────────────────────────────────
{
  const t = (n: number) => Array.from({ length: n }, (_, i) => String(1000 + i));
  const s250 = B.samplePoints(t(250));
  const s101 = B.samplePoints(t(101));
  const s100 = B.samplePoints(t(100));
  ok('L10 up to 100 points all are kept; above, every k-th (k = ceil(n/100)) counting back from the last',
    s100.length === 100 && s101.length === 51 && s101[50] === '1100' && s101[0] === '1000' &&
    s250.length === 84 && s250[83] === '1249' && s250[82] === '1246' && s250[0] === '1000', { s101: s101.length, s250: s250.length });
  ok('L11 equal times are merged before sampling; a smaller max counts back from the last (5 times, max 2 → k 3)', B.samplePoints(['1', '2', '2', '3', '3']).join() === '1,2,3' &&
    B.samplePoints(t(5), 2).join() === '1001,1004');
  const specs: Spec[] = Array.from({ length: 120 }, (_, i) => i % 2 === 0
    ? [entry('buy', '1', '1', 100 + i), 100 + i] : [entry('sell', '1', '1.5', 100 + i), 100 + i]);
  const b = await B.buildListing(fakeReader(journal(specs)), TERMS, { now: NOW });
  const pts = b.listing.curve.points;
  ok('L12 a 120-entry journal gets 60 points, ending at the last record with realised 30',
    b.listing.fingerprint.count === 120 && pts.length === 60 && pts[59].atNs === ns(219) && pts[59].realised === '30.000000' &&
    pts[0].atNs === ns(101) && pts[0].realised === '0.500000', { n: pts.length, first: pts[0], last: pts[59] });
}

// ── refusals ────────────────────────────────────────────────────────────────────────────────
{
  const refused = async (what: string, j: Json, want: string, opts: Json = {}, terms: Json = TERMS) => {
    const e = await thrown(() => B.buildListing(fakeReader(j), terms, { now: NOW, ...opts }));
    return e instanceof B.ListingBuildRefused && e.name === 'ListingBuildRefused' && e.message === want ? null : `${what}: ${e.name} ${e.message}`;
  };
  const foreign = journal([[entry('buy', '10', '1', 100), 100], [entry('buy', '1', '1', 150), 150, OTHER], [entry('sell', '5', '3', 300), 300]]);
  const tampered = journal([[entry('buy', '10', '1', 100), 100, SELLER, encodeEntry(entry('buy', '10', '0.5', 100))]]);
  const garbage = journal([[entry('buy', '10', '1', 100), 100, SELLER, new TextEncoder().encode('not json')]]);
  const id = (j: Json, i: number) => j.rows[i].trans_id.slice(0, 12);
  const fails = (await Promise.all([
    refused('a foreign record in the range', foreign, `listing-builder: record ${id(foreign, 1)}: uploaded by ${OTHER}, not the seller`),
    refused('an empty group', journal([]), 'listing-builder: the group has no entries'),
    refused('only legacy records', journal([[null, 0]]), 'listing-builder: the group has no entries'),
    refused('sinceNs after the last record', journal(THREE), 'listing-builder: range: since and asOf must be ns decimal strings with since <= asOf', { sinceNs: ns(301) }),
    refused('sinceNs not ns', journal(THREE), 'listing-builder: range: since and asOf must be ns decimal strings with since <= asOf', { sinceNs: '1.5' }),
    refused('content that is not the recorded entry', tampered, `listing-builder: feed: entry ${id(tampered, 0)}: content does not match its on-chain hash`),
    refused('content that is not an entry', garbage, 'listing-builder: entry: not JSON'),
    refused('a curve that says real for simulated entries', journal(THREE), `listing-builder: pnl: entry ${id(journal(THREE), 0)}: simulated is true, the curve says false`,
      {}, { ...TERMS, simulated: false }),
    refused('opened before the range ends', journal(THREE), 'listing-builder: listing: opens before its range ends', { now: () => BASE_MS + 299_000 }),
    refused('a zero price', journal(THREE), 'listing-builder: listing: price must be a positive integer string', {}, { ...TERMS, price: '0' }),
    refused('another seller', journal(THREE), `listing-builder: record ${id(journal(THREE), 0)}: uploaded by ${SELLER}, not the seller`, {}, { ...TERMS, seller: OTHER }),
  ])).filter(Boolean);
  ok('L13 each refusal is a ListingBuildRefused carrying the core module\'s message (11 cases)', fails.length === 0, fails);
  const at = await B.buildListing(fakeReader(journal(THREE)), TERMS, { now: () => BASE_MS + 300_000 });
  ok('L14 opening exactly at the range\'s end is allowed', at.listing.openedAtMs === BASE_MS + 300_000);
}
{
  const listErr = new Error('MCP down');
  const getErr = Object.assign(new Error('prepare_retrieve failed'), { name: 'NovaError' });
  const e1 = await thrown(() => B.buildListing(fakeReader(journal(THREE), { list: listErr }), TERMS, { now: NOW }));
  const e2 = await thrown(() => B.buildListing(fakeReader(journal(THREE), { retrieve: getErr }), TERMS, { now: NOW }));
  const nul = journal(THREE);
  const e3 = await thrown(() => B.buildListing({ listRecords: async () => nul.rows, retrieve: async () => null as Json }, TERMS, { now: NOW }));
  ok('L15 reader errors pass through unchanged, and a reader returning no bytes is an error, never a refusal',
    e1 === listErr && e2 === getErr && e3 instanceof TypeError && !(e3 instanceof B.ListingBuildRefused), { e3: String(e3) });
}
{
  const real: Spec[] = [[entry('buy', '10', '1', 100, { simulated: false, correlation_id: 'c1' }), 100], [entry('sell', '10', '1.1', 200, { simulated: false, correlation_id: 'c2' }), 200]];
  const j = journal(real);
  const b = await B.buildListing(fakeReader(j), { ...TERMS, simulated: false }, { now: NOW });
  const feed = await verifyFeed(b.listing, fakeReader(j));
  ok('L16 a journal of real trades gives a curve that says simulated: false, and verifies',
    b.listing.curve.simulated === false && b.listing.curve.points[1].realised === '1.000000' && feed.entries.length === 2, b.listing.curve);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log('failed:'); for (const r of failed) console.log(`  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`); process.exit(1); }