/**
 * ledger-file.ts: the seller's admissions ledger (membership.ts LedgerStore) as one JSON file.
 *
 * The ledger is also verifyPayment's used-intent store: losing it would let a payment be claimed twice. So:
 *   - a ledger that does not parse, has another version, or holds a record under another key is REFUSED,
 *     never treated as empty;
 *   - every write goes to a temporary file in the same directory (mode 0600), is fsynced, then renamed over the
 *     ledger: a crash leaves the old ledger or the new one, never a mix; a failed write removes its temp file;
 *   - writes within the process are serialised;
 *   - a lock file (<ledger>.lock, holding the owner's pid) keeps a second runner off the same ledger; a lock
 *     whose pid is no longer running is taken over.
 * Records are returned as copies: changing one never changes the ledger.
 */
import { promises as defaultFsp } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AdmissionRecord, LedgerStore } from '../core/membership.ts';

export const LEDGER_VERSION = 1;

type Fsp = typeof defaultFsp;
export interface LedgerOptions {
  /** fs/promises, replaceable in tests. */
  fsp?: Fsp;
  /** Whether a pid is running (process.kill(pid, 0)); replaceable in tests. */
  isAlive?: (pid: number) => boolean;
}

export interface FileLedger extends LedgerStore {
  readonly path: string;
  close(): Promise<void>;
}

export class LedgerError extends Error {
  constructor(message: string) { super(message); this.name = 'LedgerError'; }
}

const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const defaultIsAlive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

function parse(file: string, text: string): Map<string, AdmissionRecord> {
  let doc: any;
  try { doc = JSON.parse(text); } catch { throw new LedgerError(`ledger: ${file} is not valid JSON (refusing to treat it as empty)`); }
  if (doc?.v !== LEDGER_VERSION) throw new LedgerError(`ledger: ${file} has version ${JSON.stringify(doc?.v)}, expected ${LEDGER_VERSION}`);
  if (typeof doc.records !== 'object' || doc.records === null || Array.isArray(doc.records)) {
    throw new LedgerError(`ledger: ${file} has no records object`);
  }
  const out = new Map<string, AdmissionRecord>();
  for (const [key, r] of Object.entries(doc.records as Record<string, any>)) {
    if (r?.intentHash !== key) throw new LedgerError(`ledger: ${file} holds a record under ${key} whose intentHash is ${JSON.stringify(r?.intentHash)}`);
    out.set(key, r);
  }
  return out;
}

export async function openLedger(file: string, options: LedgerOptions = {}): Promise<FileLedger> {
  const fsp = options.fsp ?? defaultFsp;
  const isAlive = options.isAlive ?? defaultIsAlive;
  const ledgerPath = path.resolve(file);
  const lockPath = `${ledgerPath}.lock`;

  // Take the lock: create it exclusively; if it exists and its pid still runs, refuse; otherwise take it over.
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.writeFile(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) throw e;
      const pid = Number((await fsp.readFile(lockPath, 'utf8')).trim());
      if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) throw new LedgerError(`ledger: ${ledgerPath} is held by pid ${pid}`);
      await fsp.unlink(lockPath);
    }
  }

  let records: Map<string, AdmissionRecord>;
  try {
    records = parse(ledgerPath, await fsp.readFile(ledgerPath, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') records = new Map();
    else { await fsp.unlink(lockPath).catch(() => {}); throw e; }
  }

  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const next = queue.then(f, f);
    queue = next.catch(() => {});
    return next;
  };

  async function persist(next: Map<string, AdmissionRecord>) {
    const tmp = path.join(path.dirname(ledgerPath), `.${path.basename(ledgerPath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    const body = JSON.stringify({ v: LEDGER_VERSION, records: Object.fromEntries(next) }, null, 2) + '\n';
    try {
      const h = await fsp.open(tmp, 'w', 0o600);
      try { await h.writeFile(body, 'utf8'); await h.sync(); } finally { await h.close(); }
      await fsp.rename(tmp, ledgerPath);
    } catch (e) {
      await fsp.unlink(tmp).catch(() => {});
      throw e;
    }
  }

  const live = () => { if (closed) throw new LedgerError('ledger: closed'); };
  return {
    path: ledgerPath,
    get: async (intentHash) => { live(); const r = records.get(intentHash); return r ? copy(r) : undefined; },
    all: async () => { live(); return [...records.values()].map(copy); },
    put: (record) => serial(async () => {
      live();
      if (typeof record?.intentHash !== 'string' || record.intentHash.length === 0) throw new LedgerError('ledger: a record needs an intentHash');
      const next = new Map(records);
      next.set(record.intentHash, copy(record));
      await persist(next);
      records = next;            // only once the file holds it
    }),
    close: () => serial(async () => {
      if (closed) return;
      closed = true;
      await fsp.unlink(lockPath).catch(() => {});
    }),
  };
}