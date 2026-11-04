import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import type {Prisma} from '../../../generated/prisma/client';
import {answerText, defaultSettings, FORM_TEMPLATES, slugify, type FieldType, type StoredAnswer} from '@/lib/forms';
import {copyName, cut, FORM_LIMITS} from '@/lib/record-limits';
import {currentUser, isAdmin, requireRole, type AppEnv, type User} from '../kit/guards';
import {audit} from '../lib/audit';
import {formFields, formSettings} from '../lib/form-submit';
import {fieldError, httpUrl, notFound, valid} from '../lib/http';
import {moveToBin} from '../lib/recycle-bin';
import {userSelect} from '../lib/users';
import {csv} from './import-export';

const FIELD_TYPES = [
  'name', 'email', 'phone', 'company', 'website', 'address', 'short_text', 'long_text', 'number', 'date',
  'dropdown', 'single_choice', 'multiple_choice', 'yes_no', 'consent', 'rating', 'file', 'hidden', 'booking', 'heading', 'page_break',
] as const satisfies readonly FieldType[];

const rule = z.object({fieldId: z.string().max(80), op: z.enum(['is', 'is_not', 'contains', 'not_contains', 'empty', 'not_empty', 'gt', 'lt']), value: z.string().max(500).optional()});
const group = z.object({match: z.enum(['all', 'any']), rules: z.array(rule).max(20)});

const field = z.object({
  id: z.string().min(1).max(80),
  type: z.enum(FIELD_TYPES),
  label: z.string().max(1000),
  description: z.string().max(2000).optional(),
  placeholder: z.string().max(200).optional(),
  required: z.boolean().optional(),
  width: z.enum(['full', 'half']).optional(),
  options: z.array(z.string().max(200)).max(100).optional(),
  scale: z.number().int().min(3).max(10).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  accept: z.enum(['any', 'images', 'documents']).optional(),
  param: z.string().max(100).optional(),
  defaultValue: z.string().max(500).optional(),
  bookingLinkId: z.string().max(80).optional(),
  mapTo: z.string().max(100).optional(),
  logic: group.extend({action: z.enum(['show', 'hide'])}).optional(),
});

const settings = z.object({
  title: z.string().max(200).optional(),
  intro: z.string().max(4000).optional(),
  submitLabel: z.string().max(60).optional(),
  layout: z.enum(['classic', 'conversational']),
  progressBar: z.boolean(),
  accent: z.string().regex(/^#[0-9a-f]{6}$/i).or(z.literal('')).optional(),
  opensAt: z.string().nullish(),
  closesAt: z.string().nullish(),
  closedMessage: z.string().max(1000).optional(),
  responseLimit: z.number().int().min(1).nullish(),
  onePerContact: z.boolean().optional(),
  endings: z.array(z.object({id: z.string().max(80), title: z.string().max(200), message: z.string().max(4000), redirectUrl: httpUrl.transform((v) => v ?? undefined), when: group.optional()})).min(1).max(10), // redirectUrl: http(s) only, never `javascript:`
  contactSource: z.string().max(100).optional(),
  lifecycleStage: z.enum(['LEAD', 'QUALIFIED', 'OPPORTUNITY', 'CUSTOMER', 'CHURNED', 'OTHER']).nullish(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  listIds: z.array(z.string().max(60)).max(20).optional(),
  owner: z.object({mode: z.enum(['none', 'user', 'round_robin']), userId: z.string().nullish(), userIds: z.array(z.string()).max(50).optional(), next: z.number().int().optional()}).optional(),
  createDeal: z.object({enabled: z.boolean(), pipelineId: z.string().nullish(), stageId: z.string().nullish(), title: z.string().max(200).optional(), value: z.number().nullish()}).optional(),
  createTicket: z.object({enabled: z.boolean(), subject: z.string().max(300).optional(), priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).nullish(), category: z.string().max(60).nullish()}).optional(),
  notifyUserIds: z.array(z.string()).max(50).optional(),
  notifyEmails: z.array(z.email()).max(20).optional(),
  autoresponder: z.object({enabled: z.boolean(), subject: z.string().max(200), body: z.string().max(10000)}).optional(),
  inbox: z.object({enabled: z.boolean(), accountId: z.string().max(60).nullish()}).optional(),
});

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The form's creator or an admin may publish, close, delete it and delete its responses. */
function canManage(me: Pick<User, 'id' | 'role'>, form: {createdById: string | null}) {
  return form.createdById === me.id || isAdmin(me);
}

async function uniqueSlug(db: AppEnv['Variables']['db'], base: string, exceptId?: string) {
  // Within the slug's limit: the name's slug itself, then a shorter root with room for "-50" or the time.
  const first = cut(slugify(base), FORM_LIMITS.slug).replace(/-+$/, '') || 'form';
  const root = cut(first, FORM_LIMITS.slug - 10).replace(/-+$/, '') || 'form';
  for (let i = 0; i < 50; i++) {
    const slug = i ? `${root}-${i + 1}` : first;
    const taken = await db.form.findFirst({where: {slug, ...(exceptId ? {id: {not: exceptId}} : {})}, select: {id: true}});
    if (!taken) return slug;
  }
  return `${root}-${Date.now().toString(36)}`;
}

const listSelect = {
  id: true,
  name: true,
  slug: true,
  status: true,
  views: true,
  starts: true,
  submissionCount: true,
  lastSubmissionAt: true,
  updatedAt: true,
  createdAt: true,
  createdBy: {select: userSelect},
} as const;

export const forms = new Hono<AppEnv>()
  .get('/', async (c) => {
    const rows = await c.var.db.form.findMany({orderBy: {updatedAt: 'desc'}, select: listSelect});
    return c.json({rows});
  })

  .post('/', valid('json', z.object({name: z.string().trim().min(1).max(FORM_LIMITS.name), templateId: z.string().optional()})), async (c) => {
    const me = currentUser(c);
    const {name, templateId} = c.req.valid('json');
    const template = FORM_TEMPLATES.find((t) => t.id === templateId) ?? FORM_TEMPLATES[0]!;
    const form = await c.var.db.form.create({
      data: {
        name,
        slug: await uniqueSlug(c.var.db, name),
        fields: template.fields() as unknown as Prisma.InputJsonValue,
        // The creator hears about responses by default.
        settings: {...defaultSettings(), title: name, notifyUserIds: [me.id], ...template.settings} as Prisma.InputJsonValue,
        createdById: me.id,
      },
      select: {id: true},
    });
    await audit(c.var.db, c, {action: 'form.created', entity: 'form', recordId: form.id, label: name});
    return c.json({form}, 201);
  })

  .get('/:id', async (c) => {
    const form = await c.var.db.form.findUnique({where: {id: c.req.param('id')}, include: {createdBy: {select: userSelect}}});
    if (!form) throw notFound('Form');
    return c.json({form: {...form, settings: formSettings(form), fields: formFields(form)}});
  })

  .patch('/:id', valid('json', z.object({name: z.string().trim().min(1).max(FORM_LIMITS.name).optional(), slug: z.string().trim().max(FORM_LIMITS.slug).optional(), fields: z.array(field).max(200).optional(), settings: settings.optional()})), async (c) => {
    const db = c.var.db;
    const body = c.req.valid('json');
    const found = await db.form.findUnique({where: {id: c.req.param('id')}, select: {id: true, settings: true}});
    if (!found) throw notFound('Form');
    if (body.slug !== undefined) {
      if (!SLUG.test(body.slug)) throw fieldError('slug', 'The link can only use lowercase letters, numbers and dashes');
      if (await db.form.findFirst({where: {slug: body.slug, id: {not: found.id}}, select: {id: true}})) throw fieldError('slug', 'Another form already uses that link', 409);
    }
    if (body.fields) {
      const ids = body.fields.map((f) => f.id);
      if (new Set(ids).size !== ids.length) throw new HTTPException(400, {message: 'Two fields share an id'});
    }
    // The round-robin pointer is server state; keep it across edits.
    const prevNext = (found.settings as {owner?: {next?: number}}).owner?.next;
    const nextSettings = body.settings ? {...body.settings, owner: body.settings.owner ? {...body.settings.owner, next: prevNext ?? 0} : undefined} : undefined;
    const form = await db.form.update({
      where: {id: found.id},
      data: {
        name: body.name,
        slug: body.slug,
        fields: body.fields as unknown as Prisma.InputJsonValue | undefined,
        settings: nextSettings as Prisma.InputJsonValue | undefined,
      },
      select: {id: true, name: true, slug: true, updatedAt: true},
    });
    await audit(db, c, {action: 'form.updated', entity: 'form', recordId: form.id, label: form.name, meta: {changed: Object.keys(body), ...(body.slug !== undefined ? {slug: body.slug} : {})}});
    return c.json({form});
  })

  .post('/:id/status', valid('json', z.object({status: z.enum(['DRAFT', 'PUBLISHED', 'CLOSED'])})), async (c) => {
    const {status} = c.req.valid('json');
    const existing = await c.var.db.form.findUnique({where: {id: c.req.param('id')}, select: {id: true, fields: true, publishedAt: true, createdById: true}});
    if (!existing) throw notFound('Form');
    if (!canManage(currentUser(c), existing)) throw new HTTPException(403, {message: 'Only the creator or an admin can publish or close this form'});
    if (status === 'PUBLISHED' && !formFields(existing).some((f) => f.type !== 'heading' && f.type !== 'page_break' && f.type !== 'hidden')) {
      throw new HTTPException(400, {message: 'Add at least one question before publishing'});
    }
    const form = await c.var.db.form.update({
      where: {id: existing.id},
      data: {status, publishedAt: status === 'PUBLISHED' ? (existing.publishedAt ?? new Date()) : undefined},
      select: {id: true, name: true, status: true},
    });
    await audit(c.var.db, c, {action: 'form.status_changed', entity: 'form', recordId: form.id, label: form.name, meta: {status}});
    return c.json({form});
  })

  .post('/:id/duplicate', async (c) => {
    const me = currentUser(c);
    const src = await c.var.db.form.findUnique({where: {id: c.req.param('id')}});
    if (!src) throw notFound('Form');
    const name = copyName(src.name, FORM_LIMITS.name);
    const form = await c.var.db.form.create({
      data: {name, slug: await uniqueSlug(c.var.db, name), fields: src.fields as Prisma.InputJsonValue, settings: src.settings as Prisma.InputJsonValue, createdById: me.id},
      select: {id: true},
    });
    await audit(c.var.db, c, {action: 'form.duplicated', entity: 'form', recordId: form.id, label: name, meta: {from: src.id}});
    return c.json({form}, 201);
  })

  .delete('/:id', async (c) => {
    const me = currentUser(c);
    const form = await c.var.db.form.findUnique({where: {id: c.req.param('id')}, select: {id: true, name: true, createdById: true}});
    if (!form) throw notFound('Form');
    if (!canManage(me, form)) throw new HTTPException(403, {message: 'Only the creator or an admin can delete this form'});
    const [bin] = await moveToBin(c.var.db, 'form', [form.id], me);
    await audit(c.var.db, c, {action: 'form.deleted', entity: 'form', recordId: form.id, label: form.name});
    return c.json({ok: true, binId: bin?.id ?? null});
  })

  // ─── Results ───

  .get('/:id/submissions', valid('query', z.object({page: z.string().regex(/^\d{1,4}$/, 'must be a page number').transform(Number).pipe(z.number().int().min(1).max(1000)).default(1), q: z.string().trim().max(200).optional()})), async (c) => {
    const {page, q} = c.req.valid('query');
    const pageSize = 25;
    const where: Prisma.FormSubmissionWhereInput = {
      formId: c.req.param('id'),
      ...(q ? {OR: [{email: {contains: q, mode: 'insensitive'}}, {contact: {OR: [{firstName: {contains: q, mode: 'insensitive'}}, {lastName: {contains: q, mode: 'insensitive'}}]}}]} : {}),
    };
    const [rows, total] = await Promise.all([
      c.var.db.formSubmission.findMany({
        where,
        orderBy: {createdAt: 'desc'},
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {contact: {select: {id: true, firstName: true, lastName: true, email: true}}, deal: {select: {id: true, title: true}}},
      }),
      c.var.db.formSubmission.count({where}),
    ]);
    return c.json({rows, total, page, pageSize});
  })

  .get('/:id/stats', async (c) => {
    const db = c.var.db;
    const form = await db.form.findUnique({where: {id: c.req.param('id')}, select: {id: true, views: true, starts: true, submissionCount: true}});
    if (!form) throw notFound('Form');
    const since = new Date(Date.now() - 29 * 86_400_000);
    since.setUTCHours(0, 0, 0, 0);
    const recent = await db.formSubmission.findMany({where: {formId: form.id, createdAt: {gte: since}}, select: {createdAt: true}});
    const daily = Array.from({length: 30}, (_, i) => {
      const day = new Date(since.getTime() + i * 86_400_000).toISOString().slice(0, 10);
      return {day, submissions: recent.filter((r) => r.createdAt.toISOString().slice(0, 10) === day).length};
    });
    return c.json({views: form.views, starts: form.starts, submissions: form.submissionCount, daily});
  })

  .get('/:id/export', async (c) => {
    const form = await c.var.db.form.findUnique({where: {id: c.req.param('id')}});
    if (!form) throw notFound('Form');
    const subs = await c.var.db.formSubmission.findMany({where: {formId: form.id}, orderBy: {createdAt: 'asc'}, include: {contact: {select: {firstName: true, lastName: true}}}});
    // Current fields first, then answers to fields that were removed since.
    const columns = formFields(form).filter((f) => f.type !== 'heading' && f.type !== 'page_break').map((f) => ({id: f.id, label: f.label}));
    for (const s of subs) for (const a of s.answers as unknown as StoredAnswer[]) if (!columns.some((col) => col.id === a.fieldId)) columns.push({id: a.fieldId, label: a.label});
    // Same label twice ("Question") gets a number, so no column is overwritten.
    const seen = new Map<string, number>();
    const headers = columns.map((col) => {
      const n = (seen.get(col.label) ?? 0) + 1;
      seen.set(col.label, n);
      return n === 1 ? col.label : `${col.label} (${n})`;
    });
    const metaCols = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'referrer', 'page'];
    const rows = subs.map((s) => {
      const answers = s.answers as unknown as StoredAnswer[];
      const meta = (s.meta ?? {}) as Record<string, unknown>;
      return {
        'Submitted at': s.createdAt,
        Contact: s.contact ? [s.contact.firstName, s.contact.lastName].filter(Boolean).join(' ') : '',
        Email: s.email ?? '',
        ...Object.fromEntries(columns.map((col, i) => {
          const a = answers.find((x) => x.fieldId === col.id);
          return [headers[i]!, a ? answerText(a.type, a.value) : ''];
        })),
        ...Object.fromEntries(metaCols.map((k) => [k, meta[k] ?? ''])),
      };
    });
    const header = ['Submitted at', 'Contact', 'Email', ...headers, ...metaCols];
    await audit(c.var.db, c, {action: 'export.csv', entity: 'form', recordId: form.id, label: `${form.name} responses`, meta: {rows: rows.length}});
    return new Response(csv(rows, header), {
      headers: {'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${form.slug}-responses-${new Date().toISOString().slice(0, 10)}.csv"`},
    });
  })

  .delete('/submissions/:id', async (c) => {
    const sub = await c.var.db.formSubmission.findUnique({where: {id: c.req.param('id')}, select: {id: true, formId: true, email: true, form: {select: {createdById: true}}}});
    if (!sub) throw notFound('Response');
    if (!canManage(currentUser(c), sub.form)) throw new HTTPException(403, {message: 'Only the form’s creator or an admin can delete its responses'});
    await c.var.db.formSubmission.delete({where: {id: sub.id}});
    await c.var.db.form.update({where: {id: sub.formId}, data: {submissionCount: {decrement: 1}}});
    await c.var.db.activity.deleteMany({where: {type: 'form_submitted', refId: sub.id}});
    await audit(c.var.db, c, {action: 'form_response.deleted', entity: 'form_response', recordId: sub.id, label: sub.email ?? sub.id, meta: {formId: sub.formId}});
    return c.json({ok: true});
  });
