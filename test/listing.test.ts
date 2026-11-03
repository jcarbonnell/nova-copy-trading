// listing.test.ts: harness for src/core/listing.ts (the public listing and its content-addressed id).
// Pure: no network.
//
//   npx tsx test/listing.test.ts
//   LISTING_MODULE=<path> npx tsx test/listing.test.ts     (the mutation script)
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const modPath = process.env.LISTING_MODULE ? resolve(process.env.LISTING_MODULE) : resolve(here, '../src/core/listing.ts');
const L = await import(pathToFileURL(modPath).href);

type Json = any;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function ok(name: string, pass: boolean, detail?: unknown) {
  const d = detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ name, ok: pass, detail: d });
  console.log(`${pass ? '✓' : '✗'} ${name}${!pass && d ? ` — ${d}` : ''}`);
}
function refusal(f: () => unknown): string {
  try { f(); return 'no refusal'; } catch (e) { return e instanceof L.ListingRefused ? (e as Error).message : `not a ListingRefused: ${String(e)}`; }
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const clone = (x: Json): Json => JSON.parse(JSON.stringify(x));

const SINCE = '1762160000000000000';
const MID = '1762200000000000000';
const ASOF = '1762246400000000000';
const LISTING = {
  v: 1,
  seller: '5a5d96f384a41ba3d1c90399dcd563ed6f52c34aa28ba5f200902a655d8ab288',
  groupId: 'agent-owned-20261030T073943Z',
  proceedsAccount: '1000fans.near',
  token: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  price: '100000',
  openedAtMs: 1762246500000,
  periodMinutes: 1440,
  range: { sinceNs: SINCE, asOfNs: ASOF },
  fingerprint: { count: 4, root: 'cd'.repeat(32) },
  curve: { quote: 'USDC', simulated: true, points: [{ atNs: MID, realised: '0.000000' }, { atNs: ASOF, realised: '2.500000' }] },
};
const CANON = '{"v":1,"seller":"5a5d96f384a41ba3d1c90399dcd563ed6f52c34aa28ba5f200902a655d8ab288",' +
  '"groupId":"agent-owned-20261030T073943Z","proceedsAccount":"1000fans.near",' +
  '"token":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","price":"100000",' +
  '"openedAtMs":1762246500000,"periodMinutes":1440,' +
  `"range":{"sinceNs":"${SINCE}","asOfNs":"${ASOF}"},` +
  `"fingerprint":{"count":4,"root":"${'cd'.repeat(32)}"},` +
  `"curve":{"quote":"USDC","simulated":true,"points":[{"atNs":"${MID}","realised":"0.000000"},{"atNs":"${ASOF}","realised":"2.500000"}]}}`;
const ID = sha(CANON);

// ── canonical form and id ───────────────────────────────────────────────────────────────────
{
  ok('L1 a valid listing passes checkListing unchanged', JSON.stringify(L.checkListing(clone(LISTING))) === JSON.stringify(LISTING));
  ok('L2 the canonical form is fixed key order at every level, no whitespace', L.canonicalListing(LISTING) === CANON, L.canonicalListing(LISTING));
  ok('L3 the id is the SHA-256 hex of the canonical form', L.listingId(LISTING) === ID, L.listingId(LISTING));
  const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(clone(LISTING)).reverse())));
  reordered.curve = { points: LISTING.curve.points.map((p) => ({ realised: p.realised, atNs: p.atNs })), simulated: true, quote: 'USDC' };
  reordered.range = { asOfNs: ASOF, sinceNs: SINCE };
  ok('L4 key order in the published JSON does not change the id', L.listingId(reordered) === ID);
  const changes: [string, (l: Json) => void][] = [
    ['price', (l) => { l.price = '100001'; }],
    ['proceeds account', (l) => { l.proceedsAccount = 'attacker.near'; }],
    ['one curve value', (l) => { l.curve.points[1].realised = '2.500001'; }],
    ['the period', (l) => { l.periodMinutes = 1441; }],
    ['the fingerprint root', (l) => { l.fingerprint.root = 'ce' + 'cd'.repeat(31); }],
    ['the simulated flag', (l) => { l.curve.simulated = false; }],
  ];
  const same = changes.filter(([, f]) => { const l = clone(LISTING); f(l); return L.listingId(l) === ID; }).map(([w]) => w);
  ok('L5 any change to the terms, the fingerprint or the curve gives another id', same.length === 0, same);
}

// ── parse with the approved id ──────────────────────────────────────────────────────────────
{
  const got = L.parseListing(JSON.stringify(LISTING, null, 2), ID);
  ok('L6 parseListing accepts the published JSON (any formatting) when its id is the approved one', JSON.stringify(got) === JSON.stringify(LISTING));
  const forged = clone(LISTING); forged.proceedsAccount = 'attacker.near';
  const m1 = refusal(() => L.parseListing(JSON.stringify(forged), ID));
  ok('L7 a listing whose content differs from the approved id → refused', m1 === 'listing: id differs from the approved one', m1);
  const m2 = refusal(() => L.parseListing(JSON.stringify(LISTING), ID.toUpperCase()));
  const m3 = refusal(() => L.parseListing('{"v":1', ID));
  ok('L8 a malformed approved id, or JSON that does not parse → refused', m2 === 'listing: approved id must be 64 lowercase hex' && m3 === 'listing: not JSON', [m2, m3]);
  const t = L.paymentTerms(LISTING);
  ok('L9 paymentTerms gives verifyPayment exactly its four terms',
    JSON.stringify(t) === JSON.stringify({ proceedsAccount: '1000fans.near', token: LISTING.token, price: '100000', openedAtMs: 1762246500000 }), t);
}

// ── refusals ────────────────────────────────────────────────────────────────────────────────
const bad: [string, (l: Json) => void, string][] = [
  ['an unknown top-level field', (l) => { l.seats = 3; }, 'listing: unexpected field seats'],
  ['a missing field', (l) => { delete l.curve; }, 'listing: missing field curve'],
  ['an unknown nested field', (l) => { l.range.extra = 1; }, 'listing: unexpected field range.extra'],
  ['a missing nested field', (l) => { delete l.fingerprint.root; }, 'listing: missing field fingerprint.root'],
  ['a point with an extra field', (l) => { l.curve.points[0].note = 'x'; }, 'listing: unexpected field curve.points[0].note'],
  ['version 2', (l) => { l.v = 2; }, 'listing: unsupported version'],
  ['a seller that is not an account id', (l) => { l.seller = 'Seller.near'; }, 'listing: seller is not a valid NEAR account id'],
  ['a group id with a colon', (l) => { l.groupId = 'member:bob.near'; }, 'listing: groupId is not a valid NOVA group id'],
  ['a group id of 65 characters', (l) => { l.groupId = 'g'.repeat(65); }, 'listing: groupId is not a valid NOVA group id'],
  ['a proceeds account that is not an account id', (l) => { l.proceedsAccount = 'a'; }, 'listing: proceedsAccount is not a valid NEAR account id'],
  ['a token with the nep141: prefix', (l) => { l.token = 'nep141:usdc.near'; }, 'listing: token is not a valid NEAR account id (bare contract id)'],
  ['price zero', (l) => { l.price = '0'; }, 'listing: price must be a positive integer string'],
  ['price as a number', (l) => { l.price = 100000; }, 'listing: price must be a positive integer string'],
  ['openedAtMs fractional', (l) => { l.openedAtMs = 1.5; }, 'listing: openedAtMs must be a time in ms'],
  ['periodMinutes zero', (l) => { l.periodMinutes = 0; }, 'listing: periodMinutes must be 1-525600'],
  ['periodMinutes above a year', (l) => { l.periodMinutes = 525_601; }, 'listing: periodMinutes must be 1-525600'],
  ['a reversed range', (l) => { l.range = { sinceNs: ASOF, asOfNs: SINCE }; }, 'listing: range must be ns decimal strings with sinceNs <= asOfNs'],
  ['a range bound as a number', (l) => { l.range.sinceNs = 1; }, 'listing: range must be ns decimal strings with sinceNs <= asOfNs'],
  ['opening 1 ms before the range ends', (l) => { l.openedAtMs = Number(BigInt(ASOF) / 1_000_000n) - 1; }, 'listing: opens before its range ends'],
  ['fingerprint count zero', (l) => { l.fingerprint.count = 0; }, 'listing: fingerprint.count must be a positive integer'],
  ['fingerprint root uppercase', (l) => { l.fingerprint.root = 'CD'.repeat(32); }, 'listing: fingerprint.root must be 64 lowercase hex'],
  ['a curve in USDT', (l) => { l.curve.quote = 'USDT'; }, 'listing: curve.quote must be USDC'],
  ['simulated as a string', (l) => { l.curve.simulated = 'yes'; }, 'listing: curve.simulated must be a boolean'],
  ['no curve points', (l) => { l.curve.points = []; }, 'listing: curve.points must hold 1-100 points'],
  ['101 curve points', (l) => { l.curve.points = Array.from({ length: 101 }, (_, i) => ({ atNs: (BigInt(SINCE) + BigInt(i)).toString(), realised: '0.000000' })); }, 'listing: curve.points must hold 1-100 points'],
  ['a point time that is not ns', (l) => { l.curve.points[0].atNs = '1e18'; }, 'listing: curve.points[0].atNs must be ns'],
  ['a point value with 2 decimals', (l) => { l.curve.points[1].realised = '2.50'; }, 'listing: curve.points[1].realised must have exactly 6 decimals'],
  ['repeated point times', (l) => { l.curve.points[0].atNs = ASOF; }, 'listing: curve points must be ascending'],
  ['a curve starting before the range', (l) => { l.curve.points[0].atNs = (BigInt(SINCE) - 1n).toString(); }, 'listing: curve starts before the range'],
  ['a curve ending before asOf', (l) => { l.curve.points[1].atNs = (BigInt(ASOF) - 1n).toString(); }, 'listing: curve must end at range.asOfNs'],
  ['not an object', () => {}, 'listing: listing must be an object'],
];
{
  const failures = bad.map(([what, f, want]) => {
    const l = what === 'not an object' ? [LISTING] : clone(LISTING);
    if (what !== 'not an object') f(l);
    const m = refusal(() => L.checkListing(l));
    return m === want ? null : `${what}: ${m}`;
  }).filter(Boolean);
  ok(`L10 each broken rule is refused by its own message (${bad.length} cases)`, failures.length === 0, failures);
  const edge = clone(LISTING);
  edge.openedAtMs = Number(BigInt(ASOF) / 1_000_000n); edge.periodMinutes = 525_600;
  edge.curve.points = [{ atNs: SINCE, realised: '-0.500000' }, { atNs: ASOF, realised: '2.500000' }];
  ok('L11 the edges pass: opening exactly at asOf, a one-year period, a curve starting at sinceNs, a negative value',
    refusal(() => L.checkListing(edge)) === 'no refusal', refusal(() => L.checkListing(edge)));
  const m = refusal(() => L.listingId({ ...clone(LISTING), price: '0' }));
  ok('L12 listingId refuses an invalid listing rather than hashing it', m === 'listing: price must be a positive integer string', m);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log('failed:'); for (const r of failed) console.log(`  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`); process.exit(1); }