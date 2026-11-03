/**
 * state-dir.ts: the seller service's StateStore (seller-service.ts) in one directory (approved 2026-11-03).
 *
 *   since-ns         the record time of the first journal entry: every listing starts there. Written once,
 *                    atomically (0600 temp file, fsync, rename); setting it again to the same value is a no-op,
 *                    to another value is refused. A damaged file is refused, never read as "no journal yet".
 *   listings/<id>.json  each published listing, content-addressed: the file's SHA-256 must be its id. Created
 *                    exclusively (temp file, fsync, hard link to the final name), never overwritten; the same
 *                    listing saved again is a no-op. Any other file there is refused at load (temp files aside).
 *   events.jsonl     append-only, one JSON object per line (metadata only, by the service's rule).
 * The directory and listings/ are created 0700; files are 0600. All calls are serialised.
 */
import { promises as defaultFsp } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { StateStore } from '../seller/seller-service.ts';

type Fsp = typeof defaultFsp;
export interface StateDir extends StateStore { readonly path: string }

export class StateError extends Error {
  constructor(message: string) { super(message); this.name = 'StateError'; }
}
const fail = (m: string): never => { throw new StateError(m); };

const NS = /^(0|[1-9]\d*)$/;
const HEX64 = /^[0-9a-f]{64}$/;
const LISTING_FILE = /^([0-9a-f]{64})\.json$/;
const TEMP_FILE = /^\..*\.tmp$/;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const code = (e: unknown) => (e as NodeJS.ErrnoException)?.code;

export async function openStateDir(dir: string, options: { fsp?: Fsp } = {}): Promise<StateDir> {
  const fsp = options.fsp ?? defaultFsp;
  const root = path.resolve(dir);
  const listings = path.join(root, 'listings');
  const sincePath = path.join(root, 'since-ns');
  const eventsPath = path.join(root, 'events.jsonl');
  await fsp.mkdir(listings, { recursive: true, mode: 0o700 });

  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const next = queue.then(f, f);
    queue = next.catch(() => {});
    return next;
  };

  /** Writes `body` to a fsynced 0600 temp file next to `target`, then hands it to `place`. */
  async function viaTemp(target: string, body: string, place: (tmp: string) => Promise<void>) {
    const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      const h = await fsp.open(tmp, 'wx', 0o600);
      try { await h.writeFile(body, 'utf8'); await h.sync(); } finally { await h.close(); }
      await place(tmp);
    } finally {
      await fsp.unlink(tmp).catch(() => {});
    }
  }

  async function readSince(): Promise<string | null> {
    let text: string;
    try { text = await fsp.readFile(sincePath, 'utf8'); } catch (e) {
      if (code(e) === 'ENOENT') return null;
      throw e;
    }
    const v = text.endsWith('\n') ? text.slice(0, -1) : text;
    if (!NS.test(v)) fail(`state: ${sincePath} does not hold a ns time (refusing to treat it as empty)`);
    return v;
  }

  return {
    path: root,
    getSinceNs: () => serial(readSince),
    setSinceNs: (ns) => serial(async () => {
      if (typeof ns !== 'string' || !NS.test(ns)) fail('state: sinceNs must be a ns decimal string');
      const current = await readSince();
      if (current === ns) return;
      if (current !== null) fail(`state: sinceNs is already ${current}; refusing to change it`);
      await viaTemp(sincePath, `${ns}\n`, (tmp) => fsp.rename(tmp, sincePath));
    }),
    saveListing: (id, json) => serial(async () => {
      if (typeof id !== 'string' || !HEX64.test(id)) fail('state: a listing id must be 64 lowercase hex');
      if (typeof json !== 'string' || sha(json) !== id) fail(`state: listing ${id.slice(0, 12)}: its content does not hash to its id`);
      const target = path.join(listings, `${id}.json`);
      await viaTemp(target, json, async (tmp) => {
        try { await fsp.link(tmp, target); } catch (e) {
          if (code(e) !== 'EEXIST') throw e;
          if ((await fsp.readFile(target, 'utf8')) !== json) fail(`state: ${target} already holds other content`);
        }
      });
    }),
    loadListings: () => serial(async () => {
      const out: { id: string; json: string }[] = [];
      for (const name of (await fsp.readdir(listings)).sort()) {
        if (TEMP_FILE.test(name)) continue;
        const m = LISTING_FILE.exec(name);
        if (!m) fail(`state: unexpected file ${path.join(listings, name)}`);
        out.push({ id: m![1], json: await fsp.readFile(path.join(listings, name), 'utf8') });
      }
      return out;
    }),
    appendEvent: (e) => serial(async () => {
      await fsp.appendFile(eventsPath, `${JSON.stringify(e)}\n`, { encoding: 'utf8', mode: 0o600 });
    }),
  };
}