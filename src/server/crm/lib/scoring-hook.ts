/**
 * The cheap half of lead scoring that runs inside emit(): decides whether an
 * event matters to any scoring rule and, if so, queues a `scoring.events` job.
 * The scoring itself happens in that job (src/server/lib/scoring.ts), so a
 * write never waits for it and a failure retries with backoff.
 */
import type {Db} from '../kit/db';
import {enqueue, kickJobs} from './jobs';

/**
 * Events that can change whether a contact matches a property rule. With any
 * property rule switched on, the contacts behind these are re-evaluated right
 * away; everything else (time passing, bulk edits without events) is caught by
 * the periodic recompute in /jobs/run.
 */
export const RESCORE_EVENTS = new Set<string>([
  'contact.created',
  'contact.updated',
  'contact.merged',
  'company.updated',
  'company.merged',
  'deal.created',
  'deal.updated',
  'deal.stage_changed',
  'deal.won',
  'deal.lost',
  'form.submitted',
  'list.member_added',
  'list.member_removed',
  'ticket.created',
  'meeting.booked',
  'meeting.canceled',
  'interaction.logged',
  'email.received',
  'email.opened',
  'email.clicked',
]);

type Interest = {behavior: Set<string>; property: boolean; at: number};

// Per isolate; rule writes in this isolate clear it, others pick changes up within the TTL.
let interest: Interest | null = null;
const TTL_MS = 15_000;

export function invalidateScoringInterest() {
  interest = null;
}

async function load(db: Db): Promise<Interest> {
  if (interest && Date.now() - interest.at < TTL_MS) return interest;
  const rules = await db.scoreRule.findMany({where: {enabled: true}, select: {kind: true, event: true}});
  interest = {
    behavior: new Set(rules.filter((r) => r.kind === 'behavior' && r.event).map((r) => r.event!)),
    property: rules.some((r) => r.kind === 'property'),
    at: Date.now(),
  };
  return interest;
}

/** Queues scoring for the events any enabled rule cares about. Returns true when a job was queued (the caller kicks the runner). */
export async function queueScoring(db: Db, events: {id: string; type: string}[]) {
  if (!events.length) return false;
  const i = await load(db);
  // A merge moves awards onto the survivor, so its total is redone whenever scoring is in use.
  const wanted = (type: string) => i.behavior.has(type) || (i.property && RESCORE_EVENTS.has(type)) || (type === 'contact.merged' && i.behavior.size > 0);
  const ids = events.filter((e) => wanted(e.type)).map((e) => e.id);
  for (let k = 0; k < ids.length; k += 50) await enqueue(db, 'scoring.events', {eventIds: ids.slice(k, k + 50)});
  return ids.length > 0;
}

/** Re-evaluates property rules for contacts changed without an event (bulk edits, company links). Never throws. */
export async function queueRescore(db: Db, contactIds: string[]) {
  try {
    const ids = [...new Set(contactIds)];
    if (!ids.length || !(await load(db)).property) return;
    for (let k = 0; k < ids.length; k += 200) await enqueue(db, 'scoring.rescore', {contactIds: ids.slice(k, k + 200)});
    kickJobs();
  } catch (e) {
    console.error('[scoring]', e);
  }
}
