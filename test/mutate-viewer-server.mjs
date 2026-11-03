// mutate-viewer-server.mjs: every mutant of src/viewer/server.ts must be caught by the harness.
// Same scheme as mutate-pnl.mjs: one anchored string replacement per mutant, written to a temporary directory,
// run through test/viewer-server.test.ts with VIEWER_MODULE pointing at it. The module imports nothing from the
// project, so a mutant runs from the temporary directory as is.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const MODULE = join(root, 'src/viewer/server.ts');
const HARNESS = join(root, 'test/viewer-server.test.ts');
const TSX = join(root, 'node_modules/.bin/tsx');
const src = readFileSync(MODULE, 'utf8');

/** [id, what it breaks, anchor, replacement] */
const MUTANTS = [
  ['S1', 'any host accepted', "if (!host || !hosts.has(host)) return reply(403", 'if (false) return reply(403'],
  ['S2', 'a missing host accepted', "if (!host || !hosts.has(host))", 'if (host && !hosts.has(host))'],
  ['S3', 'any port accepted', 'const hosts = new Set([`127.0.0.1:${o.port}`, `localhost:${o.port}`]);', "const hosts = { has: (h: string) => /^(127\\.0\\.0\\.1|localhost)(:\\d+)?$/.test(h) };"],
  ['S4', 'any method accepted', "if (method !== 'GET') return reply(405", 'if (false) return reply(405'],
  ['S5', 'request paths reach the filesystem', "return reply(404, 'application/json', JSON.stringify({ error: 'not found' }));",
    "try { return reply(200, 'text/plain', await fsp.readFile(path.join(root, p), 'utf8')); } catch { return reply(404, 'application/json', JSON.stringify({ error: 'not found' })); }"],
  ['S6', 'stray listing files served', '      if (!m) continue;\n', ''],
  ['S7', 'the payment served', "      hostile: { events: await lines('follower-hostile/events.jsonl', errors) },", "      hostile: { events: await lines('follower-hostile/events.jsonl', errors) }, payment: await text('follower/payment.json'),"],
  ['S8', 'bad lines dropped silently', "catch { errors.push(`${rel} line ${i + 1} is not JSON`); }", 'catch { }'],
  ['S9', 'read errors read as empty', "      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;\n      throw e;", '      return null;'],
  ['S10', 'a state error leaks its message', "JSON.stringify({ error: `state unreadable: ${(e as NodeJS.ErrnoException).code ?? 'error'}` })", 'JSON.stringify({ error: `state unreadable: ${(e as Error).message} ${root}` })'],
  ['S11', 'the feed left out', "feed: await lines('follower/feed.jsonl', errors) },", 'feed: [] },'],
  ['S12', 'every state taken as mock', "mode: path.basename(root) === 'mock' ? 'mock' : 'live',", "mode: 'mock',"],
  ['S13', 'cacheable replies', "'cache-control': 'no-store',", "'cache-control': 'max-age=60',"],
  ['S14', 'no CSP', "'content-security-policy': \"default-src 'none';", "'x-csp': \"default-src 'none';"],
  ['S15', 'framing allowed', "base-uri 'none'; form-action 'none'; frame-ancestors 'none'\"", "base-uri 'none'; form-action 'none'\""],
  ['S16', 'listening on every interface', "server.listen(o.port, '127.0.0.1', () => ok())", 'server.listen(o.port, () => ok())'],
  ['S17', 'the page served under any path', "if (p === '/' || p === '/index.html') return", 'if (true) return'],
  ['S18', 'sinceNs left out', 'sinceNs: since === null ? null : since.trim() },', 'sinceNs: null },'],
];



const run = (modulePath) => spawnSync(TSX, [HARNESS], {
  cwd: root, encoding: 'utf8', timeout: 60_000, env: { ...process.env, VIEWER_MODULE: modulePath },
});

const base = run(MODULE);
if (base.status !== 0) { console.error('baseline harness fails:\n' + base.stdout + base.stderr); process.exit(1); }

const dir = mkdtempSync(join(tmpdir(), 'viewer-mutants-'));
let caught = 0;
const survived = [];
try {
  for (const [id, what, anchor, repl] of MUTANTS) {
    const n = src.split(anchor).length - 1;
    if (n !== 1) { console.error(`${id} anchor occurs ${n} times, expected 1: ${anchor}`); process.exit(1); }
    const file = join(dir, `mutant-${id}.ts`);
    writeFileSync(file, src.replace(anchor, () => repl));
    const r = run(file);
    if (r.status !== 0) { caught++; console.log(`✓ ${id} caught: ${what}`); }
    else { survived.push(id); console.log(`✗ ${id} SURVIVED: ${what}`); }
  }
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log(`\n${caught}/${MUTANTS.length} mutants caught`);
if (survived.length) { console.log('survived: ' + survived.join(', ')); process.exit(1); }
