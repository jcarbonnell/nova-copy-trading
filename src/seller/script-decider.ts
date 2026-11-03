/**
 * script-decider.ts: the seller's scripted Decider (seller-service.ts), until a model decides (item 8).
 *
 * A script is a JSON list of TradeDecisions ({ side, amount, reasoning }: amount in atomic units of the asset
 * spent, as journal-writer.ts takes it). The whole script is checked before anything starts, with the writer's
 * own rules, so a typo stops the runner at start rather than mid-recording. Decisions are played once, in
 * order; then next() returns null (the seller stops trading, claims and revokes go on). Whether a sell fits the
 * position, or a trade fits the owner's per-trade limit, is decided at run time by the writer and the dry quote.
 */
import { MAX_REASONING } from '../core/journal.ts';
import type { TradeDecision } from './journal-writer.ts';
import type { Decider } from './seller-service.ts';

export const MAX_SCRIPT_DECISIONS = 100;

export class ScriptRefused extends Error {
  constructor(m: string) { super(m); this.name = 'ScriptRefused'; }
}
const refuse = (m: string): never => { throw new ScriptRefused(m); };
const ATOMIC = /^[1-9]\d*$/;
const KEYS = ['side', 'amount', 'reasoning'];

/** Parses and checks a script; refuses with the first problem, naming the decision. */
export function parseScript(json: string): TradeDecision[] {
  let doc: unknown;
  try { doc = JSON.parse(json); } catch { return refuse('script: not JSON'); }
  if (!Array.isArray(doc) || doc.length < 1 || doc.length > MAX_SCRIPT_DECISIONS) refuse(`script: must be a list of 1-${MAX_SCRIPT_DECISIONS} decisions`);
  return (doc as unknown[]).map((d, i) => {
    if (typeof d !== 'object' || d === null || Array.isArray(d)) refuse(`script: decision ${i} is not an object`);
    const o = d as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!KEYS.includes(k)) refuse(`script: decision ${i}: unexpected field ${k}`);
    if (o.side !== 'buy' && o.side !== 'sell') refuse(`script: decision ${i}: side must be buy or sell`);
    if (typeof o.amount !== 'string' || !ATOMIC.test(o.amount)) refuse(`script: decision ${i}: amount must be a positive atomic integer string`);
    if (typeof o.reasoning !== 'string' || o.reasoning.length < 1 || o.reasoning.length > MAX_REASONING) {
      refuse(`script: decision ${i}: reasoning must be 1-${MAX_REASONING} characters`);
    }
    return o as unknown as TradeDecision; // a fresh object from JSON.parse, holding exactly these fields
  });
}

/** Plays the decisions once, in order (copied at creation, so the caller's list can change freely); then null. */
export function scriptDecider(decisions: readonly TradeDecision[]): Decider & { readonly remaining: number } {
  const queue = decisions.map((d) => ({ ...d }));
  return {
    next: async () => queue.shift() ?? null,
    get remaining() { return queue.length; },
  };
}