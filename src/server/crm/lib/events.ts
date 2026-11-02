import type {Prisma} from '../../../generated/prisma/client';
import type {Db} from '../kit/db';
import type {EventType} from '@/lib/events';
import {enqueue, kickJobs} from './jobs';
import {queueScoring} from './scoring-hook';
import {queueAutomations} from './automation-hook';

type EmitInput = {
  entity?: 'contact' | 'company' | 'deal' | 'task' | 'note' | 'email' | 'interaction' | 'file' | 'form' | 'list' | 'ticket' | 'automation' | 'report' | 'conversation' | 'incoming_webhook' | 'data_in';
  recordId?: string | null;
  actorId?: string | null;
  /** The record (or a summary of the change). Dates become ISO strings. */
  data: unknown;
};

/**
 * Records a domain event, queues a delivery for every webhook subscribed to
 * it and, when a scoring rule or an automation cares about it, a lead scoring
 * / automation job. Never throws:
 * a broken webhook must not fail the user's write.
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
    for (const hook of hooks) {
      const delivery = await db.webhookDelivery.create({data: {webhookId: hook.id, eventId: event.id, eventType: type}});
      await enqueue(db, 'webhook.deliver', {deliveryId: delivery.id});
    }
    const scored = await queueScoring(db, [event]);
    const automated = await queueAutomations(db, [event]);
    if (hooks.length || scored || automated) kickJobs();
    return event;
  } catch (e) {
    console.error('[events]', type, e);
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
    const scored = await queueScoring(db, events.map((e) => ({id: e.id, type})));
    const automated = await queueAutomations(db, events.map((e) => ({id: e.id, type})));
    const hooks = await db.webhook.findMany({where: {active: true, OR: [{events: {has: type}}, {events: {has: '*'}}]}, select: {id: true}});
    if (!hooks.length) {
      if (scored || automated) kickJobs();
      return;
    }
    const deliveries = await db.webhookDelivery.createManyAndReturn({
      data: hooks.flatMap((hook) => events.map((event) => ({webhookId: hook.id, eventId: event.id, eventType: type}))),
      select: {id: true},
    });
    for (const d of deliveries) await enqueue(db, 'webhook.deliver', {deliveryId: d.id});
  } catch (e) {
    console.error('[events]', type, e);
  }
}
