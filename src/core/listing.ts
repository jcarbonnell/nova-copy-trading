/**
 * listing.ts: the seller's public listing (teaser + sale terms) and its content-addressed id.
 *
 * Fields (approved 2026-11-03): seller and group (the fingerprint's subject), proceeds account, token, price
 * and opening time (what verifyPayment checks), the membership period, the journal range, the fingerprint,
 * and the claimed realised P&L curve (pnl.ts rules).
 *
 * The id is the SHA-256 of the listing's canonical JSON (fixed key order at every level, no whitespace), so
 * any change (another price, another proceeds account, a doctored curve) is another listing. "Never reused"
 * holds by construction. The listing is not signed: the follower's owner supplies the id it approves
 * (§5.18 / Cleanroom D37), and the follower's Agent Connect policy whitelists only the proceeds account, so a
 * forged listing cannot be paid. Everything else in it is checked after purchase (verify-feed.ts).
 */
import { createHash } from 'node:crypto';
import { QUOTE, DECIMALS } from './pnl.ts';
import type { ClaimedCurve } from './pnl.ts';
import type { Listing as PaymentTerms } from './verify-payment.ts';

export const MAX_PERIOD_MINUTES = 525_600; // the SDK's access window bound (1 year)
export const MAX_CURVE_POINTS = 100;

export interface Listing {
  v: 1;
  seller: string;
  groupId: string;
  proceedsAccount: string;
  token: string;
  price: string;
  openedAtMs: number;
  periodMinutes: number;
  range: { sinceNs: string; asOfNs: string };
  fingerprint: { count: number; root: string };
  curve: ClaimedCurve;
}

export class ListingRefused extends Error {
  constructor(message: string) { super(message); this.name = 'ListingRefused'; }
}
const refuse = (m: string): never => { throw new ListingRefused(m); };

const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const isAccountId = (s: unknown): s is string => typeof s === 'string' && s.length >= 2 && s.length <= 64 && ACCOUNT_ID.test(s);
const GROUP_ID = /^[A-Za-z0-9._-]{1,64}$/;       // contract v0.3.9 assert_valid_group_id
const NS = /^(0|[1-9]\d*)$/;
const HEX64 = /^[0-9a-f]{64}$/;
const VALUE = new RegExp(`^-?(0|[1-9]\\d*)\\.\\d{${DECIMALS}}$`);
const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

function exactKeys(where: string, o: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isObject(o)) return refuse(`listing: ${where} must be an object`);
  for (const k of Object.keys(o)) if (!keys.includes(k)) refuse(`listing: unexpected field ${where === 'listing' ? '' : `${where}.`}${k}`);
  for (const k of keys) if (!(k in o)) refuse(`listing: missing field ${where === 'listing' ? '' : `${where}.`}${k}`);
  return o;
}

/** Validates a parsed listing; refuses with a message naming the first rule it breaks. */
export function checkListing(x: unknown): Listing {
  const l = exactKeys('listing', x, ['v', 'seller', 'groupId', 'proceedsAccount', 'token', 'price', 'openedAtMs',
    'periodMinutes', 'range', 'fingerprint', 'curve']);
  if (l.v !== 1) refuse('listing: unsupported version');
  if (!isAccountId(l.seller)) refuse('listing: seller is not a valid NEAR account id');
  if (typeof l.groupId !== 'string' || !GROUP_ID.test(l.groupId)) refuse('listing: groupId is not a valid NOVA group id');
  if (!isAccountId(l.proceedsAccount)) refuse('listing: proceedsAccount is not a valid NEAR account id');
  if (!isAccountId(l.token)) refuse('listing: token is not a valid NEAR account id (bare contract id)');
  if (typeof l.price !== 'string' || !/^[1-9]\d*$/.test(l.price)) refuse('listing: price must be a positive integer string');
  if (!Number.isSafeInteger(l.openedAtMs) || (l.openedAtMs as number) < 0) refuse('listing: openedAtMs must be a time in ms');
  if (!Number.isSafeInteger(l.periodMinutes) || (l.periodMinutes as number) < 1 || (l.periodMinutes as number) > MAX_PERIOD_MINUTES) {
    refuse(`listing: periodMinutes must be 1-${MAX_PERIOD_MINUTES}`);
  }

  const r = exactKeys('range', l.range, ['sinceNs', 'asOfNs']);
  if (typeof r.sinceNs !== 'string' || typeof r.asOfNs !== 'string' || !NS.test(r.sinceNs) || !NS.test(r.asOfNs) ||
      BigInt(r.sinceNs) > BigInt(r.asOfNs)) {
    refuse('listing: range must be ns decimal strings with sinceNs <= asOfNs');
  }
  if (BigInt(l.openedAtMs as number) * 1_000_000n < BigInt(r.asOfNs as string)) refuse('listing: opens before its range ends');

  const f = exactKeys('fingerprint', l.fingerprint, ['count', 'root']);
  if (!Number.isSafeInteger(f.count) || (f.count as number) < 1) refuse('listing: fingerprint.count must be a positive integer');
  if (typeof f.root !== 'string' || !HEX64.test(f.root)) refuse('listing: fingerprint.root must be 64 lowercase hex');

  const c = exactKeys('curve', l.curve, ['quote', 'simulated', 'points']);
  if (c.quote !== QUOTE) refuse(`listing: curve.quote must be ${QUOTE}`);
  if (typeof c.simulated !== 'boolean') refuse('listing: curve.simulated must be a boolean');
  if (!Array.isArray(c.points) || c.points.length < 1 || c.points.length > MAX_CURVE_POINTS) {
    refuse(`listing: curve.points must hold 1-${MAX_CURVE_POINTS} points`);
  }
  const points = c.points as unknown[];
  points.forEach((p, i) => {
    const q = exactKeys(`curve.points[${i}]`, p, ['atNs', 'realised']);
    if (typeof q.atNs !== 'string' || !NS.test(q.atNs)) refuse(`listing: curve.points[${i}].atNs must be ns`);
    if (typeof q.realised !== 'string' || !VALUE.test(q.realised)) refuse(`listing: curve.points[${i}].realised must have exactly ${DECIMALS} decimals`);
    if (i > 0 && BigInt(q.atNs as string) <= BigInt((points[i - 1] as { atNs: string }).atNs)) refuse('listing: curve points must be ascending');
  });
  if (BigInt((points[0] as { atNs: string }).atNs) < BigInt(r.sinceNs as string)) refuse('listing: curve starts before the range');
  if ((points[points.length - 1] as { atNs: string }).atNs !== r.asOfNs) refuse('listing: curve must end at range.asOfNs');
  return l as unknown as Listing;
}

/** Canonical JSON: fixed key order at every level, no whitespace. */
export function canonicalListing(l: Listing): string {
  return JSON.stringify({
    v: l.v, seller: l.seller, groupId: l.groupId, proceedsAccount: l.proceedsAccount, token: l.token, price: l.price,
    openedAtMs: l.openedAtMs, periodMinutes: l.periodMinutes,
    range: { sinceNs: l.range.sinceNs, asOfNs: l.range.asOfNs },
    fingerprint: { count: l.fingerprint.count, root: l.fingerprint.root },
    curve: { quote: l.curve.quote, simulated: l.curve.simulated, points: l.curve.points.map((p) => ({ atNs: p.atNs, realised: p.realised })) },
  });
}

/** The listing's id: SHA-256 hex of its canonical JSON. */
export const listingId = (l: Listing): string => createHash('sha256').update(canonicalListing(checkListing(l))).digest('hex');

/** The follower's entry point: parse a published listing and require the id its owner approved. */
export function parseListing(json: string, approvedId: string): Listing {
  if (typeof approvedId !== 'string' || !HEX64.test(approvedId)) refuse('listing: approved id must be 64 lowercase hex');
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return refuse('listing: not JSON'); }
  const l = checkListing(parsed);
  if (listingId(l) !== approvedId) refuse('listing: id differs from the approved one');
  return l;
}

/** The terms verifyPayment checks. */
export const paymentTerms = (l: Listing): PaymentTerms =>
  ({ proceedsAccount: l.proceedsAccount, token: l.token, price: l.price, openedAtMs: l.openedAtMs });