/**
 * nova-reader.ts: the follower's FeedReader (verify-feed.ts) over nova-sdk-js 1.4.0.
 *
 * getTransactionsForGroup goes through MCP's get_group_transactions, which for an Agent Connect session reads
 * the contract's reader-gated get_transactions_for_group_of and returns its rows unchanged, in the group
 * index's order (MCP v0.4.12, server.py). retrieve decrypts client-side and returns { data, ipfs_hash, group_id }.
 *
 * The SDK's return types are promises it does not check, so this adapter checks the shape of every reply and
 * passes on exactly the TxRow fields. A malformed reply is a NovaReplyError: a reader failure, never a verdict
 * on the feed (verify-feed rethrows it). Content is still checked against its on-chain hash by verify-feed.
 */
import type { TxRow } from '../core/journal.ts';
import type { FeedReader } from '../core/verify-feed.ts';

/** The two nova-sdk-js methods the reader uses (a NovaSdk instance, or a fake in the harness). */
export interface NovaReadClient {
  getTransactionsForGroup(groupId: string): Promise<unknown>;
  retrieve(groupId: string, ref: string): Promise<unknown>;
}

export class NovaReplyError extends Error {
  constructor(message: string) { super(message); this.name = 'NovaReplyError'; }
}
const fail = (m: string): never => { throw new NovaReplyError(m); };

const STRING_FIELDS = ['trans_id', 'group_id', 'user_id', 'file_hash', 'ipfs_hash'] as const;

function toRow(r: any, i: number): TxRow {
  if (typeof r !== 'object' || r === null || Array.isArray(r)) fail(`nova: record ${i} is not an object`);
  for (const f of STRING_FIELDS) if (typeof r[f] !== 'string') fail(`nova: record ${i}: ${f} must be a string`);
  if (r.timestamp !== null && typeof r.timestamp !== 'string') fail(`nova: record ${i}: timestamp must be a string or null`);
  if (r.deleted !== null && (typeof r.deleted !== 'object' || Array.isArray(r.deleted))) fail(`nova: record ${i}: deleted must be an object or null`);
  return { trans_id: r.trans_id, group_id: r.group_id, user_id: r.user_id, file_hash: r.file_hash, ipfs_hash: r.ipfs_hash,
    timestamp: r.timestamp, deleted: r.deleted };
}

export function novaFeedReader(sdk: NovaReadClient): FeedReader {
  return {
    async listRecords(groupId) {
      const rows = await sdk.getTransactionsForGroup(groupId);
      if (!Array.isArray(rows)) return fail('nova: get_group_transactions did not return a list');
      return rows.map(toRow);
    },
    async retrieve(groupId, ref) {
      const r: any = await sdk.retrieve(groupId, ref);
      if (!(r?.data instanceof Uint8Array)) fail('nova: retrieve returned no bytes');
      if (r.group_id !== groupId || r.ipfs_hash !== ref) fail('nova: retrieve answered for another file');
      return r.data;
    },
  };
}