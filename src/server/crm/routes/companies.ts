import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import type {Prisma} from '../../../generated/prisma/client';
import {currentUser, type AppEnv} from '../kit/guards';
import {customDiff, diff, logActivity} from '../lib/activity';
import {audit, auditMany} from '../lib/audit';
import {cleanCustom} from '../lib/custom-fields';
import {forgetPairs, queueDuplicateCheck} from '../lib/duplicates';
import {emit, emitMany} from '../lib/events';
import {custom, httpUrl, listQuery, notFound, optStr, ownerScope, sortBy, tags, valid} from '../lib/http';
import {adoptContactsForDomain} from '../lib/domains';
import {notify, recordLink} from '../lib/notify';
import {moveToBin} from '../lib/recycle-bin';
import {rememberOption} from '../lib/settings';
import {userSelect} from '../lib/users';
import {strings} from '../lib/json-list';

export const normalizeDomain = (v: string | null | undefined) =>
  v ? v.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '') || null : v;

export const companyBody = z.object({
  name: z.string().trim().min(1, 'is required').max(200),
  domain: optStr.transform(normalizeDomain),
  industry: optStr,
  type: optStr,
  size: optStr,
  employees: z.coerce.number().int().min(0).max(10_000_000).nullish(),
  annualRevenue: z.coerce.number().min(0).max(1e13).nullish(),
  timezone: optStr,
  website: httpUrl,
  phone: optStr,
  address: optStr,
  city: optStr,
  state: optStr,
  postalCode: optStr,
  country: optStr,
  linkedin: httpUrl,
  description: optStr,
  tags: tags.optional(),
  ownerId: z.string().nullish(),
  custom: custom.optional(),
});

/** Contacts and deals shown on a company page, and where their totals stop counting ("1000+"). */
const DETAIL_ROWS = 50;
const COUNT_CAP = 1000;

/** Properties a company merge lets you choose between. */
const COMPANY_MERGE_FIELDS = ['name', 'domain', 'industry', 'type', 'size', 'employees', 'annualRevenue', 'website', 'phone', 'address', 'city', 'state', 'postalCode', 'country', 'timezone', 'linkedin', 'description', 'ownerId'] as const;

export function companyWhere(q: Record<string, string | undefined>): Prisma.CompanyWhereInput {
  const where: Prisma.CompanyWhereInput = {};
  if (q.q) {
    where.OR = [
      {name: {contains: q.q, mode: 'insensitive'}},
      {domain: {contains: q.q, mode: 'insensitive'}},
      {industry: {contains: q.q, mode: 'insensitive'}},
    ];
  }
  if (q.ownerId) where.ownerId = q.ownerId === 'none' ? null : q.ownerId;
  if (q.tag) where.tags = {array_contains: [q.tag]};
  if (q.industry) where.industry = q.industry;
  return where;
}

export const companies = new Hono<AppEnv>()
  .get('/', valid('query', listQuery.extend({industry: z.string().optional()})), async (c) => {
    const q = c.req.valid('query');
    const where = {...companyWhere(q as unknown as Record<string, string>), ...(await ownerScope(c))};
    const [rows, total] = await Promise.all([
      c.var.db.company.findMany({
        where,
        include: {owner: {select: userSelect}, _count: {select: {contacts: true, deals: {where: {status: 'OPEN'}}}}},
        orderBy: sortBy(q.sort, q.dir, ['name', 'domain', 'industry', 'createdAt', 'lastActivityAt'], 'createdAt'),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      c.var.db.company.count({where}),
    ]);
    return c.json({rows, total, page: q.page, pageSize: q.pageSize});
  })

  .post('/', valid('json', companyBody), async (c) => {
    const me = currentUser(c);
    const {custom: customInput, ...body} = c.req.valid('json');
    if (body.domain) {
      const dupe = await c.var.db.company.findFirst({where: {domain: body.domain}, select: {id: true, name: true}});
      if (dupe) throw new HTTPException(409, {message: `${dupe.name} already uses ${body.domain}`});
    }
    const company = await c.var.db.company.create({
      data: {
        ...body,
        ownerId: body.ownerId === undefined ? me.id : body.ownerId,
        custom: ((await cleanCustom(c.var.db, 'COMPANY', customInput)) ?? {}) as Prisma.InputJsonValue,
        lastActivityAt: new Date(),
      },
      include: {owner: {select: userSelect}},
    });
    await logActivity(c.var.db, {type: 'company_created', title: 'Company created', actorId: me.id, companyId: company.id});
    await emit(c.var.db, 'company.created', {recordId: company.id, actorId: me.id, data: company});
    await audit(c.var.db, c, {action: 'company.created', entity: 'company', recordId: company.id, label: company.name});
    await notify(c.var.db, [company.ownerId], {type: 'assigned', title: `${me.name} assigned you a company: ${company.name}`, link: recordLink.company(company.id), actorId: me.id});
    await rememberOption(c.var.db, 'industries', company.industry);
    await rememberOption(c.var.db, 'companyTypes', company.type);
    const linkedContacts = await adoptContactsForDomain(c.var.db, company.id, company.domain, me.id);
    // Compared with every company: a job, not this request (P2-25).
    await queueDuplicateCheck(c.var.db, 'company', company.id);
    return c.json({company, linkedContacts}, 201);
  })

  .get('/:id', async (c) => {
    const db = c.var.db;
    const scope = await ownerScope(c);
    // The page shows the 50 most recent contacts and deals; the totals are counted (up to a cap).
    const company = await db.company.findFirst({
      where: {id: c.req.param('id'), ...scope},
      include: {
        owner: {select: userSelect},
        contacts: {where: {contact: scope}, include: {contact: {include: {owner: {select: userSelect}}}}, orderBy: [{isPrimary: 'desc'}, {contact: {lastActivityAt: {sort: 'desc', nulls: 'last'}}}], take: DETAIL_ROWS},
      },
    });
    if (!company) throw notFound('Company');
    // Deals where this company is primary or one of several (that the user may see).
    const dealWhere: Prisma.DealWhereInput = {companies: {some: {companyId: company.id}}, ...scope};
    const [deals, contactCount, dealCount, sums] = await Promise.all([
      db.deal.findMany({where: dealWhere, include: {stage: true, owner: {select: userSelect}}, orderBy: {createdAt: 'desc'}, take: DETAIL_ROWS}),
      db.contactCompany.count({where: {companyId: company.id, contact: scope}, take: COUNT_CAP}),
      db.deal.count({where: dealWhere, take: COUNT_CAP}),
      db.deal.groupBy({by: ['status'], where: {...dealWhere, status: {in: ['OPEN', 'WON']}}, _sum: {value: true}}),
    ]);
    const sum = (status: string) => sums.find((s) => s.status === status)?._sum.value ?? 0;
    return c.json({company: {...company, deals, contactCount, dealCount, openValue: sum('OPEN'), wonValue: sum('WON')}});
  })

  .patch('/:id', valid('json', companyBody.partial()), async (c) => {
    const me = currentUser(c);
    const before = await c.var.db.company.findFirst({where: {id: c.req.param('id'), ...(await ownerScope(c))}});
    if (!before) throw notFound('Company');
    const {custom: customInput, ...body} = c.req.valid('json');
    const customValue = await cleanCustom(c.var.db, 'COMPANY', customInput, before.custom);
    const company = await c.var.db.company.update({
      where: {id: before.id},
      data: {...body, custom: customValue as Prisma.InputJsonValue | undefined},
      include: {owner: {select: userSelect}},
    });
    if (body.industry) await rememberOption(c.var.db, 'industries', body.industry);
    if (body.type) await rememberOption(c.var.db, 'companyTypes', body.type);
    if (body.domain && body.domain !== before.domain) await adoptContactsForDomain(c.var.db, company.id, body.domain, me.id);
    // Custom field edits count as changes too ("field changed" automations, timeline, audit).
    const changes = [...diff(before, body), ...(customInput ? customDiff(before.custom, company.custom) : [])];
    if (changes.length) {
      await logActivity(c.var.db, {type: 'field_changed', title: 'Company updated', actorId: me.id, companyId: company.id, data: {changes} as Prisma.InputJsonValue});
      await emit(c.var.db, 'company.updated', {recordId: company.id, actorId: me.id, data: {...company, changes}});
      await audit(c.var.db, c, {action: 'company.updated', entity: 'company', recordId: company.id, label: company.name, meta: {changes}});
      if (changes.some((ch) => ['name', 'domain', 'website'].includes(ch.field))) await queueDuplicateCheck(c.var.db, 'company', company.id);
    }
    if (company.ownerId !== before.ownerId) {
      await notify(c.var.db, [company.ownerId], {type: 'assigned', title: `${me.name} assigned you a company: ${company.name}`, link: recordLink.company(company.id), actorId: me.id});
    }
    return c.json({company});
  })

  .delete('/:id', async (c) => {
    const found = await c.var.db.company.findFirst({where: {id: c.req.param('id'), ...(await ownerScope(c))}});
    if (!found) throw notFound('Company');
    const me = currentUser(c);
    const [bin] = await moveToBin(c.var.db, 'company', [found.id], me);
    await emit(c.var.db, 'company.deleted', {recordId: found.id, actorId: me.id, data: found});
    await audit(c.var.db, c, {action: 'company.deleted', entity: 'company', recordId: found.id, label: found.name});
    return c.json({ok: true, binId: bin?.id ?? null});
  })

  .post('/bulk', valid('json', z.object({ids: z.array(z.string()).min(1).max(500), action: z.enum(['delete', 'assign']), value: z.string().optional()})), async (c) => {
    const me = currentUser(c);
    const db = c.var.db;
    const {ids, action, value} = c.req.valid('json');
    const where = {id: {in: ids}, ...(await ownerScope(c))};
    if (action === 'delete') {
      const gone = await db.company.findMany({where});
      await moveToBin(db, 'company', gone.map((r) => r.id), me);
      // One batch of events and one of audit rows, not a few queries per record.
      await emitMany(db, 'company.deleted', gone.map((row) => ({recordId: row.id, actorId: me.id, data: row})));
      await auditMany(db, c, gone.map((r) => ({action: 'company.deleted', entity: 'company', recordId: r.id, label: r.name, meta: {bulk: true}})));
    }
    if (action === 'assign') {
      const rows = await db.company.findMany({where, select: {id: true, name: true, ownerId: true}});
      await auditMany(db, c, rows.map((r) => ({action: 'company.bulk_updated', entity: 'company', recordId: r.id, label: r.name, meta: {action, value, changes: diff(r, {ownerId: value || null})}})));
      const {count} = await db.company.updateMany({where, data: {ownerId: value || null}});
      await notify(db, [value], {type: 'assigned', title: `${me.name} assigned you ${count} compan${count === 1 ? 'y' : 'ies'}`, link: '/companies', actorId: me.id});
    }
    return c.json({ok: true});
  })

  // Merge `otherId` with this company. Contacts, deals and all activity move to the kept record.
  .post('/:id/merge', valid('json', z.object({
    otherId: z.string(),
    keep: z.enum(['this', 'other']).default('this'),
    fields: z.record(z.string(), z.enum(['this', 'other'])).default({}),
  })), async (c) => {
    const me = currentUser(c);
    const db = c.var.db;
    const {otherId, keep, fields} = c.req.valid('json');
    const thisId = c.req.param('id');
    if (thisId === otherId) throw new HTTPException(400, {message: 'Pick a different company'});
    // Both must be visible to the user: a merge takes the other's history and deletes it for good.
    const scope = await ownerScope(c);
    const [a, b] = await Promise.all([
      db.company.findFirst({where: {id: thisId, ...scope}, include: {contacts: true}}),
      db.company.findFirst({where: {id: otherId, ...scope}, include: {contacts: true}}),
    ]);
    if (!a || !b) throw notFound('Company');
    const [survivor, dropped] = keep === 'this' ? [a, b] : [b, a];
    const pick = (f: (typeof COMPANY_MERGE_FIELDS)[number]) => (fields[f] === 'this' ? a[f] : fields[f] === 'other' ? b[f] : (survivor[f] ?? dropped[f]));
    const data = Object.fromEntries(COMPANY_MERGE_FIELDS.map((f) => [f, pick(f)])) as Prisma.CompanyUncheckedUpdateInput;
    const keepId = survivor.id;
    const dropId = dropped.id;
    const merged = {...data, tags: [...new Set([...strings(survivor.tags), ...strings(dropped.tags)])], custom: {...(dropped.custom as object), ...(survivor.custom as object)}};
    // What the merge changed on the survivor, for the audit log and property history.
    const changes = [...diff(survivor, {...merged, custom: undefined}), ...customDiff(survivor.custom, merged.custom)];
    await db.$transaction([
      // Its own history entries follow it to the timeline, but aren't the survivor's property history.
      db.$executeRaw`UPDATE "Activity" SET "data" = "data" || jsonb_build_object('mergedFrom', ${dropId}::text) WHERE "companyId" = ${dropId} AND "contactId" IS NULL AND "dealId" IS NULL AND "type" IN ('field_changed', 'company_created', 'merged', 'restored')`,
      ...dropped.contacts
        .filter((l) => !survivor.contacts.some((k) => k.contactId === l.contactId))
        .map((l) => db.contactCompany.create({data: {contactId: l.contactId, companyId: keepId, role: l.role, isPrimary: l.isPrimary}})),
      db.deal.updateMany({where: {companyId: dropId}, data: {companyId: keepId}}),
      db.$executeRaw`INSERT INTO "DealCompany" ("dealId", "companyId", "isPrimary") SELECT "dealId", ${keepId}, "isPrimary" FROM "DealCompany" WHERE "companyId" = ${dropId} ON CONFLICT DO NOTHING`,
      db.note.updateMany({where: {companyId: dropId}, data: {companyId: keepId}}),
      db.task.updateMany({where: {companyId: dropId}, data: {companyId: keepId}}),
      db.activity.updateMany({where: {companyId: dropId}, data: {companyId: keepId}}),
      db.interaction.updateMany({where: {companyId: dropId}, data: {companyId: keepId}}),
      db.emailThread.updateMany({where: {companyId: dropId}, data: {companyId: keepId}}),
      db.file.updateMany({where: {companyId: dropId}, data: {companyId: keepId}}),
      // Links the database would only clear: tickets and followers.
      db.ticket.updateMany({where: {companyId: dropId}, data: {companyId: keepId}}),
      // Automation history (and so re-enrollment) follows the survivor.
      db.automationRun.updateMany({where: {object: 'company', recordId: dropId}, data: {recordId: keepId}}),
      db.$executeRaw`INSERT INTO "Follow" ("userId", "entity", "recordId", "createdAt") SELECT "userId", "entity", ${keepId}, "createdAt" FROM "Follow" WHERE "entity" = 'COMPANY' AND "recordId" = ${dropId} ON CONFLICT DO NOTHING`,
      db.follow.deleteMany({where: {entity: 'COMPANY', recordId: dropId}}),
      db.company.update({where: {id: keepId}, data: merged}),
      db.company.delete({where: {id: dropId}}),
    ]);
    await logActivity(db, {type: 'merged', title: `Merged with ${dropped.name}`, actorId: me.id, companyId: keepId});
    await emit(db, 'company.merged', {recordId: keepId, actorId: me.id, data: {keptId: keepId, droppedId: dropId, dropped}});
    await forgetPairs(db, [dropId]);
    await audit(db, c, {action: 'company.merged', entity: 'company', recordId: keepId, label: String(data.name ?? survivor.name), meta: {droppedId: dropId, dropped: dropped.name, droppedDomain: dropped.domain, fields, changes}});
    await queueDuplicateCheck(db, 'company', keepId);
    return c.json({ok: true, keptId: keepId});
  })

  .post('/:id/clone', async (c) => {
    const me = currentUser(c);
    const src = await c.var.db.company.findFirst({where: {id: c.req.param('id'), ...(await ownerScope(c))}});
    if (!src) throw notFound('Company');
    const {id: _id, createdAt: _c, updatedAt: _u, lastActivityAt: _l, domain: _d, ...fields} = src;
    // Domain stays with the original so email-domain matching remains unambiguous.
    const copy = await c.var.db.company.create({data: {...fields, custom: src.custom as Prisma.InputJsonValue, tags: strings(src.tags), name: `${src.name} (copy)`, lastActivityAt: new Date()}});
    await logActivity(c.var.db, {type: 'company_created', title: `Cloned from ${src.name}`, actorId: me.id, companyId: copy.id});
    await emit(c.var.db, 'company.created', {recordId: copy.id, actorId: me.id, data: copy});
    await audit(c.var.db, c, {action: 'company.cloned', entity: 'company', recordId: copy.id, label: copy.name, meta: {from: src.id}});
    return c.json({company: copy}, 201);
  })

  .get('/:id/export', async (c) => {
    const db = c.var.db;
    const id = c.req.param('id');
    const scope = await ownerScope(c);
    const company = await db.company.findFirst({
      where: {id, ...scope},
      include: {owner: {select: userSelect}, contacts: {where: {contact: scope}, include: {contact: true}}, deals: {where: scope, include: {stage: true}}},
    });
    if (!company) throw notFound('Company');
    const [notes, tasks, interactions, activities] = await Promise.all([
      db.note.findMany({where: {companyId: id}, orderBy: {createdAt: 'asc'}}),
      db.task.findMany({where: {companyId: id}, orderBy: {createdAt: 'asc'}}),
      db.interaction.findMany({where: {companyId: id}, orderBy: {occurredAt: 'asc'}}),
      db.activity.findMany({where: {companyId: id}, orderBy: {createdAt: 'asc'}, select: {type: true, title: true, data: true, createdAt: true}}),
    ]);
    const body = JSON.stringify({exportedAt: new Date().toISOString(), company, notes, tasks, interactions, activities}, null, 2);
    const slug = company.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    await audit(db, c, {action: 'export.json', entity: 'company', recordId: id, label: company.name});
    return new Response(body, {headers: {'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="company-${slug}.json"`}});
  });
