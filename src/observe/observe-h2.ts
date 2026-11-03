// observe-h2.ts: H2 observation on the seller agent (nova-observation-1). Reads and DRY runs only:
// nothing is signed, nothing is spent, no policy changes. Every request carries dry: true; a reply that is
// not a dry quote stops the run before anything else is sent.
//
//   Q7  operation proof of the 2026-10-19 withdrawal: still 501 transparency_log_disabled?
//   Q8  the seller's policy as the API reads it (actions, assets, limits, max_actions_per_hour, confidential)
//   Q11 dry swap 0.05 USDC → wNEAR (the policy allows withdraw only): refused, or policy_action_denied warning?
//   Q12 the same dry swap with confidential: true (the policy has confidential: false)
//   Q10 dry withdraw 0.21 USDC (above the 0.20 cap): refused, or a quote with a policy_limit_exceeded warning?
//       (a LIVE 0.25 USDC was refused at admission on 2026-10-19: 409 policy_denied)
//   Q10b the same dry withdraw (0.10) without the grant: do previews need it (SDK 0.7.2: yes; docs: no)?
//   Q9  dry withdraw 0.10 USDC to 1000fans.near, memo listing:test (within the cap): baseline quote. Run last:
//       it is the only request that could move funds if the server ignored dry: true.
//
// Run from the repo, with the paid-handoff directory's files (nothing secret is printed or written):
//   export PAID_HANDOFF_DIR=~/near/nova/paid-handoff
//   export AGENT_API_BASE_URL="$(jq -r .api "$PAID_HANDOFF_DIR/observation-20261019T103449Z.json")"
//   npx tsx src/observe/observe-h2.ts
// Reads NEAR_INTENTS_AGENT_API_KEY from $PAID_HANDOFF_DIR/.env, the grant token from .grant-token and the
// agent id from aa-state.json. Writes runs/observe-h2-<ts>.json (public data only).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentApi, AgentApiError, createIdempotencyKey } from '@near-intents-agent-api/sdk';

const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const WNEAR = 'nep141:wrap.near';
const RECIPIENT = '1000fans.near';
const MEMO = 'listing:test';
const OBSERVED_OP = 'op_W-P0i-2Tj04PIB5fJuiHkodhpX10xEMW4hEUP8f8SXI'; // the 2026-10-19 withdrawal (aa-state.json)

type Json = any;
const die = (m: string): never => { console.error(`✗ ${m}`); process.exit(1); };

const dir = (process.env.PAID_HANDOFF_DIR ?? '').replace(/^~(?=$|\/)/, os.homedir());
if (!dir || !fs.existsSync(dir)) die('set PAID_HANDOFF_DIR to the paid-handoff directory');
const baseUrl = process.env.AGENT_API_BASE_URL;
if (!baseUrl || !/^https:\/\//.test(baseUrl)) die('set AGENT_API_BASE_URL (the "api" field of the 2026-10-19 observation)');

function envValue(file: string, key: string): string | undefined {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && m[1] === key) return m[2].replace(/^['"]|['"]$/g, '');
  }
  return undefined;
}
const apiKey = envValue(path.join(dir, '.env'), 'NEAR_INTENTS_AGENT_API_KEY') ?? die('NEAR_INTENTS_AGENT_API_KEY not in .env');
const grant = fs.readFileSync(path.join(dir, '.grant-token'), 'utf8').trim() || die('.grant-token is empty');
const agentId: string = JSON.parse(fs.readFileSync(path.join(dir, 'aa-state.json'), 'utf8')).agent_id ?? die('no agent_id in aa-state.json');

const api = new AgentApi({ apiKey, baseUrl });
const agent = api.forGrant(grant);
const record: Record<string, unknown> = { started_at: new Date().toISOString(), api: baseUrl, agent_id: agentId, results: {} };
const results = record.results as Record<string, unknown>;

const errorView = (e: unknown) => e instanceof AgentApiError
  ? { refused: true, status: e.status, code: e.code, layer: e.layer, title: e.title, detail: e.detail, minAmount: e.minAmount, requestId: e.requestId }
  : { failed: true, error: String((e as Error)?.message ?? e) };

let sawDryQuote = false;
/** A dry reply must be a quote. Anything else (an execution) stops the run: nothing more is sent. */
function quoteView(name: string, r: Json) {
  if (!r || r.dry !== true) {
    record.stopped = { at: name, reply: { correlation_id: r?.correlation_id, status: r?.status } };
    fs.mkdirSync('runs', { recursive: true });
    fs.writeFileSync(path.join('runs', `observe-h2-STOPPED-${Date.now()}.json`), JSON.stringify(record, null, 2) + '\n');
    die(`${name}: the server did not return a dry quote (correlation_id ${r?.correlation_id}); stopped, nothing else sent. Tell Claude.`);
  }
  sawDryQuote = true;
  return { dry: true, type: r.type, warnings: r.warnings, spend: r.spend, fee: r.fee, owner_approval: r.owner_approval, quote: r.quote };
}

async function step(name: string, f: () => Promise<unknown>) {
  try { results[name] = await f(); } catch (e) { results[name] = errorView(e); }
  const r = results[name] as Json;
  const summary = r?.refused ? `${r.status} ${r.code}` : r?.failed ? `failed: ${r.error}`
    : r?.warnings ? `quote, warnings: ${JSON.stringify((r.warnings as Json[]).map((w) => w.code))}` : 'ok';
  console.log(`· ${name}: ${summary}`);
}

async function main() {
  const net = await api.getNetwork() as Json;
  if (net?.network !== 'mainnet') die(`expected mainnet, got ${net?.network}`);
  record.network = { network: net.network, contract_id: net.contract_id };

  await step('Q7_operation_proof', () => api.getOperationProof(agentId, OBSERVED_OP));
  await step('Q8_policy', async () => {
    const p = await api.getPolicy(agentId) as Json;
    const pol = p.policy ?? {};
    return { revision: p.revision, status: p.status, synced: p.provider_policy_synced, actions: pol.actions, assets: pol.assets,
      limits: pol.limits, max_actions_per_hour: pol.max_actions_per_hour, confidential: pol.confidential, budget: pol.budget,
      destinations: pol.destinations, native: pol.native };
  });

  // Order: first the dry runs that cannot move funds even if dry were ignored (an action the policy refuses,
  // an amount above the cap, no grant), then the one within policy (Q9), only once dry was seen honoured.
  const swap = { origin_asset: USDC, destination_asset: WNEAR, amount: '50000', dry: true as const };
  await step('Q11_dry_swap_not_allowed', async () => quoteView('Q11', await agent.swap(agentId, swap)));
  await step('Q12_dry_swap_confidential', async () => quoteView('Q12', await agent.swap(agentId, { ...swap, confidential: true })));

  const withdraw = (amount: string) => ({ asset: USDC, amount, chain: 'near', recipient: RECIPIENT, memo: MEMO, dry: true as const });
  await step('Q10_dry_withdraw_above_cap', async () =>
    quoteView('Q10', await agent.withdraw(agentId, withdraw('210000'), { idempotencyKey: `dry-${createIdempotencyKey()}` })));
  await step('Q10b_dry_withdraw_without_grant', async () =>
    quoteView('Q10b', await api.withdraw(agentId, withdraw('100000'), { idempotencyKey: `dry-${createIdempotencyKey()}` })));
  if (!sawDryQuote) {
    results.Q9_dry_withdraw_within_cap = { skipped: 'no earlier request came back as a dry quote, so dry was never seen honoured' };
    console.log('· Q9_dry_withdraw_within_cap: skipped (dry not yet seen honoured)');
    return;
  }
  await step('Q9_dry_withdraw_within_cap', async () =>
    quoteView('Q9', await agent.withdraw(agentId, withdraw('100000'), { idempotencyKey: `dry-${createIdempotencyKey()}` })));
}

main()
  .catch((e) => { record.run_error = errorView(e); console.error(`✗ run: ${JSON.stringify(record.run_error)}`); })
  .finally(() => {
    fs.mkdirSync('runs', { recursive: true });
    const out = path.join('runs', `observe-h2-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.json`);
    fs.writeFileSync(out, JSON.stringify(record, null, 2) + '\n');
    console.log(`\nwrote ${out}`);
  });