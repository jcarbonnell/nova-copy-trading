/**
 * follower-state.ts: the follower service's FollowerState (follower-service.ts) in one directory (approved 2026-11-03).
 *
 * The payment record is what keeps a payment from being sent twice, so it gets the ledger's treatment:
 *   payment.json   { v: 1, payment }. Written atomically (0600 temp file, fsync, rename). A missing file is "no
 *                  payment"; a damaged one is REFUSED, never read as none. A record only moves forward: its listing
 *                  and idempotency key never change once saved, its correlation id and claim never change once set,
 *                  and it can be cleared only before a correlation id exists (a refusal documented as not sent).
 *   copies.jsonl   one copy record per line, appended; a damaged line is refused; a trans_id is recorded once.
 *   events.jsonl   append-only, one JSON object per line (metadata only, by the service's rule).
 *   lock           the owner's pid, taken exclusively at open: a second follower on the same state is refused (two
 *                  processes could otherwise both find no payment and both send one); a lock whose pid is no longer
 *                  running is taken over.
 * The directory is created 0700; files are 0600. All calls are serialised.
 */
import { promises as defaultFsp } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { CopyRecord, FollowerState, PaymentRecord } from '../follower/follower-service.ts';

export const PAYMENT_VERSION = 1;
type Fsp = typeof defaultFsp;
export interface FollowerStateOptions { fsp?: Fsp; isAlive?: (pid: number) => boolean }
export interface FollowerStateDir extends FollowerState { readonly path: string; close(): Promise<void> }

export class FollowerStateError extends Error {
  constructor(message: string) { super(message); this.name = 'FollowerStateError'; }
}
const fail = (m: string): never => { throw new FollowerStateError(m); };
const code = (e: unknown) => (e as NodeJS.ErrnoException)?.code;
const defaultIsAlive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e) { return code(e) === 'EPERM'; }
};
const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const HEX64 = /^[0-9a-f]{64}$/;
const nonEmpty = (x: unknown) => typeof x === 'string' && x.length > 0;

/** Why a value is not a well-formed payment record (null: it is). */
function paymentProblem(p: unknown): string | null {
  if (!isObject(p)) return 'is not an object';
  for (const k of Object.keys(p)) if (!['listingId', 'idempotencyKey', 'correlationId', 'claim'].includes(k)) return `has an unexpected field ${k}`;
  if (typeof p.listingId !== 'string' || !HEX64.test(p.listingId)) return 'has no listingId';
  if (!nonEmpty(p.idempotencyKey)) return 'has no idempotencyKey';
  if ('correlationId' in p && !nonEmpty(p.correlationId)) return 'has an empty correlationId';
  if ('claim' in p) {
    const c = p.claim;
    if (!('correlationId' in p)) return 'has a claim without a correlationId';
    if (!isObject(c) || !nonEmpty(c.intentHash) || !nonEmpty(c.payer) || !Number.isFinite(c.windowFromMs) || !Number.isFinite(c.windowToMs) ||
        Object.keys(c).length !== 4) return 'has a malformed claim';
  }
  return null;
}
function copyProblem(c: unknown): string | null {
  if (!isObject(c)) return 'is not an object';
  if (typeof c.transId !== 'string' || !HEX64.test(c.transId)) return 'has no transId';
  if (!['copied', 'refused', 'skipped'].includes(c.outcome as string)) return 'has no outcome';
  return null;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export async function openFollowerState(dir: string, options: FollowerStateOptions = {}): Promise<FollowerStateDir> {
  const fsp = options.fsp ?? defaultFsp;
  const isAlive = options.isAlive ?? defaultIsAlive;
  const root = path.resolve(dir);
  const paymentPath = path.join(root, 'payment.json');
  const copiesPath = path.join(root, 'copies.jsonl');
  const eventsPath = path.join(root, 'events.jsonl');
  const lockPath = path.join(root, 'lock');
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });

  for (let attempt = 0; ; attempt++) {
    try { await fsp.writeFile(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 }); break; } catch (e) {
      if (code(e) !== 'EEXIST' || attempt > 0) throw e;
      const pid = Number((await fsp.readFile(lockPath, 'utf8')).trim());
      if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) fail(`follower state: ${root} is held by pid ${pid}`);
      await fsp.unlink(lockPath);
    }
  }

  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const next = queue.then(() => { if (closed) fail('follower state: closed'); return f(); });
    queue = next.catch(() => {});
    return next;
  };

  async function readPayment(): Promise<PaymentRecord | null> {
    let text: string;
    try { text = await fsp.readFile(paymentPath, 'utf8'); } catch (e) {
      if (code(e) === 'ENOENT') return null;
      throw e;
    }
    let doc: any;
    try { doc = JSON.parse(text); } catch { return fail(`follower state: ${paymentPath} is not valid JSON (refusing to treat it as no payment)`); }
    if (doc?.v !== PAYMENT_VERSION) fail(`follower state: ${paymentPath} has version ${JSON.stringify(doc?.v)}, expected ${PAYMENT_VERSION}`);
    const why = paymentProblem(doc.payment);
    if (why) fail(`follower state: ${paymentPath}: the payment ${why}`);
    return doc.payment as PaymentRecord;
  }

  async function readCopies(): Promise<CopyRecord[]> {
    let text: string;
    try { text = await fsp.readFile(copiesPath, 'utf8'); } catch (e) {
      if (code(e) === 'ENOENT') return [];
      throw e;
    }
    const lines = text.split('\n');
    if (lines.at(-1) !== '') fail(`follower state: ${copiesPath} ends with an unfinished line`);
    return lines.slice(0, -1).map((line, i) => {
      let c: unknown;
      try { c = JSON.parse(line); } catch { return fail(`follower state: ${copiesPath} line ${i + 1} is not JSON`); }
      const why = copyProblem(c);
      if (why) fail(`follower state: ${copiesPath} line ${i + 1} ${why}`);
      return c as CopyRecord;
    });
  }

  return {
    path: root,
    getPayment: () => serial(readPayment),
    setPayment: (p) => serial(async () => {
      const current = await readPayment();
      if (p === null) {
        if (current?.correlationId) fail('follower state: a payment that may have been sent cannot be cleared');
        await fsp.unlink(paymentPath).catch((e) => { if (code(e) !== 'ENOENT') throw e; });
        return;
      }
      const why = paymentProblem(p);
      if (why) fail(`follower state: refusing to save a payment that ${why}`);
      if (current) {
        if (current.listingId !== p.listingId || current.idempotencyKey !== p.idempotencyKey) fail('follower state: the payment\'s listing and key cannot change');
        if (current.correlationId && current.correlationId !== p.correlationId) fail('follower state: the payment\'s correlation id cannot change');
        if (current.claim && !same(current.claim, p.claim)) fail('follower state: the payment\'s claim cannot change');
      }
      const tmp = path.join(root, `.payment.json.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
      try {
        const h = await fsp.open(tmp, 'wx', 0o600);
        try { await h.writeFile(JSON.stringify({ v: PAYMENT_VERSION, payment: p }, null, 2) + '\n', 'utf8'); await h.sync(); } finally { await h.close(); }
        await fsp.rename(tmp, paymentPath);
      } finally {
        await fsp.unlink(tmp).catch(() => {});
      }
    }),
    copies: () => serial(readCopies),
    addCopy: (c) => serial(async () => {
      const why = copyProblem(c);
      if (why) fail(`follower state: refusing to record a copy that ${why}`);
      if ((await readCopies()).some((x) => x.transId === c.transId)) fail(`follower state: entry ${c.transId.slice(0, 12)} is already recorded`);
      await fsp.appendFile(copiesPath, `${JSON.stringify(c)}\n`, { encoding: 'utf8', mode: 0o600 });
    }),
    appendEvent: (e) => serial(async () => {
      await fsp.appendFile(eventsPath, `${JSON.stringify(e)}\n`, { encoding: 'utf8', mode: 0o600 });
    }),
    close: async () => {
      await queue;
      if (closed) return;
      closed = true;
      await fsp.unlink(lockPath).catch(() => {});
    },
  };
}