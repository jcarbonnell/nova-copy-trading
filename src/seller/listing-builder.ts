/**
 * listing-builder.ts: the seller's public listing, built from what the chain shows (approved 2026-11-03).
 *
 *   1. The group's records are read with the same FeedReader the follower uses (nova-reader.ts over the seller's
 *      own SDK: reads only, nothing signed, nothing against the action cap). Entries are decrypted client-side.
 *   2. Range: by default from the first record's time to the last one's; sinceNs may start it later. The bounds
 *      are record times, so a record landing during the build falls outside the range.
 *   3. Curve: one point per covered entry's record time (equal times merged), at most MAX_CURVE_POINTS; above
 *      that every k-th, k = ceil(n / MAX_CURVE_POINTS), always keeping the last. Values from recomputeCurve.
 *   4. Terms (seller, group, proceeds account, token, price, period, simulated) come from the caller; openedAtMs
 *      is now(), which checkListing requires to be no earlier than the range's end.
 *   5. Self-check: verifyFeed (the buyer's exact check) runs on the result over the records and bytes just read.
 *   6. The runner rebuilds after each confirmed upload (teaser update). Each build is a new listing with a new id;
 *      the runner keeps the ones it published so a buyer can pay any of them.
 * A record by another uploader inside the range is refused, never skipped (the follower's fingerprint would
 * refuse it too). A refusal is a ListingBuildRefused with the core module's message; reader errors pass through.
 */
import { computeFingerprint, decodeEntry, JournalRefused, type TxRow } from '../core/journal.ts';
import { recomputeCurve, PnlRefused, QUOTE, type CurveEntry } from '../core/pnl.ts';
import { checkListing, canonicalListing, listingId, ListingRefused, MAX_CURVE_POINTS, type Listing } from '../core/listing.ts';
import { verifyFeed, FeedRefused, type FeedReader } from '../core/verify-feed.ts';

export interface ListingTerms {
  seller: string;
  groupId: string;
  proceedsAccount: string;
  token: string;
  price: string;
  periodMinutes: number;
  simulated: boolean;
}
export interface BuildOptions { sinceNs?: string; now?: () => number }
export interface BuiltListing { listing: Listing; id: string; json: string }

export class ListingBuildRefused extends Error {
  constructor(m: string) { super(m); this.name = 'ListingBuildRefused'; }
}
const refuse = (m: string): never => { throw new ListingBuildRefused(m); };
const NS = /^(0|[1-9]\d*)$/;

/** Runs core checks; their refusals become a ListingBuildRefused with their own message. */
async function as<T>(f: () => T | Promise<T>): Promise<T> {
  try { return await f(); } catch (e) {
    if (e instanceof JournalRefused || e instanceof PnlRefused || e instanceof ListingRefused || e instanceof FeedRefused) {
      return refuse(`listing-builder: ${e.message}`);
    }
    throw e;
  }
}

/** Record times to sample: equal times merged, at most `max`, the last always kept. */
export function samplePoints(times: string[], max: number = MAX_CURVE_POINTS): string[] {
  const distinct = times.filter((t, i) => i === times.length - 1 || t !== times[i + 1]);
  const k = Math.ceil(distinct.length / max);
  const n = distinct.length;
  return distinct.filter((_, i) => (n - 1 - i) % k === 0);
}

export async function buildListing(reader: FeedReader, terms: ListingTerms, opts: BuildOptions = {}): Promise<BuiltListing> {
  const now = opts.now ?? Date.now;
  const { groupId, seller } = terms;

  const rows = await reader.listRecords(groupId);
  const timed = rows.filter((r) => typeof r.timestamp === 'string' && NS.test(r.timestamp));
  if (timed.length === 0) refuse('listing-builder: the group has no entries');
  const sinceNs = opts.sinceNs ?? (timed[0].timestamp as string);
  const asOfNs = timed[timed.length - 1].timestamp as string;
  const fp = await as(() => computeFingerprint(rows, { groupId, seller, sinceNs, asOfNs }));

  const byId = new Map(rows.map((r) => [r.trans_id, r]));
  const bytesByRef = new Map<string, Uint8Array>();
  const entries: CurveEntry[] = [];
  for (const transId of fp.transIds) {
    const row = byId.get(transId) as TxRow;
    const bytes = await reader.retrieve(groupId, row.ipfs_hash);
    bytesByRef.set(row.ipfs_hash, bytes);
    const entry = await as(() => decodeEntry(bytes));
    entries.push({ transId, recordNs: row.timestamp as string, entry });
  }

  const points = samplePoints(entries.map((e) => e.recordNs));
  const curvePoints = await as(() => recomputeCurve(entries, QUOTE, terms.simulated, points));
  const listing = await as(() => checkListing({
    v: 1, seller, groupId, proceedsAccount: terms.proceedsAccount, token: terms.token, price: terms.price,
    openedAtMs: now(), periodMinutes: terms.periodMinutes, range: { sinceNs, asOfNs },
    fingerprint: { count: fp.count, root: fp.root }, curve: { quote: QUOTE, simulated: terms.simulated, points: curvePoints },
  }));

  // The buyer's check, over exactly what was read.
  const same: FeedReader = {
    listRecords: async () => rows,
    retrieve: async (_g, ref) => bytesByRef.get(ref) as Uint8Array,
  };
  await as(() => verifyFeed(listing, same));
  return { listing, id: listingId(listing), json: canonicalListing(listing) };
}