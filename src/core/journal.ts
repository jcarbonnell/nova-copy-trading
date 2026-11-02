/**
 * journal.ts: the seller's journal entries and the listing's fingerprint over them.
 *
 * Entry. One trade per entry (roadmap §5.18): pair, side, size, price, time, one line of reasoning and the
 * trade's Agent Connect correlation_id, plus `simulated` (labelled in the viewer) and a 32-byte random salt.
 * The salt is needed because `record_transaction`'s arguments, file_hash included, are public in the
 * transaction: without it, anyone could confirm a guessed trade by hashing candidates. Entries are canonical
 * JSON (fixed key order, no whitespace), so their bytes and their file_hash are reproducible; decoding refuses
 * anything that is not exactly the canonical encoding of a valid entry.
 *
 * Fingerprint. The listing names a range [since, asOf] (block time, ns) and commits to EVERY record in the
 * seller's group in that range, in chain order, so no trade inside the range can be left out. The covered
 * records are the contiguous slice of the group's index (append order = chain order) from the first record
 * at or after `since` to the last at or before `asOf`. Each covered record must be the seller's, in this
 * group, not tombstoned, carry an upload time, keep chain order, hold a lowercase SHA-256 file_hash, and have
 * a trans_id equal to the contract's sha256(group_id + user_id + file_hash + ipfs_hash + timestamp), so a
 * reader (MCP) cannot shift an entry's time or swap its hash unnoticed.
 *
 * Trust note: the contract also lets its owner (nova-sdk.near) record on a member's behalf; the view cannot
 * tell such a record from one the seller signed (roadmap deferral).
 */
import { createHash, randomBytes } from 'node:crypto';

export const MAX_ENTRY_BYTES = 2048;
export const MAX_REASONING = 280;
const FINGERPRINT_DOMAIN = 'nova-copy-trading fingerprint v1';

export interface JournalEntry {
  v: 1;
  simulated: boolean;
  /** Trade time, ISO-8601 UTC with milliseconds (Date.prototype.toISOString). */
  ts: string;
  pair: string;
  side: 'buy' | 'sell';
  /** Positive decimal strings: no floats in a hash-committed record. */
  size: string;
  price: string;
  reasoning: string;
  /** Agent Connect correlation_id of the trade; null for a simulated trade. */
  correlation_id: string | null;
  /** 32 random bytes, lowercase hex. */
  salt: string;
}

/** A group record as the contract's enriched transaction view returns it (nova-sdk-js `Transaction`). */
export interface TxRow {
  trans_id: string;
  group_id: string;
  user_id: string;
  file_hash: string;
  ipfs_hash: string;
  timestamp: string | null;
  deleted: unknown | null;
}

export interface FingerprintRange {
  groupId: string;
  seller: string;
  /** Block time bounds in ns, decimal strings (the contract's own unit), inclusive. */
  sinceNs: string;
  asOfNs: string;
}

export interface Fingerprint {
  count: number;
  root: string;
  transIds: string[];
}

export class JournalRefused extends Error {
  constructor(message: string) { super(message); this.name = 'JournalRefused'; }
}
const refuse = (m: string): never => { throw new JournalRefused(m); };

const KEYS = ['v', 'simulated', 'ts', 'pair', 'side', 'size', 'price', 'reasoning', 'correlation_id', 'salt'] as const;
const HEX64 = /^[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/;
const PAIR = /^[A-Za-z0-9._-]{1,32}\/[A-Za-z0-9._-]{1,32}$/;
const NS = /^(0|[1-9]\d*)$/;

const sha256hex = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const positiveDecimal = (s: unknown) => typeof s === 'string' && DECIMAL.test(s) && /[1-9]/.test(s);

function checkEntry(e: Record<string, unknown>): JournalEntry {
  for (const k of Object.keys(e)) if (!(KEYS as readonly string[]).includes(k)) refuse(`entry: unexpected field ${k}`);
  for (const k of KEYS) if (!(k in e)) refuse(`entry: missing field ${k}`);
  if (e.v !== 1) refuse('entry: unsupported version');
  if (typeof e.simulated !== 'boolean') refuse('entry: simulated must be a boolean');
  if (typeof e.ts !== 'string' || Number.isNaN(Date.parse(e.ts)) || new Date(Date.parse(e.ts)).toISOString() !== e.ts) {
    refuse('entry: ts must be an ISO-8601 UTC time with milliseconds');
  }
  if (typeof e.pair !== 'string' || !PAIR.test(e.pair)) refuse('entry: pair must be BASE/QUOTE');
  if (e.side !== 'buy' && e.side !== 'sell') refuse('entry: side must be buy or sell');
  if (!positiveDecimal(e.size)) refuse('entry: size must be a positive decimal string');
  if (!positiveDecimal(e.price)) refuse('entry: price must be a positive decimal string');
  if (typeof e.reasoning !== 'string' || e.reasoning.length < 1 || e.reasoning.length > MAX_REASONING) {
    refuse(`entry: reasoning must be 1-${MAX_REASONING} characters`);
  }
  if (e.correlation_id !== null && (typeof e.correlation_id !== 'string' || e.correlation_id.length === 0)) {
    refuse('entry: correlation_id must be a non-empty string or null');
  }
  if (typeof e.salt !== 'string' || !HEX64.test(e.salt)) refuse('entry: salt must be 64 lowercase hex');
  return e as unknown as JournalEntry;
}

const canonical = (e: JournalEntry) => JSON.stringify(Object.fromEntries(KEYS.map((k) => [k, e[k]])));

export const newSalt = (): string => randomBytes(32).toString('hex');

/** The exact bytes uploaded to NOVA. */
export function encodeEntry(entry: JournalEntry): Uint8Array {
  const bytes = new TextEncoder().encode(canonical(checkEntry({ ...entry })));
  if (bytes.length > MAX_ENTRY_BYTES) refuse('entry: too large');
  return bytes;
}

/** SHA-256 hex of the plaintext: what the SDK records on chain as file_hash. */
export const entryFileHash = (bytes: Uint8Array): string => sha256hex(bytes);

export function decodeEntry(bytes: Uint8Array): JournalEntry {
  if (bytes.length > MAX_ENTRY_BYTES) refuse('entry: too large');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return refuse('entry: not UTF-8'); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return refuse('entry: not JSON'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) refuse('entry: not an object');
  const entry = checkEntry(parsed as Record<string, unknown>);
  if (canonical(entry) !== text) refuse('entry: not canonical');
  return entry;
}

/** The contract's trans_id for a record (record_transaction, v0.3.9). */
export const contractTransId = (r: TxRow): string =>
  sha256hex(`${r.group_id}${r.user_id}${r.file_hash}${r.ipfs_hash}${r.timestamp}`);

export function computeFingerprint(rows: TxRow[], range: FingerprintRange): Fingerprint {
  const { groupId, seller, sinceNs, asOfNs } = range;
  if (!NS.test(sinceNs) || !NS.test(asOfNs) || BigInt(sinceNs) > BigInt(asOfNs)) {
    refuse('range: since and asOf must be ns decimal strings with since <= asOf');
  }
  const since = BigInt(sinceNs);
  const asOf = BigInt(asOfNs);
  const time = (r: TxRow) => (typeof r.timestamp === 'string' && NS.test(r.timestamp) ? BigInt(r.timestamp) : null);

  const first = rows.findIndex((r) => { const t = time(r); return t !== null && t >= since; });
  let last = -1;
  rows.forEach((r, i) => { const t = time(r); if (t !== null && t <= asOf) last = i; });
  if (first < 0 || last < first) refuse('range: no entries');

  const covered = rows.slice(first, last + 1);
  let prev: bigint | null = null;
  for (const r of covered) {
    const id = String(r.trans_id).slice(0, 12);
    const t = time(r);
    if (t === null) refuse(`record ${id}: no upload time`);
    if (r.group_id !== groupId) refuse(`record ${id}: in another group`);
    if (r.user_id !== seller) refuse(`record ${id}: uploaded by ${r.user_id}, not the seller`);
    if (r.deleted !== null && r.deleted !== undefined) refuse(`record ${id}: deleted`);
    if (typeof r.file_hash !== 'string' || !HEX64.test(r.file_hash)) refuse(`record ${id}: file_hash is not lowercase SHA-256 hex`);
    if (prev !== null && t! < prev) refuse(`record ${id}: out of chain order`);
    if (contractTransId(r) !== r.trans_id) refuse(`record ${id}: trans_id does not match its fields`);
    prev = t;
  }

  const header = `${FINGERPRINT_DOMAIN}\n${groupId}\n${seller}\n${sinceNs}\n${asOfNs}\n`;
  const root = sha256hex(header + covered.map((r) => `${r.trans_id} ${r.file_hash}\n`).join(''));
  return { count: covered.length, root, transIds: covered.map((r) => r.trans_id) };
}