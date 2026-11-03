/**
 * seller-service.ts: the seller's logic, every dependency injected (approved 2026-11-03). runner.ts wires it.
 *
 *   1. One write at a time: uploads, admits and revokes go through one queue (the signer has one pending slot);
 *      resolvePending runs before each upload (member-ops.ts does it before admits and revokes).
 *   2. Trade tick: resolvePending → decider → journal writer (dry-quote price, upload) → listing rebuild → publish. A TradeRefused
 *      is logged and skipped; a write still pending skips the tick; any other failure stops trading (claims and
 *      revokes go on). A failed rebuild keeps the previous listing.
 *   3. Upload budget: at most maxUploadsPerHour (default 8) upload attempts per rolling hour, so admits and
 *      revokes always fit in the policy's 12 actions per hour.
 *   4. sinceNs is saved as the record time of the first journal upload; every build starts there, so records
 *      from before the journal (Deliverable 2's uploads) are never read. No entry yet: no listing (404).
 *   5. Every published listing is saved under its id and reloaded at start (checked against its id), so a claim
 *      for an older listing is still verified against that listing's own terms.
 *   6. POST /claim: unknown listing → 404; verifyPayment over the ledger (paymentRecorder) → admitPaid.
 *      PaymentRefused / MembershipRefused → 422 with its message; a chain failure → 503; verified but not yet
 *      admitted → 202 (the next maintenance tick admits); admitted → 200. The member is the payer the chain names.
 *   7. Maintenance tick: revokeExpired, then admitPaid (repairs what a crash or a 503 left).
 *   8. Events: metadata only (ids, hashes, accounts, states, refusal messages). Never a trade's side, size,
 *      price or reasoning, never a key or token.
 *   9. Start: resolvePending; reload listings; if the journal exists, rebuild the listing and load the writer's
 *      history from the follower's verifyFeed over it (the position comes from the chain); a maintenance tick.
 */
import { verifyPayment, PaymentRefused, type ChainReader } from '../core/verify-payment.ts';
import { paymentRecorder, admitPaid, revokeExpired, MembershipRefused, type LedgerStore, type MemberOps, type AdmissionRecord } from '../core/membership.ts';
import { parseListing, paymentTerms, type Listing } from '../core/listing.ts';
import { verifyFeed, type FeedReader } from '../core/verify-feed.ts';
import type { JournalEntry } from '../core/journal.ts';
import { buildListing, type ListingTerms } from './listing-builder.ts';
import type { TradeDecision, Written } from './journal-writer.ts';

export const HOUR_MS = 3_600_000;
export const DEFAULT_MAX_UPLOADS_PER_HOUR = 8;
const HEX64 = /^[0-9a-f]{64}$/;

export interface Decider { next(ctx: { position: string }): Promise<TradeDecision | null> }
export interface Writer { write(d: TradeDecision): Promise<Written>; position(): string; readonly uploads: number }
export interface PendingResolver { resolvePending(): Promise<unknown> }
export interface StateStore {
  getSinceNs(): Promise<string | null>;
  setSinceNs(ns: string): Promise<void>;
  saveListing(id: string, json: string): Promise<void>;
  loadListings(): Promise<{ id: string; json: string }[]>;
  appendEvent(e: Record<string, unknown>): Promise<void>;
}
export interface ServiceDeps {
  reader: FeedReader;
  chain: ChainReader;
  ledger: LedgerStore;
  ops: MemberOps;
  signer: PendingResolver;
  decider: Decider;
  state: StateStore;
  makeWriter(history: JournalEntry[]): Writer;
  now?: () => number;
}
export interface ServiceConfig { terms: ListingTerms; maxUploadsPerHour?: number }
export interface Reply { status: number; body: Record<string, unknown> }

// By name: the writer and the signer are injected, so their error classes may come from another copy of the module.
const isPending = (e: unknown) => (e as Error)?.name === 'NativeCallPendingError';
const isTradeRefused = (e: unknown) => (e as Error)?.name === 'TradeRefused';
const msg = (e: unknown) => String((e as Error)?.message ?? e);

export async function createSellerService(deps: ServiceDeps, cfg: ServiceConfig) {
  const now = deps.now ?? Date.now;
  const terms = cfg.terms;
  const maxUploads = cfg.maxUploadsPerHour ?? DEFAULT_MAX_UPLOADS_PER_HOUR;
  const published = new Map<string, Listing>();
  let latest: { id: string; listing: Listing } | null = null;
  let stopped: string | null = null;
  const attempts: number[] = [];

  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const run = chain.then(f, f);
    chain = run.catch(() => {});
    return run;
  };
  const event = (kind: string, fields: Record<string, unknown> = {}) => deps.state.appendEvent({ at: now(), kind, ...fields });

  async function rebuild(): Promise<void> {
    const sinceNs = await deps.state.getSinceNs();
    if (sinceNs === null) return;
    try {
      const b = await buildListing(deps.reader, terms, { sinceNs, now });
      await deps.state.saveListing(b.id, b.json);
      published.set(b.id, b.listing);
      latest = { id: b.id, listing: b.listing };
      await event('listing_published', { listingId: b.id, count: b.listing.fingerprint.count });
    } catch (e) {
      await event('listing_build_failed', { message: msg(e) });
    }
  }

  const adminEvents = async (changed: AdmissionRecord[]) => {
    for (const r of changed) {
      await event(`member_${r.state}`, { intentHash: r.intentHash, listingId: r.listingId, member: r.member, expiresAtMs: r.expiresAtMs,
        ...(r.rotation ? { rotation: r.rotation } : {}) });
    }
  };

  async function tradeTick(): Promise<void> {
    return serial(async () => {
      if (stopped) return;
      const t = now();
      while (attempts.length && attempts[0] <= t - HOUR_MS) attempts.shift();
      if (attempts.length >= maxUploads) { await event('trade_skipped', { reason: 'upload budget' }); return; }
      try {
        await deps.signer.resolvePending();
      } catch (e) {
        if (isPending(e)) { await event('trade_skipped', { reason: 'a write is still pending' }); return; }
        stopped = msg(e); await event('trading_stopped', { message: stopped }); return;
      }
      const d = await deps.decider.next({ position: writer.position() });
      if (d === null) return;
      let w: Written;
      try {
        w = await writer.write(d);
      } catch (e) {
        if (isTradeRefused(e)) { await event('entry_refused', { message: msg(e) }); return; }
        stopped = msg(e); await event('trading_stopped', { message: stopped }); return;
      }
      attempts.push(now()); // a failed upload stops trading, so only successful ones need counting
      await event('entry_written', { transId: w.transId, fileHash: w.fileHash });
      if ((await deps.state.getSinceNs()) === null) {
        const row = (await deps.reader.listRecords(terms.groupId)).find((r) => r.trans_id === w.transId);
        if (!row || typeof row.timestamp !== 'string') {
          stopped = 'service: the first entry\'s record was not found'; await event('trading_stopped', { message: stopped }); return;
        }
        await deps.state.setSinceNs(row.timestamp);
      }
      await rebuild();
    });
  }

  async function maintenanceTick(): Promise<void> {
    return serial(async () => {
      try {
        await adminEvents(await revokeExpired(deps.ledger, deps.ops, now()));
        await adminEvents(await admitPaid(deps.ledger, deps.ops, now()));
      } catch (e) {
        await event('maintenance_failed', { message: msg(e) });
      }
    });
  }

  async function claim(raw: string | undefined): Promise<Reply> {
    let c: any;
    try { c = JSON.parse(raw ?? ''); } catch { return { status: 400, body: { error: 'claim: not JSON' } }; }
    if (typeof c?.listingId !== 'string' || !HEX64.test(c.listingId)) return { status: 400, body: { error: 'claim: listingId must be 64 lowercase hex' } };
    const listing = published.get(c.listingId);
    if (!listing) return { status: 404, body: { error: 'claim: unknown listing' } };
    const ref = { listingId: c.listingId, groupId: listing.groupId, seller: listing.seller, periodMinutes: listing.periodMinutes };
    return serial(async () => {
      let p;
      try {
        p = await verifyPayment({ chain: deps.chain, used: paymentRecorder(deps.ledger, ref), now },
          paymentTerms(listing), { intentHash: c.intentHash, payer: c.payer, windowFromMs: c.windowFromMs, windowToMs: c.windowToMs });
      } catch (e) {
        if (e instanceof PaymentRefused || e instanceof MembershipRefused) {
          await event('payment_refused', { listingId: c.listingId, message: e.message });
          return { status: 422, body: { error: e.message } };
        }
        await event('payment_check_failed', { listingId: c.listingId, message: msg(e) });
        return { status: 503, body: { error: 'claim: the payment could not be checked now; send the claim again' } };
      }
      await event('payment_verified', { listingId: c.listingId, intentHash: p.intentHash, payer: p.payer, txHash: p.txHash });
      try {
        await adminEvents(await admitPaid(deps.ledger, deps.ops, now()));
      } catch (e) {
        await event('admission_deferred', { intentHash: p.intentHash, message: msg(e) });
      }
      const r = await deps.ledger.get(p.intentHash);
      const body = { member: r?.member, state: r?.state, expiresAtMs: r?.expiresAtMs, txHash: p.txHash };
      return { status: r?.state === 'admitted' ? 200 : 202, body };
    });
  }

  async function handle(req: { method: string; path: string; body?: string }): Promise<Reply> {
    const { method, path } = req;
    if (method === 'GET' && path === '/health') return { status: 200, body: { ok: true, trading: stopped === null, latest: latest?.id ?? null } };
    if (method === 'GET' && path === '/listing') {
      return latest ? { status: 200, body: { id: latest.id, listing: latest.listing } } : { status: 404, body: { error: 'no listing yet' } };
    }
    const m = /^\/listings\/([0-9a-f]{64})$/.exec(path);
    if (method === 'GET' && m) {
      const l = published.get(m[1]);
      return l ? { status: 200, body: { id: m[1], listing: l } } : { status: 404, body: { error: 'unknown listing' } };
    }
    if (method === 'POST' && path === '/claim') return claim(req.body);
    if (path === '/claim' || path === '/health' || path === '/listing' || m) return { status: 405, body: { error: 'method not allowed' } };
    return { status: 404, body: { error: 'not found' } };
  }

  // ── start ──
  await deps.signer.resolvePending();
  for (const { id, json } of await deps.state.loadListings()) published.set(id, parseListing(json, id));
  let history: JournalEntry[] = [];
  if ((await deps.state.getSinceNs()) !== null) {
    await rebuild();
    const built = latest as { id: string; listing: Listing } | null; // set by rebuild()
    if (!built) throw new Error('service: the journal does not verify; not starting');
    history = (await verifyFeed(built.listing, deps.reader)).entries.map((e) => e.entry);
  }
  const writer = deps.makeWriter(history);
  await maintenanceTick();

  return {
    tradeTick,
    maintenanceTick,
    handle,
    /** Why trading stopped, or null. */
    stoppedReason: () => stopped,
  };
}