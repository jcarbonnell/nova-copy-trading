/**
 * membership.ts: the seller's admissions ledger, admit after a verified payment, revoke at expiry.
 *
 * Approved 2026-11-03. The seller owns its group and administers it with its own signature (owner-operations
 * rule, 2026-10-30: NOVA never performs an owner operation on anyone's behalf). The owner keeps control of its
 * data and runs its own membership maintenance; nothing can force it to keep a member.
 *
 *   - One durable record per verified payment, keyed by intent hash: paid → admitted → revoked (or lapsed if
 *     its period ended before it was admitted). The ledger is also verifyPayment's used-intent store, so
 *     "used" and "admitted" cannot drift apart.
 *   - Expiry comes from on-chain facts, never the runner's clock: expiresAtMs = max(payment block time, the
 *     latest expiry among the member's earlier payments in this group) + period. A payment made while the
 *     member's period was still running renews from that period's end, even if it is verified after the
 *     revoke. Anyone can check that the revoke landed on time by comparing the revoke transaction with the
 *     payment blocks.
 *   - Admit and revoke are idempotent against the chain: a member already present is marked admitted without
 *     a write; a member already gone is marked revoked without a write. A crash between a write and its ledger
 *     update is repaired on the next pass.
 *   - A revoke whose chain step landed but whose key rotation (the SDK's MCP follow-up) was not confirmed is
 *     marked rotation "unconfirmed" (roadmap: idempotent wallet revoke in nova-sdk-js).
 *   - The seller is never admitted or revoked. A NOVA or chain failure is rethrown and leaves the record as
 *     it was.
 */
import type { UsedIntentStore, VerifiedPayment } from './verify-payment.ts';

export type AdmissionState = 'paid' | 'admitted' | 'revoked' | 'lapsed';

export interface AdmissionRecord {
  intentHash: string;
  listingId: string;
  groupId: string;
  seller: string;
  member: string;
  txHash: string;
  blockMs: number;
  periodMinutes: number;
  expiresAtMs: number;
  state: AdmissionState;
  admittedAtMs?: number;
  revokedAtMs?: number;
  rotation?: 'confirmed' | 'unconfirmed';
}

/** Durable storage for the ledger (a file or database in the runner; a map in the harness). */
export interface LedgerStore {
  get(intentHash: string): Promise<AdmissionRecord | undefined>;
  put(record: AdmissionRecord): Promise<void>;
  all(): Promise<AdmissionRecord[]>;
}

/** NOVA calls, signed by the seller agent: nova-sdk-js wallet mode over agentConnectSigner. */
export interface MemberOps {
  /** Free view: contract is_authorized. */
  isMember(groupId: string, account: string): Promise<boolean>;
  /** add_group_member, then the SDK's MCP follow-up. */
  add(groupId: string, account: string): Promise<void>;
  /** revoke_group_member, then the SDK's MCP follow-up, which rotates the group key. */
  revoke(groupId: string, account: string): Promise<void>;
}

/** The listing terms the ledger needs. */
export interface ListingRef { listingId: string; groupId: string; seller: string; periodMinutes: number }

export class MembershipRefused extends Error {
  constructor(message: string) { super(message); this.name = 'MembershipRefused'; }
}

const MINUTE_MS = 60_000;
const live = (r: AdmissionRecord) => r.state === 'paid' || r.state === 'admitted';

/**
 * verifyPayment's used-intent store, backed by the ledger. `add` is called by verifyPayment last, only for a
 * verified payment, and records it as paid with its on-chain expiry.
 */
export function paymentRecorder(ledger: LedgerStore, listing: ListingRef): UsedIntentStore {
  return {
    has: async (intentHash) => (await ledger.get(intentHash)) !== undefined,
    add: async (intentHash, p: VerifiedPayment) => {
      if (p.payer === listing.seller) throw new MembershipRefused('membership: the seller cannot buy its own listing');
      if (await ledger.get(intentHash)) throw new MembershipRefused('membership: intent hash already recorded');
      const current = (await ledger.all())
        .filter((r) => r.groupId === listing.groupId && r.member === p.payer)
        .reduce((m, r) => Math.max(m, r.expiresAtMs), 0);
      const expiresAtMs = Math.max(p.blockMs, current) + listing.periodMinutes * MINUTE_MS;
      await ledger.put({
        intentHash, listingId: listing.listingId, groupId: listing.groupId, seller: listing.seller, member: p.payer,
        txHash: p.txHash, blockMs: p.blockMs, periodMinutes: listing.periodMinutes, expiresAtMs, state: 'paid',
      });
    },
  };
}

/** Admits every paid record whose period has not ended. Returns the records it changed. */
export async function admitPaid(ledger: LedgerStore, ops: MemberOps, nowMs: number): Promise<AdmissionRecord[]> {
  const changed: AdmissionRecord[] = [];
  for (const r of await ledger.all()) {
    if (r.state !== 'paid' || r.member === r.seller) continue;
    if (r.expiresAtMs <= nowMs) {
      const lapsed = { ...r, state: 'lapsed' as const };
      await ledger.put(lapsed);
      changed.push(lapsed);
      continue;
    }
    if (!(await ops.isMember(r.groupId, r.member))) await ops.add(r.groupId, r.member);
    const admitted = { ...r, state: 'admitted' as const, admittedAtMs: nowMs };
    await ledger.put(admitted);
    changed.push(admitted);
  }
  return changed;
}

/**
 * Revokes every member whose admitted records have all expired and who holds no other live record in the
 * group (a renewal keeps the member). Returns the records it changed.
 */
export async function revokeExpired(ledger: LedgerStore, ops: MemberOps, nowMs: number): Promise<AdmissionRecord[]> {
  const records = await ledger.all();
  const due = records.filter((r) => r.state === 'admitted' && r.expiresAtMs <= nowMs && r.member !== r.seller);
  const changed: AdmissionRecord[] = [];
  const done = new Set<string>();
  for (const r of due) {
    const key = `${r.groupId}\u0000${r.member}`;
    if (done.has(key)) continue;
    done.add(key);
    const stillLive = records.some((o) => live(o) && o.groupId === r.groupId && o.member === r.member && o.expiresAtMs > nowMs);
    if (stillLive) continue;
    let rotation: 'confirmed' | 'unconfirmed';
    if (await ops.isMember(r.groupId, r.member)) {
      await ops.revoke(r.groupId, r.member);
      rotation = 'confirmed';
    } else {
      rotation = 'unconfirmed';
    }
    for (const o of due.filter((x) => x.groupId === r.groupId && x.member === r.member)) {
      const revoked = { ...o, state: 'revoked' as const, revokedAtMs: nowMs, rotation };
      await ledger.put(revoked);
      changed.push(revoked);
    }
  }
  return changed;
}