// mutate-near-chain.mjs: every mutant of src/core/near-chain.ts must be caught by the harness.
// Same scheme as mutate-verify-payment.mjs: one anchored string replacement per mutant, written to a
// temporary directory, run through test/near-chain.test.ts with NC_MODULE pointing at it. The mutant's
// import of ./verify-payment.ts is pointed at the real module, so the harness and the mutant share it.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const MODULE = join(root, 'src/core/near-chain.ts');
const HARNESS = join(root, 'test/near-chain.test.ts');
const TSX = join(root, 'node_modules/.bin/tsx');
const IMPORT = `from './verify-payment.ts'`;
const src = readFileSync(MODULE, 'utf8');
if (src.split(IMPORT).length !== 2) { console.error(`expected exactly one ${IMPORT}`); process.exit(1); }
const relocated = src.replace(IMPORT, `from '${pathToFileURL(join(root, 'src/core/verify-payment.ts')).href}'`);

/** [id, what it breaks, anchor, replacement] */
const MUTANTS = [
  // transport
  ['K1', 'no pacing', `if (wait > 0) await sleep(wait);`, ``],
  ['K2', 'retryable statuses not retried', ` || RETRY_STATUS.has(res.status)`, ``],
  ['K3', 'one retry too many', `if (attempt >= maxRetries)`, `if (attempt > maxRetries)`],
  ['K4', 'no exponential backoff', `await sleep(1000 * 2 ** attempt);`, `await sleep(1000);`],
  ['K5', 'transport failure not retried', `if (res === null || RETRY_STATUS`, `if (res !== null && RETRY_STATUS`],
  ['K6', 'JSON-RPC error ignored', `if (body?.error) throw`, `if (false) throw`],
  ['K7', 'HTTP status ignored', `if (!res.ok) throw`, `if (false) throw`],
  ['K8', 'missing result accepted', `if (body?.result == null) throw`, `if (false) throw`],
  ['K9', 'another RPC URL', `res = await fetchFn(o.rpcUrl, {`, `res = await fetchFn('https://rpc.mainnet.near.org', {`],
  // blocks
  ['K10', 'skipped height is fatal', `if (e instanceof NearRpcError && e.reason === 'UNKNOWN_BLOCK') continue;`, ``],
  ['K11', 'block height unchecked', `if (b?.header?.height !== h) throw`, `if (false) throw`],
  ['K12', 'search bound too late', `export const MIN_BLOCK_MS = 400;`, `export const MIN_BLOCK_MS = 60_000;`],
  ['K13', 'window start exclusive', `if (blockTime(b) < tMs) lo = b.header.height;`, `if (blockTime(b) <= tMs) lo = b.header.height;`],
  ['K14', 'window end exclusive', `if (blockTime(b) > toMs) break;`, `if (blockTime(b) >= toMs) break;`],
  ['K15', 'non-final window scanned', `if (blockTime(head) < toMs) throw`, `if (false) throw`],
  ['K16', 'nanoseconds rounded', `Number(BigInt(b.header.timestamp_nanosec) / 1_000_000n)`, `Math.round(Number(b.header.timestamp_nanosec) / 1e6)`],
  // chunks and transactions
  ['K17', 'missing chunk read again', `if (ch.height_included !== b.header.height) continue;`, ``],
  ['K18', 'shard not learned', `if (shard !== null && ch.shard_id !== shard) continue;`, ``],
  ['K19', 'shard kept across resharding', `if (b.chunks.length !== layout) { layout = b.chunks.length; shard = null; }`, ``],
  ['K20', 'chunk hash unchecked', `if (c?.header?.chunk_hash !== ch.chunk_hash) throw`, `if (false) throw`],
  ['K21', 'any signer returned', `if (t?.signer_id !== INTENTS) continue;`, ``],
  // tx status and block time
  ['K22', 'sender ignored', `sender_account_id: senderAccountId`, `sender_account_id: INTENTS`],
  ['K23', 'not waited until final', `wait_until: 'FINAL'`, `wait_until: 'EXECUTED'`],
  ['K24', 'tx hash unchecked', `if (st?.transaction?.hash !== txHash) throw`, `if (false) throw`],
  ['K25', 'block hash unchecked', `if (b?.header?.hash !== blockHash) throw`, `if (false) throw`],
  ['K26', 'gateway errors not retried', `new Set([429, 502, 503, 504])`, `new Set([429])`],
  ['K27', 'HTTP 500 retried', `new Set([429, 502, 503, 504])`, `new Set([429, 500, 502, 503, 504])`],
  ['K28', 'HTTP 400 retried', `new Set([429, 502, 503, 504])`, `new Set([400, 429, 502, 503, 504])`],
  ['K29', 'the final error loses its reason', '`${reason} after ${maxRetries} retries`', '`after ${maxRetries} retries`'],
  ['K30', 'a transport failure loses its message', `reason = String((e as Error)?.message ?? e);`, `reason = 'transport';`],
  ['K31', 'the HTTP status is not the reason', 'reason = `HTTP ${res.status}`;', "reason = 'HTTP';"],
];

const run = (modulePath) => spawnSync(TSX, [HARNESS], {
  cwd: root, encoding: 'utf8', timeout: 120_000, env: { ...process.env, NC_MODULE: modulePath },
});

const dir = mkdtempSync(join(tmpdir(), 'nc-mutants-'));
let caught = 0;
const survived = [];
try {
  // The unmutated module, relocated the same way, must pass first, or a "caught" mutant means nothing.
  const baseFile = join(dir, 'baseline.ts');
  writeFileSync(baseFile, relocated);
  const base = run(baseFile);
  if (base.status !== 0) { console.error('baseline harness fails:\n' + base.stdout + base.stderr); process.exit(1); }

  for (const [id, what, anchor, repl] of MUTANTS) {
    const n = relocated.split(anchor).length - 1;
    if (n !== 1) { console.error(`${id} anchor occurs ${n} times, expected 1: ${anchor}`); process.exit(1); }
    const file = join(dir, `mutant-${id}.ts`);
    writeFileSync(file, relocated.replace(anchor, () => repl));
    const r = run(file);
    if (r.status !== 0) { caught++; console.log(`✓ ${id} caught: ${what}`); }
    else { survived.push(id); console.log(`✗ ${id} SURVIVED: ${what}`); }
  }
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log(`\n${caught}/${MUTANTS.length} mutants caught`);
if (survived.length) { console.log('survived: ' + survived.join(', ')); process.exit(1); }