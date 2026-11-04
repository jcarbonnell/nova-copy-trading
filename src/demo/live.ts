// live.ts: `npm run demo:live`, the whole story on NEAR mainnet in one process (approved 2026-11-04).
//
// Two agents, each with its own Agent Connect account, credentials directory and signatures: the seller
// (nova-observation-1) and the follower (nova-copytrade-follower-1). The real seller and follower services run
// over the real adapters, exactly as their runners wire them; this script only drives them in the video's order
// and asserts each beat. Events go to state/seller and state/follower, so `VIEWER_STATE=state npm run viewer`
// shows the run as it happens and replays it afterwards.
//
//   npm run demo:live -- --preflight   READ-ONLY: sign-ins, policies, balances, dry quotes and previews, the
//                                      group, and a re-check of an earlier real payment. Nothing signed or spent.
//   npm run demo:live                  the preflight, then the run. Writes: 7 NOVA uploads, 1 admit, 1 revoke
//                                      (the seller pays its own gas); spends: one 0.10 USDC payment, sent only
//                                      after you type "pay". About 25 minutes (15-minute access period).
//
// Run from the repo. Reads (never prints): ~/near/nova/paid-handoff/{.env,.grant-token,aa-state.json} for the
// seller and ~/near/nova/paid-handoff/follower-1/ for the follower. Optional: AGENT_API_BASE_URL (default: the
// "api" of observation-20261019T103449Z.json), NEAR_RPC_URL, NEAR_ARCHIVAL_RPC_URL (default fastnear archival),
// NEAR_ARCHIVAL_MIN_INTERVAL_MS (1200), ENTRY_INTERVAL_MS (60000), HOSTILE_PROCEEDS (wrap.near: an existing
// account outside the follower's whitelist), PREFLIGHT_PAYMENT_DIR (state/attempt2: an earlier run to re-check).
//
// Technical demo, not investment advice. Trade contents are simulated (dry quotes); the files, the payment, the
// admission and the revocation are real mainnet transactions.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { AgentApi, createIdempotencyKey, type SwapRequest, type WithdrawRequest as SdkWithdraw } from '@near-intents-agent-api/sdk';
import { connectNovaAgent, memoryStore, type NovaAgentConnection } from '../vendor/nova-agent-connect.ts';
import { createNearChain } from '../core/near-chain.ts';
import { verifyPayment } from '../core/verify-payment.ts';
import { parseListing, paymentTerms } from '../core/listing.ts';
import { openLedger } from '../adapters/ledger-file.ts';
import { filePendingStore } from '../adapters/pending-file.ts';
import { openStateDir } from '../adapters/state-dir.ts';
import { openFollowerState } from '../adapters/follower-state.ts';
import { novaFeedReader } from '../adapters/nova-reader.ts';
import { memberOps, sellerSignerOptions } from '../adapters/member-ops.ts';
import { createJournalWriter, quoteProblems, USDC, WNEAR } from '../seller/journal-writer.ts';
import { parseScript, scriptDecider } from '../seller/script-decider.ts';
import { createSellerService, type StateStore } from '../seller/seller-service.ts';
import { createFollowerService, mirrorDecider, FollowerRefused, type FollowerAgent, type SellerClient, type FollowerState } from '../follower/follower-service.ts';
import { hostileListing } from './hostile-seller.ts';

// ── fixed terms ─────────────────────────────────────────────────────────────────────────────
const GROUP_ID = 'agent-owned-20261030T073943Z';
const SELLER_ACCOUNT = '5a5d96f384a41ba3d1c90399dcd563ed6f52c34aa28ba5f200902a655d8ab288';
const FOLLOWER_ACCOUNT = '9a45ea1ce599c5df4143001cddc0dd80e6a0a897f8665d0b6570a70c3ac93b35';
const SELLER_AGENT = '03363967db25b34a7940523a59975691f41f8b123bdeda93ac8c70a521a51986';
const PROCEEDS = '1000fans.near';
const USDC_CONTRACT = USDC.slice('nep141:'.length);
const PRICE = '100000';
const PERIOD_MINUTES = 15;           // demo run (approved 2026-11-04)
const MEMO = 'copytrade';
const MAX_PRICE = '150000';
const TERMS = { seller: SELLER_ACCOUNT, groupId: GROUP_ID, proceedsAccount: PROCEEDS, token: USDC_CONTRACT, price: PRICE,
  periodMinutes: PERIOD_MINUTES, simulated: true };

const MIN = 60_000;
const home = (p: string) => p.replace(/^~(?=$|\/)/, os.homedir());
const HANDOFF = home('~/near/nova/paid-handoff');
const SELLER_DIR = HANDOFF;
const FOLLOWER_DIR = path.join(HANDOFF, 'follower-1');
const preflightOnly = process.argv.includes('--preflight');
const entryEvery = Number(process.env.ENTRY_INTERVAL_MS ?? MIN);
const rpcUrl = process.env.NEAR_RPC_URL ?? 'https://rpc.mainnet.near.org';
const archivalUrl = process.env.NEAR_ARCHIVAL_RPC_URL ?? 'https://archival-rpc.mainnet.fastnear.com';
const pace = Number(process.env.NEAR_ARCHIVAL_MIN_INTERVAL_MS ?? 1200);
const hostileProceeds = process.env.HOSTILE_PROCEEDS ?? 'wrap.near';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const t0 = Date.now();
const clock = () => { const s = Math.round((Date.now() - t0) / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const say = (m: string) => console.log(`\n[${clock()}] ${m}`);
const fail = (m: string): never => { console.error(`\n✗ ${m}\nstopped. Nothing further is sent; paste this to Claude.`); process.exit(1); };

function envValue(file: string, key: string): string | undefined {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && m[1] === key) return m[2].replace(/^['"]|['"]$/g, '');
  }
  return undefined;
}
function credentials(dir: string, role: string) {
  const apiKey = envValue(path.join(dir, '.env'), 'NEAR_INTENTS_AGENT_API_KEY') ?? fail(`${role}: NEAR_INTENTS_AGENT_API_KEY not in ${dir}/.env`);
  const grant = fs.readFileSync(path.join(dir, '.grant-token'), 'utf8').trim() || fail(`${role}: ${dir}/.grant-token is empty`);
  const agentId: string = JSON.parse(fs.readFileSync(path.join(dir, 'aa-state.json'), 'utf8')).agent_id ?? fail(`${role}: no agent_id in ${dir}/aa-state.json`);
  return { apiKey, grant, agentId };
}
async function view(method: string, args: unknown, account: string): Promise<any> {
  const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query',
    params: { request_type: 'call_function', finality: 'final', account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }) });
  const j: any = await r.json();
  if (j.error || j.result?.error) throw new Error(`view ${account}.${method}: ${JSON.stringify(j.error ?? j.result.error).slice(0, 200)}`);
  return JSON.parse(Buffer.from(j.result.result).toString());
}
async function nearBalance(account: string): Promise<bigint> {
  const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query',
    params: { request_type: 'view_account', finality: 'final', account_id: account } }) });
  const j: any = await r.json();
  if (!j.result?.amount) throw new Error(`view_account ${account}: ${JSON.stringify(j.error ?? j).slice(0, 200)}`);
  return BigInt(j.result.amount);
}

// ── agents ──────────────────────────────────────────────────────────────────────────────────
const baseUrl = process.env.AGENT_API_BASE_URL ?? JSON.parse(fs.readFileSync(path.join(HANDOFF, 'observation-20261019T103449Z.json'), 'utf8')).api;
if (!/^https:\/\//.test(baseUrl)) fail('AGENT_API_BASE_URL must be https');
const sc = credentials(SELLER_DIR, 'seller');
const fc = credentials(FOLLOWER_DIR, 'follower');
if (sc.agentId !== SELLER_AGENT) fail(`seller: ${SELLER_DIR}/aa-state.json holds another agent`);
if (fc.agentId === SELLER_AGENT) fail('follower: the follower directory holds the seller');
const sellerApi = new AgentApi({ apiKey: sc.apiKey, baseUrl }).forGrant(sc.grant);
const followerApi = new AgentApi({ apiKey: fc.apiKey, baseUrl }).forGrant(fc.grant);
const chain = createNearChain({ rpcUrl: archivalUrl, minIntervalMs: pace, maxRetries: 10 });

const followerAgent: FollowerAgent = {
  previewWithdraw: (req) => followerApi.withdraw(fc.agentId, { ...req, dry: true } as SdkWithdraw & { dry: true }, { idempotencyKey: `dry-${createIdempotencyKey()}` }),
  withdraw: (req, key) => followerApi.withdraw(fc.agentId, req as SdkWithdraw, { idempotencyKey: key }),
  status: (c) => followerApi.getStatus(c, { waitMs: 10_000 }),
  quoteSwap: (req) => followerApi.swap(fc.agentId, { ...req, confidential: true, dry: true } as SwapRequest & { dry: true }),
};
const sellerQuotes = { swap: (id: string, req: { origin_asset: string; destination_asset: string; amount: string; dry: true }) =>
  sellerApi.swap(id, { ...req, confidential: true } as SwapRequest & { dry: true }) };

// ── preflight (read-only) ───────────────────────────────────────────────────────────────────
async function preflight() {
  const checks: [string, boolean, string][] = [];
  const check = async (name: string, f: () => Promise<[boolean, string]>) => {
    try { const [ok, d] = await f(); checks.push([name, ok, d]); } catch (e) { checks.push([name, false, String((e as Error)?.message ?? e).slice(0, 240)]); }
    const [n, ok, d] = checks.at(-1)!; console.log(`${ok ? '✓' : '✗'} ${n}${d ? ` · ${d}` : ''}`);
  };
  say('PREFLIGHT · read-only: nothing is signed or spent');
  let sConn: NovaAgentConnection | null = null;
  let fConn: NovaAgentConnection | null = null;
  await check('P1 the seller signs in to NOVA as its own account (grant valid)', async () => {
    sConn = await connectNovaAgent(sellerApi, sc.agentId, { store: memoryStore(), maxDepositYocto: 0n, methods: [], sdkConfig: { rpcUrl } });
    return [sConn.accountId === SELLER_ACCOUNT, sConn.accountId.slice(0, 12)];
  });
  await check('P2 the follower signs in to NOVA as its own account (grant valid)', async () => {
    fConn = await connectNovaAgent(followerApi, fc.agentId, { store: memoryStore(), maxDepositYocto: 0n, methods: [], sdkConfig: { rpcUrl } });
    return [fConn.accountId === FOLLOWER_ACCOUNT, fConn.accountId.slice(0, 12)];
  });
  await check('P3 the seller\'s policy is revision 6: swap only, destinations any, NOVA calls only, 12 actions/hour', async () => {
    const v: any = await sellerApi.getPolicy(sc.agentId); const p = v.policy;
    return [v.status === 'APPLIED' && v.provider_policy_synced && v.revision === 6 && JSON.stringify(p.actions) === '["swap"]' && p.destinations.mode === 'any' &&
      p.native.near.transfer === false && JSON.stringify(p.native.near.call) === '["nova-sdk.near"]' && p.max_actions_per_hour === 12, `revision ${v.revision}`];
  });
  await check('P4 the follower\'s policy pays only 1000fans.near (memo copytrade), caps 0.15 USDC per trade', async () => {
    const v: any = await followerApi.getPolicy(fc.agentId); const p = v.policy;
    const d = p.destinations;
    return [v.status === 'APPLIED' && d.mode === 'only' && d.list.length === 1 && d.list[0].address === PROCEEDS && d.list[0].memo === MEMO &&
      p.limits.per_transaction[USDC] === '150000' && p.native.near.transfer === false, `revision ${v.revision}`];
  });
  await check('P5 balances: the seller has NEAR for 9 writes; the follower has 0.10 USDC to pay', async () => {
    const sn = await nearBalance(SELLER_ACCOUNT);
    const fu = BigInt(await view('mt_balance_of', { account_id: FOLLOWER_ACCOUNT, token_id: USDC }, 'intents.near'));
    return [sn >= 2n * 10n ** 22n && fu >= BigInt(PRICE), `seller ${Number(sn / 10n ** 18n) / 1e6} NEAR · follower ${Number(fu) / 1e6} USDC`];
  });
  await check('P6 the seller\'s dry confidential quote passes (0.10 USDC → NEAR)', async () => {
    const q: any = await sellerQuotes.swap(sc.agentId, { origin_asset: USDC, destination_asset: WNEAR, amount: '100000', dry: true });
    return [q?.dry === true && quoteProblems(q, true).length === 0 && /^[1-9]\d*$/.test(q?.quote?.amount_out ?? ''), `out ${q?.quote?.amount_out}`];
  });
  await check('P7 the follower\'s copy quotes: 0.05 USDC passes, 0.18 USDC is refused by its policy', async () => {
    const a: any = await followerAgent.quoteSwap({ origin_asset: USDC, destination_asset: WNEAR, amount: '50000' });
    const b: any = await followerAgent.quoteSwap({ origin_asset: USDC, destination_asset: WNEAR, amount: '180000' });
    const codes = (b?.warnings ?? []).map((w: any) => w.code);
    return [a?.dry === true && quoteProblems(a, true).length === 0 && codes.some((c: string) => c.startsWith('policy_')), `0.18 → ${codes.join(', ') || 'no warning'}`];
  });
  await check('P8 the follower\'s dry payment to 1000fans.near passes', async () => {
    const q: any = await followerAgent.previewWithdraw({ asset: USDC, amount: PRICE, chain: 'near', recipient: PROCEEDS, memo: MEMO });
    return [q?.dry === true && (q.warnings ?? []).length === 0 && q?.quote?.would_succeed !== false, JSON.stringify(q?.warnings ?? [])];
  });
  await check(`P9 the follower's dry payment to ${hostileProceeds} (exists, not whitelisted) is refused by its policy`, async () => {
    try {
      const q: any = await followerAgent.previewWithdraw({ asset: USDC, amount: PRICE, chain: 'near', recipient: hostileProceeds, memo: MEMO });
      const codes = (q?.warnings ?? []).map((w: any) => w.code);
      return [codes.includes('policy_destination_denied'), codes.join(', ') || 'no warning'];
    } catch (e) { return [false, `refused before the policy: ${(e as Error).message}`]; }
  });
  await check('P10 the seller reads its group; the follower is not a member', async () => {
    const rows: any = await sConn!.nova.getTransactionsForGroup(GROUP_ID);
    const member = await sConn!.nova.isAuthorized(GROUP_ID, FOLLOWER_ACCOUNT);
    return [Array.isArray(rows) && rows.length > 0 && member === false, `${rows.length} records · follower member: ${member}`];
  });
  const dir = path.resolve(process.env.PREFLIGHT_PAYMENT_DIR ?? 'state/attempt2');
  await check(`P11 the payment check works on mainnet: an earlier real payment (${path.basename(dir)}) verifies over ${new URL(archivalUrl).host}`, async () => {
    const pay = JSON.parse(fs.readFileSync(`${dir}-follower/payment.json`, 'utf8')).payment;
    const listing = parseListing(fs.readFileSync(`${dir}-seller/listings/${pay.listingId}.json`, 'utf8'), pay.listingId);
    const used = new Set<string>();
    const p = await verifyPayment({ chain, used: { has: async (h) => used.has(h), add: async (h) => { used.add(h); } } }, paymentTerms(listing), pay.claim);
    return [p.payer === FOLLOWER_ACCOUNT && p.amount === PRICE && p.proceedsAccount === PROCEEDS, `tx ${p.txHash.slice(0, 12)} · ${Math.round((Date.now() - t0) / 1000)}s`];
  });
  await check('P12 fresh state: state/seller and state/follower do not exist yet', async () =>
    [!fs.existsSync('state/seller') && !fs.existsSync('state/follower') && !fs.existsSync('state/follower-hostile'), '']);
  const bad = checks.filter((c) => !c[1]);
  console.log(`\npreflight: ${checks.length - bad.length}/${checks.length} passed`);
  return bad.length === 0;
}

// ── the run ─────────────────────────────────────────────────────────────────────────────────
async function run() {
  fs.mkdirSync('state/seller', { recursive: true, mode: 0o700 });
  const ledger = await openLedger('state/seller/ledger.json');
  const sellerState = await openStateDir('state/seller');
  const log = (who: string) => (e: Record<string, unknown>) => { const { at: _a, kind, ...rest } = e as any; console.log(`   ${who} · ${kind}${Object.keys(rest).length ? ` ${JSON.stringify(rest).slice(0, 160)}` : ''}`); };
  const sState: StateStore = { ...sellerState, appendEvent: async (e) => { log('seller')(e); await sellerState.appendEvent(e); } };
  const pending = filePendingStore('state/seller/pending.json');
  const connectSeller = () => connectNovaAgent(sellerApi, sc.agentId, { ...sellerSignerOptions(pending), sdkConfig: { rpcUrl } });
  const connectFollower = () => connectNovaAgent(followerApi, fc.agentId, { store: memoryStore(), maxDepositYocto: 0n, methods: [], sdkConfig: { rpcUrl } });
  let sConn = await connectSeller(); let sAt = Date.now();
  if (sConn.accountId !== SELLER_ACCOUNT) fail('the seller connected as another account');
  const fDisk = await openFollowerState('state/follower');
  const fState: FollowerState = { ...fDisk, appendEvent: async (e) => { log('follower')(e); await fDisk.appendEvent(e); } };
  let fConn = await connectFollower(); let fAt = Date.now();
  // NOVA sessions expire: each agent signs in again 5 minutes before its session would (both proxies below read the current one)
  const stale = (c: NovaAgentConnection, at: number) => c.sessionExpiresIn !== undefined && Date.now() - at > (c.sessionExpiresIn - 300) * 1000;
  const renew = async () => {
    if (stale(sConn, sAt)) { sConn = await connectSeller(); sAt = Date.now(); say('the seller signed in to NOVA again (session renewal)'); }
    if (stale(fConn, fAt)) { fConn = await connectFollower(); fAt = Date.now(); say('the follower signed in to NOVA again (session renewal)'); }
  };
  const fNova = { getTransactionsForGroup: (g: string) => fConn.nova.getTransactionsForGroup(g), retrieve: (g: string, r: string) => fConn.nova.retrieve(g, r) };

  const signer = { resolvePending: () => sConn.signer.resolvePending() };
  const sNova = {
    getTransactionsForGroup: (g: string) => sConn.nova.getTransactionsForGroup(g), retrieve: (g: string, r: string) => sConn.nova.retrieve(g, r),
    isAuthorized: (g: string, u?: string) => sConn.nova.isAuthorized(g, u), addGroupMember: (g: string, m: string) => sConn.nova.addGroupMember(g, m),
    revokeGroupMember: (g: string, m: string) => sConn.nova.revokeGroupMember(g, m), upload: (g: string, d: Buffer, n: string) => sConn.nova.upload(g, d, n),
  };
  const seller = await createSellerService({
    reader: novaFeedReader(sNova), chain, ledger, ops: memberOps(sNova, signer), signer, state: sState,
    decider: scriptDecider(parseScript(fs.readFileSync('demo/live-script.json', 'utf8'))),
    makeWriter: (history) => createJournalWriter({ quotes: sellerQuotes, nova: sNova }, { agentId: sc.agentId, groupId: GROUP_ID, simulated: true }, history),
  }, { terms: TERMS });
  const sellerClient: SellerClient = { get: (p) => seller.handle({ method: 'GET', path: p }), post: (p, body) => seller.handle({ method: 'POST', path: p, body }) };
  const isMember = async (g: string) => { const v = await fConn.nova.isAuthorized(g, FOLLOWER_ACCOUNT); if (typeof v !== 'boolean') throw new Error('is_authorized did not return a boolean'); return v; };
  const followerFor = (state: FollowerState, approvedId: string, sellerApiFor: SellerClient) => createFollowerService({ seller: sellerApiFor, agent: followerAgent,
    reader: novaFeedReader(fNova as any), isMember, decider: mirrorDecider, state, newKey: createIdempotencyKey }, { approvedId, maxPrice: MAX_PRICE, memo: MEMO, pollMs: 5000 });
  const entry = async (n: number) => {
    await renew();
    await seller.tradeTick();
    if (seller.stoppedReason()) fail(`the seller stopped trading: ${seller.stoppedReason()}`);
    say(`entry ${n} recorded in NOVA`);
  };
  const latest = async () => (await sellerClient.get('/listing')).body as any;

  // beat 1
  say('BEAT 1 · the seller journals its trades; its listing is public, the feed stays encrypted');
  for (let i = 1; i <= 3; i++) { await sleep(entryEvery); await entry(i); }
  const pub = await latest();
  if (pub?.listing?.fingerprint?.count !== 3) fail('the listing does not cover the 3 entries');

  // beat 2
  say(`BEAT 2 · listing #99 pays ${hostileProceeds}: the follower's owner policy must refuse it`);
  const h = hostileListing(pub.listing, hostileProceeds);
  const hostileClient: SellerClient = { get: async (p) => (p === `/listings/${h.id}` ? { status: 200, body: { id: h.id, listing: h.listing } } : { status: 404, body: {} }),
    post: async () => ({ status: 403, body: { error: 'this stub never takes a claim' } }) };
  const hDisk = await openFollowerState('state/follower-hostile');
  const hState: FollowerState = { ...hDisk, appendEvent: async (e) => { log('follower')(e); await hDisk.appendEvent(e); } };
  const hostile = followerFor(hState, h.id, hostileClient);
  try { await hostile.preview(await hostile.approve()); fail('listing #99 was NOT refused'); } catch (e) {
    if (!(e instanceof FollowerRefused) || !/policy_destination_denied/.test(e.message)) fail(`listing #99 refused, but not by the policy: ${(e as Error).message}`);
  }
  await hDisk.close();
  say('✓ refused by policy; nothing paid');

  // beat 3
  say('BEAT 3 · the follower buys the real listing');
  const buyId = (await latest()).id as string;
  const follower = followerFor(fState, buyId, sellerClient);
  const l = await follower.approve();
  const q = await follower.preview(l);
  console.log(`\n   Payment: ${Number(l.price) / 1e6} USDC to ${l.proceedsAccount} (memo ${MEMO}), ${l.periodMinutes} min of access to ${l.fingerprint.count} entries.` +
    `\n   Dry preview: warnings ${JSON.stringify(q.warnings ?? [])}, fee ${q.fee?.amount_usd ?? '?'} USD.`);
  if (!process.stdin.isTTY) fail('the payment needs you at a terminal to type "pay"');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('   Type "pay" to send it (anything else stops): ')).trim();
  rl.close();
  if (answer !== 'pay') fail('not paid (you did not type "pay")');
  const claim = await follower.pay(l);
  say('paid; waiting 20 s for the blocks around the payment to be final');
  await sleep(20_000);
  for (let attempt = 1; ; attempt++) {
    try { await follower.claim(l, claim); break; } catch (e) {
      if (!(e instanceof FollowerRefused) || !/HTTP 503/.test(e.message) || attempt >= 4) fail(`the claim did not go through: ${(e as Error).message}`);
      say(`the seller could not check the payment yet (RPC); claiming again (${attempt}/3)`);
    }
  }
  say('✓ verified on chain and admitted');

  // beat 4
  say('BEAT 4 · the follower verifies what it bought');
  await follower.verify(l);
  say('✓ fingerprint, every entry\'s hash, recomputed P&L = public curve');

  // beat 5
  say('BEAT 5 · the seller trades; the follower copies within its owner\'s limits');
  for (let i = 4; i <= 6; i++) {
    await sleep(entryEvery); await entry(i);
    await sleep(15_000); await follower.copyTick(l);
  }
  const copies = await fDisk.copies();
  if (copies.filter((c) => c.outcome === 'copied').length < 2 || !copies.some((c) => c.outcome === 'refused')) fail(`the copies are not as expected: ${JSON.stringify(copies)}`);

  // beat 6
  const expires = (await ledger.all()).find((r) => r.member === FOLLOWER_ACCOUNT)?.expiresAtMs ?? fail('no admission record');
  say(`BEAT 6 · access ends at ${new Date(expires).toISOString().slice(11, 19)} UTC; the seller revokes it then`);
  while (!follower.ended()) {
    await sleep(30_000); await renew();
    if (Date.now() >= expires) await seller.maintenanceTick();
    await follower.copyTick(l);
    if (Date.now() > expires + 10 * MIN) fail('the follower is still a member 10 minutes after expiry');
  }
  await sleep(entryEvery); await entry(7);
  const last = (await sNova.getTransactionsForGroup(GROUP_ID) as any[]).at(-1);
  let unreadable = '';
  try { await fNova.retrieve(GROUP_ID, last.ipfs_hash); } catch (e) { unreadable = (e as Error).message; }
  if (!unreadable) fail('the follower could still read an entry written after its access ended');
  say(`✓ revoked, key rotated; the next entry is unreadable to the follower (${unreadable.slice(0, 80)})`);

  await ledger.close(); await fDisk.close();
  say('DONE · all beats on mainnet. Record the replay: VIEWER_STATE=state npm run viewer → http://127.0.0.1:8790/?autoplay&pace=4000');
  console.log('Technical demo, not investment advice. Trade contents simulated; files, payment, admission and revocation real.');
}

// ── main ────────────────────────────────────────────────────────────────────────────────────
console.log(`demo:live · NEAR mainnet · seller ${SELLER_ACCOUNT.slice(0, 10)}… · follower ${FOLLOWER_ACCOUNT.slice(0, 10)}… · access ${PERIOD_MINUTES} min · an entry every ${entryEvery / 1000}s` +
  '\n           technical demo, not investment advice');
if (!(await preflight())) fail('the preflight did not pass');
if (preflightOnly) { console.log('preflight only: nothing was signed or spent.'); process.exit(0); }
await run();
process.exit(0);