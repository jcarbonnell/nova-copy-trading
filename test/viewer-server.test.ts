// viewer-server.test.ts: harness for src/viewer/server.ts (the viewer's read-only server on 127.0.0.1).
// Real files in a fresh temporary state directory, laid out as the seller and follower write them, plus files the
// server must never serve (payment, ledger, pending store, locks). The handler is called directly; the last checks
// go through a real listening server.
//
//   npx tsx test/viewer-server.test.ts
//   VIEWER_MODULE=<path> npx tsx test/viewer-server.test.ts     (the mutation script)
import { promises as fsp, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const modPath = process.env.VIEWER_MODULE ? resolve(process.env.VIEWER_MODULE) : resolve(here, '../src/viewer/server.ts');
const V = await import(pathToFileURL(modPath).href);

type Json = any;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function ok(name: string, pass: boolean, detail?: unknown) {
  const d = detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ name, ok: pass, detail: d });
  console.log(`${pass ? '✓' : '✗'} ${name}${!pass && d ? ` — ${d}` : ''}`);
}

const SECRETS = ['PAYMENT-SECRET', 'LEDGER-SECRET', 'PENDING-SECRET', 'LOCK-SECRET', 'NOTES-SECRET', 'STRAY-SECRET'];
function stateDir(name = 'mock') {
  const base = mkdtempSync(join(tmpdir(), 'viewer-'));
  const root = join(base, name);
  const w = (rel: string, body: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
  const id = 'ab'.repeat(32);
  w('seller/events.jsonl', '{"at":1,"kind":"entry_written"}\n{"at":2,"kind":"listing_published"}\n');
  w('seller/since-ns', '1760868000000000000\n');
  w(`seller/listings/${id}.json`, JSON.stringify({ v: 1, price: '100000' }));
  w('seller/listings/.x.tmp', 'STRAY-SECRET');
  w('seller/listings/notes.txt', 'NOTES-SECRET');
  w('seller/ledger.json', 'LEDGER-SECRET');
  w('seller/ledger.json.lock', 'LOCK-SECRET');
  w('seller/pending.json', 'PENDING-SECRET');
  w('follower/events.jsonl', '{"at":3,"kind":"feed_verified"}\n');
  w('follower/copies.jsonl', '{"transId":"t","outcome":"copied"}\n');
  w('follower/feed.jsonl', '{"transId":"t","recordNs":"1","entry":{"reasoning":"bought"}}\n');
  w('follower/payment.json', 'PAYMENT-SECRET');
  w('follower/lock', 'LOCK-SECRET');
  w('follower-hostile/events.jsonl', '{"at":0,"kind":"payment_refused_by_policy"}\n');
  return { base, root, id };
}
const PAGE = '<!doctype html><title>viewer</title>';
const PORT = 8790;
const H = `127.0.0.1:${PORT}`;

// ── /api/state ──────────────────────────────────────────────────────────────────────────────
{
  const { base, root, id } = stateDir();
  const handle = V.viewerHandler({ stateDir: root, page: PAGE, port: PORT });
  const r = await handle('GET', '/api/state', H);
  const s = JSON.parse(r.body);
  ok('V1 /api/state assembles the seller\'s events, listings and sinceNs, the follower\'s events, copies and feed, and mock mode\'s hostile events',
    r.status === 200 && r.headers['content-type'] === 'application/json' && s.mode === 'mock' && s.seller.events.length === 2 && s.seller.sinceNs === '1760868000000000000' &&
    s.seller.listings.length === 1 && s.seller.listings[0].id === id && s.seller.listings[0].listing.price === '100000' &&
    s.follower.events[0].kind === 'feed_verified' && s.follower.copies.length === 1 && s.follower.feed[0].entry.reasoning === 'bought' &&
    s.hostile.events[0].kind === 'payment_refused_by_policy' && s.errors.length === 0, s);
  ok('V2 it never serves the payment, the ledger, the pending store, a lock, or a stray file in listings/', SECRETS.every((x) => !r.body.includes(x)), r.body.slice(0, 200));
  writeFileSync(join(root, 'follower/copies.jsonl'), '{"transId":"t","outcome":"copied"}\nnot json\n');
  const r2 = JSON.parse((await handle('GET', '/api/state', H)).body);
  ok('V3 a line that does not parse is reported in errors, never dropped silently', r2.follower.copies.length === 1 &&
    JSON.stringify(r2.errors) === JSON.stringify(['follower/copies.jsonl line 2 is not JSON']), r2.errors);
  rmSync(base, { recursive: true, force: true });
}
{
  const base = mkdtempSync(join(tmpdir(), 'viewer-'));
  const root = join(base, 'state');
  const s = JSON.parse((await V.viewerHandler({ stateDir: root, page: PAGE, port: PORT })('GET', '/api/state', H)).body);
  ok('V4 an empty or missing state is an empty document, and a directory not named mock is a live run',
    s.mode === 'live' && s.seller.events.length === 0 && s.seller.listings.length === 0 && s.seller.sinceNs === null && s.follower.feed.length === 0 && s.errors.length === 0, s);
  const denied = { ...fsp, readFile: async () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } };
  const r = await V.viewerHandler({ stateDir: root, page: PAGE, port: PORT, fsp: denied as Json })('GET', '/api/state', H);
  ok('V5 a state it cannot read is a 500 naming only the error code (no path, no content)', r.status === 500 && r.body === '{"error":"state unreadable: EACCES"}', r.body);
  rmSync(base, { recursive: true, force: true });
}

// ── routes, methods, hosts, headers ─────────────────────────────────────────────────────────
{
  const { base, root } = stateDir();
  const handle = V.viewerHandler({ stateDir: root, page: PAGE, port: PORT });
  const page = await handle('GET', '/', H);
  const page2 = await handle('GET', '/index.html?x=1', 'localhost:8790');
  ok('R1 GET / and /index.html serve the page as HTML, on 127.0.0.1 or localhost at this port', page.status === 200 && page.body === PAGE &&
    page.headers['content-type'] === 'text/html; charset=utf-8' && page2.status === 200);
  const paths = ['/seller/ledger.json', '/follower/payment.json', '/../follower/payment.json', '/%2e%2e/follower/payment.json', '/api/state/../../x', '/api', '/viewer/index.html', '/state'];
  const r404 = await Promise.all(paths.map((p) => handle('GET', p, H)));
  ok('R2 every other path is 404, traversal attempts included, and none of them reads a file', r404.every((r: Json) => r.status === 404 && !SECRETS.some((x) => r.body.includes(x))),
    r404.map((r: Json) => r.status));
  const r405 = await Promise.all(['POST', 'PUT', 'DELETE', 'PATCH'].map((m) => handle(m, '/api/state', H)));
  ok('R3 every other method is 405', r405.every((r: Json) => r.status === 405));
  const r403 = await Promise.all(['evil.example:8790', '127.0.0.1:9999', '127.0.0.1', undefined, '0.0.0.0:8790'].map((h) => handle('GET', '/api/state', h)));
  ok('R4 a request for another host (DNS rebinding), another port or no host is 403 and reads nothing', r403.every((r: Json) => r.status === 403 && !r.body.includes('feed')),
    r403.map((r: Json) => r.status));
  ok('R5 every reply says no-store, nosniff, no referrer, and a CSP that allows only this page\'s own requests',
    [page, r404[0], r405[0], r403[0]].every((r: Json) => r.headers['cache-control'] === 'no-store' && r.headers['x-content-type-options'] === 'nosniff' &&
      r.headers['referrer-policy'] === 'no-referrer' && r.headers['content-security-policy'].includes("default-src 'none'") &&
      r.headers['content-security-policy'].includes("connect-src 'self'") && r.headers['content-security-policy'].includes("frame-ancestors 'none'")));
  rmSync(base, { recursive: true, force: true });
}

// ── a real server ───────────────────────────────────────────────────────────────────────────
{
  const { base, root } = stateDir();
  const port = 18790 + Math.floor(Math.random() * 1000);
  const server = await V.startViewer({ stateDir: root, page: PAGE, port });
  const addr = server.address() as Json;
  const get = (p: string) => new Promise<{ status: number; body: string }>((ok2) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => ok2({ status: res.statusCode!, body: b })); });
  });
  const st = await get('/api/state');
  ok('L1 the server listens on 127.0.0.1 only and answers /api/state', addr.address === '127.0.0.1' && addr.port === port && st.status === 200 && JSON.parse(st.body).seller.events.length === 2, addr);
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(base, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log('failed:'); for (const r of failed) console.log(`  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`); process.exit(1); }