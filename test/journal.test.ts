// journal.test.ts: harness for src/core/journal.ts (journal entries and the listing fingerprint).
// Pure: no network. Records are built the way contract v0.3.9 builds them
// (trans_id = sha256(group_id + user_id + file_hash + ipfs_hash + timestamp)).
//
//   npx tsx test/journal.test.ts
//   JOURNAL_MODULE=<path> npx tsx test/journal.test.ts     (the mutation script)
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const modPath = process.env.JOURNAL_MODULE ? resolve(process.env.JOURNAL_MODULE) : resolve(here, '../src/core/journal.ts');
const J = await import(pathToFileURL(modPath).href);

type Json = any;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function ok(name: string, pass: boolean, detail?: unknown) {
  const d = detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ name, ok: pass, detail: d });
  console.log(`${pass ? '✓' : '✗'} ${name}${!pass && d ? ` — ${d}` : ''}`);
}
function refusal(f: () => unknown): string {
  try { f(); return 'no refusal'; } catch (e) { return e instanceof J.JournalRefused ? (e as Error).message : `not a JournalRefused: ${String(e)}`; }
}
const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const enc = (s: string) => new TextEncoder().encode(s);

// ── entries ─────────────────────────────────────────────────────────────────────────────────
const SALT = 'ab'.repeat(32);
const ENTRY = { v: 1, simulated: true, ts: '2026-11-02T16:00:00.000Z', pair: 'NEAR/USDC', side: 'buy', size: '12.5',
  price: '3.4210', reasoning: 'Breakout above the 4h range with rising volume.', correlation_id: null, salt: SALT };
const CANON = '{"v":1,"simulated":true,"ts":"2026-11-02T16:00:00.000Z","pair":"NEAR/USDC","side":"buy","size":"12.5",' +
  '"price":"3.4210","reasoning":"Breakout above the 4h range with rising volume.","correlation_id":null,"salt":"' + SALT + '"}';
{
  const bytes = J.encodeEntry(ENTRY);
  ok('J1 the encoding is canonical: fixed key order, no whitespace', new TextDecoder().decode(bytes) === CANON, new TextDecoder().decode(bytes));
  ok('J2 decode(encode(entry)) is the entry', JSON.stringify(J.decodeEntry(bytes)) === JSON.stringify(ENTRY));
  ok('J3 file_hash is the lowercase SHA-256 hex of the encoded bytes (what the SDK records)', J.entryFileHash(bytes) === sha(CANON), J.entryFileHash(bytes));
  const shuffled = Object.fromEntries(Object.entries(ENTRY).reverse());
  ok('J4 key order in the input object does not change the bytes', new TextDecoder().decode(J.encodeEntry(shuffled)) === CANON);
  const s1 = J.newSalt(), s2 = J.newSalt();
  ok('J5 newSalt is 64 lowercase hex, fresh each call', /^[0-9a-f]{64}$/.test(s1) && /^[0-9a-f]{64}$/.test(s2) && s1 !== s2, [s1, s2]);
  ok('J6 two entries differing only in salt have different file hashes',
    J.entryFileHash(J.encodeEntry({ ...ENTRY, salt: s1 })) !== J.entryFileHash(J.encodeEntry({ ...ENTRY, salt: s2 })));
  ok('J7 a real trade with a correlation_id and side sell encodes and decodes',
    J.decodeEntry(J.encodeEntry({ ...ENTRY, simulated: false, side: 'sell', correlation_id: 'corr_123' })).correlation_id === 'corr_123');
}
const bad: [string, Json, RegExp][] = [
  ['unknown field', { ...ENTRY, extra: 1 }, /^entry: unexpected field extra$/],
  ['missing field', (({ salt, ...r }) => r)(ENTRY), /^entry: missing field salt$/],
  ['version 2', { ...ENTRY, v: 2 }, /^entry: unsupported version$/],
  ['simulated as a string', { ...ENTRY, simulated: 'true' }, /^entry: simulated must be a boolean$/],
  ['ts without milliseconds', { ...ENTRY, ts: '2026-11-02T16:00:00Z' }, /^entry: ts must be an ISO-8601 UTC time with milliseconds$/],
  ['ts with an offset', { ...ENTRY, ts: '2026-11-02T17:00:00.000+01:00' }, /^entry: ts must be an ISO-8601 UTC time with milliseconds$/],
  ['pair without a quote', { ...ENTRY, pair: 'NEAR' }, /^entry: pair must be BASE\/QUOTE$/],
  ['side hold', { ...ENTRY, side: 'hold' }, /^entry: side must be buy or sell$/],
  ['size as a number', { ...ENTRY, size: 12.5 }, /^entry: size must be a positive decimal string$/],
  ['size zero', { ...ENTRY, size: '0.000' }, /^entry: size must be a positive decimal string$/],
  ['size with a leading zero', { ...ENTRY, size: '012' }, /^entry: size must be a positive decimal string$/],
  ['price negative', { ...ENTRY, price: '-3.4' }, /^entry: price must be a positive decimal string$/],
  ['price in exponent form', { ...ENTRY, price: '3e2' }, /^entry: price must be a positive decimal string$/],
  ['reasoning empty', { ...ENTRY, reasoning: '' }, /^entry: reasoning must be 1-280 characters$/],
  ['reasoning of 281 characters', { ...ENTRY, reasoning: 'x'.repeat(281) }, /^entry: reasoning must be 1-280 characters$/],
  ['correlation_id empty', { ...ENTRY, correlation_id: '' }, /^entry: correlation_id must be a non-empty string or null$/],
  ['salt uppercase', { ...ENTRY, salt: 'AB'.repeat(32) }, /^entry: salt must be 64 lowercase hex$/],
  ['salt of 31 bytes', { ...ENTRY, salt: 'ab'.repeat(31) }, /^entry: salt must be 64 lowercase hex$/],
];
{
  const failures = bad.map(([what, e, re]) => [what, refusal(() => J.encodeEntry(e)), re] as const).filter(([, m, re]) => !re.test(m));
  ok(`J8 encode refuses each invalid entry by its own message (${bad.length} cases)`, failures.length === 0, failures.map(([w, m]) => `${w}: ${m}`));
  const dfail = bad.map(([what, e, re]) => [what, refusal(() => J.decodeEntry(enc(JSON.stringify(e)))), re] as const).filter(([, m, re]) => !re.test(m));
  ok(`J9 decode refuses the same invalid entries by the same messages (${bad.length} cases)`, dfail.length === 0, dfail.map(([w, m]) => `${w}: ${m}`));
}
{
  const m1 = refusal(() => J.decodeEntry(enc(CANON.replace('{"v":1,', '{ "v":1,'))));
  const m2 = refusal(() => J.decodeEntry(enc(JSON.stringify(Object.fromEntries(Object.entries(ENTRY).reverse())))));
  ok('J10 a valid entry in non-canonical form (whitespace, key order) is refused', /^entry: not canonical$/.test(m1) && /^entry: not canonical$/.test(m2), [m1, m2]);
  const m3 = refusal(() => J.decodeEntry(enc('{"v":1')));
  const m4 = refusal(() => J.decodeEntry(enc('[1,2]')));
  const m5 = refusal(() => J.decodeEntry(new Uint8Array([0x7b, 0xff, 0x7d])));
  ok('J11 not JSON, not an object, not UTF-8 → refused by their messages',
    m3 === 'entry: not JSON' && m4 === 'entry: not an object' && m5 === 'entry: not UTF-8', [m3, m4, m5]);
  const big = { ...ENTRY, reasoning: 'é'.repeat(280) };
  const bigBytes = enc(CANON.replace(ENTRY.reasoning, big.reasoning).padEnd(2049, ' '));
  const m6 = refusal(() => J.decodeEntry(bigBytes));
  ok('J12 more than 2048 bytes → refused before parsing', m6 === 'entry: too large', m6);
}

// ── fingerprint ─────────────────────────────────────────────────────────────────────────────
const G = 'agent-owned-20261030T073943Z';
const SELLER = '5a5d96f384a41ba3d1c90399dcd563ed6f52c34aa28ba5f200902a655d8ab288';
const T = (s: number) => (1_762_099_200_000_000_000n + BigInt(s) * 1_000_000_000n).toString(); // seconds after a base, in ns
function row(n: number, ts: string | null, over: Partial<Json> = {}): Json {
  const r: Json = { group_id: G, user_id: SELLER, file_hash: sha(`entry ${n}`), ipfs_hash: `fastfs/${n}`, timestamp: ts,
    backend: ts === null ? null : 'FastFS', deleted: null, ...over };
  r.trans_id = over.trans_id ?? sha(`${r.group_id}${r.user_id}${r.file_hash}${r.ipfs_hash}${r.timestamp}`);
  return r;
}
const smoke = row(0, T(-86_400), { user_id: '1000fans.near' }); // before the range, another uploader
const legacy = row(9, null);                                      // a legacy record before the range
const entries = [row(1, T(0)), row(2, T(60)), row(3, T(60)), row(4, T(120))];
const later = row(5, T(500));
const ROWS = [smoke, legacy, ...entries, later];
const RANGE = { groupId: G, seller: SELLER, sinceNs: T(0), asOfNs: T(120) };
const expectedRoot = sha(`nova-copy-trading fingerprint v1\n${G}\n${SELLER}\n${T(0)}\n${T(120)}\n` +
  entries.map((r) => `${r.trans_id} ${r.file_hash}\n`).join(''));
const fp = (rows: Json[], range: Json = RANGE) => J.computeFingerprint(rows, range);
{
  const f = fp(ROWS);
  ok('K1 the fingerprint covers exactly the records in [since, asOf], in chain order, with the documented root',
    f.count === 4 && f.root === expectedRoot && JSON.stringify(f.transIds) === JSON.stringify(entries.map((r) => r.trans_id)), f);
  ok('K2 records before the range (another uploader, a legacy record) and after it are not covered',
    !f.transIds.includes(smoke.trans_id) && !f.transIds.includes(legacy.trans_id) && !f.transIds.includes(later.trans_id));
  const tight = fp(ROWS, { ...RANGE, sinceNs: T(60), asOfNs: T(60) });
  ok('K3 both bounds are inclusive (a range of one instant covers its two records)', tight.count === 2, tight);
  const narrower = fp(ROWS, { ...RANGE, sinceNs: (BigInt(T(0)) + 1n).toString(), asOfNs: (BigInt(T(120)) - 1n).toString() });
  ok('K4 one ns inside each bound drops the boundary records', narrower.count === 2, narrower);
}
{
  const swapped = [smoke, legacy, entries[0], entries[2], entries[1], entries[3], later];
  const changed = [smoke, legacy, entries[0], row(2, T(60), { file_hash: sha('other') }), entries[2], entries[3], later];
  ok('K5 the root changes when two same-time records swap or one file_hash differs',
    fp(swapped).root !== expectedRoot && fp(changed).root !== expectedRoot);
  const roots = [fp(ROWS, { ...RANGE, asOfNs: T(130) }), fp(ROWS, { ...RANGE, sinceNs: (BigInt(T(0)) - 1n).toString() })];
  ok('K6 the root binds the range: the same four records under another since or asOf give another root',
    roots.every((f) => f.count === 4 && f.root !== expectedRoot), roots);
}
const inRange: [string, Json[], RegExp][] = [
  ['a tombstoned record', [entries[0], row(2, T(60), { deleted: { deleted_at: T(70), deleted_by: SELLER, reason: 'OwnerRequest' } }), entries[3]], /: deleted$/],
  ['another uploader', [entries[0], row(2, T(60), { user_id: '1000fans.near' }), entries[3]], /: uploaded by 1000fans\.near, not the seller$/],
  ['a record without upload time', [entries[0], row(2, null), entries[3]], /: no upload time$/],
  ['another group', [entries[0], row(2, T(60), { group_id: 'other-group' }), entries[3]], /: in another group$/],
  ['an uppercase file_hash', [entries[0], row(2, T(60), { file_hash: sha('x').toUpperCase() }), entries[3]], /: file_hash is not lowercase SHA-256 hex$/],
  ['times out of order', [entries[0], entries[3], row(2, T(60))], /: out of chain order$/],
  ['a trans_id not matching its fields', [entries[0], { ...entries[1], timestamp: T(61) }, entries[3]], /: trans_id does not match its fields$/],
];
{
  const failures = inRange.map(([what, rows, re]) => [what, refusal(() => fp(rows)), re] as const).filter(([, m, re]) => !re.test(m));
  ok(`K7 a covered record that breaks a rule refuses the whole journal, by its message (${inRange.length} cases)`, failures.length === 0,
    failures.map(([w, m]) => `${w}: ${m}`));
  const other = row(2, T(60), { user_id: '1000fans.near' });
  const m = refusal(() => fp([entries[0], other, entries[3]]));
  ok('K8 the refusal names the record by its trans_id prefix',
    m === `record ${other.trans_id.slice(0, 12)}: uploaded by 1000fans.near, not the seller`, m);
}
{
  const m1 = refusal(() => fp(ROWS, { ...RANGE, sinceNs: T(200), asOfNs: T(300) }));
  const m2 = refusal(() => fp([smoke, legacy]));
  const m3 = refusal(() => fp(ROWS, { ...RANGE, sinceNs: T(120), asOfNs: T(0) }));
  const m4 = refusal(() => fp(ROWS, { ...RANGE, sinceNs: '1.5e18' }));
  const m5 = refusal(() => fp(ROWS, { ...RANGE, asOfNs: '-1' }));
  ok('K9 an empty range, a reversed range or non-ns bounds → refused',
    m1 === 'range: no entries' && m2 === 'range: no entries' &&
    [m3, m4, m5].every((m) => m === 'range: since and asOf must be ns decimal strings with since <= asOf'), [m1, m2, m3, m4, m5]);
  const huge = (BigInt(T(0)) + 1n).toString();
  const near = [row(1, T(0)), row(2, huge)];
  ok('K10 ns bounds compare exactly beyond 2^53 (a 1 ns difference is honoured)',
    fp(near, { ...RANGE, sinceNs: T(0), asOfNs: T(0) }).count === 1 && fp(near, { ...RANGE, sinceNs: huge, asOfNs: huge }).count === 1);
  ok('K11 contractTransId reproduces the contract\'s trans_id', J.contractTransId(entries[0]) === entries[0].trans_id);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log('failed:'); for (const r of failed) console.log(`  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`); process.exit(1); }