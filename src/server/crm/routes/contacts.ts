import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import {Prisma} from '../../../generated/prisma/client';
import {currentUser, type AppEnv} from '../kit/guards';
import {customDiff, diff, logActivity} from '../lib/activity';
import {audit, auditMany} from '../lib/audit';
import {cleanCustom} from '../lib/custom-fields';
import {forgetPairs, queueDuplicateCheck} from '../lib/duplicates';
import {emit, emitMany} from '../lib/events';
import {assertVisible, custom, fieldError, httpUrl, intParam, listQuery, notFound, optStr, ownerScope, sortBy, tags, valid} from '../lib/http';
import {associateByDomain} from '../lib/domains';
import {notify, recordLink} from '../lib/notify';
import {moveScoreEvents, scoreBandWhere} from '../lib/scoring';
import {queueRescore} from '../lib/scoring-hook';
import {moveToBin} from '../lib/recycle-bin';
import {listContactWhere} from '../lib/segments';
import {rememberOption} from '../lib/settings';
import {userSelect} from '../lib/users';
import {strings} from '../lib/json-list';

const lifecycle = z.enum(['LEAD', 'QUALIFIED', 'OPPORTUNITY', 'CUSTOMER', 'CHURNED', 'OTHER']);

export const contactBody = z.object({
  firstName: z.string().trim().min(1, 'is required').max(100),
  lastName: optStr,
  email: z.union([z.email(), z.literal('')]).nullish().transform((v) => (v ? v.toLowerCase() : v === '' ? null : v)),
  phone: optStr,
  title: optStr,
  linkedin: httpUrl,
  lifecycleStage: lifecycle.optional(),
  leadStatus: optStr,
  buyingRole: optStr,
  emailOptOut: z.boolean().optional(),
  city: optStr,
  country: optStr,
  source: optStr,
  tags: tags.optional(),
  ownerId: z.string().nullish(),
  custom: custom.optional(),
  companyId: z.string().nullish(), // convenience: link a primary company on create
});

export const contactInclude = {
  owner: {select: userSelect},
  companies: {include: {company: {select: {id: true, name: true, domain: true}}}, orderBy: {isPrimary: 'desc'}},
} satisfies Prisma.ContactInclude;

export const contactName = (c: {firstName: string; lastName: string | null}) => [c.firstName, c.lastName].filter(Boolean).join(' ');

/** Properties a merge lets you choose between. */
export const MERGE_FIELDS = ['firstName', 'lastName', 'email', 'phone', 'title', 'linkedin', 'lifecycleStage', 'leadStatus', 'buyingRole', 'city', 'country', 'source', 'ownerId'] as const;

export function contactWhere(q: Record<string, string | undefined>): Prisma.ContactWhereInput {
  const where: Prisma.ContactWhereInput = {};
  if (q.q) {
    const terms = q.q.trim().split(/\s+/);
    where.AND = terms.map((t) => ({
      OR: [
        {firstName: {contains: t, mode: 'insensitive'}},
        {lastName: {contains: t, mode: 'insensitive'}},
        {email: {contains: t, mode: 'insensitive'}},
        {phone: {contains: t}},
        {title: {contains: t, mode: 'insensitive'}},
        {companies: {some: {company: {name: {contains: t, mode: 'insensitive'}}}}},
      ],
    }));
  }
  if (q.ownerId) where.ownerId = q.ownerId === 'none' ? null : q.ownerId;
  if (q.tag) where.tags = {array_contains: [q.tag]};
  if (q.lifecycleStage) where.lifecycleStage = q.lifecycleStage as Prisma.ContactWhereInput['lifecycleStage'];
  if (q.source) where.source = q.source;
  if (q.companyId) where.companies = {some: {companyId: q.companyId}};
  // Other callers (exports) pass the raw query string: a non-number is ignored, never an Invalid Date.
  const idleDays = Number(q.noActivityDays);
  if (q.noActivityDays && Number.isInteger(idleDays) && idleDays > 0 && idleDays <= 36_500) where.OR = [{lastActivityAt: null}, {lastActivityAt: {lt: new Date(Date.now() - idleDays * 86400_000)}}];
  return where;
}

export const contacts = new Hono<AppEnv>()
  .get('/', valid('query', listQuery.extend({lifecycleStage: lifecycle.optional(), source: z.string().optional(), companyId: z.string().optional(), noActivityDays: intParam(1, 36_500).optional(), listId: z.string().optional(), scoreBand: z.string().max(30).optional()})), async (c) => {
    const q = c.req.valid('query');
    const plain = contactWhere(q as unknown as Record<string, string>);
    const base = q.scoreBand ? {AND: [plain, await scoreBandWhere(c.var.db, q.scoreBand)]} : plain;
    const where = {...(q.listId ? {AND: [base, await listContactWhere(c.var.db, q.listId)]} : base), ...(await ownerScope(c))};
    const [rows, total] = await Promise.all([
      c.var.db.contact.findMany({
        where,
        include: {...contactInclude, _count: {select: {deals: true, tasks: {where: {done: false}}}}},
        orderBy: sortBy(q.sort, q.dir, ['firstName', 'lastName', 'email', 'createdAt', 'lastActivityAt', 'lifecycleStage', 'score'], 'createdAt'),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      c.var.db.contact.count({where}),
    ]);
    return c.json({rows, total, page: q.page, pageSize: q.pageSize});
  })

  .post('/', valid('json', contactBody), async (c) => {
    const me = currentUser(c);
    const {companyId, custom: customInput, ...body} = c.req.valid('json');
    if (companyId) await assertVisible(c, {companyId});
    if (body.email) {
      const dupe = await c.var.db.contact.findFirst({where: {email: body.email}, select: {id: true}});
      if (dupe) throw fieldError('email', `A contact with ${body.email} already exists`, 409);
    }
    const contact = await c.var.db.contact.create({
      data: {
        ...body,
        ownerId: body.ownerId === undefined ? me.id : body.ownerId,
        custom: (await cleanCustom(c.var.db, 'CONTACT', customInput)) as Prisma.InputJsonValue ?? {},
        lastActivityAt: new Date(),
        companies: companyId ? {create: {companyId, isPrimary: true}} : undefined,
      },
      include: contactInclude,
    });
    await rememberOption(c.var.db, 'sources', contact.source);
    await logActivity(c.var.db, {type: 'contact_created', title: 'Contact created', actorId: me.id, contactId: contact.id, companyId});
    await emit(c.var.db, 'contact.created', {recordId: contact.id, actorId: me.id, data: contact});
    await audit(c.var.db, c, {action: 'contact.created', entity: 'contact', recordId: contact.id, label: contactName(contact)});
    await notify(c.var.db, [contact.ownerId], {type: 'assigned', title: `${me.name} assigned you a contact: ${contactName(contact)}`, link: recordLink.contact(contact.id), actorId: me.id});
    const linked = companyId ? null : await associateByDomain(c.var.db, contact.id, me.id);
    // Compared with every contact: a job, not this request (P2-25).
    await queueDuplicateCheck(c.var.db, 'contact', contact.id);
    return c.json({contact, linkedCompany: linked}, 201);
  })

  .get('/:id', async (c) => {
    const scope = await ownerScope(c);
    const contact = await c.var.db.contact.findFirst({
      where: {id: c.req.param('id'), ...scope},
      include: {
        ...contactInclude,
        // Only deals the user may see (owner-only visibility).
        deals: {where: {deal: scope}, include: {deal: {include: {stage: true, owner: {select: userSelect}}}}},
      },
    });
    if (!contact) throw notFound('Contact');
    return c.json({contact});
  })

  .patch('/:id', valid('json', contactBody.partial()), async (c) => {
    const me = currentUser(c);
    const db = c.var.db;
    const before = await db.contact.findFirst({where: {id: c.req.param('id'), ...(await ownerScope(c))}});
    if (!before) throw notFound('Contact');
    const {companyId: _ignored, custom: customInput, ...body} = c.req.valid('json');
    const customValue = await cleanCustom(db, 'CONTACT', customInput, before.custom);
    const contact = await db.contact.update({
      where: {id: before.id},
      data: {...body, custom: customValue as Prisma.InputJsonValue | undefined},
      include: contactInclude,
    });
    if (body.source) await rememberOption(db, 'sources', body.source);
    if (body.email && body.email !== before.email) await associateByDomain(db, contact.id, me.id);
    // Custom field edits count as changes too ("field changed" automations, timeline, audit).
    const changes = [...diff(before, body), ...(customInput ? customDiff(before.custom, contact.custom) : [])];
    if (changes.length) {
      await logActivity(db, {type: 'field_changed', title: 'Contact updated', actorId: me.id, contactId: contact.id, data: {changes} as Prisma.InputJsonValue});
      await emit(db, 'contact.updated', {recordId: contact.id, actorId: me.id, data: {...contact, changes}});
      await audit(db, c, {action: 'contact.updated', entity: 'contact', recordId: contact.id, label: contactName(contact), meta: {changes}});
      if (changes.some((ch) => ['firstName', 'lastName', 'email', 'phone'].includes(ch.field))) await queueDuplicateCheck(db, 'contact', contact.id);
    }
    if (contact.ownerId !== before.ownerId) {
      await notify(db, [contact.ownerId], {type: 'assigned', title: `${me.name} assigned you a contact: ${contactName(contact)}`, link: recordLink.contact(contact.id), actorId: me.id});
    }
    return c.json({contact});
  })

  .delete('/:id', async (c) => {
    const found = await c.var.db.contact.findFirst({where: {id: c.req.param('id'), ...(await ownerScope(c))}});
    if (!found) throw notFound('Contact');
    const me = currentUser(c);
    const [bin] = await moveToBin(c.var.db, 'contact', [found.id], me);
    await emit(c.var.db, 'contact.deleted', {recordId: found.id, actorId: me.id, data: found});
    await audit(c.var.db, c, {action: 'contact.deleted', entity: 'contact', recordId: found.id, label: contactName(found)});
    return c.json({ok: true, binId: bin?.id ?? null});
  })

  .post('/bulk', valid('json', z.object({
    ids: z.array(z.string().max(40)).min(1).max(500),
    action: z.enum(['delete', 'assign', 'tag', 'untag', 'stage']),
    value: z.string().trim().max(100).optional(),
  })), async (c) => {
    const {ids, action, value} = c.req.valid('json');
    const db = c.var.db;
    const me = currentUser(c);
    const scope = await ownerScope(c);
    const where = {id: {in: ids}, ...scope};
    if (action === 'delete') {
      const gone = await db.contact.findMany({where});
      await moveToBin(db, 'contact', gone.map((r) => r.id), me);
      // One batch of events and one of audit rows, not a few queries per record.
      await emitMany(db, 'contact.deleted', gone.map((row) => ({recordId: row.id, actorId: me.id, data: row})));
      await auditMany(db, c, gone.map((r) => ({action: 'contact.deleted', entity: 'contact', recordId: r.id, label: contactName(r), meta: {bulk: true}})));
    }
    // Values before the edit, so the audit log (and property history) shows old → new per record.
    const before = action === 'delete' ? [] : await db.contact.findMany({where, select: {id: true, firstName: true, lastName: true, ownerId: true, lifecycleStage: true, tags: true}});
    if (action === 'assign') {
      const {count} = await db.contact.updateMany({where, data: {ownerId: value || null}});
      await notify(db, [value], {type: 'assigned', title: `${me.name} assigned you ${count} contact${count === 1 ? '' : 's'}`, link: '/contacts', actorId: me.id});
    }
    if (action === 'stage' && value) {
      const stage = lifecycle.safeParse(value);
      if (!stage.success) throw new HTTPException(400, {message: 'Pick a lifecycle stage'});
      await db.contact.updateMany({where, data: {lifecycleStage: stage.data}});
    }
    if ((action === 'tag' || action === 'untag') && value && before.length) {
      // ONE set-based statement for the whole selection (not one update per record). It acts only on
      // `before`, the records this user may see (`where` carries the owner scope), and skips records
      // that already have (tag) / don't have (untag) the tag.
      const ids = Prisma.join(before.map((r) => r.id));
      const tag = Prisma.sql`jsonb_build_array(${value}::text)`;
      await (action === 'tag'
        ? db.$executeRaw`UPDATE "Contact" SET "tags" = "tags" || ${tag}, "updatedAt" = ${new Date()} WHERE "id" IN (${ids}) AND NOT ("tags" @> ${tag})`
        : db.$executeRaw`UPDATE "Contact" SET "tags" = "tags" - ${value}::text, "updatedAt" = ${new Date()} WHERE "id" IN (${ids}) AND "tags" @> ${tag}`);
    }
    if (action !== 'delete') await queueRescore(db, before.map((r) => r.id));
    if (action !== 'delete') {
      const after = new Map((await db.contact.findMany({where: {id: {in: before.map((r) => r.id)}}, select: {id: true, ownerId: true, lifecycleStage: true, tags: true}})).map((r) => [r.id, r]));
      await auditMany(db, c, before.map((r) => {
        const now = after.get(r.id);
        const changes = now ? diff(r, {ownerId: now.ownerId, lifecycleStage: now.lifecycleStage, tags: now.tags}) : [];
        return {action: 'contact.bulk_updated', entity: 'contact', recordId: r.id, label: contactName(r), meta: {action, value, changes}};
      }));
    }
    return c.json({ok: true});
  })

  // Link / unlink companies
  .post('/:id/companies', valid('json', z.object({companyId: z.string(), role: optStr, isPrimary: z.boolean().optional()})), async (c) => {
    const {companyId, role, isPrimary} = c.req.valid('json');
    const contactId = c.req.param('id');
    await assertVisible(c, {contactId, companyId});
    if (isPrimary) await c.var.db.contactCompany.updateMany({where: {contactId}, data: {isPrimary: false}});
    await c.var.db.contactCompany.upsert({
      where: {contactId_companyId: {contactId, companyId}},
      create: {contactId, companyId, role, isPrimary: isPrimary ?? false},
      update: {role, isPrimary},
    });
    await queueRescore(c.var.db, [contactId]);
    return c.json({ok: true});
  })
  .delete('/:id/companies/:companyId', async (c) => {
    await assertVisible(c, {contactId: c.req.param('id')});
    await c.var.db.contactCompany.deleteMany({where: {contactId: c.req.param('id'), companyId: c.req.param('companyId')}});
    await queueRescore(c.var.db, [c.req.param('id')]);
    return c.json({ok: true});
  })

  // Merge two contacts. `keep` picks the surviving record; `fields` picks, per property,
  // whose value wins (default: the survivor's, falling back to the other's when empty).
  .post('/:id/merge', valid('json', z.object({
    otherId: z.string(),
    keep: z.enum(['this', 'other']).default('this'),
    fields: z.record(z.string(), z.enum(['this', 'other'])).default({}),
  })), async (c) => {
    const me = currentUser(c);
    const db = c.var.db;
    const {otherId, keep, fields} = c.req.valid('json');
    const thisId = c.req.param('id');
    if (thisId === otherId) throw new HTTPException(400, {message: 'Pick a different contact'});
    // Both must be visible to the user: a merge takes the other's history and deletes it for good.
    const scope = await ownerScope(c);
    const [a, b] = await Promise.all([
      db.contact.findFirst({where: {id: thisId, ...scope}, include: {companies: true, deals: true, listMemberships: true}}),
      db.contact.findFirst({where: {id: otherId, ...scope}, include: {companies: true, deals: true, listMemberships: true}}),
    ]);
    if (!a || !b) throw notFound('Contact');
    const [survivor, dropped] = keep === 'this' ? [a, b] : [b, a];
    const pick = (field: (typeof MERGE_FIELDS)[number]) => {
      const choice = fields[field];
      const fromThis = a[field];
      const fromOther = b[field];
      if (choice === 'this') return fromThis;
      if (choice === 'other') return fromOther;
      return survivor[field] ?? dropped[field];
    };
    const data = Object.fromEntries(MERGE_FIELDS.map((f) => [f, pick(f)])) as Prisma.ContactUncheckedUpdateInput;
    const keepId = survivor.id;
    const dropId = dropped.id;
    const merged = {
      ...data,
      tags: [...new Set([...strings(survivor.tags), ...strings(dropped.tags)])],
      custom: {...(dropped.custom as object), ...(survivor.custom as object)},
      emailOptOut: survivor.emailOptOut || dropped.emailOptOut,
    };
    // What the merge changed on the survivor, for the audit log and property history.
    const changes = [...diff(survivor, {...merged, custom: undefined}), ...customDiff(survivor.custom, merged.custom)];

    await db.$transaction([
      // The dropped record's email must be released before the survivor can take it.
      db.contact.update({where: {id: dropId}, data: {email: null}}),
      // Its own history entries follow it to the timeline, but aren't the survivor's property history.
      db.$executeRaw`UPDATE "Activity" SET "data" = "data" || jsonb_build_object('mergedFrom', ${dropId}::text) WHERE "contactId" = ${dropId} AND "type" IN ('field_changed', 'contact_created', 'merged', 'restored')`,
      db.note.updateMany({where: {contactId: dropId}, data: {contactId: keepId}}),
      db.task.updateMany({where: {contactId: dropId}, data: {contactId: keepId}}),
      db.activity.updateMany({where: {contactId: dropId}, data: {contactId: keepId}}),
      db.interaction.updateMany({where: {contactId: dropId}, data: {contactId: keepId}}),
      db.emailThread.updateMany({where: {contactId: dropId}, data: {contactId: keepId}}),
      db.emailMessage.updateMany({where: {contactId: dropId}, data: {contactId: keepId}}),
      db.channelIdentity.updateMany({where: {contactId: dropId}, data: {contactId: keepId}}),
      db.channelMessage.updateMany({where: {contactId: dropId}, data: {contactId: keepId}}),
      db.file.updateMany({where: {contactId: dropId}, data: {contactId: keepId}}),
      moveScoreEvents(db, dropId, keepId),
      // Links the database would only clear: tickets, form responses, bookings, meeting attendees, followers.
      db.ticket.updateMany({where: {contactId: dropId}, data: {contactId: keepId}}),
      db.formSubmission.updateMany({where: {contactId: dropId}, data: {contactId: keepId}}),
      db.booking.updateMany({where: {contactId: dropId}, data: {contactId: keepId}}),
      // Automation history (and so re-enrollment) follows the survivor.
      db.automationRun.updateMany({where: {object: 'contact', recordId: dropId}, data: {recordId: keepId}}),
      // Meetings the dropped contact attended list the survivor instead (once).
      db.$executeRaw`UPDATE "Interaction" SET "attendeeIds" = (SELECT COALESCE(jsonb_agg(DISTINCT CASE WHEN a.v = ${dropId}::text THEN ${keepId}::text ELSE a.v END), '[]'::jsonb) FROM jsonb_array_elements_text("attendeeIds") AS a(v)) WHERE "attendeeIds" @> jsonb_build_array(${dropId}::text)`,
      db.$executeRaw`INSERT INTO "Follow" ("userId", "entity", "recordId", "createdAt") SELECT "userId", "entity", ${keepId}, "createdAt" FROM "Follow" WHERE "entity" = 'CONTACT' AND "recordId" = ${dropId} ON CONFLICT DO NOTHING`,
      db.follow.deleteMany({where: {entity: 'CONTACT', recordId: dropId}}),
      ...dropped.companies
        .filter((l) => !survivor.companies.some((k) => k.companyId === l.companyId))
        .map((l) => db.contactCompany.create({data: {contactId: keepId, companyId: l.companyId, role: l.role, isPrimary: l.isPrimary && survivor.companies.length === 0}})),
      ...dropped.deals
        .filter((l) => !survivor.deals.some((k) => k.dealId === l.dealId))
        .map((l) => db.dealContact.create({data: {contactId: keepId, dealId: l.dealId}})),
      ...dropped.listMemberships
        .filter((m) => !survivor.listMemberships.some((k) => k.listId === m.listId))
        .map((m) => db.contactListMember.create({data: {listId: m.listId, contactId: keepId, source: 'merge', addedById: m.addedById, createdAt: m.createdAt}})),
      db.contact.update({where: {id: keepId}, data: merged}),
      db.contact.delete({where: {id: dropId}}),
    ]);
    await logActivity(db, {type: 'merged', title: `Merged with ${contactName(dropped)}`, actorId: me.id, contactId: keepId, data: {droppedId: dropId}});
    await emit(db, 'contact.merged', {recordId: keepId, actorId: me.id, data: {keptId: keepId, droppedId: dropId, dropped}});
    // The survivor now holds both contacts' score history; recompute its score from it.
    await queueRescore(db, [keepId]);
    await forgetPairs(db, [dropId]);
    await audit(db, c, {action: 'contact.merged', entity: 'contact', recordId: keepId, label: contactName({firstName: String(data.firstName ?? survivor.firstName), lastName: (data.lastName as string | null) ?? null}), meta: {droppedId: dropId, dropped: contactName(dropped), droppedEmail: dropped.email, fields, changes}});
    await queueDuplicateCheck(db, 'contact', keepId);
    return c.json({ok: true, keptId: keepId});
  })

  // Copy a contact (without email, which must stay unique).
  .post('/:id/clone', async (c) => {
    const me = currentUser(c);
    const src = await c.var.db.contact.findFirst({where: {id: c.req.param('id'), ...(await ownerScope(c))}, include: {companies: true}});
    if (!src) throw notFound('Contact');
    const {id: _id, createdAt: _c, updatedAt: _u, lastActivityAt: _l, email: _e, companies, ...fields} = src;
    const copy = await c.var.db.contact.create({
      data: {
        ...fields,
        custom: src.custom as Prisma.InputJsonValue,
        tags: strings(src.tags),
        firstName: src.firstName,
        lastName: `${src.lastName ?? ''} (copy)`.trim(),
        lastActivityAt: new Date(),
        companies: {create: companies.map((l) => ({companyId: l.companyId, role: l.role, isPrimary: l.isPrimary}))},
      },
    });
    await logActivity(c.var.db, {type: 'contact_created', title: `Cloned from ${contactName(src)}`, actorId: me.id, contactId: copy.id});
    await emit(c.var.db, 'contact.created', {recordId: copy.id, actorId: me.id, data: copy});
    await audit(c.var.db, c, {action: 'contact.cloned', entity: 'contact', recordId: copy.id, label: contactName(copy), meta: {from: src.id}});
    return c.json({contact: copy}, 201);
  })

  // Everything we hold about one person, as a JSON download (data-subject requests, hand-offs).
  .get('/:id/export', async (c) => {
    const db = c.var.db;
    const id = c.req.param('id');
    const contact = await db.contact.findFirst({
      where: {id, ...(await ownerScope(c))},
      include: {owner: {select: userSelect}, companies: {include: {company: true}}, deals: {include: {deal: {include: {stage: true}}}}},
    });
    if (!contact) throw notFound('Contact');
    const [notes, tasks, interactions, emails, activities] = await Promise.all([
      db.note.findMany({where: {contactId: id}, orderBy: {createdAt: 'asc'}}),
      db.task.findMany({where: {contactId: id}, orderBy: {createdAt: 'asc'}}),
      db.interaction.findMany({where: {OR: [{contactId: id}, {attendeeIds: {array_contains: [id]}}]}, orderBy: {occurredAt: 'asc'}}),
      db.emailMessage.findMany({
        where: {contactId: id},
        orderBy: {sentAt: 'asc'},
        select: {direction: true, status: true, fromEmail: true, to: true, cc: true, subject: true, text: true, sentAt: true, openCount: true, clickCount: true},
      }),
      db.activity.findMany({where: {contactId: id}, orderBy: {createdAt: 'asc'}, select: {type: true, title: true, data: true, createdAt: true}}),
    ]);
    const body = JSON.stringify({exportedAt: new Date().toISOString(), contact, notes, tasks, interactions, emails, activities}, null, 2);
    const slug = contactName(contact).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    await audit(db, c, {action: 'export.json', entity: 'contact', recordId: id, label: contactName(contact)});
    return new Response(body, {headers: {'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="contact-${slug}.json"`}});
  });
