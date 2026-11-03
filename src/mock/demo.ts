// demo.ts: `npm run demo:mock`, the whole story with no keys and no network (approved 2026-11-03).
// The real seller and follower services, the real core checks and the real state adapters run over the mock world
// (mock-world.ts). Every beat is asserted; any ✗ exits non-zero. Events go to state/mock/ for the viewer.
//
// MOCK MODE: NOVA, the Agent API and the chain are in memory; there is no encryption (a revoked member's reads are
// refused instead of failing to decrypt); prices follow a synthetic path, so the P&L says nothing about a
// strategy; the one payment is the REAL recorded 57r1 payment (0.10 USDC to 1000fans.near), replayed.
// Technical demo, not investment advice.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createMockWorld, FIXTURE_SHA, RECORDED } from './mock-world.ts';
import { novaFeedReader } from '../adapters/nova-reader.ts';
import { memberOps } from '../adapters/member-ops.ts';
import { openLedger } from '../adapters/ledger-file.ts';
import { openStateDir } from '../adapters/state-dir.ts';
import { openFollowerState } from '../adapters/follower-state.ts';
import { createJournalWriter } from '../seller/journal-writer.ts';
import { parseScript, scriptDecider } from '../seller/script-decider.ts';
import { buildListing } from '../seller/listing-builder.ts';
import { createSellerService } from '../seller/seller-service.ts';
import { createFollowerService, mirrorDecider, type FollowerAgent, type SellerClient } from '../follower/follower-service.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'state/mock');
const MIN = 60_000;
const GROUP = 'agent-owned-mock';
const SELLER = 'mock-seller.near';
const FOLLOWER = RECORDED.payer;
const TERMS = { seller: SELLER, groupId: GROUP, proceedsAccount: '1000fans.near', token: RECORDED.asset.slice('nep141:'.length),
  price: '100000', periodMinutes: 60, simulated: true };
// MOCK NEAR prices (USDC), one every 5 minutes from 10:00 UTC: synthetic, labelled.
const PRICES = ['3.80', '3.82', '3.86', '3.90', '3.88', '3.93', '3.97', '4.01', '3.99', '4.04', '4.02', '4.06'];

const beats: { name: string; ok: boolean; detail?: string }[] = [];
function beat(name: string, ok: boolean, detail?: unknown) {
  beats.push({ name, ok, detail: detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail) });
  console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail !== undefined ? ` — ${beats.at(-1)!.detail}` : ''}`);
}
const readEvents = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
async function refusal(f: () => Promise<unknown>): Promise<string> { try { await f(); return 'no refusal'; } catch (e) { return (e as Error).message; } }

// ── the world ───────────────────────────────────────────────────────────────────────────────
const raw = fs.readFileSync(path.join(root, 'test/fixtures/withdrawal-57r1.tx.json'));
if (createHash('sha256').update(raw).digest('hex') !== FIXTURE_SHA) { console.error('✗ the 57r1 fixture does not match its sha256'); process.exit(1); }
fs.rmSync(out, { recursive: true, force: true });
const world = createMockWorld({ startMs: Date.parse('2026-10-19T10:00:00.000Z'), fixture: JSON.parse(raw.toString()), prices: PRICES });
const { clock } = world;
world.createGroup(GROUP, SELLER);
world.record(GROUP, SELLER, new TextEncoder().encode('a file from before the journal'), 'fastfs/earlier');   // like Deliverable 2's uploads

const sellerNova = world.novaFor(SELLER);
const followerNova = world.novaFor(FOLLOWER);
const sellerAgent = world.agentFor({ capUsdc: 200_000n, capWnear: 6n * 10n ** 22n, withdrawTo: [] });          // policy revision 5
const followerApi = world.agentFor({ capUsdc: 150_000n, capWnear: 5n * 10n ** 22n, withdrawTo: ['1000fans.near'] });
const signer = { resolvePending: async () => null };
const script = (f: string) => parseScript(fs.readFileSync(path.join(root, 'demo', f), 'utf8'));

async function startSeller(decisions: ReturnType<typeof parseScript>) {
  fs.mkdirSync(path.join(out, 'seller'), { recursive: true, mode: 0o700 });
  const ledger = await openLedger(path.join(out, 'seller/ledger.json'));
  const state = await openStateDir(path.join(out, 'seller'));
  const svc = await createSellerService({
    reader: novaFeedReader(sellerNova), chain: world.chain, ledger, ops: memberOps(sellerNova, signer), signer, state,
    decider: scriptDecider(decisions), now: clock.now,
    makeWriter: (history) => createJournalWriter({ quotes: sellerAgent, nova: sellerNova, now: clock.now }, { agentId: 'mock-seller', groupId: GROUP, simulated: true }, history),
  }, { terms: TERMS });
  return { svc, ledger };
}
const phase1 = script('seller-script.json');
let seller = await startSeller(phase1);
const sellerClient: SellerClient = {
  get: (p) => seller.svc.handle({ method: 'GET', path: p }),
  post: (p, body) => seller.svc.handle({ method: 'POST', path: p, body }),
};
const followerAgent: FollowerAgent = {
  previewWithdraw: (req) => followerApi.previewWithdraw(req),
  withdraw: (req, key) => followerApi.withdraw(req, key),
  status: (c) => followerApi.status(c),
  quoteSwap: (req) => followerApi.swap('mock-follower', { ...req, dry: true }),
};
let keys = 0;
async function startFollower(dir: string, approvedId: string, sellerApi: SellerClient) {
  const state = await openFollowerState(path.join(out, dir));
  const svc = createFollowerService({ seller: sellerApi, agent: followerAgent, reader: novaFeedReader(followerNova),
    isMember: (g) => followerNova.isAuthorized(g), decider: mirrorDecider, state, newKey: () => `mock-key-${++keys}`, now: clock.now, sleep: async (ms) => clock.advance(ms) },
    { approvedId, maxPrice: '150000', memo: 'copytrade', pollMs: 1000 });
  return { svc, state };
}
const trade = async () => { clock.advance(5 * MIN); await seller.svc.tradeTick(); };

console.log('demo:mock · MOCK MODE: in-memory NOVA, Agent API and chain; synthetic prices; the payment is the real recorded 57r1 payment, replayed\n' +
  '           simulated trades · technical demo, not investment advice\n');

// ── beat 1: a public P&L curve next to a locked feed ────────────────────────────────────────
for (let i = 0; i < 3; i++) await trade();
const pub = await sellerClient.get('/listing');
const listing = pub.body?.listing;
const locked = await refusal(() => followerNova.retrieve(GROUP, 'fastfs/earlier'));
beat('1 the seller journals 3 trades; its listing is public (curve, count, fingerprint, price) while the feed stays locked',
  pub.status === 200 && listing?.fingerprint.count === 3 && listing.curve.points.length === 3 && /not authorized/.test(locked),
  { status: pub.status, count: listing?.fingerprint.count, locked });

// ── beat 2: a hostile listing is refused by the follower's destination whitelist ───────────
clock.advance(5 * MIN);
const hostileBuilt = await buildListing(novaFeedReader(sellerNova), { ...TERMS, proceedsAccount: 'listing-99.near' },
  { sinceNs: listing.range.sinceNs, now: clock.now });
const hostileSeller: SellerClient = {
  get: async (p) => (p === `/listings/${hostileBuilt.id}` ? { status: 200, body: { id: hostileBuilt.id, listing: hostileBuilt.listing } } : { status: 404, body: {} }),
  post: async () => ({ status: 404, body: {} }),
};
const hostile = await startFollower('follower-hostile', hostileBuilt.id, hostileSeller);
const hostileListing = await hostile.svc.approve();
const hostileRefusal = await refusal(() => hostile.svc.preview(hostileListing));
await hostile.state.close();
beat('2 "pay my listing #99" (to listing-99.near) is refused by the follower\'s policy on the dry preview; nothing is paid',
  /policy_destination_denied/.test(hostileRefusal) && !fs.existsSync(path.join(out, 'follower-hostile/payment.json')), hostileRefusal);

// ── beat 3: the follower pays the real listing; the seller verifies on chain and admits it ──
clock.set(RECORDED.windowToMs + 30_000);   // just after the recorded payment
const follower = await startFollower('follower', pub.body.id, sellerClient);
const approved = await follower.svc.approve();
await follower.svc.preview(approved);
const claim = await follower.svc.pay(approved);
await follower.svc.claim(approved, claim);
const sellerEvents = () => readEvents(path.join(out, 'seller/events.jsonl'));
const verified = sellerEvents().find((e) => e.kind === 'payment_verified');
beat('3 the follower pays 0.10 USDC to 1000fans.near; the seller verifies the payment on chain and admits the payer',
  verified?.payer === FOLLOWER && (await followerNova.isAuthorized(GROUP)) && sellerEvents().some((e) => e.kind === 'member_admitted'),
  verified);

// ── beat 4: the feed unlocks: fingerprint ✓, each entry's hash ✓, recomputed P&L ✓ ─────────
const entries = await follower.svc.verify(approved);
const followerEvents = () => readEvents(path.join(out, 'follower/events.jsonl'));
const fv = followerEvents().find((e) => e.kind === 'feed_verified');
beat('4 the feed unlocks and verifies: fingerprint, each entry\'s on-chain hash, the recomputed P&L equals the public curve',
  entries.length === 3 && fv?.root === approved.fingerprint.root && fv?.realised === approved.curve.points.at(-1)!.realised, fv);

// ── beat 5: the seller trades, the follower copies within its limit; an oversized copy is refused ──
for (let i = 0; i < 4; i++) { await trade(); clock.advance(30_000); await follower.svc.copyTick(approved); }
const fe = followerEvents();
const copies = fe.filter((e) => e.kind === 'copy_done');
const refused = fe.filter((e) => e.kind === 'copy_refused');
beat('5 the seller journals 4 more trades; the follower copies the 0.05 USDC buy and the sell (capped at its position); the 0.18 USDC buy is refused (policy)',
  copies.length >= 2 && copies[0].side === 'buy' && copies[0].amount === '50000' && copies[1].side === 'sell' &&
    refused.length === 1 && refused[0].amount === '180000' && refused[0].codes.includes('policy_transaction_limit_exceeded'),
  { copies: copies.map((c) => `${c.side} ${c.amount}`), refused: refused.map((r) => `${r.side} ${r.amount} ${r.codes}`) });

// ── beat 6: the period ends; the seller revokes; new entries are unreadable to the follower ─
clock.set(RECORDED.blockMs + 60 * MIN + 1000);
await seller.svc.maintenanceTick();
await follower.svc.copyTick(approved);
await seller.ledger.close();
seller = await startSeller(script('seller-script-after.json'));   // as the live run restarts with phase 2
await trade();
const afterRows = await sellerNova.getTransactionsForGroup(GROUP);
const lastEntry = afterRows.at(-1)!;
const unreadable = await refusal(() => followerNova.retrieve(GROUP, lastEntry.ipfs_hash));
const revoked = sellerEvents().find((e) => e.kind === 'member_revoked');
beat('6 at the end of the period the seller revokes the follower; it logs access ended; the next entry is unreadable to it',
  revoked?.member === FOLLOWER && followerEvents().some((e) => e.kind === 'access_ended') && /not authorized/.test(unreadable) &&
    lastEntry.user_id === SELLER && BigInt(lastEntry.timestamp) / 1_000_000n > BigInt(revoked.at), { revoked, unreadable });

await seller.ledger.close();
await follower.state.close();

// ── closing card ────────────────────────────────────────────────────────────────────────────
const failed = beats.filter((b) => !b.ok);
const journal = afterRows.filter((r) => r.user_id === SELLER && r.ipfs_hash !== 'fastfs/earlier').length;
console.log(`\n── demo:mock ${failed.length ? `✗ ${failed.length} beat(s) failed` : '✓ all 6 beats'} ──`);
console.log(`journal: ${journal} entries in ${GROUP} · listing ${pub.body.id.slice(0, 12)} · payment ${RECORDED.intentHash.slice(0, 12)} (recorded 57r1) · events in state/mock/`);
console.log('MOCK MODE · simulated trades · synthetic prices · technical demo, not investment advice');
process.exit(failed.length ? 1 : 0);