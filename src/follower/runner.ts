// runner.ts: the follower (nova-copytrade-follower-1), wired (approved 2026-11-03). All logic is in
// follower-service.ts; this file only builds its dependencies and runs it once: approve → preview → (you type
// "pay") → pay → claim → verify → copy until access ends.
//
// Technical demo, not investment advice. H5: copies are SIMULATED (dry quotes, nothing swapped). The payment is
// REAL: one USDC withdrawal of the listing's price to its proceeds account, sent only after you type "pay", and
// never twice (follower-state.ts).
//
// Run from the repo (nothing secret is printed, logged or written to state/):
//   export PAID_HANDOFF_DIR=~/near/nova/paid-handoff/follower-1   # .env (NEAR_INTENTS_AGENT_API_KEY), .grant-token, aa-state.json
//   export AGENT_API_BASE_URL=https://api.demo.agentsonintents.com
//   export APPROVED_LISTING_ID=<64 hex, the listing you approved>
//   npx tsx src/follower/runner.ts
// Optional: SELLER_URL (default http://127.0.0.1:8787, loopback only), FOLLOWER_STATE_DIR (state/follower),
// MAX_PRICE (atomic USDC, default 150000), COPY_INTERVAL_MS (20000, at least 5000), NEAR_RPC_URL.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { AgentApi, createIdempotencyKey, type WithdrawRequest as SdkWithdraw, type SwapRequest } from '@near-intents-agent-api/sdk';
import { connectNovaAgent, memoryStore } from '../vendor/nova-agent-connect.ts';
import { novaFeedReader } from '../adapters/nova-reader.ts';
import { openFollowerState } from '../adapters/follower-state.ts';
import { createFollowerService, mirrorDecider, type FollowerAgent, type SellerClient, type FollowerState } from './follower-service.ts';

const FOLLOWER_ACCOUNT = '9a45ea1ce599c5df4143001cddc0dd80e6a0a897f8665d0b6570a70c3ac93b35'; // nova-copytrade-follower-1
const MEMO = 'copytrade';   // the memo the follower's policy allows for its withdrawal

const die = (m: string): never => { console.error(`✗ ${m}`); process.exit(1); };
const home = (p: string) => p.replace(/^~(?=$|\/)/, os.homedir());
function envValue(file: string, key: string): string | undefined {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && m[1] === key) return m[2].replace(/^['"]|['"]$/g, '');
  }
  return undefined;
}
function intEnv(name: string, dflt: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined) return dflt;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= min ? n : die(`${name} must be an integer >= ${min}`);
}

// ── configuration ───────────────────────────────────────────────────────────────────────────
const dir = home(process.env.PAID_HANDOFF_DIR ?? '');
if (!dir || !fs.existsSync(dir)) die('set PAID_HANDOFF_DIR to the follower\'s directory (paid-handoff/follower-1)');
const baseUrl = process.env.AGENT_API_BASE_URL ?? '';
if (!/^https:\/\//.test(baseUrl)) die('set AGENT_API_BASE_URL (https)');
const approvedId = process.env.APPROVED_LISTING_ID ?? '';
if (!/^[0-9a-f]{64}$/.test(approvedId)) die('set APPROVED_LISTING_ID to the 64-hex id of the listing you approved');
const sellerUrl = new URL(process.env.SELLER_URL ?? 'http://127.0.0.1:8787');
if (sellerUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(sellerUrl.hostname)) die('SELLER_URL must be http on 127.0.0.1 or localhost');
const maxPrice = process.env.MAX_PRICE ?? '150000';
if (!/^[1-9]\d*$/.test(maxPrice)) die('MAX_PRICE must be a positive atomic USDC amount');
const copyEvery = intEnv('COPY_INTERVAL_MS', 20_000, 5_000);
const stateDir = path.resolve(process.env.FOLLOWER_STATE_DIR ?? 'state/follower');
const rpcUrl = process.env.NEAR_RPC_URL ?? 'https://rpc.mainnet.near.org';
const apiKey = envValue(path.join(dir, '.env'), 'NEAR_INTENTS_AGENT_API_KEY') ?? die('NEAR_INTENTS_AGENT_API_KEY not in .env');
const grant = fs.readFileSync(path.join(dir, '.grant-token'), 'utf8').trim() || die('.grant-token is empty');
const agentId: string = JSON.parse(fs.readFileSync(path.join(dir, 'aa-state.json'), 'utf8')).agent_id ?? die('no agent_id in aa-state.json');

// ── dependencies ────────────────────────────────────────────────────────────────────────────
const disk = await openFollowerState(stateDir);     // first: its lock keeps a second follower off
const state: FollowerState = { ...disk, appendEvent: async (e) => { console.log(JSON.stringify(e)); await disk.appendEvent(e); } };

const api = new AgentApi({ apiKey, baseUrl }).forGrant(grant);
// Member only: the follower never writes to NOVA (methods: [] refuses every write before anything is sent).
const conn = await connectNovaAgent(api, agentId, { store: memoryStore(), maxDepositYocto: 0n, methods: [], sdkConfig: { rpcUrl } });
if (conn.accountId !== FOLLOWER_ACCOUNT) die(`the agent's NEAR account is ${conn.accountId}, not the follower ${FOLLOWER_ACCOUNT}`);

// The payment goes the way the 57r1 payment did (a plain withdrawal: the route verify-payment.ts was built on);
// copies are confidential quotes, as an H6 swap would be.
const agent: FollowerAgent = {
  previewWithdraw: (req) => api.withdraw(agentId, { ...req, dry: true } as SdkWithdraw & { dry: true }, { idempotencyKey: `dry-${createIdempotencyKey()}` }),
  withdraw: (req, key) => api.withdraw(agentId, req as SdkWithdraw, { idempotencyKey: key }),
  status: (c) => api.getStatus(c, { waitMs: 10_000 }),
  quoteSwap: (req) => api.swap(agentId, { ...req, confidential: true, dry: true } as SwapRequest & { dry: true }),
};
const seller: SellerClient = {
  get: async (p) => { const r = await fetch(new URL(p, sellerUrl)); return { status: r.status, body: await r.json().catch(() => null) }; },
  post: async (p, body) => {
    const r = await fetch(new URL(p, sellerUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    return { status: r.status, body: await r.json().catch(() => null) };
  },
};
const isMember = async (groupId: string) => {
  const v = await conn.nova.isAuthorized(groupId, conn.accountId);
  if (typeof v !== 'boolean') throw new Error('follower: is_authorized did not return a boolean');
  return v;
};

const svc = createFollowerService({ seller, agent, reader: novaFeedReader(conn.nova), isMember, decider: mirrorDecider, state,
  newKey: createIdempotencyKey }, { approvedId, maxPrice, memo: MEMO });

// ── run ─────────────────────────────────────────────────────────────────────────────────────
let copyTimer: NodeJS.Timeout | undefined;
async function finish(code: number) { if (copyTimer) clearInterval(copyTimer); await disk.close(); process.exit(code); }
process.on('SIGINT', () => { void finish(0); });
process.on('SIGTERM', () => { void finish(0); });

try {
  console.log(`follower ${FOLLOWER_ACCOUNT} · listing ${approvedId.slice(0, 12)} · seller ${sellerUrl.origin} · copies SIMULATED · technical demo, not investment advice`);
  const listing = await svc.approve();
  const quote = await svc.preview(listing);
  const onRecord = await state.getPayment();
  if (!onRecord) {
    console.log(`\nPayment: ${Number(listing.price) / 1e6} USDC to ${listing.proceedsAccount} (memo ${MEMO}), for ${listing.periodMinutes} minutes of access ` +
      `to ${listing.fingerprint.count} entries (claimed realised P&L ${listing.curve.points.at(-1)!.realised} USDC, verifiable after purchase).`);
    console.log(`Dry preview: ${JSON.stringify({ spend: quote.spend ?? null, fee: quote.fee ?? null, warnings: quote.warnings ?? [] })}`);
    if (!process.stdin.isTTY) die('the payment needs you at a terminal to type "pay"');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question('Type "pay" to send it (anything else stops): ')).trim();
    rl.close();
    if (answer !== 'pay') { console.log('not paid'); await finish(0); }
  } else {
    console.log(`resuming the payment on record (key ${onRecord.idempotencyKey.slice(0, 8)}…): nothing new is sent`);
  }
  const claim = await svc.pay(listing);
  await svc.claim(listing, claim);
  await svc.verify(listing);
  let busy = false;   // ticks never overlap
  copyTimer = setInterval(() => {
    if (busy) return;
    busy = true;
    svc.copyTick(listing)
      .then(() => { if (svc.ended() || svc.stoppedReason()) void finish(svc.stoppedReason() ? 1 : 0); })
      .catch((e) => console.error(`✗ copy tick: ${(e as Error)?.message ?? e}`))
      .finally(() => { busy = false; });
  }, copyEvery);
} catch (e) {
  console.error(`✗ ${(e as Error)?.message ?? e}`);
  await finish(1);
}