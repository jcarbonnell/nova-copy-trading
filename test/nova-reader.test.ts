// nova-reader.test.ts: harness for src/adapters/nova-reader.ts (the follower's FeedReader over nova-sdk-js).
// No network: a fake SDK returning what MCP v0.4.12 returns (the contract view's rows, unchanged) and what
// retrieve returns ({ data: Buffer, ipfs_hash, group_id }). The last checks run verifyFeed over the adapter.
//
//   npx tsx test/nova-reader.test.ts
//   READER_MODULE=<path> npx tsx test/nova-reader.test.ts     (the mutation script)
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodeEntry, entryFileHash, computeFingerprint, type JournalEntry } from '../src/core/journal.ts';
import { recomputeCurve } from '../src/core/pnl.ts';
import { checkListing } from '../src/core/listing.ts';
import { verifyFeed, FeedRefused } from '../src/core/verify-feed.ts';

const here = dirname(fileURLToPath(import.meta.url));
const modPath = process.env.READER_MODULE ? resolve(process.env.READER_MODULE) : resolve(here, '../src/adapters/nova-reader.ts');
const R = await import(pathToFileURL(modPath).href);

type Json = any;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function ok(name: string, pass: boolean, detail?: unknown) {
  const d = detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ name, ok: pass, detail: d });
  console.log(`${pass ? '✓' : '✗'} ${name}${!pass && d ? ` — ${d}` : ''}`);
}
async function thrown(f: () => Promise<unknown>): Promise<{ name: string; message: string }> {
  try { await f(); return { name: 'none', message: 'no error' }; } catch (e) { return { name: (e as Error).name, message: (e as Error).message }; }
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const G = 'agent-owned-20261030T073943Z';
const SELLER = '5a5d96f384a41ba3d1c90399dcd563ed6f52c34aa28ba5f200902a655d8ab288';
const row = (n: number, over: Json = {}) => ({ trans_id: sha(`t${n}`), group_id: G, user_id: SELLER, file_hash: sha(`f${n}`),
  ipfs_hash: `fastfs/loc-${n}`, backend: 'FastFS', timestamp: String(1_762_000_000_000_000_000n + BigInt(n)), deleted: null, ...over });

function fakeSdk(rows: unknown, files: Record<string, Uint8Array> = {}, hooks: { retrieve?: (g: string, ref: string) => unknown } = {}) {
  const calls: string[] = [];
  return {
    calls,
    getTransactionsForGroup: async (g: string) => { calls.push(`list ${g}`); return rows; },
    retrieve: async (g: string, ref: string) => {
      calls.push(`retrieve ${g} ${ref}`);
      if (hooks.retrieve) return hooks.retrieve(g, ref);
      if (!(ref in files)) throw Object.assign(new Error(`MCP tool 'prepare_retrieve' failed: not found`), { name: 'NovaError' });
      return { data: Buffer.from(files[ref]), ipfs_hash: ref, group_id: g };
    },
  };
}

// ── listRecords ─────────────────────────────────────────────────────────────────────────────
{
  const rows = [row(1, { extra: 'x' }), row(2, { timestamp: null, backend: null }), row(3, { deleted: { deleted_at: '1', deleted_by: SELLER, reason: 'OwnerRequest' } })];
  const sdk = fakeSdk(rows);
  const got = await R.novaFeedReader(sdk).listRecords(G);
  ok('R1 rows are passed on in the order MCP returns them, with exactly the TxRow fields',
    got.length === 3 && got.map((r: Json) => r.trans_id).join() === rows.map((r) => r.trans_id).join() &&
    got.every((r: Json) => Object.keys(r).sort().join() === 'deleted,file_hash,group_id,ipfs_hash,timestamp,trans_id,user_id') &&
    sdk.calls[0] === `list ${G}`, got);
  ok('R2 a legacy row (timestamp null) and a tombstoned row (deleted set) pass through for the core to judge',
    got[1].timestamp === null && got[2].deleted?.reason === 'OwnerRequest');
  ok('R3 an empty group is an empty list', (await R.novaFeedReader(fakeSdk([])).listRecords(G)).length === 0);
}
{
  const replies: [string, unknown][] = [['null', null], ['an object', { result: [row(1)] }], ['a string', '[]']];
  const fails = [];
  for (const [what, reply] of replies) {
    const e = await thrown(() => R.novaFeedReader(fakeSdk(reply)).listRecords(G));
    if (e.name !== 'NovaReplyError' || e.message !== 'nova: get_group_transactions did not return a list') fails.push(`${what}: ${e.name} ${e.message}`);
  }
  ok('R4 a reply that is not a list → NovaReplyError (an unwrapped envelope included)', fails.length === 0, fails);
}
{
  const bad: [string, Json, string][] = [
    ['a row that is not an object', ['x'], 'nova: record 0 is not an object'],
    ['trans_id as a number', [row(1), row(2, { trans_id: 7 })], 'nova: record 1: trans_id must be a string'],
    ['a missing group_id', [(({ group_id, ...r }) => r)(row(1))], 'nova: record 0: group_id must be a string'],
    ['user_id null', [row(1, { user_id: null })], 'nova: record 0: user_id must be a string'],
    ['file_hash missing', [(({ file_hash, ...r }) => r)(row(1))], 'nova: record 0: file_hash must be a string'],
    ['ipfs_hash as a number', [row(1, { ipfs_hash: 3 })], 'nova: record 0: ipfs_hash must be a string'],
    ['timestamp as a number', [row(1, { timestamp: 1762 })], 'nova: record 0: timestamp must be a string or null'],
    ['timestamp missing', [(({ timestamp, ...r }) => r)(row(1))], 'nova: record 0: timestamp must be a string or null'],
    ['deleted as a list', [row(1, { deleted: [] })], 'nova: record 0: deleted must be an object or null'],
    ['deleted as a string', [row(1, { deleted: 'yes' })], 'nova: record 0: deleted must be an object or null'],
  ];
  const fails = [];
  for (const [what, rows, want] of bad) {
    const e = await thrown(() => R.novaFeedReader(fakeSdk(rows)).listRecords(G));
    if (e.name !== 'NovaReplyError' || e.message !== want) fails.push(`${what}: ${e.name} ${e.message}`);
  }
  ok(`R5 each malformed row → NovaReplyError naming the record and the field (${bad.length} cases)`, fails.length === 0, fails);
}

// ── retrieve ────────────────────────────────────────────────────────────────────────────────
{
  const bytes = new TextEncoder().encode('hello');
  const sdk = fakeSdk([], { 'fastfs/loc-1': bytes });
  const got = await R.novaFeedReader(sdk).retrieve(G, 'fastfs/loc-1');
  ok('R6 retrieve asks for the record\'s own location in the listing\'s group and returns the plaintext bytes (a Buffer is accepted)',
    sdk.calls[0] === `retrieve ${G} fastfs/loc-1` && got instanceof Uint8Array && new TextDecoder().decode(got) === 'hello', sdk.calls);
  const cases: [string, (g: string, ref: string) => unknown, string][] = [
    ['no data', (g, ref) => ({ ipfs_hash: ref, group_id: g }), 'nova: retrieve returned no bytes'],
    ['data as base64 text', (g, ref) => ({ data: 'aGVsbG8=', ipfs_hash: ref, group_id: g }), 'nova: retrieve returned no bytes'],
    ['nothing at all', () => undefined, 'nova: retrieve returned no bytes'],
    ['another file', (g) => ({ data: bytes, ipfs_hash: 'fastfs/loc-2', group_id: g }), 'nova: retrieve answered for another file'],
    ['another group', (_g, ref) => ({ data: bytes, ipfs_hash: ref, group_id: 'other' }), 'nova: retrieve answered for another file'],
  ];
  const fails = [];
  for (const [what, hook, want] of cases) {
    const e = await thrown(() => R.novaFeedReader(fakeSdk([], {}, { retrieve: hook })).retrieve(G, 'fastfs/loc-1'));
    if (e.name !== 'NovaReplyError' || e.message !== want) fails.push(`${what}: ${e.name} ${e.message}`);
  }
  ok(`R7 a retrieve reply without bytes, or for another file or group → NovaReplyError (${cases.length} cases)`, fails.length === 0, fails);
  const e = await thrown(() => R.novaFeedReader(fakeSdk([])).retrieve(G, 'fastfs/missing'));
  ok('R8 an SDK error passes through unchanged', e.name === 'NovaError' && /prepare_retrieve' failed: not found/.test(e.message), e);
}

// ── end to end: verifyFeed over the adapter ─────────────────────────────────────────────────
{
  const BASE_MS = 1_762_160_000_000;
  const ns = (s: number) => ((BigInt(BASE_MS) + BigInt(s * 1000)) * 1_000_000n).toString();
  const entry = (side: 'buy' | 'sell', size: string, price: string, at: number): JournalEntry => ({ v: 1, simulated: true,
    ts: new Date(BASE_MS + (at - 30) * 1000).toISOString(), pair: 'NEAR/USDC', side, size, price, reasoning: `${side} ${size}`,
    correlation_id: null, salt: sha(`salt ${at}`) });
  const stored = [entry('buy', '10', '1', 100), entry('sell', '10', '1.25', 200)].map((e, i) => {
    const bytes = encodeEntry(e);
    const r: Json = { group_id: G, user_id: SELLER, file_hash: entryFileHash(bytes), ipfs_hash: `fastfs/e-${i}`, backend: 'FastFS',
      timestamp: ns(100 * (i + 1)), deleted: null };
    r.trans_id = sha(`${r.group_id}${r.user_id}${r.file_hash}${r.ipfs_hash}${r.timestamp}`);
    return { row: r, bytes };
  });
  const rows = stored.map((s) => s.row);
  const fp = computeFingerprint(rows, { groupId: G, seller: SELLER, sinceNs: ns(100), asOfNs: ns(200) });
  const listing = checkListing({ v: 1, seller: SELLER, groupId: G, proceedsAccount: '1000fans.near',
    token: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', price: '100000', openedAtMs: BASE_MS + 300_000,
    periodMinutes: 60, range: { sinceNs: ns(100), asOfNs: ns(200) }, fingerprint: { count: fp.count, root: fp.root },
    curve: { quote: 'USDC', simulated: true, points: recomputeCurve(stored.map((s) => ({ transId: s.row.trans_id, recordNs: s.row.timestamp,
      entry: JSON.parse(new TextDecoder().decode(s.bytes)) })), 'USDC', true, [ns(200)]) } });
  const files = Object.fromEntries(stored.map((s) => [s.row.ipfs_hash, s.bytes]));
  const feed = await verifyFeed(listing, R.novaFeedReader(fakeSdk(rows, files)));
  ok('R9 verifyFeed over the adapter verifies a seller\'s journal served as MCP serves it (realised 2.5 USDC)',
    feed.entries.length === 2 && feed.curve[0].realised === '2.500000', feed.curve);
  const e = await thrown(() => verifyFeed(listing, R.novaFeedReader(fakeSdk([{ ...rows[0], timestamp: 5 }, rows[1]], files))));
  ok('R10 a malformed reply under verifyFeed stays a reader failure, never a verdict on the feed',
    e.name === 'NovaReplyError' && !(e instanceof FeedRefused), e);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log('failed:'); for (const r of failed) console.log(`  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`); process.exit(1); }