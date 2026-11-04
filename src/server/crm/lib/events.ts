import type {Prisma} from '../../../generated/prisma/client';
import type {Db} from '../kit/db';
import type {EventType} from '@/lib/events';
import {enqueue} from './jobs';
import {queueScoring} from './scoring-hook';
import {queueAutomations} from './automation-hook';

/** Deliveries one `webhook.deliver` job of a bulk change sends (ten at a time, 10 s each at most). */
const DELIVERIES_PER_JOB = 20;

type EmitInput = {
  entity?: 'contact' | 'company' | 'deal' | 'task' | 'note' | 'email' | 'interaction' | 'file' | 'form' | 'list' | 'ticket' | 'automation' | 'report' | 'conversation' | 'incoming_webhook' | 'data_in';
  recordId?: string | null;
  actorId?: string | null;
  /** The record (or a summary of the change). Dates become ISO strings. */
  data: unknown;
};

/**
 * Records a domain event, writes a delivery for every webhook subscribed to
 * it and queues ONE job that sends them all (the platform takes only so many
 * new jobs a minute) and, when a scoring rule or an automation cares about it,
 * a lead scoring / automation job. Never throws: a broken webhook must not
 * fail the user's write.
 */
export async function emit(db: Db, type: EventType, input: EmitInput) {
  try {
    const event = await db.event.create({
      data: {
        type,
        entity: input.entity ?? type.split('.')[0],
        recordId: input.recordId ?? null,
        actorId: input.actorId ?? null,
        data: JSON.parse(JSON.stringify(input.data ?? {})) as Prisma.InputJsonValue,
      },
    });
    const hooks = await db.webhook.findMany({where: {active: true, OR: [{events: {has: type}}, {events: {has: '*'}}]}, select: {id: true}});
    if (hooks.length) {
      await db.webhookDelivery.createMany({data: hooks.map((hook) => ({webhookId: hook.id, eventId: event.id, eventType: type}))});
      await enqueue(db, 'webhook.deliver', {eventId: event.id});
    }
    await queueScoring(db, [event]);
    await queueAutomations(db, [event]);
    return event;
  } catch (e) {
    console.error('[events]', type, String((e as Error)?.message ?? e).slice(0, 200));
    return null;
  }
}

/** emit() for many records at once (bulk list changes): a few queries in total instead of a few per record. */
export async function emitMany(db: Db, type: EventType, inputs: EmitInput[]) {
  if (!inputs.length) return;
  try {
    const events = await db.event.createManyAndReturn({
      data: inputs.map((input) => ({
        type,
        entity: input.entity ?? type.split('.')[0],
        recordId: input.recordId ?? null,
        actorId: input.actorId ?? null,
        data: JSON.parse(JSON.stringify(input.data ?? {})) as Prisma.InputJsonValue,
      })),
      select: {id: true},
    });
    await queueScoring(db, events.map((e) => ({id: e.id, type})));
    await queueAutomations(db, events.map((e) => ({id: e.id, type})));
    const hooks = await db.webhook.findMany({where: {active: true, OR: [{events: {has: type}}, {events: {has: '*'}}]}, select: {id: true}});
    if (!hooks.length) return;
    await db.webhookDelivery.createMany({data: hooks.flatMap((hook) => events.map((event) => ({webhookId: hook.id, eventId: event.id, eventType: type})))});
    // One job per few events, about DELIVERIES_PER_JOB deliveries each (all hooks of an event in the same job).
    const perJob = Math.max(1, Math.floor(DELIVERIES_PER_JOB / hooks.length));
    for (let k = 0; k < events.length; k += perJob) await enqueue(db, 'webhook.deliver', {eventIds: events.slice(k, k + perJob).map((e) => e.id)});
  } catch (e) {
    console.error('[events]', type, String((e as Error)?.message ?? e).slice(0, 200));
  }
}
