// script-decider.test.ts: harness for src/seller/script-decider.ts (the seller's scripted Decider).
// Pure: scripts as strings; the last check plays a script through the real journal writer over fake dry quotes.
//
//   npx tsx test/script-decider.test.ts
//   SCRIPT_MODULE=<path> npx tsx test/script-decider.test.ts     (the mutation script)
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createJournalWriter } from '../src/seller/journal-writer.ts';

const here = dirname(fileURLToPath(import.meta.url));
const modPath = process.env.SCRIPT_MODULE ? resolve(process.env.SCRIPT_MODULE) : resolve(here, '../src/seller/script-decider.ts');
const D = await import(pathToFileURL(modPath).href);

type Json = any;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function ok(name: string, pass: boolean, detail?: unknown) {
  const d = detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ name, ok: pass, detail: d });
  console.log(`${pass ? '✓' : '✗'} ${name}${!pass && d ? ` — ${d}` : ''}`);
}
const refusal = (f: () => unknown): string => { try { f(); return 'no error'; } catch (e) { return `${(e as Error).name}: ${(e as Error).message}`; } };

const BUY = { side: 'buy', amount: '100000', reasoning: 'NEAR held its range; small entry' };
const SELL = { side: 'sell', amount: '20000000000000000000000', reasoning: 'take half off' };

// ── parsing ─────────────────────────────────────────────────────────────────────────────────
{
  const got = D.parseScript(JSON.stringify([BUY, SELL]));
  ok('C1 a valid script parses to its decisions, in order, with exactly side, amount and reasoning',
    JSON.stringify(got) === JSON.stringify([BUY, SELL]), got);
  const at280 = D.parseScript(JSON.stringify([{ ...BUY, reasoning: 'x'.repeat(280) }]));
  const hundred = D.parseScript(JSON.stringify(Array.from({ length: 100 }, () => BUY)));
  ok('C2 280 characters of reasoning and 100 decisions are accepted', at280[0].reasoning.length === 280 && hundred.length === 100 && D.MAX_SCRIPT_DECISIONS === 100);
}
{
  const cases: [string, string, string][] = [
    ['not JSON', '[{', 'script: not JSON'],
    ['an object', JSON.stringify({ decisions: [BUY] }), 'script: must be a list of 1-100 decisions'],
    ['empty', '[]', 'script: must be a list of 1-100 decisions'],
    ['101 decisions', JSON.stringify(Array.from({ length: 101 }, () => BUY)), 'script: must be a list of 1-100 decisions'],
    ['a string item', JSON.stringify([BUY, 'sell']), 'script: decision 1 is not an object'],
    ['a null item', JSON.stringify([null]), 'script: decision 0 is not an object'],
    ['a list item', JSON.stringify([[BUY]]), 'script: decision 0 is not an object'],
    ['an extra field', JSON.stringify([{ ...BUY, price: '3' }]), 'script: decision 0: unexpected field price'],
    ['side hold', JSON.stringify([BUY, { ...SELL, side: 'hold' }]), 'script: decision 1: side must be buy or sell'],
    ['no side', JSON.stringify([{ amount: '1', reasoning: 'x' }]), 'script: decision 0: side must be buy or sell'],
    ['amount as a number', JSON.stringify([{ ...BUY, amount: 100000 }]), 'script: decision 0: amount must be a positive atomic integer string'],
    ['amount 0', JSON.stringify([{ ...BUY, amount: '0' }]), 'script: decision 0: amount must be a positive atomic integer string'],
    ['amount 0.1', JSON.stringify([{ ...BUY, amount: '0.1' }]), 'script: decision 0: amount must be a positive atomic integer string'],
    ['amount 01', JSON.stringify([{ ...BUY, amount: '01' }]), 'script: decision 0: amount must be a positive atomic integer string'],
    ['no reasoning', JSON.stringify([{ ...BUY, reasoning: '' }]), 'script: decision 0: reasoning must be 1-280 characters'],
    ['reasoning of 281', JSON.stringify([{ ...BUY, reasoning: 'x'.repeat(281) }]), 'script: decision 0: reasoning must be 1-280 characters'],
    ['reasoning as a list', JSON.stringify([{ ...BUY, reasoning: ['x'] }]), 'script: decision 0: reasoning must be 1-280 characters'],
  ];
  const fails = [];
  for (const [what, json, want] of cases) {
    const m = refusal(() => D.parseScript(json));
    if (m !== `ScriptRefused: ${want}`) fails.push(`${what}: ${m}`);
  }
  ok(`C3 each bad script is refused with a message naming the decision and the rule (${cases.length} cases)`, fails.length === 0, fails);
}

// ── playing ─────────────────────────────────────────────────────────────────────────────────
{
  const src = [BUY, SELL].map((d) => ({ ...d }));
  const d = D.scriptDecider(src);
  const a = await d.next({ position: '0' });
  const r1 = d.remaining;
  const b = await d.next({ position: '0.026' });
  const c = await d.next({ position: '0' });
  const e = await d.next({ position: '0' });
  ok('P1 decisions are played once, in order; then null, and null again', JSON.stringify([a, b]) === JSON.stringify([BUY, SELL]) &&
    c === null && e === null && r1 === 1 && d.remaining === 0, { a, b, c });
  const list = [BUY, SELL].map((x) => ({ ...x }));
  const d2 = D.scriptDecider(list);
  list[0].amount = '999'; list.pop();
  const first = await d2.next({ position: '0' });
  ok('P2 the decider copies the script at creation: changing the caller\'s list afterwards changes nothing',
    JSON.stringify(first) === JSON.stringify(BUY) && d2.remaining === 1, { first, remaining: d2.remaining });
}

// ── with the journal writer ─────────────────────────────────────────────────────────────────
{
  const quotes = { swap: async (_a: string, req: Json) => ({ dry: true, warnings: [], quote: { would_succeed: true,
    amount_out: req.origin_asset.includes('17208628') ? '40000000000000000000000' : '130000' } }) };
  const nova = { upload: async (_g: string, data: Buffer) => ({ trans_id: 't', file_hash: createHash('sha256').update(data).digest('hex') }) };
  const w = createJournalWriter({ quotes, nova }, { agentId: 'seller', groupId: 'g', simulated: true });
  const d = D.scriptDecider(D.parseScript(JSON.stringify([BUY, SELL])));
  const out: string[] = [];
  for (let x = await d.next({ position: w.position() }); x; x = await d.next({ position: w.position() })) out.push((await w.write(x)).entry.side);
  ok('W1 a parsed script plays through the real journal writer: buy 0.04 NEAR, sell 0.02', out.join() === 'buy,sell' && w.position() === '0.02', { out, pos: w.position() });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log('failed:'); for (const r of failed) console.log(`  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`); process.exit(1); }