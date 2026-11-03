/**
 * verify-feed.ts: the follower's check after admission, that it received exactly what the listing promised.
 *
 * In order (approved 2026-11-03), each step only after the previous one passed:
 *   1. the listing is valid (listing.ts);
 *   2. the group's records give back the listing's fingerprint, count and root (journal.ts);
 *   3. each covered entry is retrieved, its plaintext's SHA-256 equals its record's on-chain file_hash, and
 *      it decodes as a valid canonical entry (journal.ts); only covered records are retrieved;
 *   4. the claimed P&L curve equals the one recomputed from the entries at their record times (pnl.ts).
 *
 * Nothing here trusts NOVA's servers: decryption is client-side in the SDK, and a substituted or reordered
 * file fails its on-chain hash or the fingerprint. The reader is two functions over nova-sdk-js
 * (getTransactionsForGroup, retrieve) supplied by the caller. A refusal is a FeedRefused; a reader failure
 * (network, MCP) is rethrown as it is: it is not a verdict on the feed.
 */
import { computeFingerprint, decodeEntry, entryFileHash, JournalRefused } from './journal.ts';
import type { JournalEntry, TxRow } from './journal.ts';
import { checkClaimedCurve, PnlRefused } from './pnl.ts';
import type { CurvePoint } from './pnl.ts';
import { checkListing, ListingRefused } from './listing.ts';
import type { Listing } from './listing.ts';

export interface FeedReader {
  /** The group's records in index (chain) order: nova-sdk-js getTransactionsForGroup. */
  listRecords(groupId: string): Promise<TxRow[]>;
  /** The decrypted plaintext of one record: nova-sdk-js retrieve(groupId, record.ipfs_hash).data. */
  retrieve(groupId: string, ref: string): Promise<Uint8Array>;
}

export interface VerifiedEntry { transId: string; recordNs: string; entry: JournalEntry }
export interface VerifiedFeed { entries: VerifiedEntry[]; curve: CurvePoint[] }

export class FeedRefused extends Error {
  constructor(message: string) { super(message); this.name = 'FeedRefused'; }
}
const refuse = (m: string): never => { throw new FeedRefused(m); };

/** Runs a check from another core module; its refusal becomes a FeedRefused with its own message. */
function as<T>(prefix: string, f: () => T): T {
  try { return f(); } catch (e) {
    if (e instanceof JournalRefused || e instanceof PnlRefused || e instanceof ListingRefused) return refuse(`${prefix}${e.message}`);
    throw e;
  }
}

export async function verifyFeed(listing: Listing, reader: FeedReader): Promise<VerifiedFeed> {
  as('feed: ', () => checkListing(listing));
  const { groupId, seller, range } = listing;

  const rows = await reader.listRecords(groupId);
  const fp = as('feed: ', () => computeFingerprint(rows, { groupId, seller, sinceNs: range.sinceNs, asOfNs: range.asOfNs }));
  if (fp.count !== listing.fingerprint.count) refuse(`feed: fingerprint count differs: listing ${listing.fingerprint.count}, journal ${fp.count}`);
  if (fp.root !== listing.fingerprint.root) refuse('feed: fingerprint root differs from the listing');

  const byId = new Map(rows.map((r) => [r.trans_id, r]));
  const entries: VerifiedEntry[] = [];
  for (const transId of fp.transIds) {
    const row = byId.get(transId)!;
    const id = transId.slice(0, 12);
    const bytes = await reader.retrieve(groupId, row.ipfs_hash);
    if (entryFileHash(bytes) !== row.file_hash) refuse(`feed: entry ${id}: content does not match its on-chain hash`);
    const entry = as(`feed: entry ${id}: `, () => decodeEntry(bytes));
    entries.push({ transId, recordNs: row.timestamp as string, entry });
  }

  const curve = as('feed: ', () => checkClaimedCurve(entries, listing.curve));
  return { entries, curve };
}