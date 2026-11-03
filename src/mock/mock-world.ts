/**
 * mock-world.ts: in-memory stand-ins for NOVA, the Agent API and the chain, for `npm run demo:mock` (approved
 * 2026-11-03). The real seller and follower services run on top of them unchanged. No keys, no network.
 *
 *   NOVA     one store of group records, built as contract v0.3.9 builds them (trans_id = sha256 of group, user,
 *            file_hash, location and block-time ns); uploads recorded under the uploader's account; owner-only
 *            add and revoke; is_authorized; reads by a non-member refused. MOCK: no encryption, no key
 *            rotation; refusing a non-member's read stands in for the rotated key.
 *   Agent    dry swap quotes from a labelled MOCK NEAR price path (no fees), each agent's per-trade caps as
 *            policy_* warnings; withdraw previews refused for any recipient outside the agent's list
 *            (policy_destination_denied); a withdrawal settles only as the one REAL recorded payment (57r1).
 *   Chain    the real 57r1 transaction (test/fixtures, hash-checked by the caller), so verifyPayment runs for real.
 *   Clock    virtual: the demo moves it, so a 60-minute period passes in seconds.
 */
import { createHash } from 'node:crypto';
import type { ChainReader } from '../core/verify-payment.ts';

type Json = any;
const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');

export const FIXTURE_SHA = 'a075acf5527013f7c4ed479170bff597a6415fe24b7438d92f42d1788aa171f8';
/** The real payment the fixture records (0.10 USDC to 1000fans.near, 2026-10-19). */
export const RECORDED = {
  intentHash: 'B2btEHKa3W2DcSo51dYoEAMghbmHqEUKg78BwSPK3UbY',
  payer: '5a5d96f384a41ba3d1c90399dcd563ed6f52c34aa28ba5f200902a655d8ab288',
  recipient: '1000fans.near',
  asset: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  amount: '100000',
  blockMs: Date.parse('2026-10-19T10:34:44.600Z'),
  windowFromMs: Date.parse('2026-10-19T10:34:42.845Z'),
  windowToMs: Date.parse('2026-10-19T10:34:48.248Z'),
} as const;
export const USDC = RECORDED.asset;
export const WNEAR = 'nep141:wrap.near';
const NEAR_SCALE = 10n ** 18n;      // yocto per micro-USDC unit ratio: 10^(24-6)
const PRICE_SCALE = 1_000_000_000n; // prices have 9 decimals

export interface Clock { now(): number; advance(ms: number): void; set(ms: number): void }
export interface AgentPolicy { capUsdc: bigint; capWnear: bigint; withdrawTo: string[] }
export interface MockWorldOptions {
  startMs: number;
  fixture: Json;
  /** MOCK NEAR prices in USDC (9 decimals at most), one per step of `stepMs` from startMs; the last holds. */
  prices: string[];
  stepMs?: number;
}

export class MockNovaError extends Error { constructor(m: string) { super(m); this.name = 'NovaError'; } }

export function createMockWorld(o: MockWorldOptions) {
  let t = o.startMs;
  const clock: Clock = { now: () => t, advance: (ms) => { t += ms; }, set: (ms) => { t = ms; } };
  const step = o.stepMs ?? 5 * 60_000;
  const prices = o.prices.map((p) => { const [i, f = ''] = p.split('.'); return BigInt(i + f.padEnd(9, '0').slice(0, 9)); });
  const priceAt = (ms: number) => prices[Math.min(prices.length - 1, Math.max(0, Math.floor((ms - o.startMs) / step)))];

  // ── NOVA ──
  const groups = new Map<string, { owner: string; members: Set<string>; rows: Json[]; files: Map<string, Uint8Array> }>();
  let lastNs = 0n;
  const group = (g: string) => { const x = groups.get(g); if (!x) throw new MockNovaError(`group ${g} not found`); return x; };

  function createGroup(groupId: string, owner: string) {
    groups.set(groupId, { owner, members: new Set([owner]), rows: [], files: new Map() });
  }
  /** Adds a record by any account (for the demo's "other uploader" and pre-journal records). */
  function record(groupId: string, user: string, data: Uint8Array, location: string) {
    const g = group(groupId);
    let ns = BigInt(t) * 1_000_000n;
    if (ns <= lastNs) ns = lastNs + 1n;
    lastNs = ns;
    const r: Json = { group_id: groupId, user_id: user, file_hash: sha(data), ipfs_hash: location, timestamp: ns.toString(), deleted: null };
    r.trans_id = sha(`${r.group_id}${r.user_id}${r.file_hash}${r.ipfs_hash}${r.timestamp}`);
    g.rows.push(r);
    g.files.set(location, new Uint8Array(data));
    return r;
  }

  /** A NovaSdk stand-in signed in as `account` (the methods the services use, with nova-sdk-js's shapes). */
  function novaFor(account: string) {
    const member = (g: string) => group(g).members.has(account);
    return {
      accountId: account,
      async upload(groupId: string, data: Buffer, filename: string) {
        if (!member(groupId)) throw new MockNovaError('Wallet transaction \'record_transaction\' failed or was rejected: User not authorized');
        const r = record(groupId, account, new Uint8Array(data), `fastfs/${filename}`);
        return { cid: r.ipfs_hash, trans_id: r.trans_id, file_hash: r.file_hash };
      },
      async retrieve(groupId: string, ref: string) {
        if (!member(groupId)) throw new MockNovaError('MCP tool \'prepare_retrieve\' failed: not authorized (MOCK: stands in for the rotated key)');
        const data = group(groupId).files.get(ref);
        if (!data) throw new MockNovaError(`MCP tool 'prepare_retrieve' failed: ${ref} not found`);
        return { data: Buffer.from(data), ipfs_hash: ref, group_id: groupId };
      },
      async getTransactionsForGroup(groupId: string) {
        if (!member(groupId)) throw new MockNovaError('MCP tool \'get_group_transactions\' failed: not authorized');
        return group(groupId).rows.map((r) => ({ ...r }));
      },
      async isAuthorized(groupId: string, userId?: string) { return group(groupId).members.has(userId ?? account); },
      async addGroupMember(groupId: string, memberId: string) {
        const g = group(groupId);
        if (g.owner !== account) throw new MockNovaError('Wallet transaction \'add_group_member\' failed or was rejected: Only group owner');
        if (g.members.has(memberId)) throw new MockNovaError('Wallet transaction \'add_group_member\' failed or was rejected: User already a member');
        g.members.add(memberId);
        return `Added ${memberId}`;
      },
      async revokeGroupMember(groupId: string, memberId: string) {
        const g = group(groupId);
        if (g.owner !== account) throw new MockNovaError('Wallet transaction \'revoke_group_member\' failed or was rejected: Only group owner');
        if (!g.members.has(memberId)) throw new MockNovaError('Wallet transaction \'revoke_group_member\' failed or was rejected: User not a member');
        g.members.delete(memberId);
        return `Revoked ${memberId}`;
      },
    };
  }

  // ── Agent API ──
  const withdrawals = new Map<string, Json>();   // idempotency key → status
  function agentFor(policy: AgentPolicy) {
    const capOf = (asset: string) => (asset === USDC ? policy.capUsdc : asset === WNEAR ? policy.capWnear : 0n);
    const limit = (asset: string, amount: string) => (BigInt(amount) > capOf(asset) ? [{ code: 'policy_transaction_limit_exceeded' }] : []);
    return {
      /** A dry swap quote (QuoteResponse shape), priced on the MOCK path. */
      async swap(_agentId: string, req: Json) {
        if (req?.dry !== true) throw new Error('mock: only dry swaps exist in mock mode');
        const p = priceAt(t);
        const amount = BigInt(req.amount);
        const out = req.origin_asset === USDC ? (amount * NEAR_SCALE * PRICE_SCALE) / p : (amount * p) / (NEAR_SCALE * PRICE_SCALE);
        const warnings = limit(req.origin_asset, req.amount);
        return { dry: true, type: 'swap', warnings, quote: { amount_out: out.toString(), would_succeed: warnings.length === 0 } };
      },
      async previewWithdraw(req: Json) {
        const warnings = [...(policy.withdrawTo.includes(req.recipient) ? [] : [{ code: 'policy_destination_denied' }]), ...limit(req.asset, req.amount)];
        return { dry: true, type: 'withdraw', warnings, quote: { would_succeed: warnings.length === 0 } };
      },
      async withdraw(req: Json, key: string) {
        const seen = withdrawals.get(key);
        if (seen) return { ...seen };
        if (!policy.withdrawTo.includes(req.recipient) || BigInt(req.amount) > policy.capUsdc) {
          throw Object.assign(new Error('policy_denied'), { name: 'AgentApiError', status: 409, code: 'policy_denied', retryable: false });
        }
        const settles = req.recipient === RECORDED.recipient && req.amount === RECORDED.amount && req.asset === RECORDED.asset;
        const st = { correlation_id: `mock-${sha(key).slice(0, 12)}`, status: 'PROCESSING', settles };
        withdrawals.set(key, st);
        return { correlation_id: st.correlation_id, status: st.status };
      },
      async status(correlationId: string) {
        const st = [...withdrawals.values()].find((w) => w.correlation_id === correlationId);
        if (!st) throw new Error(`mock: unknown correlation id ${correlationId}`);
        if (!st.settles) return { correlation_id: correlationId, status: 'FAILED', failure_code: 'mock_no_recorded_payment', details: {} };
        return { correlation_id: correlationId, status: 'SUCCESS', failure_code: null,
          dispatch_committed_at: new Date(RECORDED.windowFromMs).toISOString(), updated_at: new Date(RECORDED.windowToMs).toISOString(),
          details: { intent_hash: RECORDED.intentHash, near_account_id: RECORDED.payer } };
      },
    };
  }

  // ── Chain ──
  const fx = o.fixture;
  const chain: ChainReader = {
    scanExecuteIntents: async (fromMs, toMs) => (RECORDED.blockMs >= fromMs && RECORDED.blockMs <= toMs ? [fx.transaction] : []),
    txStatus: async (hash) => { if (hash !== fx.transaction.hash) throw new Error(`mock chain: unknown tx ${hash}`); return fx; },
    blockTimeMs: async (h) => { if (h !== fx.transaction_outcome.block_hash) throw new Error(`mock chain: unknown block ${h}`); return RECORDED.blockMs; },
  };

  return { clock, createGroup, record, novaFor, agentFor, chain, priceAt };
}