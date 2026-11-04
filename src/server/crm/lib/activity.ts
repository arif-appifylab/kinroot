import type {Prisma} from '../../../generated/prisma/client';
import type {Db} from '../kit/db';
import {automationStamp} from './automation-context';

export type ActivityLink = {contactId?: string | null; companyId?: string | null; dealId?: string | null};

type LogInput = ActivityLink & {
  type: string;
  title: string;
  actorId?: string | null;
  refId?: string | null;
  data?: Prisma.InputJsonValue;
  /** Defaults to now; synced emails pass their real date. */
  at?: Date;
  /** Plain text used by timeline search. */
  text?: string | null;
};

/** The Activity row for one timeline event. */
function activityRow(db: Db, input: LogInput, now: Date): Prisma.ActivityUncheckedCreateInput {
  // Written by an automation step: the timeline shows "Automation: <name>" as the actor.
  const stamp = automationStamp(db);
  const plainObject = input.data === undefined || (typeof input.data === 'object' && input.data !== null && !Array.isArray(input.data));
  const data = stamp.automation && plainObject ? {...((input.data ?? {}) as Prisma.InputJsonObject), ...stamp} : input.data;
  return {
    createdAt: now,
    type: input.type,
    title: input.title,
    actorId: input.actorId ?? null,
    refId: input.refId ?? null,
    data: data ?? {},
    text: input.text?.slice(0, 5000) ?? null,
    contactId: input.contactId ?? null,
    companyId: input.companyId ?? null,
    dealId: input.dealId ?? null,
  };
}

/** Writes one timeline event and bumps lastActivityAt on every linked record. */
export async function logActivity(db: Db, input: LogInput) {
  const now = input.at ?? new Date();
  await db.activity.create({data: activityRow(db, input, now)});
  // Scheduling something in the future still counts as activity today.
  await touch(db, input, now.getTime() > Date.now() ? new Date() : now);
}

/** logActivity() for many events at once (bulk actions): one insert and one update per record type. */
export async function logActivities(db: Db, inputs: LogInput[]) {
  if (!inputs.length) return;
  const now = new Date();
  await db.activity.createMany({data: inputs.map((input) => activityRow(db, input, input.at ?? now))});
  const ids = (key: 'contactId' | 'companyId' | 'dealId') => [...new Set(inputs.map((i) => i[key]).filter((v): v is string => !!v))];
  const [contacts, companies, deals] = [ids('contactId'), ids('companyId'), ids('dealId')];
  await Promise.all([
    contacts.length && db.contact.updateMany({where: {id: {in: contacts}}, data: {lastActivityAt: now}}),
    companies.length && db.company.updateMany({where: {id: {in: companies}}, data: {lastActivityAt: now}}),
    deals.length && db.deal.updateMany({where: {id: {in: deals}}, data: {lastActivityAt: now}}),
  ]);
}

export async function touch(db: Db, link: ActivityLink, at = new Date()) {
  await Promise.all([
    link.contactId && db.contact.update({where: {id: link.contactId}, data: {lastActivityAt: at}}).catch(() => null),
    link.companyId && db.company.update({where: {id: link.companyId}, data: {lastActivityAt: at}}).catch(() => null),
    link.dealId && db.deal.update({where: {id: link.dealId}, data: {lastActivityAt: at}}).catch(() => null),
  ]);
}

/** Custom field changes as `custom.<key>` diff entries (diff() leaves `custom` out). */
export function customDiff(before: unknown, after: unknown) {
  const a = (before ?? {}) as Record<string, unknown>;
  const b = (after ?? {}) as Record<string, unknown>;
  const changes: {field: string; from: unknown; to: unknown}[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[key] ?? null) !== JSON.stringify(b[key] ?? null)) changes.push({field: `custom.${key}`, from: a[key] ?? null, to: b[key] ?? null});
  }
  return changes;
}

/** Field-level diff for "field_changed" events. Only reports fields that were in the patch. */
export function diff(before: Record<string, unknown>, patch: Record<string, unknown>) {
  const changes: {field: string; from: unknown; to: unknown}[] = [];
  for (const [field, to] of Object.entries(patch)) {
    if (to === undefined || field === 'custom') continue;
    const from = before[field];
    const a = from instanceof Date ? from.toISOString() : from;
    const b = to instanceof Date ? to.toISOString() : to;
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) changes.push({field, from: a ?? null, to: b ?? null});
  }
  return changes;
}
