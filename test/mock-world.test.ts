// mock-world.test.ts: harness for src/mock/mock-world.ts (the in-memory NOVA, Agent API and chain of demo:mock).
// The fakes must behave like the real systems in what the services depend on: contract trans_ids, membership
// gating and owner-only operations with the contract's messages, nova-sdk-js reply shapes (checked through the real
// nova-reader adapter), dry-quote shapes and policy warnings, and the real 57r1 payment verifying on its chain.
//
//   npx tsx test/mock-world.test.ts
//   MOCK_MODULE=<path> npx tsx test/mock-world.test.ts     (the mutation script)
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { contractTransId } from '../src/core/journal.ts';
import { verifyPayment } from '../src/core/verify-payment.ts';
import { novaFeedReader } from '../src/adapters/nova-reader.ts';
import { memberOps } from '../src/adapters/member-ops.ts';

const here = dirname(fileURLToPath(import.meta.url));
const modPath = process.env.MOCK_MODULE ? resolve(process.env.MOCK_MODULE) : resolve(here, '../src/mock/mock-world.ts');
const M = await import(pathToFileURL(modPath).href);

type Json = any;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function ok(name: string, pass: boolean, detail?: unknown) {
  const d = detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ name, ok: pass, detail: d });
  console.log(`${pass ? '✓' : '✗'} ${name}${!pass && d ? ` — ${d}` : ''}`);
}
async function thrown(f: () => Promise<unknown>): Promise<Json> { try { await f(); return { name: 'none', message: 'no error' }; } catch (e) { return e; } }
const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');

const raw = readFileSync(resolve(here, 'fixtures/withdrawal-57r1.tx.json'));
if (sha(raw) !== M.FIXTURE_SHA) { console.error('fixture sha256 mismatch'); process.exit(1); }
const fixture = JSON.parse(raw.toString());
const START = Date.parse('2026-10-19T10:00:00.000Z');
const G = 'mock-group';
const SELLER = 'mock-seller.near';
const BUYER = M.RECORDED.payer;
const world = () => { const w = M.createMockWorld({ startMs: START, fixture, prices: ['4', '5'] }); w.createGroup(G, SELLER); return w; };

// ── NOVA ────────────────────────────────────────────────────────────────────────────────────
{
  const w = world();
  const s = w.novaFor(SELLER);
  const up = await s.upload(G, Buffer.from('hello'), 'e-1.json');
  const rows = await s.getTransactionsForGroup(G);
  ok('N1 an upload is recorded under the uploader, at block time, with the contract\'s trans_id; the reply has nova-sdk-js\'s shape',
    rows.length === 1 && rows[0].user_id === SELLER && rows[0].timestamp === (BigInt(START) * 1_000_000n).toString() &&
    rows[0].trans_id === contractTransId(rows[0]) && up.trans_id === rows[0].trans_id && up.file_hash === sha('hello') &&
    rows[0].ipfs_hash === 'fastfs/e-1.json' && up.cid === rows[0].ipfs_hash && rows[0].deleted === null, { up, row: rows[0] });
  const up2 = await s.upload(G, Buffer.from('again'), 'e-2.json');
  const rows2 = await s.getTransactionsForGroup(G);
  w.clock.advance(1000);
  await s.upload(G, Buffer.from('later'), 'e-3.json');
  const rows3 = await s.getTransactionsForGroup(G);
  ok('N2 records keep chain order; two in the same millisecond get increasing times; the clock moves them',
    BigInt(rows2[1].timestamp) === BigInt(rows2[0].timestamp) + 1n && rows2[1].trans_id === up2.trans_id &&
    BigInt(rows3[2].timestamp) === BigInt(START + 1000) * 1_000_000n, rows3.map((r: Json) => r.timestamp));
  const got = await novaFeedReader(s).retrieve(G, 'fastfs/e-1.json');
  const listed = await novaFeedReader(s).listRecords(G);
  ok('N3 the real nova-reader adapter accepts the mock\'s replies (rows and retrieve)', new TextDecoder().decode(got) === 'hello' && listed.length === 3);
  const b = w.novaFor(BUYER);
  const refused = await Promise.all([thrown(() => b.getTransactionsForGroup(G)), thrown(() => b.retrieve(G, 'fastfs/e-1.json')), thrown(() => b.upload(G, Buffer.from('x'), 'x'))]);
  ok('N4 a non-member can neither list, retrieve nor upload', refused.every((e) => e.name === 'NovaError') && /not authorized/.test(refused[1].message), refused.map((e) => e.message));
  ok('N5 is_authorized defaults to the caller and answers for any account', (await s.isAuthorized(G)) === true && (await b.isAuthorized(G)) === false &&
    (await s.isAuthorized(G, BUYER)) === false);
  const ops = memberOps(s, { resolvePending: async () => null });
  await ops.add(G, BUYER);
  const now = [await b.isAuthorized(G), (await b.getTransactionsForGroup(G)).length];
  const dup = await thrown(() => s.addGroupMember(G, BUYER));
  const notOwner = await thrown(() => b.revokeGroupMember(G, SELLER));
  const notOwnerAdd = await thrown(() => b.addGroupMember(G, 'third.near'));
  const byMember = await b.upload(G, Buffer.from('member'), 'm.json');
  const memberRow = (await s.getTransactionsForGroup(G)).find((r: Json) => r.trans_id === byMember.trans_id);
  await ops.revoke(G, BUYER);
  const after = await thrown(() => b.retrieve(G, 'fastfs/e-1.json'));
  const gone = await thrown(() => s.revokeGroupMember(G, BUYER));
  ok('N6 with the real member-ops adapter: the owner admits and revokes; a revoked member cannot read; the contract\'s messages',
    now[0] === true && now[1] === 3 && /User already a member/.test(dup.message) && /Only group owner/.test(notOwner.message) &&
    /Only group owner/.test(notOwnerAdd.message) && memberRow?.user_id === BUYER &&
    after.name === 'NovaError' && /User not a member/.test(gone.message) && (await b.isAuthorized(G)) === false, { dup: dup.message, notOwner: notOwner.message });
  const missing = await thrown(() => s.retrieve(G, 'fastfs/none'));
  const noGroup = await thrown(() => s.getTransactionsForGroup('other'));
  w.record(G, 'other.near', new Uint8Array([1]), 'fastfs/other');
  ok('N7 an unknown file or group is an error; record() adds a record by any account (the demo\'s other uploader)',
    /not found/.test(missing.message) && /group other not found/.test(noGroup.message) && (await s.getTransactionsForGroup(G)).at(-1).user_id === 'other.near');
}

// ── Agent API ───────────────────────────────────────────────────────────────────────────────
{
  const w = world();
  const a = w.agentFor({ capUsdc: 150000n, capWnear: 5n * 10n ** 22n, withdrawTo: ['1000fans.near'] });
  const buy = await a.swap('x', { origin_asset: M.USDC, destination_asset: M.WNEAR, amount: '100000', dry: true });
  const sell = await a.swap('x', { origin_asset: M.WNEAR, destination_asset: M.USDC, amount: (25n * 10n ** 21n).toString(), dry: true });
  ok('A1 a dry swap quote has the QuoteResponse shape, priced on the mock path (0.10 USDC at 4 → 0.025 NEAR, and back)',
    buy.dry === true && buy.quote.amount_out === (25n * 10n ** 21n).toString() && buy.quote.would_succeed === true && buy.warnings.length === 0 &&
    sell.quote.amount_out === '100000', { buy, sell });
  w.clock.advance(5 * 60_000);
  const later = await a.swap('x', { origin_asset: M.USDC, destination_asset: M.WNEAR, amount: '100000', dry: true });
  w.clock.advance(60 * 60_000);
  const held = await a.swap('x', { origin_asset: M.USDC, destination_asset: M.WNEAR, amount: '100000', dry: true });
  ok('A2 the price follows the path, one step every 5 minutes, and the last price holds', later.quote.amount_out === (2n * 10n ** 22n).toString() &&
    held.quote.amount_out === later.quote.amount_out && w.priceAt(START) === 4_000_000_000n);
  const big = await a.swap('x', { origin_asset: M.USDC, destination_asset: M.WNEAR, amount: '150001', dry: true });
  const atCap = await a.swap('x', { origin_asset: M.USDC, destination_asset: M.WNEAR, amount: '150000', dry: true });
  const bigNear = await a.swap('x', { origin_asset: M.WNEAR, destination_asset: M.USDC, amount: (5n * 10n ** 22n + 1n).toString(), dry: true });
  ok('A3 above the agent\'s per-trade cap a quote carries policy_transaction_limit_exceeded and would_succeed: false; at the cap it passes',
    big.warnings[0].code === 'policy_transaction_limit_exceeded' && big.quote.would_succeed === false && atCap.warnings.length === 0 &&
    bigNear.warnings[0].code === 'policy_transaction_limit_exceeded');
  const live = await thrown(() => a.swap('x', { origin_asset: M.USDC, destination_asset: M.WNEAR, amount: '1' }));
  ok('A4 only dry swaps exist in mock mode', live.message === 'mock: only dry swaps exist in mock mode');
  const p1 = await a.previewWithdraw({ asset: M.USDC, amount: '100000', chain: 'near', recipient: 'listing-99.near', memo: 'copytrade' });
  const p2 = await a.previewWithdraw({ asset: M.USDC, amount: '100000', chain: 'near', recipient: '1000fans.near', memo: 'copytrade' });
  ok('A5 a withdraw preview to a recipient outside the policy carries policy_destination_denied; to 1000fans.near it passes',
    p1.dry === true && p1.warnings[0].code === 'policy_destination_denied' && p1.quote.would_succeed === false && p2.warnings.length === 0 && p2.quote.would_succeed === true);
  const req = { asset: M.USDC, amount: '100000', chain: 'near', recipient: '1000fans.near', memo: 'copytrade' };
  const w1 = await a.withdraw(req, 'key-1');
  const w2 = await a.withdraw({ ...req, amount: '1' }, 'key-1');   // the same key replays the first request
  const st = await a.status(w2.correlation_id);
  ok('A6 a withdrawal is idempotent by key and settles as the recorded payment (intent hash, payer, window)',
    w1.correlation_id === w2.correlation_id && w1.status === 'PROCESSING' && st.status === 'SUCCESS' && st.details.intent_hash === M.RECORDED.intentHash &&
    st.details.near_account_id === M.RECORDED.payer && Date.parse(st.dispatch_committed_at) === M.RECORDED.windowFromMs &&
    Date.parse(st.updated_at) === M.RECORDED.windowToMs, st);
  const other = await a.withdraw({ ...req, amount: '50000' }, 'key-2');
  const st2 = await a.status(other.correlation_id);
  const denied = await thrown(() => a.withdraw({ ...req, recipient: 'listing-99.near' }, 'key-3'));
  ok('A7 any other withdrawal fails (no recorded payment); one the policy refuses throws a 409 AgentApiError that is not retryable',
    st2.status === 'FAILED' && st2.failure_code === 'mock_no_recorded_payment' && denied.name === 'AgentApiError' && denied.status === 409 &&
    denied.code === 'policy_denied' && denied.retryable === false, { st2, denied: denied.message });
}

// ── Chain ───────────────────────────────────────────────────────────────────────────────────
{
  const w = world();
  const used = new Set<string>();
  const listing = { proceedsAccount: '1000fans.near', token: M.USDC.slice('nep141:'.length), price: '100000', openedAtMs: Date.parse('2026-10-19T10:30:00.000Z') };
  const claim = { intentHash: M.RECORDED.intentHash, payer: M.RECORDED.payer, windowFromMs: M.RECORDED.windowFromMs, windowToMs: M.RECORDED.windowToMs };
  const p = await verifyPayment({ chain: w.chain, used: { has: async (h: string) => used.has(h), add: async (h: string) => { used.add(h); } },
    now: () => Date.parse('2026-10-19T10:40:00.000Z') }, listing, claim);
  ok('C1 the real verifyPayment accepts the recorded payment over the mock chain', p.payer === M.RECORDED.payer && p.txHash === fixture.transaction.hash &&
    p.blockMs === M.RECORDED.blockMs && p.amount === '100000', p);
  ok('C2 the chain serves the payment only inside its window', (await w.chain.scanExecuteIntents(0, M.RECORDED.blockMs - 1)).length === 0 &&
    (await w.chain.scanExecuteIntents(M.RECORDED.blockMs, M.RECORDED.blockMs)).length === 1 &&
    (await thrown(() => w.chain.txStatus('other', 'intents.near'))).message === 'mock chain: unknown tx other');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log('failed:'); for (const r of failed) console.log(`  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`); process.exit(1); }