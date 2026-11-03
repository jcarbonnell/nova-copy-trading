/**
 * server.ts: the standalone viewer's server (approved 2026-11-03). Read-only, on 127.0.0.1 only.
 *
 *   GET /            the page (viewer/index.html)
 *   GET /api/state   one JSON document assembled from FIXED file names in the state directory:
 *                      seller/events.jsonl, seller/since-ns, seller/listings/<64 hex>.json,
 *                      follower/events.jsonl, follower/copies.jsonl, follower/feed.jsonl (the follower's own bought
 *                      entries, option A), follower-hostile/events.jsonl (mock mode's beat 2).
 * Nothing else: no request path reaches the filesystem; payment.json, the ledger, the pending store and the locks
 * are never read. It never writes, signs or calls out. Every other method is 405, every other path 404, and a
 * request whose Host is not this loopback address and port is 403 (a page from another site cannot read the feed
 * through DNS rebinding). Lines that do not parse are reported in `errors`, never dropped silently.
 *
 *   npm run viewer                         # state/mock, http://127.0.0.1:8790
 *   VIEWER_STATE=state npm run viewer      # a live run's state/seller and state/follower
 */
import { promises as defaultFsp } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Fsp = typeof defaultFsp;
export interface ViewerOptions { stateDir: string; page: string; port: number; fsp?: Fsp }
export interface ViewerReply { status: number; headers: Record<string, string>; body: string }

const LISTING_FILE = /^([0-9a-f]{64})\.json$/;
const HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export function viewerHandler(o: ViewerOptions) {
  const fsp = o.fsp ?? defaultFsp;
  const root = path.resolve(o.stateDir);
  const hosts = new Set([`127.0.0.1:${o.port}`, `localhost:${o.port}`]);

  async function text(rel: string): Promise<string | null> {
    try { return await fsp.readFile(path.join(root, rel), 'utf8'); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
  async function lines(rel: string, errors: string[]): Promise<unknown[]> {
    const t = await text(rel);
    if (t === null) return [];
    const out: unknown[] = [];
    t.split('\n').forEach((l, i) => {
      if (l === '') return;
      try { out.push(JSON.parse(l)); } catch { errors.push(`${rel} line ${i + 1} is not JSON`); }
    });
    return out;
  }
  async function listings(errors: string[]) {
    let names: string[];
    try { names = await fsp.readdir(path.join(root, 'seller/listings')); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const out: { id: string; listing: unknown }[] = [];
    for (const name of names.sort()) {
      const m = LISTING_FILE.exec(name);
      if (!m) continue;
      try { out.push({ id: m[1], listing: JSON.parse((await text(`seller/listings/${name}`)) ?? 'null') }); } catch { errors.push(`seller/listings/${name} is not JSON`); }
    }
    return out;
  }

  async function state() {
    const errors: string[] = [];
    const since = await text('seller/since-ns');
    return {
      mode: path.basename(root) === 'mock' ? 'mock' : 'live',
      seller: { events: await lines('seller/events.jsonl', errors), listings: await listings(errors), sinceNs: since === null ? null : since.trim() },
      follower: { events: await lines('follower/events.jsonl', errors), copies: await lines('follower/copies.jsonl', errors), feed: await lines('follower/feed.jsonl', errors) },
      hostile: { events: await lines('follower-hostile/events.jsonl', errors) },
      errors,
    };
  }

  return async function handle(method: string, url: string, host: string | undefined): Promise<ViewerReply> {
    const reply = (status: number, type: string, body: string): ViewerReply => ({ status, headers: { ...HEADERS, 'content-type': type }, body });
    if (!host || !hosts.has(host)) return reply(403, 'application/json', JSON.stringify({ error: 'forbidden host' }));
    if (method !== 'GET') return reply(405, 'application/json', JSON.stringify({ error: 'method not allowed' }));
    const p = new URL(url, 'http://127.0.0.1').pathname;
    if (p === '/' || p === '/index.html') return reply(200, 'text/html; charset=utf-8', o.page);
    if (p === '/api/state') {
      try { return reply(200, 'application/json', JSON.stringify(await state())); } catch (e) {
        return reply(500, 'application/json', JSON.stringify({ error: `state unreadable: ${(e as NodeJS.ErrnoException).code ?? 'error'}` }));
      }
    }
    return reply(404, 'application/json', JSON.stringify({ error: 'not found' }));
  };
}

/** Listens on 127.0.0.1 only. */
export async function startViewer(o: ViewerOptions): Promise<http.Server> {
  const handle = viewerHandler(o);
  const server = http.createServer((req, res) => {
    handle(req.method ?? 'GET', req.url ?? '/', req.headers.host).then((r) => { res.writeHead(r.status, r.headers); res.end(r.body); },
      () => { res.writeHead(500); res.end(); });
  });
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(o.port, '127.0.0.1', () => ok()); });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const port = Number(process.env.VIEWER_PORT ?? 8790);
  if (!Number.isSafeInteger(port) || port < 1) { console.error('✗ VIEWER_PORT must be a port number'); process.exit(1); }
  const stateDir = path.resolve(process.env.VIEWER_STATE ?? path.join(repo, 'state/mock'));
  const page = await defaultFsp.readFile(path.join(repo, 'viewer/index.html'), 'utf8');
  await startViewer({ stateDir, page, port });
  console.log(`viewer on http://127.0.0.1:${port} · state ${stateDir} · read-only · technical demo, not investment advice`);
}