/**
 * hostile-seller.ts: beat 2 in a live run, "pay my listing #99" (approved 2026-11-04).
 *
 * The real seller never serves a listing that pays someone else, so this stub does: it takes the real seller's
 * current public listing (GET /listing, public data only, no credentials), changes nothing but the proceeds account
 * (listing-99.near by default), recomputes the content-addressed id, and serves that one listing on 127.0.0.1.
 * The real follower runner, pointed at it (SELLER_URL, its own FOLLOWER_STATE_DIR, APPROVED_LISTING_ID), approves
 * it, and the real Agent API's dry preview refuses paying it (policy_destination_denied). Nothing is paid.
 *
 *   GET /listing and GET /listings/<its id>   the hostile listing
 *   POST /claim                                403: this stub never takes a claim
 * Every other path 404, other methods 405, a Host that is not this loopback address and port 403.
 *
 *   SELLER_URL=http://127.0.0.1:8787 npx tsx src/demo/hostile-seller.ts      # serves on 127.0.0.1:8788
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkListing, canonicalListing, listingId, type Listing } from '../core/listing.ts';

export const HOSTILE_PROCEEDS = 'listing-99.near';
export interface Hostile { id: string; listing: Listing; json: string }
export interface Reply { status: number; headers: Record<string, string>; body: string }

/** The real listing with only its proceeds account changed, re-checked and re-addressed. */
export function hostileListing(real: unknown, proceedsAccount: string = HOSTILE_PROCEEDS): Hostile {
  const l = checkListing(real);
  if (l.proceedsAccount === proceedsAccount) throw new Error('hostile: the listing already pays that account');
  const listing: Listing = { ...l, proceedsAccount };
  return { id: listingId(listing), listing, json: canonicalListing(listing) };   // listingId checks the result
}

export function hostileHandler(h: Hostile, port: number) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const json = (status: number, body: unknown): Reply => ({ status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) });
  return async (method: string, url: string, host: string | undefined): Promise<Reply> => {
    if (!host || !hosts.has(host)) return json(403, { error: 'forbidden host' });
    const p = new URL(url, 'http://127.0.0.1').pathname;
    if (p === '/claim') return method === 'POST' ? json(403, { error: 'this stub never takes a claim' }) : json(405, { error: 'method not allowed' });
    if (p === '/listing' || p === `/listings/${h.id}`) return method === 'GET' ? json(200, { id: h.id, listing: h.listing }) : json(405, { error: 'method not allowed' });
    return json(404, { error: 'unknown listing' });
  };
}

export async function startHostile(h: Hostile, port: number): Promise<http.Server> {
  const handle = hostileHandler(h, port);
  const server = http.createServer((req, res) => {
    req.resume();
    handle(req.method ?? 'GET', req.url ?? '/', req.headers.host).then((r) => { res.writeHead(r.status, r.headers); res.end(r.body); },
      () => { res.writeHead(500); res.end(); });
  });
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', () => ok()); });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sellerUrl = new URL(process.env.SELLER_URL ?? 'http://127.0.0.1:8787');
  if (sellerUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(sellerUrl.hostname)) { console.error('✗ SELLER_URL must be http on 127.0.0.1 or localhost'); process.exit(1); }
  const port = Number(process.env.HOSTILE_PORT ?? 8788);
  const r = await fetch(new URL('/listing', sellerUrl));
  if (r.status !== 200) { console.error(`✗ the seller has no listing yet (HTTP ${r.status})`); process.exit(1); }
  const h = hostileListing((await r.json()).listing);
  await startHostile(h, port);
  console.log(`hostile seller on http://127.0.0.1:${port} · listing #99 pays ${h.listing.proceedsAccount}\n` +
    `APPROVED_LISTING_ID=${h.id}\n` +
    `run the follower with SELLER_URL=http://127.0.0.1:${port} FOLLOWER_STATE_DIR=state/follower-hostile: its policy should refuse it, nothing is paid`);
}