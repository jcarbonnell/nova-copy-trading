// observe-withdrawal.ts: H2 observation, read-only, mainnet. No keys, no .env, nothing signed or spent.
//
// The Oct 19 test payment (aa_observe.py): 0.10 USDC withdrawn by agent nova-observation-1
// (NEAR Intents account 5a5d…b288) to 1000fans.near. The Agent API returned only an intent_hash;
// tx 57r1MHFX… was found later on nearblocks. Questions:
//   Q1 who submits a withdrawal transaction (the RPC lookup needs it as sender_account_id)?
//   Q2 does the solver relay map an intent_hash to its transaction hash?
//   Q3 which receipts emit the dip4 events, and is their executor intents.near?
//   Q4 do the event fields carry payer, receiver, token and exact amount under one intent_hash?
//   Q5 does nearblocks list the payment among the receiver's token transfers (discovery only)?
//   Q6 can the seller find the transaction from the chain alone, by scanning the blocks of the
//      follower's claimed time window for intents.near execute_intents signed by the payer?
//
//   npx tsx src/observe/observe-withdrawal.ts
//   (optional) NEAR_ARCHIVAL_RPC_URL=<url> npx tsx src/observe/observe-withdrawal.ts
//
// Writes runs/observe-withdrawal-<ts>.json (public data only).

import fs from 'node:fs';
import path from 'node:path';

const TX = '57r1MHFXLNJT9xUiLTdhz3HNxbawhjn1UjRfkPK7Y3Rn';
const INTENT_HASH = 'B2btEHKa3W2DcSo51dYoEAMghbmHqEUKg78BwSPK3UbY';
const PAYER = '5a5d96f384a41ba3d1c90399dcd563ed6f52c34aa28ba5f200902a655d8ab288';
const RECEIVER = '1000fans.near';
const TOKEN = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'; // USDC
const AMOUNT = '100000'; // 0.10 USDC (6 decimals)
const INTENTS = 'intents.near';

const RPC = process.env.NEAR_ARCHIVAL_RPC_URL ?? 'https://archival-rpc.mainnet.fastnear.com';
const NEARBLOCKS = 'https://api.nearblocks.io/v1';
const RELAY = 'https://solver-relay-v2.chaindefuser.com/rpc';

type Json = any; // external replies: recorded raw, never trusted for shape
interface Reply { status: number; body?: Json; error?: string }

async function http(url: string, init?: RequestInit): Promise<Reply> {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    const text = await r.text();
    let body: Json;
    try { body = JSON.parse(text); } catch { body = { _raw: text.slice(0, 500) }; }
    return { status: r.status, body };
  } catch (e) {
    return { status: 0, error: String((e as Error).message ?? e) };
  }
}
const post = (url: string, body: unknown) =>
  http(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const results: { name: string; ok: boolean; detail?: unknown }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}
const record: Record<string, unknown> = { started_at: new Date().toISOString(), tx: TX, intent_hash: INTENT_HASH, rpc: RPC, results };

// The follower's own withdrawal status (Oct 19 observation file): the window the seller is told to search.
const DISPATCHED = '2026-10-19T10:34:42.845Z';
const UPDATED = '2026-10-19T10:34:48.248Z';
const PAD_MS = 10_000;
const GENESIS = 9_820_210;

let rpcCalls = 0;
let lastRpcAt = 0;
const RPC_MIN_INTERVAL_MS = 200;
// Public RPCs rate-limit: at most one call per RPC_MIN_INTERVAL_MS, and 429 retried with backoff.
async function rpcRaw(method: string, params: unknown): Promise<Reply> {
  for (let attempt = 0; ; attempt++) {
    const wait = lastRpcAt + RPC_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    lastRpcAt = Date.now();
    rpcCalls++;
    const r = await post(RPC, { jsonrpc: '2.0', id: 's', method, params });
    if (r.status !== 429 || attempt >= 6) return r;
    await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt));
  }
}
async function rpc(method: string, params: unknown): Promise<Json> {
  const r = await rpcRaw(method, params);
  if (r.body?.result) return r.body.result;
  const err = r.body?.error;
  throw new Error(`${method}: ${err?.cause?.name ?? err?.name ?? r.error ?? `HTTP ${r.status}`}`);
}
const blockMs = (b: Json) => Number(BigInt(b.header.timestamp_nanosec) / 1_000_000n);
// Block heights can be skipped: return the first existing block at or above `height`.
async function existingBlock(height: number): Promise<Json> {
  for (let h = height; h < height + 20; h++) {
    try { return await rpc('block', { block_id: h }); }
    catch (e) { if (!/UNKNOWN_BLOCK/.test(String((e as Error).message))) throw e; }
  }
  throw new Error(`no block in [${height}, ${height + 20})`);
}
async function firstBlockAtOrAfter(tMs: number): Promise<number> {
  const head = await rpc('block', { finality: 'final' });
  // Blocks are never faster than 0.4 s, so this lower bound is before tMs.
  let lo = Math.max(GENESIS, head.header.height - Math.ceil((Date.now() - tMs) / 400));
  let hi: number = head.header.height;
  if (blockMs(await existingBlock(lo)) > tMs) throw new Error('lower bound is after the window');
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const b = await existingBlock(mid);
    if (blockMs(b) < tMs) lo = b.header.height; else hi = mid;
  }
  return hi;
}
// Transactions signed by intents.near calling execute_intents, whose signed NEP-413 message has the
// payer as signer_id and an ft_withdraw to the receiver. Chain data only; no indexer.
async function scanWindow(fromMs: number, toMs: number) {
  const started = Date.now();
  const calls0 = rpcCalls;
  const matches = new Set<string>();
  let blocks = 0, chunks = 0;
  let intentsShard: number | null = null; // learned: a tx signed by intents.near sits in its shard's chunk
  for (let h = await firstBlockAtOrAfter(fromMs); ; ) {
    const b = await existingBlock(h);
    if (blockMs(b) > toMs) break;
    blocks++;
    for (const ch of b.chunks) {
      if (ch.height_included !== b.header.height) continue; // missing chunk: header repeats an older one
      if (intentsShard !== null && ch.shard_id !== intentsShard) continue;
      chunks++;
      const c = await rpc('chunk', { chunk_id: ch.chunk_hash });
      for (const tx of c.transactions ?? []) {
        if (tx.signer_id === INTENTS) intentsShard = ch.shard_id;
        if (tx.signer_id !== INTENTS || tx.receiver_id !== INTENTS) continue;
        for (const a of tx.actions ?? []) {
          const fc = a?.FunctionCall;
          if (fc?.method_name !== 'execute_intents') continue;
          let args: Json;
          try { args = JSON.parse(Buffer.from(fc.args, 'base64').toString()); } catch { continue; }
          for (const s of args?.signed ?? []) {
            let msg: Json;
            try { msg = JSON.parse(s?.payload?.message ?? ''); } catch { continue; }
            if (msg?.signer_id === PAYER &&
                (msg.intents ?? []).some((i: Json) => i?.intent === 'ft_withdraw' && i?.receiver_id === RECEIVER)) {
              matches.add(tx.hash);
            }
          }
        }
      }
    }
    h = b.header.height + 1;
  }
  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), blocks, chunks,
    intents_shard: intentsShard, rpc_calls: rpcCalls - calls0, ms: Date.now() - started, matches: [...matches] };
}

async function main() {
  // Q1: who signed the transaction (nearblocks public API)
  const nb = await http(`${NEARBLOCKS}/txns/${TX}`);
  record.nearblocks = nb;
  const nbTx = nb.body?.txns?.[0];
  const nbSigner: string | undefined = nbTx?.signer_account_id;
  check('Q1 nearblocks names the transaction signer', typeof nbSigner === 'string',
    nbSigner ? `signer ${nbSigner}, receiver ${nbTx?.receiver_account_id}` : `HTTP ${nb.status} ${nb.error ?? ''}`);

  // Q2: does the solver relay map the intent hash to this transaction?
  const relay = await post(RELAY, { jsonrpc: '2.0', id: 1, method: 'get_status', params: [{ intent_hash: INTENT_HASH }] });
  record.relay_get_status = relay;
  const relayHash: string | undefined = relay.body?.result?.data?.hash;
  check('Q2 solver relay answered (records whether it maps the intent to a transaction)', relay.status === 200 && !!relay.body?.result,
    relayHash ? `maps it: status ${relay.body?.result?.status}, hash ${relayHash}` : `does not map it: ${relay.body?.result?.status ?? `HTTP ${relay.status} ${relay.error ?? ''}`}`);

  // Q5: can the seller find the payment among its proceeds account's incoming token transfers?
  const ft = await http(`${NEARBLOCKS}/account/${RECEIVER}/ft-txns?per_page=25`);
  record.nearblocks_ft_txns = ft;
  const rows: Json[] = Array.isArray(ft.body?.txns) ? ft.body.txns : [];
  const hit = rows.find((r) => JSON.stringify(r).includes(TX));
  record.ft_txn_row = hit ?? null;
  check(`Q5 nearblocks answered (records whether it lists the payment among ${RECEIVER}'s token transfers)`, ft.status === 200,
    hit ? { keys: Object.keys(hit), row: hit } : `HTTP ${ft.status}, ${rows.length} rows ${ft.error ?? JSON.stringify(ft.body).slice(0, 200)}`);

  // Q6: discovery from the chain alone, over the follower's claimed time window (padded).
  try {
    const scan = await scanWindow(Date.parse(DISPATCHED) - PAD_MS, Date.parse(UPDATED) + PAD_MS);
    record.chain_scan = scan;
    check('Q6 a chain scan of the claimed window finds exactly this payment', scan.matches.length === 1 && scan.matches[0] === TX, scan);
  } catch (e) {
    check('Q6 a chain scan of the claimed window finds exactly this payment', false, String((e as Error).message ?? e));
  }

  // Fetch the transaction from an archival RPC; the sender_account_id must be the real signer.
  const candidates = [...new Set([nbSigner, INTENTS, 'outlayer.near', PAYER].filter((x): x is string => !!x))];
  let tx: Json = null;
  const tried: { sender: string; status: number; error?: unknown }[] = [];
  for (const sender of candidates) {
    const r = await rpcRaw('EXPERIMENTAL_tx_status', { tx_hash: TX, sender_account_id: sender, wait_until: 'FINAL' });
    tried.push({ sender, status: r.status, error: r.body?.error?.cause?.name ?? r.body?.error?.name ?? r.error });
    if (r.body?.result) { tx = r.body.result; record.found_with_sender = sender; break; }
  }
  record.rpc_tries = tried;
  check('RPC returns the transaction from an archival node', !!tx, tx ? `with sender ${record.found_with_sender}` : tried);
  if (!tx) return;

  record.raw_tx = tx; // the full EXPERIMENTAL_tx_status result: the verifier harness's real fixture
  const t = tx.transaction;
  const firstCall = t.actions?.find((a: Json) => a?.FunctionCall)?.FunctionCall;
  record.transaction = { signer_id: t.signer_id, receiver_id: t.receiver_id, method: firstCall?.method_name };
  check('Q1 transaction signer (who submits a withdrawal)', true, `${t.signer_id} → ${t.receiver_id}.${firstCall?.method_name}`);
  check('transaction succeeded', !!tx.status && 'SuccessValue' in tx.status, Object.keys(tx.status ?? {})[0]);

  // Q3: every receipt with its executor and logs; dip4 events and who emitted them
  const outcomes = (tx.receipts_outcome ?? []).map((o: Json) => ({
    id: o.id, executor: o.outcome.executor_id, status: Object.keys(o.outcome.status ?? {})[0], logs: o.outcome.logs ?? [],
  }));
  record.receipts = outcomes;
  const events = outcomes.flatMap((o: Json) => o.logs.filter((l: string) => l.startsWith('EVENT_JSON:')).map((l: string) => {
    try { return { executor: o.executor, receipt_status: o.status, ...JSON.parse(l.slice('EVENT_JSON:'.length)) }; }
    catch { return { executor: o.executor, unparsed: l.slice(0, 200) }; }
  }));
  record.events = events;
  for (const e of events) console.log(`  · ${e.executor}: ${e.standard ?? '?'} ${e.event ?? e.unparsed}`);

  const dip4 = (name: string) => events.filter((e: Json) => e.standard === 'dip4' && e.event === name);
  const withdraws = dip4('ft_withdraw');
  const executed = dip4('intents_executed');
  check('Q3 every dip4 ft_withdraw / intents_executed event is emitted by an intents.near receipt',
    withdraws.length > 0 && executed.length > 0 && [...withdraws, ...executed].every((e: Json) => e.executor === INTENTS),
    [...withdraws, ...executed].map((e: Json) => `${e.event}@${e.executor}`));

  // Q4: the fields the seller will check
  const w = withdraws.flatMap((e: Json) => e.data ?? []).find((d: Json) => d.intent_hash === INTENT_HASH);
  const x = executed.flatMap((e: Json) => e.data ?? []).find((d: Json) => d.intent_hash === INTENT_HASH);
  record.matched = { ft_withdraw: w ?? null, intents_executed: x ?? null };
  check('Q4 ft_withdraw: payer, receiver, token, exact amount under the intent hash',
    !!w && w.account_id === PAYER && w.receiver_id === RECEIVER && w.token === TOKEN && w.amount === AMOUNT, w ?? 'no match');
  check('Q4 intents_executed: same intent hash and payer', !!x && x.account_id === PAYER, x ?? 'no match');
  const ftTransfer = events.find((e: Json) => e.executor === TOKEN && e.event === 'ft_transfer');
  check('the USDC contract itself logs the transfer to the receiver', !!ftTransfer,
    ftTransfer?.data ?? `executors seen: ${[...new Set(outcomes.map((o: Json) => o.executor))].join(', ')}`);
}

main()
  .catch((e) => check('run completed', false, String((e as Error).message ?? e)))
  .finally(() => {
    fs.mkdirSync('runs', { recursive: true });
    const out = path.join('runs', `observe-withdrawal-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.json`);
    fs.writeFileSync(out, JSON.stringify(record, null, 2) + '\n');
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed} answered, ${failed} not answered or not as expected: ${out}`);
  });