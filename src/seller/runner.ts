// runner.ts: the seller (nova-observation-1), wired (approved 2026-11-03). All logic is in seller-service.ts;
// this file only builds its dependencies, serves it on 127.0.0.1 and runs its two timers.
//
// Technical demo, not investment advice. H5: every trade is SIMULATED (priced by a real dry quote, nothing
// swapped); each journal entry IS a real NOVA upload, signed and paid by the seller agent (~0.0004 NEAR, one
// action against its policy's 12 per hour).
//
// Run from the repo (nothing secret is printed, logged or written to state/):
//   export PAID_HANDOFF_DIR=~/near/nova/paid-handoff     # .env (NEAR_INTENTS_AGENT_API_KEY), .grant-token, aa-state.json
//   export AGENT_API_BASE_URL=https://api.demo.agentsonintents.com
//   export SELLER_SCRIPT=demo/seller-script.json         # the decisions to play, in order
//   npx tsx src/seller/runner.ts
// Optional: SELLER_STATE_DIR (default state/seller), SELLER_PORT (8787), TRADE_INTERVAL_MS (600000, at least
// 60000), NEAR_RPC_URL (the SDK's RPC, default rpc.mainnet.near.org), NEAR_ARCHIVAL_RPC_URL (payment checks,
// default archival-rpc.mainnet.near.org).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { AgentApi, type SwapRequest } from '@near-intents-agent-api/sdk';
import { connectNovaAgent, type NovaAgentConnection } from '../vendor/nova-agent-connect.ts';
import { createNearChain } from '../core/near-chain.ts';
import { openLedger } from '../adapters/ledger-file.ts';
import { filePendingStore } from '../adapters/pending-file.ts';
import { openStateDir } from '../adapters/state-dir.ts';
import { novaFeedReader } from '../adapters/nova-reader.ts';
import { memberOps, sellerSignerOptions } from '../adapters/member-ops.ts';
import { createJournalWriter } from './journal-writer.ts';
import { parseScript, scriptDecider } from './script-decider.ts';
import { createSellerService, type StateStore } from './seller-service.ts';

// The listing's terms (approved 2026-11-02; cut line 2: fixed, never agent-set).
const GROUP_ID = 'agent-owned-20261030T073943Z';
const SELLER_ACCOUNT = '5a5d96f384a41ba3d1c90399dcd563ed6f52c34aa28ba5f200902a655d8ab288'; // nova-observation-1
const PROCEEDS = '1000fans.near';
const USDC_CONTRACT = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const PRICE = '100000';           // 0.10 USDC
const PERIOD_MINUTES = 60;
const SIMULATED = true;           // H5
const HOST = '127.0.0.1';
const MAX_BODY = 4096;
const MAINTENANCE_MS = 30_000;

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
if (!dir || !fs.existsSync(dir)) die('set PAID_HANDOFF_DIR to the paid-handoff directory');
const baseUrl = process.env.AGENT_API_BASE_URL ?? '';
if (!/^https:\/\//.test(baseUrl)) die('set AGENT_API_BASE_URL (https)');
const scriptPath = process.env.SELLER_SCRIPT ?? die('set SELLER_SCRIPT to the decisions file');
const decisions = parseScript(fs.readFileSync(scriptPath, 'utf8'));
const stateDir = path.resolve(process.env.SELLER_STATE_DIR ?? 'state/seller');
const port = intEnv('SELLER_PORT', 8787, 1);
const tradeEvery = intEnv('TRADE_INTERVAL_MS', 600_000, 60_000);
const rpcUrl = process.env.NEAR_RPC_URL ?? 'https://rpc.mainnet.near.org';
const archivalUrl = process.env.NEAR_ARCHIVAL_RPC_URL ?? 'https://archival-rpc.mainnet.near.org';
const apiKey = envValue(path.join(dir, '.env'), 'NEAR_INTENTS_AGENT_API_KEY') ?? die('NEAR_INTENTS_AGENT_API_KEY not in .env');
const grant = fs.readFileSync(path.join(dir, '.grant-token'), 'utf8').trim() || die('.grant-token is empty');
const agentId: string = JSON.parse(fs.readFileSync(path.join(dir, 'aa-state.json'), 'utf8')).agent_id ?? die('no agent_id in aa-state.json');

// ── dependencies ────────────────────────────────────────────────────────────────────────────
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const ledger = await openLedger(path.join(stateDir, 'ledger.json'));   // first: its lock keeps a second runner off
const pending = filePendingStore(path.join(stateDir, 'pending.json'));
const disk = await openStateDir(stateDir);
const state: StateStore = { ...disk, appendEvent: async (e) => { console.log(JSON.stringify(e)); await disk.appendEvent(e); } };

const agent = new AgentApi({ apiKey, baseUrl }).forGrant(grant);
const connect = () => connectNovaAgent(agent, agentId, { ...sellerSignerOptions(pending), sdkConfig: { rpcUrl } });
let conn: NovaAgentConnection = await connect();
if (conn.accountId !== SELLER_ACCOUNT) die(`the agent's NEAR account is ${conn.accountId}, not the seller ${SELLER_ACCOUNT}`);
let renewAt = conn.sessionExpiresIn ? Date.now() + conn.sessionExpiresIn * 800 : Infinity;   // 80% of the session

// Every NOVA call goes through the current connection, so a reconnect replaces the session everywhere.
const signer = { resolvePending: () => conn.signer.resolvePending() };
const reader = novaFeedReader({
  getTransactionsForGroup: (g) => conn.nova.getTransactionsForGroup(g),
  retrieve: (g, ref) => conn.nova.retrieve(g, ref),
});
const ops = memberOps({
  isAuthorized: (g, u) => conn.nova.isAuthorized(g, u),
  addGroupMember: (g, m) => conn.nova.addGroupMember(g, m),
  revokeGroupMember: (g, m) => conn.nova.revokeGroupMember(g, m),
}, signer);
// Policy revision 5 is confidential: quotes ask for a confidential swap, as an H6 trade would (H2 Q12: accepted).
const quotes = { swap: (id: string, req: { origin_asset: string; destination_asset: string; amount: string; dry: true }) =>
  agent.swap(id, { ...req, confidential: true } as SwapRequest & { dry: true }) };
const uploader = { upload: (g: string, data: Buffer, name: string) => conn.nova.upload(g, data, name) };

const svc = await createSellerService({
  reader, chain: createNearChain({ rpcUrl: archivalUrl, minIntervalMs: intEnv('NEAR_ARCHIVAL_MIN_INTERVAL_MS', 200, 50), maxRetries: 10 }), ledger, ops, signer, state,
  decider: scriptDecider(decisions),
  makeWriter: (history) => createJournalWriter({ quotes, nova: uploader }, { agentId, groupId: GROUP_ID, simulated: SIMULATED }, history),
}, { terms: { seller: SELLER_ACCOUNT, groupId: GROUP_ID, proceedsAccount: PROCEEDS, token: USDC_CONTRACT, price: PRICE,
  periodMinutes: PERIOD_MINUTES, simulated: SIMULATED } });

// ── server ──────────────────────────────────────────────────────────────────────────────────
const inflight = new Set<Promise<unknown>>();
const track = <T>(p: Promise<T>): Promise<T> => { inflight.add(p); p.finally(() => inflight.delete(p)).catch(() => {}); return p; };

const server = http.createServer((req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > MAX_BODY) { send(413, { error: 'request too large' }); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (size > MAX_BODY) return;
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    track(svc.handle({ method: req.method ?? 'GET', path: url.pathname, body: Buffer.concat(chunks).toString('utf8') }))
      .then((r) => send(r.status, r.body))
      .catch((e) => { console.error(`✗ request failed: ${(e as Error)?.message ?? e}`); send(500, { error: 'internal error' }); });
  });
});
await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(port, HOST, () => ok()); });
console.log(`seller ${SELLER_ACCOUNT} on http://${HOST}:${port} · group ${GROUP_ID} · ${decisions.length} scripted decisions · ` +
  `a trade every ${tradeEvery / 1000}s · SIMULATED · technical demo, not investment advice`);

// ── timers ──────────────────────────────────────────────────────────────────────────────────
let trading: Promise<void> | null = null;
let maintaining: Promise<void> | null = null;
const tradeTimer = setInterval(() => {
  if (trading) return;
  trading = track(svc.tradeTick()).catch((e) => console.error(`✗ trade tick: ${(e as Error)?.message ?? e}`)).finally(() => { trading = null; });
}, tradeEvery);
const maintenanceTimer = setInterval(() => {
  if (maintaining) return;
  maintaining = track((async () => {
    if (Date.now() >= renewAt) {
      try {
        conn = await connect();
        renewAt = conn.sessionExpiresIn ? Date.now() + conn.sessionExpiresIn * 800 : Infinity;
        await state.appendEvent({ at: Date.now(), kind: 'session_renewed' });
      } catch (e) {
        await state.appendEvent({ at: Date.now(), kind: 'session_renewal_failed', message: String((e as Error)?.message ?? e) });
      }
    }
    await svc.maintenanceTick();
  })()).catch((e) => console.error(`✗ maintenance tick: ${(e as Error)?.message ?? e}`)).finally(() => { maintaining = null; });
}, MAINTENANCE_MS);

// ── shutdown ────────────────────────────────────────────────────────────────────────────────
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: stopping (waiting for the write in flight, if any)`);
  clearInterval(tradeTimer);
  clearInterval(maintenanceTimer);
  await new Promise<void>((ok) => server.close(() => ok()));
  await Promise.allSettled([...inflight]);
  await ledger.close();
  process.exit(0);
}
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });