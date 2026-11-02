// verify-payment.test.ts: harness for src/core/verify-payment.ts, written BEFORE the module.
//
// Fixture: tx 57r1MHFX… (the Oct 19 Agent Connect withdrawal of 0.10 USDC to 1000fans.near), the raw
// EXPERIMENTAL_tx_status result from an archival RPC, checked by SHA-256 before use. The chain is faked
// behind the module's ChainReader seam; edited copies of the real transaction drive each refusal.
// Each refusal is asserted by its own message and leaves the used-intent store untouched.
// VP_MODULE=<path> runs it against a mutant (mutate-verify-payment.mjs).
//
//   npx tsx test/verify-payment.test.ts

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const modPath = process.env.VP_MODULE ?? path.join(HERE, '../src/core/verify-payment.ts');
const M: typeof import('../src/core/verify-payment.ts') = await import(pathToFileURL(path.resolve(modPath)).href);

const FIXTURE = path.join(HERE, 'fixtures/withdrawal-57r1.tx.json');
const FIXTURE_SHA256 = 'a075acf5527013f7c4ed479170bff597a6415fe24b7438d92f42d1788aa171f8';
const rawFixture = fs.readFileSync(FIXTURE);
if (createHash('sha256').update(rawFixture).digest('hex') !== FIXTURE_SHA256) {
  console.error('✗ fixture changed: test/fixtures/withdrawal-57r1.tx.json no longer matches its recorded SHA-256');
  process.exit(2);
}
type Json = any;
const REAL: Json = JSON.parse(rawFixture.toString());

const TX = '57r1MHFXLNJT9xUiLTdhz3HNxbawhjn1UjRfkPK7Y3Rn';
const INTENT_HASH = 'B2btEHKa3W2DcSo51dYoEAMghbmHqEUKg78BwSPK3UbY';
const PAYER = '5a5d96f384a41ba3d1c90399dcd563ed6f52c34aa28ba5f200902a655d8ab288';
const PROCEEDS = '1000fans.near';
const TOKEN = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const PRICE = '100000';
const DISPATCHED_MS = Date.parse('2026-10-19T10:34:42.845Z'); // the follower's status: dispatch_committed_at
const UPDATED_MS = Date.parse('2026-10-19T10:34:48.248Z');    // the follower's status: updated_at
const BLOCK_MS = Date.parse('2026-10-19T10:34:45.000Z');      // the fake chain's block time for the payment
const NOW_MS = Date.parse('2026-10-19T10:40:00.000Z');
const OPENED_MS = Date.parse('2026-10-19T10:00:00.000Z');

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: unknown, extra = '') {
  if (cond) pass++; else { fail++; failures.push(`${name}${extra ? ` — ${extra}` : ''}`); }
  console.log(`${cond ? '✓' : '✗'} ${name}${!cond && extra ? ` — ${extra}` : ''}`);
}
async function refusal(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return 'ACCEPTED'; } catch (e) { return String((e as Error).message); }
}

// ── fakes ─────────────────────────────────────────────────────────────────────────────────────
function memStore(used: string[] = []) {
  const s = new Map<string, unknown>(used.map((h) => [h, {}]));
  const writes: string[] = [];
  return {
    writes,
    has: async (h: string) => s.has(h),
    add: async (h: string, rec: unknown) => { if (s.has(h)) throw new Error('store: duplicate'); s.set(h, rec); writes.push(h); },
  };
}
function fakeChain(txs: Json[], blockMs = BLOCK_MS) {
  const calls: unknown[][] = [];
  return {
    calls,
    scanExecuteIntents: async (fromMs: number, toMs: number) => { calls.push(['scan', fromMs, toMs]); return txs.map((t) => structuredClone(t.transaction)); },
    txStatus: async (hash: string, sender: string) => {
      calls.push(['tx', hash, sender]);
      const t = txs.find((x) => x.transaction.hash === hash);
      if (!t) throw new Error('UNKNOWN_TRANSACTION');
      return structuredClone(t);
    },
    blockTimeMs: async (blockHash: string) => { calls.push(['block', blockHash]); return blockMs; },
  };
}
const LISTING = { proceedsAccount: PROCEEDS, token: TOKEN, price: PRICE, openedAtMs: OPENED_MS };
const CLAIM = { intentHash: INTENT_HASH, payer: PAYER, windowFromMs: DISPATCHED_MS, windowToMs: UPDATED_MS };
function setup(txs: Json[] = [REAL], o: { blockMs?: number; used?: string[] } = {}) {
  const chain = fakeChain(txs, o.blockMs);
  const used = memStore(o.used);
  const run = (claim: Json = CLAIM, listing: Json = LISTING) => M.verifyPayment({ chain, used, now: () => NOW_MS }, listing, claim);
  return { chain, used, run };
}

// ── edits of the real transaction ─────────────────────────────────────────────────────────────
const parseEvent = (l: string): Json => (l.startsWith('EVENT_JSON:') ? JSON.parse(l.slice('EVENT_JSON:'.length)) : null);
function editEvent(tx: Json, event: string, edit: (d: Json) => void): Json {
  const t = structuredClone(tx);
  for (const o of t.receipts_outcome) {
    o.outcome.logs = o.outcome.logs.map((l: string) => {
      const ev = parseEvent(l);
      if (!ev || ev.event !== event) return l;
      for (const d of ev.data) edit(d);
      return 'EVENT_JSON:' + JSON.stringify(ev);
    });
  }
  return t;
}
function moveEvent(tx: Json, event: string, executor: string | null): Json {
  const t = structuredClone(tx);
  let moved: string | undefined;
  for (const o of t.receipts_outcome) {
    const i = o.outcome.logs.findIndex((l: string) => parseEvent(l)?.event === event);
    if (i >= 0 && moved === undefined) moved = o.outcome.logs.splice(i, 1)[0];
  }
  if (moved === undefined) throw new Error(`fixture has no ${event}`);
  if (executor) t.receipts_outcome.push({ id: 'Forged111111111111111111111111111111111111', block_hash: t.transaction_outcome.block_hash,
    outcome: { executor_id: executor, logs: [moved], status: { SuccessValue: '' }, receipt_ids: [], gas_burnt: 0, tokens_burnt: '0' } });
  return t;
}
function failReceiptWith(tx: Json, event: string): Json {
  const t = structuredClone(tx);
  for (const o of t.receipts_outcome) {
    if (o.outcome.logs.some((l: string) => parseEvent(l)?.event === event)) o.outcome.status = { Failure: { ActionError: { index: 0 } } };
  }
  return t;
}
function editSigned(tx: Json, edit: (msg: Json) => void): Json {
  const t = structuredClone(tx);
  const fc = t.transaction.actions.find((a: Json) => a.FunctionCall)?.FunctionCall;
  const args = JSON.parse(Buffer.from(fc.args, 'base64').toString());
  for (const s of args.signed) { const msg = JSON.parse(s.payload.message); edit(msg); s.payload.message = JSON.stringify(msg); }
  fc.args = Buffer.from(JSON.stringify(args)).toString('base64');
  return t;
}
function withHash(tx: Json, hash: string): Json { const t = structuredClone(tx); t.transaction.hash = hash; return t; }

// ── 0. fixture sanity ─────────────────────────────────────────────────────────────────────────
ok('F1 fixture is tx 57r1MHFX…, signed by intents.near, successful',
  REAL.transaction.hash === TX && REAL.transaction.signer_id === 'intents.near' && 'SuccessValue' in REAL.status);

// ── 1. the real payment ───────────────────────────────────────────────────────────────────────
{
  const { chain, used, run } = setup();
  const r: Json = await run().catch((e) => ({ error: String(e.message) }));
  ok('V1 the real payment is accepted', r.txHash === TX, JSON.stringify(r));
  ok('V2 the result names the payer, intent hash, amount, token and receiver read from the chain',
    r.payer === PAYER && r.intentHash === INTENT_HASH && r.amount === PRICE && r.token === TOKEN && r.proceedsAccount === PROCEEDS && r.blockMs === BLOCK_MS);
  ok('V3 the scan covers the claimed window padded by 10 s on each side',
    JSON.stringify(chain.calls.find((c) => c[0] === 'scan')) === JSON.stringify(['scan', DISPATCHED_MS - 10_000, UPDATED_MS + 10_000]));
  ok('V4 the transaction is fetched with sender intents.near', chain.calls.some((c) => c[0] === 'tx' && c[1] === TX && c[2] === 'intents.near'));
  ok('V5 the block time is read from the transaction\'s own block', chain.calls.some((c) => c[0] === 'block' && c[1] === REAL.transaction_outcome.block_hash));
  ok('V6 the intent hash is recorded as used, once', JSON.stringify(used.writes) === JSON.stringify([INTENT_HASH]));
  const again = await refusal(() => run());
  ok('V7 the same claim again is refused (single use)', /intent hash already used/.test(again), again);
}

// ── 2. the claim's shape: refused before any chain call ──────────────────────────────────────
for (const [name, claim, re] of [
  ['C1 intent hash not base58 → refused', { ...CLAIM, intentHash: '0OIl' + INTENT_HASH.slice(4) }, /intent_hash is not a 32-byte base58 hash/],
  ['C2 intent hash of 31 bytes → refused', { ...CLAIM, intentHash: INTENT_HASH.slice(0, 42) }, /intent_hash is not a 32-byte base58 hash/],
  ['C3 payer not a NEAR account id → refused', { ...CLAIM, payer: 'Alice.near' }, /payer is not a valid NEAR account id/],
  ['C4 window reversed → refused', { ...CLAIM, windowFromMs: UPDATED_MS, windowToMs: DISPATCHED_MS }, /window must be ordered and at most 10 minutes/],
  ['C5 window of 10 minutes + 1 ms → refused', { ...CLAIM, windowToMs: DISPATCHED_MS + 600_001 }, /window must be ordered and at most 10 minutes/],
  ['C6 window ending in the future → refused', { ...CLAIM, windowToMs: NOW_MS + 1 }, /window ends in the future/],
  ['C7 window starting before the listing opened → refused', { ...CLAIM, windowFromMs: OPENED_MS - 1, windowToMs: OPENED_MS + 60_000 }, /window starts before the listing opened/],
] as const) {
  const { chain, used, run } = setup();
  const m = await refusal(() => run(claim));
  ok(`${name}, no chain call, nothing recorded`, (re as RegExp).test(m) && chain.calls.length === 0 && used.writes.length === 0, m);
}
{
  const { chain, used, run } = setup();
  const m = await refusal(() => run(CLAIM, { ...LISTING, price: '0' }));
  ok('L1 listing price not a positive integer → refused, no chain call', /listing: price must be a positive integer/.test(m) && chain.calls.length === 0 && used.writes.length === 0, m);
}
{
  const { chain, used, run } = setup([REAL], { used: [INTENT_HASH] });
  const m = await refusal(() => run());
  ok('U1 an intent hash already used → refused before any chain call', /intent hash already used/.test(m) && chain.calls.length === 0 && used.writes.length === 0, m);
}

// ── 3. finding the payment ───────────────────────────────────────────────────────────────────
for (const [name, txs, re] of [
  ['D1 nothing in the window → not found', [], /payment not found in the claimed window/],
  ['D2 signed by another account → not found', [editSigned(REAL, (m) => { m.signer_id = 'someone-else.near'; })], /payment not found in the claimed window/],
  ['D3 signed for another amount → not found', [editSigned(REAL, (m) => { m.intents[0].amount = '100001'; })], /payment not found in the claimed window/],
  ['D4 signed for another receiver → not found', [editSigned(REAL, (m) => { m.intents[0].receiver_id = 'attacker.near'; })], /payment not found in the claimed window/],
  ['D5 two transactions both pass → refused as ambiguous', [REAL, withHash(REAL, 'AnotherTx1111111111111111111111111111111111')], /more than one transaction matches this claim/],
] as const) {
  const { used, run } = setup([...txs]);
  const m = await refusal(() => run());
  ok(`${name}, nothing recorded`, (re as RegExp).test(m) && used.writes.length === 0, m);
}
{
  const failing = withHash(editEvent(REAL, 'ft_withdraw', (d) => { d.amount = '1'; }), 'FailingTx1111111111111111111111111111111111');
  const { used, run } = setup([failing, REAL]);
  const r: Json = await run().catch((e) => ({ error: String(e.message) }));
  ok('D6 one failing candidate next to the real payment → the real one is accepted', r.txHash === TX && used.writes.length === 1, JSON.stringify(r));
}

// ── 4. the on-chain checks of a candidate ────────────────────────────────────────────────────
for (const [name, tx, re, blockMs] of [
  ['E1 transaction failed → refused', { ...structuredClone(REAL), status: { Failure: { ActionError: { index: 0 } } } }, /transaction did not succeed/],
  ['E2 not an intents.near transaction → refused', (() => { const t = structuredClone(REAL); t.transaction.receiver_id = 'evil.near'; return t; })(), /transaction is not intents.near execute_intents/],
  ['E3 ft_withdraw logged by another contract (forged event) → refused', moveEvent(REAL, 'ft_withdraw', 'evil.near'), /no ft_withdraw from intents.near for this intent/],
  ['E4 ft_withdraw in a failed intents.near receipt → refused', failReceiptWith(REAL, 'ft_withdraw'), /no ft_withdraw from intents.near for this intent/],
  ['E5 ft_withdraw for another intent hash → refused', editEvent(REAL, 'ft_withdraw', (d) => { d.intent_hash = '4Qk6tSWo5D6ReB9ve6LwyiT6cKw5TjdZ3eNnqhwmFhXF'; }), /no ft_withdraw from intents.near for this intent/],
  ['E6 ft_withdraw amount one unit more → refused', editEvent(REAL, 'ft_withdraw', (d) => { d.amount = '100001'; }), /ft_withdraw amount differs/],
  ['E7 ft_withdraw amount one unit less → refused', editEvent(REAL, 'ft_withdraw', (d) => { d.amount = '99999'; }), /ft_withdraw amount differs/],
  ['E8 ft_withdraw token differs → refused', editEvent(REAL, 'ft_withdraw', (d) => { d.token = 'usdt.tether-token.near'; }), /ft_withdraw token differs/],
  ['E9 ft_withdraw receiver differs → refused', editEvent(REAL, 'ft_withdraw', (d) => { d.receiver_id = 'attacker.near'; }), /ft_withdraw receiver differs/],
  ['E10 ft_withdraw payer differs → refused', editEvent(REAL, 'ft_withdraw', (d) => { d.account_id = 'someone-else.near'; }), /ft_withdraw payer differs/],
  ['E11 intents_executed names another account → refused', editEvent(REAL, 'intents_executed', (d) => { d.account_id = 'someone-else.near'; }), /no intents_executed from intents.near for this intent and payer/],
  ['E12 intents_executed logged by another contract → refused', moveEvent(REAL, 'intents_executed', 'evil.near'), /no intents_executed from intents.near for this intent and payer/],
  ['E13 no USDC ft_transfer logged by the token contract → refused', moveEvent(REAL, 'ft_transfer', 'evil.near'), /no ft_transfer from the token contract to the proceeds account for this amount/],
  ['E14 USDC ft_transfer for another amount → refused', editEvent(REAL, 'ft_transfer', (d) => { d.amount = '1'; }), /no ft_transfer from the token contract to the proceeds account for this amount/],
  ['E15 payment block before the listing opened → refused', REAL, /payment block is before the listing opened/, OPENED_MS - 1],
  ['E16 payment block after the padded window → refused', REAL, /payment block is outside the claimed window/, UPDATED_MS + 10_001],
  ['E17 payment block before the padded window → refused', REAL, /payment block is outside the claimed window/, DISPATCHED_MS - 10_001],
] as const) {
  const { used, run } = setup([tx], { blockMs: (blockMs as number | undefined) });
  const m = await refusal(() => run());
  ok(`${name}, nothing recorded`, (re as RegExp).test(m) && used.writes.length === 0, m);
}
for (const [name, blockMs] of [
  ['E18 payment block exactly at the padded window\'s end → accepted', UPDATED_MS + 10_000],
  ['E19 payment block exactly at the padded window\'s start → accepted', DISPATCHED_MS - 10_000],
] as const) {
  const { run } = setup([REAL], { blockMs });
  const r: Json = await run().catch((e) => ({ error: String(e.message) }));
  ok(name, r.txHash === TX, JSON.stringify(r));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) { console.log('failed:\n  ' + failures.join('\n  ')); process.exit(1); }