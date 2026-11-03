/**
 * The cheap half of automations that runs inside emit(): decides whether any
 * enabled automation listens to an event and, if so, queues an
 * `automation.events` job. Matching, conditions and runs happen in that job
 * (src/server/lib/automations.ts), so a write never waits for them.
 */
import type {Db} from '../kit/db';
import {automationOf} from './automation-context';
import {enqueue} from './jobs';

type Interest = {types: Set<string>; at: number};

// Per isolate; automation writes in this isolate clear it, others pick changes up within the TTL.
let interest: Interest | null = null;
const TTL_MS = 15_000;

export function invalidateAutomationInterest() {
  interest = null;
}

async function load(db: Db) {
  if (interest && Date.now() - interest.at < TTL_MS) return interest.types;
  const rows = await db.automation.findMany({where: {enabled: true, triggerKind: 'event', triggerEvent: {not: null}}, select: {triggerEvent: true}});
  interest = {types: new Set(rows.map((r) => r.triggerEvent!)), at: Date.now()};
  return interest.types;
}

/**
 * Queues matching for the events an enabled automation listens to. Events
 * written by an automation step carry that run's chain (depth, chain id) so
 * the runs they start can be stopped at the chain limit. Returns true when a
 * job was queued (the caller kicks the runner). Never throws.
 */
export async function queueAutomations(db: Db, events: {id: string; type: string}[]) {
  try {
    if (!events.length) return false;
    const types = await load(db);
    const ids = events.filter((e) => types.has(e.type)).map((e) => e.id);
    if (!ids.length) return false;
    const auto = automationOf(db);
    const origin = auto ? {automationId: auto.automationId, runId: auto.runId, chainId: auto.chainId, depth: auto.depth} : null;
    for (let k = 0; k < ids.length; k += 50) await enqueue(db, 'automation.events', {eventIds: ids.slice(k, k + 50), origin});
    return true;
  } catch (e) {
    console.error('[automations]', String((e as Error)?.message ?? e).slice(0, 200));
    return false;
  }
}
