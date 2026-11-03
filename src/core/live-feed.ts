/**
 * live-feed.ts: the follower's check of each new journal entry after the listing's range, for the copy loop.
 *
 * Approved with verify-feed (2026-11-03): the ongoing feed gets the same per-entry checks as the listed range.
 * Given the entries already verified (verifyFeed's, then earlier live ones, in chain order):
 *   1. the last known entry must still be in the group's index; every record after it is new;
 *   2. every new record must carry an upload time (a record made without one cannot hide at the tail) no earlier
 *      than the last known entry's, and together they pass the journal's record rules: the seller's, this group,
 *      not tombstoned, chain order, lowercase hash, trans_id recomputed from its fields (journal.ts);
 *   3. each new entry is retrieved, its plaintext matches its on-chain file_hash, and it decodes (journal.ts);
 *   4. all entries, known and new, pass the P&L rules (pnl.ts): committed within 15 minutes of the trade, the
 *      listing's simulated flag, USDC, long-only against the positions so far. The realised P&L after the last
 *      new entry is returned with it.
 * Refusals are FeedRefused ("live: …"); reader failures and malformed replies are rethrown as they are.
 */
import { computeFingerprint, decodeEntry, entryFileHash, JournalRefused } from './journal.ts';
import { recomputeCurve, PnlRefused } from './pnl.ts';
import { FeedRefused } from './verify-feed.ts';
import type { FeedReader, VerifiedEntry } from './verify-feed.ts';
import type { Listing } from './listing.ts';

export { FeedRefused };

export interface LiveUpdate {
  /** The new entries, in chain order (empty when nothing new was recorded). */
  entries: VerifiedEntry[];
  /** Record time of the last entry, known or new, ns. */
  atNs: string;
  /** Realised P&L in USDC at atNs, over every entry so far. */
  realised: string;
}

const refuse = (m: string): never => { throw new FeedRefused(m); };
function as<T>(prefix: string, f: () => T): T {
  try { return f(); } catch (e) {
    if (e instanceof JournalRefused || e instanceof PnlRefused) return refuse(`${prefix}${e.message}`);
    throw e;
  }
}

export async function verifyLiveEntries(listing: Listing, reader: FeedReader, known: VerifiedEntry[]): Promise<LiveUpdate> {
  if (known.length === 0) refuse('live: no verified entries yet (run verifyFeed first)');
  const { groupId, seller } = listing;
  const last = known[known.length - 1];

  const rows = await reader.listRecords(groupId);
  const at = rows.findIndex((r) => r.trans_id === last.transId);
  if (at < 0) refuse(`live: the last verified entry ${last.transId.slice(0, 12)} is no longer in the group`);
  const tail = rows.slice(at + 1);

  const entries: VerifiedEntry[] = [];
  if (tail.length > 0) {
    let prev = BigInt(last.recordNs);
    for (const r of tail) {
      const id = String(r.trans_id).slice(0, 12);
      if (typeof r.timestamp !== 'string') refuse(`live: record ${id}: no upload time`);
      if (BigInt(r.timestamp as string) < prev) refuse(`live: record ${id}: out of chain order`);
      prev = BigInt(r.timestamp as string);
    }
    as('live: ', () => computeFingerprint(tail, { groupId, seller, sinceNs: last.recordNs, asOfNs: prev.toString() }));
    for (const r of tail) {
      const id = r.trans_id.slice(0, 12);
      const bytes = await reader.retrieve(groupId, r.ipfs_hash);
      if (entryFileHash(bytes) !== r.file_hash) refuse(`live: entry ${id}: content does not match its on-chain hash`);
      const entry = as(`live: entry ${id}: `, () => decodeEntry(bytes));
      entries.push({ transId: r.trans_id, recordNs: r.timestamp as string, entry });
    }
  }

  const all = [...known, ...entries];
  const atNs = all[all.length - 1].recordNs;
  const [point] = as('live: ', () => recomputeCurve(all, listing.curve.quote, listing.curve.simulated, [atNs]));
  return { entries, atNs, realised: point.realised };
}