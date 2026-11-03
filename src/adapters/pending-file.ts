/**
 * pending-file.ts: the seller's one in-flight NOVA write (nova-agent-connect PendingStore) as one JSON file.
 *
 * agentConnectSigner saves the call BEFORE sending it and clears it once the outcome is final; after a crash,
 * resolvePending() settles the saved call under the same idempotency key. Losing it, or reading a damaged file
 * as "nothing pending", could send a NOVA write twice. So:
 *   - a missing file is "nothing pending"; a file that does not parse, has another version, or does not hold a
 *     well-formed call is REFUSED, never treated as empty;
 *   - a save goes to a temporary file in the same directory (mode 0600), is fsynced, then renamed over the store:
 *     a crash leaves the old call or the new one, never a mix; a failed save removes its temp file;
 *   - a call that is not well-formed is refused before anything is written;
 *   - load, save and clear are serialised; load reads the file each time and returns a fresh object.
 * The call holds no secret (its args are public on chain once sent). A second runner is kept off by the ledger's
 * lock (ledger-file.ts), which the runner takes first.
 */
import { promises as defaultFsp } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { PendingNativeCall, PendingStore } from '../vendor/nova-agent-connect.ts';

export const PENDING_VERSION = 1;

type Fsp = typeof defaultFsp;
export interface FilePendingStore extends PendingStore { readonly path: string }

export class PendingStoreError extends Error {
  constructor(message: string) { super(message); this.name = 'PendingStoreError'; }
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const UINT = /^(0|[1-9]\d*)$/;
const CALL_KEYS = ['idempotencyKey', 'body', 'correlationId', 'savedAt'];
const BODY_KEYS = ['receiver_id', 'method_name', 'args', 'gas', 'deposit'];

/** Why a value is not a well-formed pending call (null: it is). */
function problem(p: unknown): string | null {
  if (!isObject(p)) return 'is not an object';
  for (const k of Object.keys(p)) if (!CALL_KEYS.includes(k)) return `has an unexpected field ${k}`;
  if (typeof p.idempotencyKey !== 'string' || p.idempotencyKey.length === 0) return 'has no idempotencyKey';
  if (typeof p.savedAt !== 'string' || p.savedAt.length === 0) return 'has no savedAt';
  if ('correlationId' in p && (typeof p.correlationId !== 'string' || p.correlationId.length === 0)) return 'has an empty correlationId';
  const b = p.body;
  if (!isObject(b)) return 'has no body';
  for (const k of Object.keys(b)) if (!BODY_KEYS.includes(k)) return `has an unexpected body field ${k}`;
  if (typeof b.receiver_id !== 'string' || b.receiver_id.length === 0) return 'has no body.receiver_id';
  if (typeof b.method_name !== 'string' || b.method_name.length === 0) return 'has no body.method_name';
  if (!isObject(b.args)) return 'has no body.args object';
  if (typeof b.gas !== 'string' || !UINT.test(b.gas)) return 'has no body.gas integer string';
  if (typeof b.deposit !== 'string' || !UINT.test(b.deposit)) return 'has no body.deposit integer string';
  return null;
}

export function filePendingStore(file: string, options: { fsp?: Fsp } = {}): FilePendingStore {
  const fsp = options.fsp ?? defaultFsp;
  const storePath = path.resolve(file);

  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const next = queue.then(f, f);
    queue = next.catch(() => {});
    return next;
  };

  return {
    path: storePath,
    load: () => serial(async () => {
      let text: string;
      try { text = await fsp.readFile(storePath, 'utf8'); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
      let doc: any;
      try { doc = JSON.parse(text); } catch { throw new PendingStoreError(`pending: ${storePath} is not valid JSON (refusing to treat it as empty)`); }
      if (doc?.v !== PENDING_VERSION) throw new PendingStoreError(`pending: ${storePath} has version ${JSON.stringify(doc?.v)}, expected ${PENDING_VERSION}`);
      const why = problem(doc.pending);
      if (why) throw new PendingStoreError(`pending: ${storePath}: the saved call ${why}`);
      return doc.pending as PendingNativeCall;
    }),
    save: (pending) => serial(async () => {
      const why = problem(pending);
      if (why) throw new PendingStoreError(`pending: refusing to save a call that ${why}`);
      const tmp = path.join(path.dirname(storePath), `.${path.basename(storePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
      const body = JSON.stringify({ v: PENDING_VERSION, pending }, null, 2) + '\n';
      try {
        const h = await fsp.open(tmp, 'w', 0o600);
        try { await h.writeFile(body, 'utf8'); await h.sync(); } finally { await h.close(); }
        await fsp.rename(tmp, storePath);
      } catch (e) {
        await fsp.unlink(tmp).catch(() => {});
        throw e;
      }
    }),
    clear: () => serial(async () => {
      try { await fsp.unlink(storePath); } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }),
  };
}