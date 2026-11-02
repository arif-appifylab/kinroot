/**
 * What each automation step does. Every executor works out everything first
 * and, in a dry run (`ctx.dry`), returns what it *would* do before touching
 * anything. Real runs write through the shared helpers (logActivity, emit,
 * audit, createTicket, addToList, sendEmail…) with the automation-tagged
 * client, so the timeline, events, audit log and notifications stay in step
 * with what a person doing the same thing would produce.
 *
 * Retries: values that must not change between attempts (a round-robin pick,
 * the id of a created task / deal / ticket, a sent email) are kept with
 * `ctx.memo()` in the step's history row, so a retried step never repeats a
 * side effect that already happened.
 */
import {HTTPException} from 'hono/http-exception';

import type {Automation, Company, Contact, Prisma, Ticket, TicketPriority, TicketStatus} from '../../../generated/prisma/client';
import type {User} from '../kit/guards';
import type {EventType} from '@/lib/events';
import {ENTITY_OF, UNIT_MS, WEEKDAY_SHORT, type AssigneeMode, type AutoObject, type Step, type Target} from '@/lib/automations';
import {addDays, isTimeZone, localDate, weekdayOf, whenIn, zonedTime} from '@/lib/scheduling';
import {PRIORITY, STATUS, TICKET_PRIORITIES, TICKET_STATUSES} from '@/lib/tickets';
import {config} from '../kit/config';
import {encryptJson, decryptJson, randomToken} from '../kit/crypto';
import type {Db} from '../kit/db';
import {sendEmail, sendSystemEmail} from '../email/service';
import {customDiff, diff, logActivity} from './activity';
import {audit} from './audit';
import {fieldsFor, fieldValue, fill, labelOf, ownerIdOf, primaryOf, recordOf, recordPath, evaluateConditions, type DealWithStage, type MergeInput, type Records} from './automation-records';
import {cleanCustom} from './custom-fields';
import {checkDuplicates} from './duplicates';
import {emit} from './events';
import {notify, notifyWatchers} from './notify';
import {addToList, isContactInList, removeFromList} from './segments';
import {assignTicket, changePriority, changeStatus, createTicket} from './tickets';
import {signPayload} from './webhooks';
import {memberWithEmail} from './users';
import {WEBHOOK_SERVICE_NAMES, webhookTarget} from '@/lib/webhook-targets';

const DAY = 86_400_000;

export type StepCtx = {
  /** Client tagged with the run (see automation-context.ts). */
  db: Db;
  automation: Automation;
  run: {id: string; object: AutoObject; recordId: string | null; source: string; eventType: string | null; context: unknown};
  records: Records;
  dry: boolean;
  /** Attempt of this step (1 = first try). */
  attempt: number;
  stepStartedAt: Date;
  /** Remembers a value in the step's history row; later attempts get it back instead of running `fn`. */
  memo: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
};

export type StepResult = {
  status: 'done' | 'skipped';
  summary: string;
  output?: Record<string, unknown>;
  branch?: 'then' | 'else';
  waitUntil?: Date;
  stop?: boolean;
};

/** Errors that a retry can't fix (missing list, no mailbox…): the run fails right away. */
export class StepError extends Error {
  permanent = true;
}

export const isPermanent = (e: unknown) => e instanceof StepError || (e instanceof HTTPException && e.status >= 400 && e.status < 500 && e.status !== 429);

const skip = (summary: string, output?: Record<string, unknown>): StepResult => ({status: 'skipped', summary, output});
const done = (summary: string, output?: Record<string, unknown>): StepResult => ({status: 'done', summary, output});

// ─── Shared helpers ─────────────────────────────────────────────────────────

const tzOf = (a: Automation) => (isTimeZone(a.timezone) ? a.timezone : 'UTC');

export function mergeInput(ctx: Pick<StepCtx, 'automation' | 'run' | 'records'>, owner: {name: string; email: string} | null): MergeInput {
  return {object: ctx.run.object, records: ctx.records, automation: {name: ctx.automation.name, origin: originOf(ctx.automation)}, owner};
}

export const originOf = (a: Automation) => a.origin || config.siteUrl();

async function userById(db: Db, id: string | null | undefined) {
  return id ? memberWithEmail(db, {id, active: true}) : null;
}

/** The person behind an assignee mode for this run. */
function assigneeId(ctx: StepCtx, mode: AssigneeMode | undefined, userId?: string | null): string | null {
  const primary = primaryOf(ctx.run.object, ctx.records);
  switch (mode) {
    case 'owner':
      return ownerIdOf(ctx.run.object === 'none' ? 'contact' : ctx.run.object, primary);
    case 'assignee':
      return ctx.records.ticket?.assigneeId ?? ownerIdOf(ctx.run.object === 'none' ? 'contact' : ctx.run.object, primary);
    case 'creator':
      return ctx.automation.createdById;
    case 'user':
      return userId ?? null;
    default:
      return null;
  }
}

async function ownerOfRun(ctx: StepCtx) {
  return userById(ctx.db, assigneeId(ctx, 'owner'));
}

async function textCtx(ctx: StepCtx) {
  const owner = await ownerOfRun(ctx);
  return mergeInput(ctx, owner ? {name: owner.name, email: owner.email} : null);
}

const fmt = (v: unknown) => (v === null || v === undefined || v === '' ? '(empty)' : Array.isArray(v) ? v.join(', ') : v instanceof Date ? v.toISOString().slice(0, 10) : String(v));

/** Display name of a field value (user names, stage names, labels). */
async function display(db: Db, target: Target, key: string, v: unknown) {
  if (v === null || v === undefined || v === '') return '(empty)';
  if (key === 'ownerId' || key === 'assigneeId') return (await db.member.findUnique({where: {id: String(v)}, select: {name: true}}))?.name ?? 'someone';
  if (key === 'stageId') return (await db.stage.findUnique({where: {id: String(v)}, select: {name: true}}))?.name ?? 'a stage';
  if (target === 'ticket' && key === 'status') return STATUS[v as TicketStatus]?.label ?? String(v);
  if (target === 'ticket' && key === 'priority') return PRIORITY[v as TicketPriority]?.label ?? String(v);
  return fmt(v);
}

// ─── Record updates ─────────────────────────────────────────────────────────

type Patch = Record<string, unknown>;
const ENTITY_LABEL: Record<Target, string> = {contact: 'Contact', company: 'Company', deal: 'Deal', ticket: 'Ticket'};

/**
 * Writes a patch to a contact, company or deal the way the record pages do:
 * timeline "field changed", `<entity>.updated` with `changes`, audit, owner
 * notification, and for deals a proper stage move (history row, timeline,
 * `deal.stage_changed`, watchers).
 */
async function updateRecord(ctx: StepCtx, target: Exclude<Target, 'ticket'>, before: Contact | Company | DealWithStage, patch: Patch) {
  const db = ctx.db;
  const customPatch: Record<string, unknown> = {};
  const plain: Patch = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k.startsWith('custom.')) customPatch[k.slice(7)] = v;
    else plain[k] = v;
  }
  const custom = Object.keys(customPatch).length ? await cleanCustom(db, ENTITY_OF[target], customPatch, before.custom) : undefined;
  const data = {...plain, ...(custom ? {custom: custom as Prisma.InputJsonValue} : {})};
  const link = target === 'contact' ? {contactId: before.id} : target === 'company' ? {companyId: before.id} : {dealId: before.id};

  let after: Contact | Company | DealWithStage;
  let stageMove: {from: {id: string; name: string}; to: {id: string; name: string}} | null = null;
  if (target === 'deal') {
    const deal = before as DealWithStage;
    if (plain.stageId && plain.stageId !== deal.stageId) {
      const stage = await db.stage.findUnique({where: {id: String(plain.stageId)}});
      if (!stage) throw new StepError('That stage no longer exists');
      Object.assign(data, {pipelineId: stage.pipelineId, stageEnteredAt: new Date()});
      stageMove = {from: {id: deal.stage.id, name: deal.stage.name}, to: {id: stage.id, name: stage.name}};
    }
    after = await db.deal.update({where: {id: before.id}, data: data as Prisma.DealUncheckedUpdateInput, include: {stage: true}});
  } else if (target === 'contact') {
    after = await db.contact.update({where: {id: before.id}, data: data as Prisma.ContactUncheckedUpdateInput});
  } else {
    after = await db.company.update({where: {id: before.id}, data: data as Prisma.CompanyUncheckedUpdateInput});
  }

  // A stage move has its own timeline entry and event, like on the deal page.
  const changes = [...diff(before as unknown as Record<string, unknown>, plain), ...(custom ? customDiff(before.custom, (after as {custom: unknown}).custom) : [])].filter((ch) => ch.field !== 'stageId');
  if (stageMove) {
    await db.stageChange.create({data: {dealId: before.id, fromStageId: stageMove.from.id, toStageId: stageMove.to.id}});
    await logActivity(db, {type: 'stage_changed', title: `Moved from ${stageMove.from.name} to ${stageMove.to.name}`, dealId: before.id, data: {from: stageMove.from.name, to: stageMove.to.name}});
    await emit(db, 'deal.stage_changed', {recordId: before.id, data: {deal: after, ...stageMove}});
    await notifyWatchers(db, {dealId: before.id}, {type: 'stage_changed', title: `Automation "${ctx.automation.name}" moved ${(after as DealWithStage).title} to ${stageMove.to.name}`});
    await audit(db, null, {action: 'deal.stage_changed', entity: 'deal', recordId: before.id, label: labelOf('deal', after), meta: {from: stageMove.from.name, to: stageMove.to.name}});
  }
  if (changes.length) {
    await logActivity(db, {type: 'field_changed', title: `${ENTITY_LABEL[target]} updated`, ...link, data: {changes} as Prisma.InputJsonValue});
    await emit(db, `${target}.updated` as EventType, {recordId: before.id, data: {...after, changes}});
    await audit(db, null, {action: `${target}.updated`, entity: target, recordId: before.id, label: labelOf(target, after), meta: {changes}});
    const matchFields = target === 'contact' ? ['firstName', 'lastName', 'phone'] : target === 'company' ? ['name', 'website'] : [];
    if (target !== 'deal' && changes.some((ch) => matchFields.includes(ch.field))) await checkDuplicates(db, target, before.id);
  }
  const ownerId = (after as {ownerId: string | null}).ownerId;
  if (ownerId && ownerId !== (before as {ownerId: string | null}).ownerId) {
    await notify(db, [ownerId], {type: 'assigned', title: `Automation "${ctx.automation.name}" assigned you a ${target}: ${labelOf(target, after)}`, link: recordPath(target, after)});
  }
  return after;
}

/** Ticket fields go through the ticket helpers so SLA, thread events and notifications stay right. */
async function updateTicket(ctx: StepCtx, before: Ticket, key: string, value: unknown) {
  const db = ctx.db;
  let ticket = before;
  if (key === 'status') ticket = await changeStatus(db, ticket, value as TicketStatus, null, {origin: originOf(ctx.automation)});
  else if (key === 'priority') ticket = await changePriority(db, ticket, value as TicketPriority, null);
  else if (key === 'assigneeId') ticket = await assignTicket(db, ticket, (value as string | null) ?? null, null);
  else ticket = await db.ticket.update({where: {id: ticket.id}, data: {[key]: value}});
  await audit(db, null, {action: 'ticket.updated', entity: 'ticket', recordId: ticket.id, label: `#${ticket.number} ${ticket.subject}`, meta: {[key]: value}});
  return ticket;
}

async function setField(ctx: StepCtx, target: Target, rec: unknown, key: string, value: unknown) {
  if (target === 'ticket') return updateTicket(ctx, rec as Ticket, key, value);
  return updateRecord(ctx, target, rec as Contact, {[key]: value});
}

// ─── Values ─────────────────────────────────────────────────────────────────

/** "YYYY-MM-DD" N days from today in the automation's time zone. */
const daysFromNow = (a: Automation, days: number) => addDays(localDate(Date.now(), tzOf(a)), days);

async function newValue(ctx: StepCtx, step: Step, field: Awaited<ReturnType<typeof fieldsFor>>[number]) {
  if (step.mode === 'clear') {
    if (field.required) throw new StepError(`${field.label} can't be cleared`);
    return null;
  }
  if (field.kind === 'date') {
    const day = step.mode === 'relative' ? daysFromNow(ctx.automation, step.days ?? 0) : String(step.value ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new StepError(`${field.label}: not a date`);
    return field.key.startsWith('custom.') ? day : new Date(`${day}T00:00:00.000Z`);
  }
  if (field.kind === 'number') {
    const n = Number(step.value);
    if (Number.isNaN(n)) throw new StepError(`${field.label} must be a number`);
    return n;
  }
  if (field.kind === 'bool') return step.value === true || step.value === 'true';
  if (field.kind === 'tags') return (Array.isArray(step.value) ? step.value : String(step.value ?? '').split(',')).map((t) => String(t).trim()).filter(Boolean);
  if (field.kind === 'choice' || field.options === 'users') return step.value === '' ? null : String(step.value);
  return fill(String(step.value ?? ''), await textCtx(ctx)).trim().slice(0, 2000);
}

async function checkRef(db: Db, target: Target, key: string, value: unknown) {
  if (value === null) return;
  if ((key === 'ownerId' || key === 'assigneeId') && !(await userById(db, String(value)))) throw new StepError('That person is no longer active');
  if (key === 'lifecycleStage' && !['LEAD', 'QUALIFIED', 'OPPORTUNITY', 'CUSTOMER', 'CHURNED', 'OTHER'].includes(String(value))) throw new StepError('Unknown lifecycle stage');
  if (target === 'ticket' && key === 'status' && !TICKET_STATUSES.some((s) => s.value === value)) throw new StepError('Unknown ticket status');
  if (target === 'ticket' && key === 'priority' && !TICKET_PRIORITIES.some((p) => p.value === value)) throw new StepError('Unknown ticket priority');
}

// ─── Round robin ────────────────────────────────────────────────────────────

/** Next person in this step's rotation (active users only); advances the position atomically. */
async function nextInRotation(db: Db, automationId: string, stepId: string, userIds: string[], peek = false) {
  const active = (await db.member.findMany({where: {id: {in: userIds}, active: true}, select: {id: true}})).map((u) => u.id);
  const order = userIds.filter((id) => active.includes(id));
  if (!order.length) throw new StepError('Nobody in the rotation is active');
  if (peek) {
    const a = await db.automation.findUnique({where: {id: automationId}, select: {state: true}});
    const pos = Number(((a?.state ?? {}) as {rr?: Record<string, number>}).rr?.[stepId] ?? -1);
    return order[(pos + 1) % order.length]!;
  }
  const rows = await db.$queryRaw<{pos: number}[]>`
    UPDATE "Automation"
    SET state = state || jsonb_build_object('rr', COALESCE(state->'rr', '{}'::jsonb) || jsonb_build_object(${stepId}::text, COALESCE((state->'rr'->>${stepId}::text)::int, -1) + 1))
    WHERE id = ${automationId}
    RETURNING (state->'rr'->>${stepId}::text)::int AS pos`;
  return order[Number(rows[0]?.pos ?? 0) % order.length]!;
}

// ─── Waits ──────────────────────────────────────────────────────────────────

function nextWeekday(a: Automation, weekdays: number[], time: string) {
  const tz = tzOf(a);
  const today = localDate(Date.now(), tz);
  for (let i = 0; i <= 7; i++) {
    const day = addDays(today, i);
    if (!weekdays.includes(weekdayOf(day))) continue;
    const at = zonedTime(day, time, tz);
    if (at > Date.now()) return new Date(at);
  }
  return new Date(Date.now() + 7 * DAY);
}

async function waitUntil(ctx: StepCtx, step: Step): Promise<Date | null> {
  if (step.waitMode === 'until_weekday') return nextWeekday(ctx.automation, step.weekdays?.length ? step.weekdays : [1], step.time || '09:00');
  if (step.waitMode === 'until_date') {
    const rec = recordOf(ctx.records, step.target ?? 'contact');
    const field = (await fieldsFor(ctx.db, step.target ?? 'contact')).find((f) => f.key === step.field);
    const v = rec && field ? fieldValue(rec, field.key) : null;
    if (!v) return null;
    if (field?.dateOnly) {
      const day = v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
      return new Date(zonedTime(day, step.time || '09:00', tzOf(ctx.automation)));
    }
    return new Date(v as string | Date);
  }
  return new Date(Date.now() + (step.amount ?? 0) * UNIT_MS[step.unit ?? 'days']);
}

// ─── Webhooks ───────────────────────────────────────────────────────────────

/** The automation's signing secret (created on first use, stored encrypted). */
export async function automationSecret(db: Db, a: Automation) {
  if (a.webhookSecret) return decryptJson<string>(a.webhookSecret);
  const secret = `whsec_${randomToken(24)}`;
  await db.automation.update({where: {id: a.id}, data: {webhookSecret: await encryptJson(secret)}});
  return secret;
}

const brief = (target: Target, rec: unknown) => (rec ? {id: (rec as {id: string}).id, name: labelOf(target, rec)} : null);

// ─── Executors ──────────────────────────────────────────────────────────────

type Executor = (ctx: StepCtx, step: Step) => Promise<StepResult>;

const EXECUTORS: Record<Step['type'], Executor> = {
  async if(ctx, step) {
    const result = await evaluateConditions(ctx.db, step.conditions, ctx.records);
    return {status: 'done', branch: result.ok ? 'then' : 'else', summary: result.ok ? 'Conditions matched: yes branch' : 'Conditions not matched: no branch', output: {matched: result.ok, blocks: result.blocks}};
  },

  async update_field(ctx, step) {
    const target = step.target ?? 'contact';
    const rec = recordOf(ctx.records, target);
    if (!rec) return skip(`No ${target} to update`);
    const field = (await fieldsFor(ctx.db, target)).find((f) => f.key === step.field);
    if (!field?.writable) throw new StepError('That field no longer exists or can\'t be set');
    const value = await newValue(ctx, step, field);
    await checkRef(ctx.db, target, field.key, value);
    const current = fieldValue(rec, field.key);
    const same = JSON.stringify(current instanceof Date ? current.toISOString() : current ?? null) === JSON.stringify(value instanceof Date ? value.toISOString() : value ?? null);
    const name = labelOf(target, rec);
    const shown = await display(ctx.db, target, field.key, value);
    if (same) return skip(`${field.label} of ${name} is already ${shown}`);
    const text = `${field.label} of ${name}: ${await display(ctx.db, target, field.key, current)} → ${shown}`;
    if (ctx.dry) return done(`Would set ${text}`);
    await setField(ctx, target, rec, field.key, value);
    return done(`Set ${text}`, {target, field: field.key, from: current ?? null, to: value instanceof Date ? value.toISOString() : value});
  },

  async assign_owner(ctx, step) {
    const target = step.target ?? 'contact';
    const rec = recordOf(ctx.records, target);
    if (!rec) return skip(`No ${target} to assign`);
    const key = target === 'ticket' ? 'assigneeId' : 'ownerId';
    const current = ownerIdOf(target, rec);
    if (step.onlyIfEmpty && current) return skip(`${labelOf(target, rec)} already has ${await display(ctx.db, target, key, current)}`);
    const pick = step.assignMode === 'round_robin'
      ? ctx.dry ? await nextInRotation(ctx.db, ctx.automation.id, step.id, step.userIds ?? [], true) : await ctx.memo('userId', () => nextInRotation(ctx.db, ctx.automation.id, step.id, step.userIds ?? []))
      : step.userId ?? null;
    if (!pick) throw new StepError('Pick who to assign');
    await checkRef(ctx.db, target, key, pick);
    const name = await display(ctx.db, target, key, pick);
    if (pick === current) return skip(`${labelOf(target, rec)} is already assigned to ${name}`);
    if (ctx.dry) return done(`Would assign ${labelOf(target, rec)} to ${name}${step.assignMode === 'round_robin' ? ' (next in the rotation)' : ''}`);
    await setField(ctx, target, rec, key, pick);
    return done(`Assigned ${labelOf(target, rec)} to ${name}`, {userId: pick});
  },

  async create_task(ctx, step) {
    const m = await textCtx(ctx);
    const title = fill(step.title, m).trim().slice(0, 300) || 'Follow up';
    const description = fill(step.description, m).trim().slice(0, 5000) || null;
    const tz = tzOf(ctx.automation);
    const day = addDays(localDate(Date.now(), tz), step.dueDays ?? 0);
    const dueAt = new Date(zonedTime(day, step.time || '00:00', tz));
    const assignee = assigneeId(ctx, step.assignee, step.userId);
    const user = await userById(ctx.db, assignee);
    const {contact, company, deal, ticket} = ctx.records;
    const object = ctx.run.object;
    const link = {
      contactId: object === 'contact' || object === 'ticket' ? contact?.id ?? null : null,
      companyId: object === 'company' ? company?.id ?? null : object === 'ticket' && !contact ? company?.id ?? null : null,
      dealId: object === 'deal' ? deal?.id ?? null : object === 'ticket' ? ticket?.dealId ?? null : null,
    };
    const text = `"${title}" due ${step.time ? whenIn(dueAt, tz) : day} for ${user?.name ?? 'nobody'}`;
    if (ctx.dry) return done(`Would create task ${text}`);
    const taskId = await ctx.memo('taskId', async () => {
      const task = await ctx.db.task.create({
        data: {
          title,
          description,
          type: (['TODO', 'CALL', 'EMAIL', 'MEETING', 'DEADLINE'].includes(step.taskType ?? '') ? step.taskType : 'TODO') as 'TODO',
          priority: (['NONE', 'LOW', 'NORMAL', 'HIGH'].includes(step.priority ?? '') ? step.priority : 'NONE') as 'NONE',
          dueAt,
          assigneeId: user?.id ?? null,
          creatorId: ctx.automation.createdById,
          ...link,
        },
      });
      await logActivity(ctx.db, {type: 'task_created', title: `Task scheduled: ${task.title}`, refId: task.id, ...link, data: {taskType: task.type, dueAt: task.dueAt?.toISOString() ?? null}, text: [task.title, task.description].filter(Boolean).join('\n')});
      await emit(ctx.db, 'task.created', {recordId: task.id, data: task});
      await notify(ctx.db, [task.assigneeId], {type: 'assigned', title: `Automation "${ctx.automation.name}" gave you a task: ${task.title}`, link: link.dealId ? `/deals/${link.dealId}` : link.contactId ? `/contacts/${link.contactId}` : link.companyId ? `/companies/${link.companyId}` : '/tasks'});
      return task.id;
    });
    return done(`Created task ${text}`, {taskId});
  },

  async create_deal(ctx, step) {
    const m = await textCtx(ctx);
    const stage = step.stageId ? await ctx.db.stage.findUnique({where: {id: step.stageId}, include: {pipeline: true}}) : null;
    if (!stage || stage.pipelineId !== step.pipelineId) throw new StepError('That pipeline or stage no longer exists');
    const title = fill(step.title, m).trim().slice(0, 200) || 'New deal';
    const owner = await userById(ctx.db, assigneeId(ctx, step.assignee, step.userId));
    const {contact, company} = ctx.records;
    const value = Math.max(0, Number(step.value ?? 0) || 0);
    const text = `"${title}" in ${stage.pipeline.name} → ${stage.name}${owner ? ` for ${owner.name}` : ''}`;
    if (ctx.dry) return done(`Would create deal ${text}`);
    const dealId = await ctx.memo('dealId', async () => {
      const first = await ctx.db.deal.findFirst({where: {stageId: stage.id, status: 'OPEN'}, orderBy: {position: 'asc'}, select: {position: true}});
      const deal = await ctx.db.deal.create({
        data: {
          title,
          value,
          pipelineId: stage.pipelineId,
          stageId: stage.id,
          position: (first?.position ?? 1) - 1,
          ownerId: owner?.id ?? null,
          companyId: company?.id ?? null,
          contacts: contact ? {create: [{contactId: contact.id}]} : undefined,
          companies: company ? {create: [{companyId: company.id, isPrimary: true}]} : undefined,
        },
        include: {stage: true},
      });
      await ctx.db.stageChange.create({data: {dealId: deal.id, toStageId: stage.id}});
      await logActivity(ctx.db, {type: 'deal_created', title: `Deal created: ${deal.title}`, dealId: deal.id, companyId: deal.companyId, contactId: contact?.id});
      await emit(ctx.db, 'deal.created', {recordId: deal.id, data: deal});
      await audit(ctx.db, null, {action: 'deal.created', entity: 'deal', recordId: deal.id, label: deal.title});
      await notify(ctx.db, [deal.ownerId], {type: 'assigned', title: `Automation "${ctx.automation.name}" assigned you a deal: ${deal.title}`, link: `/deals/${deal.id}`});
      return deal.id;
    });
    return done(`Created deal ${text}`, {dealId});
  },

  async create_ticket(ctx, step) {
    const m = await textCtx(ctx);
    const subject = fill(step.subject, m).trim().slice(0, 300) || 'New ticket';
    const description = fill(step.description, m).trim() || null;
    const assignee = await userById(ctx.db, assigneeId(ctx, step.assignee, step.userId));
    const priority = (TICKET_PRIORITIES.some((p) => p.value === step.priority) ? step.priority : 'NORMAL') as TicketPriority;
    const {contact, company, deal} = ctx.records;
    const text = `"${subject}" (${PRIORITY[priority].label})${assignee ? ` for ${assignee.name}` : ''}`;
    if (ctx.dry) return done(`Would create ticket ${text}`);
    const ticketId = await ctx.memo('ticketId', async () => {
      const ticket = await createTicket(ctx.db, {
        subject,
        description,
        priority,
        category: step.category || null,
        queue: step.queue || null,
        source: 'MANUAL',
        assigneeId: assignee?.id ?? null,
        contactId: contact?.id ?? null,
        companyId: company?.id ?? null,
        dealId: deal?.id ?? null,
        actorId: null,
      });
      await audit(ctx.db, null, {action: 'ticket.created', entity: 'ticket', recordId: ticket.id, label: `#${ticket.number} ${ticket.subject}`});
      return ticket.id;
    });
    return done(`Created ticket ${text}`, {ticketId});
  },

  async add_tag(ctx, step) {
    return tagStep(ctx, step, 'add');
  },
  async remove_tag(ctx, step) {
    return tagStep(ctx, step, 'remove');
  },

  async add_to_list(ctx, step) {
    return listStep(ctx, step, 'add');
  },
  async remove_from_list(ctx, step) {
    return listStep(ctx, step, 'remove');
  },

  async send_email(ctx, step) {
    const contact = ctx.records.contact;
    if (!contact) return skip('No contact to email');
    if (!contact.email) return skip(`${labelOf('contact', contact)} has no email address`);
    const optedOut = await ctx.db.contact.count({where: {email: {equals: contact.email, mode: 'insensitive'}, emailOptOut: true}});
    if (contact.emailOptOut || optedOut) return skip(`${contact.email} opted out of email`);

    const owner = await ownerOfRun(ctx);
    let me: User | null;
    let accountId: string;
    if (step.from === 'shared') {
      const account = step.accountId ? await ctx.db.emailAccount.findFirst({where: {id: step.accountId, userId: null}}) : null;
      if (!account) throw new StepError('The shared mailbox for this email is gone');
      accountId = account.id;
      me = owner ?? (await userById(ctx.db, ctx.automation.createdById)) ?? (await memberWithEmail(ctx.db, {active: true, role: {in: ['OWNER', 'ADMIN']}}));
      if (!me) throw new StepError('No active user to send as');
    } else {
      if (!owner) throw new StepError(`${labelOf(ctx.run.object === 'none' ? 'contact' : ctx.run.object, primaryOf(ctx.run.object, ctx.records))} has no owner to send from`);
      const account = await ctx.db.emailAccount.findFirst({where: {userId: owner.id}, orderBy: [{isDefault: 'desc'}, {createdAt: 'asc'}]});
      if (!account) throw new StepError(`${owner.name} has no mailbox connected (Settings → Email)`);
      accountId = account.id;
      me = owner;
    }
    const m = mergeInput(ctx, {name: me.name, email: me.email});
    const subject = fill(step.subject, m, {keepStandard: true}).slice(0, 300);
    const html = fill(step.html, m, {html: true, keepStandard: true});
    const shownSubject = fill(step.subject, m);
    if (ctx.dry) return done(`Would email ${contact.email}: "${shownSubject}" (${step.layout === 'plain' ? 'plain' : 'branded'} layout, from ${step.from === 'shared' ? 'a shared mailbox' : `${me.name}'s mailbox`})`);
    const messageId = await ctx.memo('messageId', async () => {
      // A previous attempt may have sent it before failing later: never send twice.
      if (ctx.attempt > 1) {
        const sent = await ctx.db.emailMessage.findFirst({where: {contactId: contact.id, senderId: me!.id, direction: 'OUTBOUND', status: 'SENT', sentAt: {gte: ctx.stepStartedAt}}, select: {id: true}});
        if (sent) return sent.id;
      }
      const sent = await sendEmail(ctx.db, me!, originOf(ctx.automation), {
        accountId,
        to: [contact.email!],
        subject,
        html,
        layout: step.layout === 'plain' ? 'plain' : 'branded',
        contactId: contact.id,
        companyId: ctx.records.company?.id ?? null,
        dealId: ctx.records.deal?.id ?? null,
      });
      return sent?.id ?? null;
    });
    return done(`Emailed ${contact.email}: "${shownSubject}"`, {messageId});
  },

  async notify(ctx, step) {
    const ids = step.assignee === 'user' ? step.userIds ?? [] : [assigneeId(ctx, step.assignee)].filter((x): x is string => !!x);
    const users = (await ctx.db.member.findMany({where: {id: {in: ids}, active: true}, select: {id: true, name: true, user: {select: {email: true}}}})).map((u) => ({id: u.id, name: u.name, email: u.user?.email ?? ''}));
    if (!users.length) return skip(step.assignee === 'owner' ? 'The record has no owner to notify' : 'Nobody to notify');
    const m = await textCtx(ctx);
    const title = fill(step.title, m).slice(0, 200);
    const body = fill(step.body, m) || null;
    const path = ctx.run.object === 'none' ? null : recordPath(ctx.run.object, primaryOf(ctx.run.object, ctx.records));
    const names = users.map((u) => u.name).join(', ');
    if (ctx.dry) return done(`Would notify ${names}: "${title}"${step.email ? ' (and by email)' : ''}`);
    const emailed = await ctx.memo('notified', async () => {
      await notify(ctx.db, users.map((u) => u.id), {type: 'automation', title, body, link: path ?? '/automations'});
      if (!step.email) return false;
      const url = path ? `${originOf(ctx.automation)}${path}` : '';
      return sendSystemEmail(ctx.db, {to: users.map((u) => u.email).filter(Boolean), subject: title, text: [body, url].filter(Boolean).join('\n\n') || title}).catch(() => false);
    });
    return done(`Notified ${names}: "${title}"${step.email ? (emailed ? ' (and by email)' : ' (no mailbox for the email copy)') : ''}`, {userIds: users.map((u) => u.id), emailed});
  },

  async webhook(ctx, step) {
    // Only to the webhook services written in code (src/crm/lib/webhook-targets.ts), checked again at send time.
    const target = webhookTarget(step.url);
    if (!target) throw new StepError(`This webhook URL is not one Kinroot can send to. Use a URL from ${WEBHOOK_SERVICE_NAMES}.`);
    const url = target.url.href;
    if (ctx.dry) return done(`Would POST the record to ${url} (signed)`);
    const object = ctx.run.object;
    const deliveryId = `${ctx.run.id}:${step.id}`;
    const body = JSON.stringify({
      id: deliveryId,
      type: 'automation.webhook',
      createdAt: new Date().toISOString(),
      data: {
        automation: {id: ctx.automation.id, name: ctx.automation.name},
        run: {id: ctx.run.id, source: ctx.run.source, eventType: ctx.run.eventType},
        object,
        record: object === 'none' ? null : primaryOf(object, ctx.records),
        related: {contact: brief('contact', ctx.records.contact), company: brief('company', ctx.records.company), deal: brief('deal', ctx.records.deal), ticket: brief('ticket', ctx.records.ticket)},
        trigger: ctx.run.context,
      },
    });
    const secret = await automationSecret(ctx.db, ctx.automation);
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {'content-type': 'application/json', 'user-agent': 'CRM-Webhooks/1.0', 'x-webhook-id': deliveryId, 'x-webhook-event': 'automation.webhook', 'x-webhook-signature': await signPayload(secret, body)},
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      throw new Error((e as Error).name === 'TimeoutError' ? 'Webhook timed out after 10 s' : `Webhook failed: ${(e as Error).message}`);
    }
    const text = (await res.text().catch(() => '')).slice(0, 300);
    if (!res.ok) {
      const message = `Webhook answered HTTP ${res.status}`;
      // 4xx (except timeouts / rate limits) won't get better by retrying.
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) throw new StepError(message);
      throw new Error(message);
    }
    return done(`Delivered to ${url} (HTTP ${res.status})`, {status: res.status, ms: Date.now() - started, response: text});
  },

  async wait(ctx, step) {
    const until = ctx.dry ? await waitUntil(ctx, step) : await ctx.memo('until', async () => (await waitUntil(ctx, step))?.toISOString() ?? null).then((v) => (v ? new Date(v) : null));
    const tz = tzOf(ctx.automation);
    if (!until) return skip('No date to wait for: continuing');
    const label = step.waitMode === 'until_weekday' ? `next ${(step.weekdays ?? []).map((d) => WEEKDAY_SHORT[d]).join(' / ')}` : 'that time';
    if (until.getTime() <= Date.now()) return done(`${whenIn(until, tz)} has passed: continuing`);
    return {status: 'done', waitUntil: until, summary: `${ctx.dry ? 'Would wait' : 'Waiting'} until ${whenIn(until, tz)}${step.waitMode === 'until_weekday' ? ` (${label})` : ''}`, output: {until: until.toISOString()}};
  },

  async stop() {
    return {status: 'done', stop: true, summary: 'Stopped the run'};
  },
};

async function tagStep(ctx: StepCtx, step: Step, change: 'add' | 'remove'): Promise<StepResult> {
  const target = step.target ?? 'contact';
  const rec = recordOf(ctx.records, target) as {id: string; tags: string[]} | null;
  if (!rec) return skip(`No ${target} to tag`);
  const tag = fill(step.tag, await textCtx(ctx)).trim().slice(0, 40);
  if (!tag) throw new StepError('The tag is empty');
  const has = rec.tags.some((t) => t.toLowerCase() === tag.toLowerCase());
  const name = labelOf(target, rec);
  if (change === 'add' && has) return skip(`${name} already has "${tag}"`);
  if (change === 'remove' && !has) return skip(`${name} doesn't have "${tag}"`);
  const tags = change === 'add' ? [...rec.tags, tag] : rec.tags.filter((t) => t.toLowerCase() !== tag.toLowerCase());
  if (ctx.dry) return done(`Would ${change} "${tag}" ${change === 'add' ? 'to' : 'from'} ${name}`);
  await setField(ctx, target, rec, 'tags', tags);
  return done(`${change === 'add' ? 'Added' : 'Removed'} "${tag}" ${change === 'add' ? 'to' : 'from'} ${name}`, {tag});
}

async function listStep(ctx: StepCtx, step: Step, change: 'add' | 'remove'): Promise<StepResult> {
  const contact = ctx.records.contact;
  if (!contact) return skip('No contact for the list');
  if (!step.listId) throw new StepError('No list picked for this step');
  const list = await ctx.db.contactList.findUnique({where: {id: step.listId}, select: {id: true, name: true, kind: true}});
  if (!list) throw new StepError('That list no longer exists');
  if (list.kind !== 'STATIC') throw new StepError(`${list.name} is a segment: its members come from its rules`);
  const member = await isContactInList(ctx.db, list.id, contact.id);
  const name = labelOf('contact', contact);
  if (change === 'add' && member) return skip(`${name} is already in ${list.name}`);
  if (change === 'remove' && !member) return skip(`${name} isn't in ${list.name}`);
  if (ctx.dry) return done(`Would ${change} ${name} ${change === 'add' ? 'to' : 'from'} ${list.name}`);
  if (change === 'add') await addToList(ctx.db, list.id, [contact.id], {actorId: null, source: 'automation'});
  else await removeFromList(ctx.db, list.id, [contact.id], {actorId: null, source: 'automation'});
  await audit(ctx.db, null, {action: change === 'add' ? 'list.members_added' : 'list.members_removed', entity: 'list', recordId: list.id, label: list.name, meta: {contactId: contact.id}});
  return done(`${change === 'add' ? 'Added' : 'Removed'} ${name} ${change === 'add' ? 'to' : 'from'} ${list.name}`, {listId: list.id});
}

export function executeStep(ctx: StepCtx, step: Step) {
  return EXECUTORS[step.type](ctx, step);
}
