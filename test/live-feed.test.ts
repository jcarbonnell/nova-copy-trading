// live-feed.test.ts: harness for src/core/live-feed.ts (each new journal entry after the listing's range).
// No network: a fake NOVA reader over a group built with the real journal, P&L, listing and verify-feed
// modules; records shaped exactly as contract v0.3.9 builds them.
//
//   npx tsx test/live-feed.test.ts
//   LIVE_MODULE=<path> npx tsx test/live-feed.test.ts     (the mutation script)
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodeEntry, entryFileHash, computeFingerprint, type JournalEntry } from '../src/core/journal.ts';
import { recomputeCurve } from '../src/core/pnl.ts';
import { checkListing } from '../src/core/listing.ts';
import { verifyFeed } from '../src/core/verify-feed.ts';

const here = dirname(fileURLToPath(import.meta.url));
const modPath = process.env.LIVE_MODULE ? resolve(process.env.LIVE_MODULE) : resolve(here, '../src/core/live-feed.ts');
const L = await import(pathToFileURL(modPath).href);
const FeedRefused = L.FeedRefused; // the module's own class (a relocated mutant loads its own copy)

type Json = any;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function ok(name: string, pass: boolean, detail?: unknown) {
  const d = detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ name, ok: pass, detail: d });
  console.log(`${pass ? '✓' : '✗'} ${name}${!pass && d ? ` — ${d}` : ''}`);
}
async function refusal(f: () => Promise<unknown>): Promise<string> {
  try { await f(); return 'no refusal'; } catch (e) { return e instanceof FeedRefused ? (e as Error).message : `not a FeedRefused: ${String(e)}`; }
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const clone = (x: Json): Json => JSON.parse(JSON.stringify(x));

// ── a seller's group: three listed entries, then the live feed ──────────────────────────────
const G = 'agent-owned-20261030T073943Z';
const SELLER = '5a5d96f384a41ba3d1c90399dcd563ed6f52c34aa28ba5f200902a655d8ab288';
const BASE_MS = 1_762_160_000_000;
const ns = (s: number) => ((BigInt(BASE_MS) + BigInt(s * 1000)) * 1_000_000n).toString();
const iso = (s: number) => new Date(BASE_MS + s * 1000).toISOString();

interface Stored { row: Json; bytes: Uint8Array }
function record(entry: JournalEntry, at: number | null, n: number, over: Partial<Json> = {}): Stored {
  const bytes = encodeEntry(entry);
  const row: Json = { group_id: G, user_id: SELLER, file_hash: entryFileHash(bytes), ipfs_hash: `fastfs/loc-${n}`,
    backend: at === null ? null : 'FastFS', timestamp: at === null ? null : ns(at), deleted: null, ...over };
  row.trans_id = sha(`${row.group_id}${row.user_id}${row.file_hash}${row.ipfs_hash}${row.timestamp}`);
  return { row, bytes };
}
const entry = (side: 'buy' | 'sell', size: string, price: string, at: number, over: Partial<JournalEntry> = {}): JournalEntry =>
  ({ v: 1, simulated: true, ts: iso(at - 30), pair: 'NEAR/USDC', side, size, price, reasoning: `${side} ${size}`,
    correlation_id: null, salt: sha(`salt ${at} ${side} ${size}`), ...over });

const listed = [record(entry('buy', '10', '1', 100), 100, 1), record(entry('sell', '4', '1.5', 200), 200, 2),
  record(entry('sell', '6', '2', 300), 300, 3)];                       // realised 8 at asOf
const live1 = record(entry('buy', '5', '2', 400), 400, 4);             // position 5 @ 2
const live2 = record(entry('sell', '5', '3', 500), 500, 5);            // +5 → 13
const live3 = record(entry('buy', '1', '3', 500, { reasoning: 'same block' }), 500, 6); // same block as live2

const curveOf = (stored: Stored[]) => stored.map((s) => ({ transId: s.row.trans_id, recordNs: s.row.timestamp,
  entry: JSON.parse(new TextDecoder().decode(s.bytes)) }));
const fp = computeFingerprint(listed.map((s) => s.row), { groupId: G, seller: SELLER, sinceNs: ns(100), asOfNs: ns(300) });
const LISTING = checkListing({ v: 1, seller: SELLER, groupId: G, proceedsAccount: '1000fans.near',
  token: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', price: '100000', openedAtMs: BASE_MS + 350_000,
  periodMinutes: 1440, range: { sinceNs: ns(100), asOfNs: ns(300) }, fingerprint: { count: fp.count, root: fp.root },
  curve: { quote: 'USDC', simulated: true, points: recomputeCurve(curveOf(listed), 'USDC', true, [ns(300)]) } });

function reader(group: Stored[], hooks: { list?: () => Promise<Json>; get?: (ref: string) => Promise<Uint8Array> | undefined } = {}) {
  const calls: { method: string; ref?: string }[] = [];
  return {
    calls,
    listRecords: async () => { calls.push({ method: 'list' }); return hooks.list ? hooks.list() : clone(group.map((s) => s.row)); },
    retrieve: async (_g: string, ref: string) => {
      calls.push({ method: 'retrieve', ref });
      const hooked = hooks.get?.(ref);
      if (hooked) return hooked;
      const s = group.find((x) => x.row.ipfs_hash === ref);
      if (!s) throw new Error(`no file at ${ref}`);
      return s.bytes;
    },
  };
}
const refs = (r: Json) => r.calls.filter((c: Json) => c.method === 'retrieve').map((c: Json) => c.ref);
const KNOWN = (await verifyFeed(LISTING, reader(listed))).entries;
const id12 = (s: Stored) => s.row.trans_id.slice(0, 12);

// ── the live feed ───────────────────────────────────────────────────────────────────────────
{
  const r = reader(listed);
  const u = await L.verifyLiveEntries(LISTING, r, KNOWN);
  ok('F1 nothing new recorded → no entries, nothing retrieved, the realised P&L at the last known entry',
    u.entries.length === 0 && refs(r).length === 0 && u.atNs === ns(300) && u.realised === '8.000000', u);
}
{
  const r = reader([...listed, live1, live2]);
  const u = await L.verifyLiveEntries(LISTING, r, KNOWN);
  ok('F2 new entries after the range are verified in chain order, each retrieved once by its own location',
    u.entries.map((e: Json) => e.transId).join() === [live1, live2].map((s) => s.row.trans_id).join() &&
    JSON.stringify(refs(r)) === JSON.stringify([live1.row.ipfs_hash, live2.row.ipfs_hash]) &&
    u.entries[1].recordNs === ns(500) && u.entries[1].entry.price === '3', u.entries.map((e: Json) => e.transId.slice(0, 8)));
  ok('F3 the realised P&L covers every entry so far (8 + 5 = 13 USDC) at the last record time', u.realised === '13.000000' && u.atNs === ns(500), u);
  const r2 = reader([...listed, live1, live2, live3]);
  const u2 = await L.verifyLiveEntries(LISTING, r2, [...KNOWN, ...u.entries]);
  ok('F4 the next call returns only what came after, including a record in the same block as the last known one',
    u2.entries.length === 1 && u2.entries[0].transId === live3.row.trans_id && JSON.stringify(refs(r2)) === JSON.stringify([live3.row.ipfs_hash]) &&
    u2.realised === '13.000000', u2);
}

// ── refusals ────────────────────────────────────────────────────────────────────────────────
const cases: [string, Stored[], Json, string][] = [
  ['another uploader', [...listed, record(entry('buy', '1', '1', 400), 400, 7, { user_id: 'other.near' })], {}, 'uploaded by other.near, not the seller'],
  ['a tombstoned new record', [...listed, record(entry('buy', '1', '1', 400), 400, 7, { deleted: { deleted_at: ns(450), deleted_by: SELLER, reason: 'OwnerRequest' } })], {}, ': deleted'],
  ['a new record without upload time, at the tail', [...listed, live1, record(entry('buy', '1', '1', 450), null, 8)], {}, ': no upload time'],
  ['a new record dated before the last known one', [...listed, record(entry('buy', '1', '1', 250), 250, 9)], {}, 'out of chain order'],
  ['a trans_id that does not match its fields', [...listed, { row: { ...live1.row, timestamp: ns(401) }, bytes: live1.bytes }], {}, 'trans_id does not match its fields'],
];
{
  const failures: string[] = [];
  for (const [what, group, , want] of cases) {
    const m = await refusal(() => L.verifyLiveEntries(LISTING, reader(group), KNOWN));
    if (!m.startsWith('live: ') || !m.includes(want)) failures.push(`${what}: ${m}`);
  }
  ok(`F5 a new record breaking a journal rule is refused with the rule's message (${cases.length} cases)`, failures.length === 0, failures);
}
{
  const r = reader([...listed, live1, live2], { get: (ref) => (ref === live2.row.ipfs_hash ? Promise.resolve(encodeEntry(entry('sell', '5', '9', 500))) : undefined) });
  const m = await refusal(() => L.verifyLiveEntries(LISTING, r, KNOWN));
  ok('F6 a new file whose plaintext differs from its on-chain hash → refused, naming the entry',
    m === `live: entry ${id12(live2)}: content does not match its on-chain hash`, m);
  const junk = new TextEncoder().encode('junk');
  const bad = { row: { ...live1.row, file_hash: entryFileHash(junk) }, bytes: junk };
  bad.row.trans_id = sha(`${bad.row.group_id}${bad.row.user_id}${bad.row.file_hash}${bad.row.ipfs_hash}${bad.row.timestamp}`);
  const m2 = await refusal(() => L.verifyLiveEntries(LISTING, reader([...listed, bad]), KNOWN));
  ok('F7 a new file matching its hash that is not a valid entry → refused with the decoder\'s message', m2 === `live: entry ${id12(bad)}: entry: not JSON`, m2);
}
{
  const late = record(entry('buy', '1', '1', 400, { ts: iso(400 - 901) }), 400, 10);
  const m1 = await refusal(() => L.verifyLiveEntries(LISTING, reader([...listed, late]), KNOWN));
  const real = record(entry('buy', '1', '1', 400, { simulated: false }), 400, 11);
  const m2 = await refusal(() => L.verifyLiveEntries(LISTING, reader([...listed, real]), KNOWN));
  const oversell = record(entry('sell', '0.000001', '1', 400), 400, 12);  // the listed range closed the position
  const m3 = await refusal(() => L.verifyLiveEntries(LISTING, reader([...listed, oversell]), KNOWN));
  ok('F8 the P&L rules apply to new entries against everything before: committed late, simulated flag, long-only',
    m1 === `live: pnl: entry ${id12(late)}: committed late` && m2 === `live: pnl: entry ${id12(real)}: simulated is false, the curve says true` &&
    m3 === `live: pnl: entry ${id12(oversell)}: sells more than held`, [m1, m2, m3]);
}
{
  const m = await refusal(() => L.verifyLiveEntries(LISTING, reader([...listed.slice(0, 2), live1]), KNOWN));
  ok('F9 the last verified entry missing from the group → refused', m === `live: the last verified entry ${id12(listed[2])} is no longer in the group`, m);
  const m2 = await refusal(() => L.verifyLiveEntries(LISTING, reader(listed), []));
  ok('F10 no verified entries yet → refused (verifyFeed comes first)', m2 === 'live: no verified entries yet (run verifyFeed first)', m2);
}
{
  let e1: unknown, e2: unknown;
  try { await L.verifyLiveEntries(LISTING, reader(listed, { list: async () => { throw new Error('MCP 503'); } }), KNOWN); } catch (e) { e1 = e; }
  try { await L.verifyLiveEntries(LISTING, reader([...listed, live1], { get: () => Promise.reject(new Error('FastFS timeout')) }), KNOWN); } catch (e) { e2 = e; }
  ok('F11 reader failures are rethrown as they are, never a verdict',
    (e1 as Error)?.message === 'MCP 503' && !(e1 instanceof FeedRefused) && (e2 as Error)?.message === 'FastFS timeout' && !(e2 instanceof FeedRefused),
    [String(e1), String(e2)]);
}
{
  // A listing of real trades: entries and curve all simulated: false.
  const realListed = [record(entry('buy', '2', '1', 100, { simulated: false, correlation_id: 'c1' }), 100, 21),
    record(entry('sell', '2', '2', 200, { simulated: false, correlation_id: 'c2' }), 200, 22)];
  const realFp = computeFingerprint(realListed.map((x) => x.row), { groupId: G, seller: SELLER, sinceNs: ns(100), asOfNs: ns(200) });
  const REAL = checkListing({ ...clone(LISTING), range: { sinceNs: ns(100), asOfNs: ns(200) }, fingerprint: { count: realFp.count, root: realFp.root },
    curve: { quote: 'USDC', simulated: false, points: recomputeCurve(curveOf(realListed), 'USDC', false, [ns(200)]) } });
  const realKnown = (await verifyFeed(REAL, reader(realListed))).entries;
  const realLive = record(entry('buy', '1', '2', 300, { simulated: false, correlation_id: 'c3' }), 300, 23);
  const u = await L.verifyLiveEntries(REAL, reader([...realListed, realLive]), realKnown);
  ok('F12 a listing of real trades accepts a real live entry (the listing\'s simulated flag is the one applied)',
    u.entries.length === 1 && u.entries[0].entry.correlation_id === 'c3' && u.realised === '2.000000', u);
}
{
  const broken = [...KNOWN.slice(0, 2), { ...KNOWN[2], entry: {} }];
  let e: unknown;
  try { await L.verifyLiveEntries(LISTING, reader(listed), broken); } catch (x) { e = x; }
  ok('F13 a malformed known entry surfaces as an error, never as a verdict on the feed', e instanceof Error && !(e instanceof FeedRefused), String(e));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log('failed:'); for (const r of failed) console.log(`  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`); process.exit(1); }