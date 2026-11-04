/**
 * near-chain.ts: the ChainReader verifyPayment reads the chain through, over NEAR JSON-RPC.
 *
 * Read-only: no keys, nothing signed, no indexer. Point it at an archival node: claims are checked after
 * the fact, and regular nodes keep only recent blocks. verifyPayment trusts this node's answers
 * (README, trust assumptions); the reader only checks that each reply is for what it asked
 * (block height or hash, chunk hash, transaction hash).
 *
 * The scan is the H2 observation's Q6 (src/observe/observe-withdrawal.ts), proven on mainnet on the
 * 57r1 payment: binary-search the first block at or after the window's start, then read each block's
 * new chunks until the window's end. A transaction is included in its signer's shard, so once a
 * transaction signed by intents.near is seen, only that shard's chunks are read; the learned shard is
 * forgotten when the number of shards changes (resharding).
 *
 * Public RPCs rate-limit: at most one request per `minIntervalMs`. Every call is a read, so a retry is safe:
 * HTTP 429, a gateway error (502, 503, 504), a timeout or a network failure is retried with exponential
 * backoff, up to `maxRetries` times. Every failure is a NearRpcError: an RPC failure is never a payment verdict.
 */
import { INTENTS, type ChainReader } from './verify-payment.ts';

export const GENESIS_HEIGHT = 9_820_210;
/** No mainnet block comes faster than this, so it bounds the binary search from below. */
export const MIN_BLOCK_MS = 400;
/** HTTP statuses retried like a transport failure. Any other non-2xx reply is an error at once. */
export const RETRY_STATUS = new Set([429, 502, 503, 504]);

export interface NearChainOptions {
  rpcUrl: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  minIntervalMs?: number;
  maxRetries?: number;
  timeoutMs?: number;
  genesisHeight?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class NearRpcError extends Error {
  constructor(readonly method: string, readonly reason: string) {
    super(`rpc ${method}: ${reason}`);
    this.name = 'NearRpcError';
  }
}

type Json = any;
const blockTime = (b: Json): number => Number(BigInt(b.header.timestamp_nanosec) / 1_000_000n);

export function createNearChain(o: NearChainOptions): ChainReader {
  const fetchFn = o.fetch ?? ((url, init) => fetch(url, init));
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  const minIntervalMs = o.minIntervalMs ?? 200;
  const maxRetries = o.maxRetries ?? 6;
  const timeoutMs = o.timeoutMs ?? 30_000;
  const genesis = o.genesisHeight ?? GENESIS_HEIGHT;
  let lastAt = -Infinity;

  async function rpc(method: string, params: unknown): Promise<Json> {
    for (let attempt = 0; ; attempt++) {
      const wait = lastAt + minIntervalMs - now();
      if (wait > 0) await sleep(wait);
      lastAt = now();
      let res: Response | null = null;
      let reason: string;
      try {
        res = await fetchFn(o.rpcUrl, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'nc', method, params }), signal: AbortSignal.timeout(timeoutMs),
        });
        reason = `HTTP ${res.status}`;
      } catch (e) {
        reason = String((e as Error)?.message ?? e);
      }
      if (res === null || RETRY_STATUS.has(res.status)) {
        if (attempt >= maxRetries) throw new NearRpcError(method, `${reason} after ${maxRetries} retries`);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      let body: Json;
      try { body = JSON.parse(await res.text()); } catch { throw new NearRpcError(method, `HTTP ${res.status}`); }
      if (body?.error) throw new NearRpcError(method, String(body.error.cause?.name ?? body.error.name ?? 'error'));
      if (!res.ok) throw new NearRpcError(method, `HTTP ${res.status}`);
      if (body?.result == null) throw new NearRpcError(method, 'no result');
      return body.result;
    }
  }

  /** The first existing block at or above `height` (heights can be skipped). */
  async function existingBlock(height: number): Promise<Json> {
    for (let h = height; h < height + 20; h++) {
      let b: Json;
      try { b = await rpc('block', { block_id: h }); }
      catch (e) { if (e instanceof NearRpcError && e.reason === 'UNKNOWN_BLOCK') continue; throw e; }
      if (b?.header?.height !== h) throw new NearRpcError('block', 'reply is for another block');
      return b;
    }
    throw new NearRpcError('block', `no block in [${height}, ${height + 20})`);
  }

  async function firstBlockAtOrAfter(tMs: number, head: Json): Promise<number> {
    let lo = Math.max(genesis, head.header.height - Math.ceil((blockTime(head) - tMs) / MIN_BLOCK_MS));
    let hi: number = head.header.height;
    if (blockTime(await existingBlock(lo)) >= tMs) throw new NearRpcError('scan', 'search bound is not before the window');
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const b = await existingBlock(mid);
      if (blockTime(b) < tMs) lo = b.header.height; else hi = mid;
    }
    return hi;
  }

  return {
    async scanExecuteIntents(fromMs, toMs) {
      const head = await rpc('block', { finality: 'final' });
      if (blockTime(head) < toMs) throw new NearRpcError('scan', 'window ends after the last final block');
      const out: Json[] = [];
      let shard: number | null = null;
      let layout: number | null = null;
      for (let h = await firstBlockAtOrAfter(fromMs, head); h <= head.header.height; ) {
        const b = await existingBlock(h);
        if (blockTime(b) > toMs) break;
        if (b.chunks.length !== layout) { layout = b.chunks.length; shard = null; }
        for (const ch of b.chunks) {
          if (ch.height_included !== b.header.height) continue; // missing chunk: the header repeats an older one
          if (shard !== null && ch.shard_id !== shard) continue;
          const c = await rpc('chunk', { chunk_id: ch.chunk_hash });
          if (c?.header?.chunk_hash !== ch.chunk_hash) throw new NearRpcError('chunk', 'reply is for another chunk');
          for (const t of c.transactions ?? []) {
            if (t?.signer_id !== INTENTS) continue;
            shard = ch.shard_id;
            out.push(t);
          }
        }
        h = b.header.height + 1;
      }
      return out;
    },

    async txStatus(txHash, senderAccountId) {
      const st = await rpc('EXPERIMENTAL_tx_status', { tx_hash: txHash, sender_account_id: senderAccountId, wait_until: 'FINAL' });
      if (st?.transaction?.hash !== txHash) throw new NearRpcError('EXPERIMENTAL_tx_status', 'reply is for another transaction');
      return st;
    },

    async blockTimeMs(blockHash) {
      const b = await rpc('block', { block_id: blockHash });
      if (b?.header?.hash !== blockHash) throw new NearRpcError('block', 'reply is for another block');
      return blockTime(b);
    },
  };
}