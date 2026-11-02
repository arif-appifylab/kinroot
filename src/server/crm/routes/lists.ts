import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import type {ContactList, Prisma} from '../../../generated/prisma/client';
import {asRules, referencedLists} from '@/lib/segments';
import {currentUser, isAdmin, type AppContext, type AppEnv} from '../kit/guards';
import {audit} from '../lib/audit';
import {notFound, optStr, ownerScope, sortBy, valid} from '../lib/http';
import {moveToBin} from '../lib/recycle-bin';
import {addToList, assertNoCycle, listContactWhere, loadSegmentDefs, removeFromList, segmentRulesSchema, segmentWhere, type CustomDefs} from '../lib/segments';
import {userSelect} from '../lib/users';
import {contactInclude, contactWhere} from './contacts';

const kind = z.enum(['STATIC', 'DYNAMIC']);
const ids = z.array(z.string()).min(1).max(500);

const listBody = z.object({
  name: z.string().trim().min(1, 'is required').max(120),
  description: optStr,
  kind: kind.default('STATIC'),
  rules: segmentRulesSchema.optional(),
  contactIds: z.array(z.string()).max(500).optional(), // "new list from selection"
});

const listSelect = {
  id: true,
  name: true,
  description: true,
  kind: true,
  rules: true,
  ownerId: true,
  createdAt: true,
  updatedAt: true,
  owner: {select: userSelect},
} satisfies Prisma.ContactListSelect;

/** Members the signed-in user may see (owner-scoped installs only count their own contacts). */
async function scopedWhere(c: AppContext, list: Pick<ContactList, 'id' | 'kind' | 'rules'>, defs?: CustomDefs): Promise<Prisma.ContactWhereInput> {
  return {AND: [await listContactWhere(c.var.db, list, {defs})], ...(await ownerScope(c))};
}

async function findList(c: AppContext) {
  const list = await c.var.db.contactList.findUnique({where: {id: c.req.param('id')}, select: listSelect});
  if (!list) throw notFound('List');
  return list;
}

function assertCanEdit(c: AppContext, list: {ownerId: string | null}) {
  const me = currentUser(c);
  if (list.ownerId && list.ownerId !== me.id && !isAdmin(me)) throw new HTTPException(403, {message: 'Only the list owner or an admin can change this list'});
}

/** Contact ids from the request that the user may see. */
async function visibleIds(c: AppContext, contactIds: string[]) {
  const rows = await c.var.db.contact.findMany({where: {id: {in: contactIds}, ...(await ownerScope(c))}, select: {id: true}});
  return rows.map((r) => r.id);
}

export const lists = new Hono<AppEnv>()
  .get('/', valid('query', z.object({q: z.string().trim().max(100).optional(), kind: kind.optional()})), async (c) => {
    const {q, kind: k} = c.req.valid('query');
    const rows = await c.var.db.contactList.findMany({
      where: {...(q ? {name: {contains: q, mode: 'insensitive'}} : {}), ...(k ? {kind: k} : {})},
      select: listSelect,
      orderBy: {updatedAt: 'desc'},
    });
    // Static lists in one grouped query; segments one count each (in sequence: local Postgres has few connections).
    const scope = await ownerScope(c);
    const grouped = await c.var.db.contactListMember.groupBy({by: ['listId'], where: {listId: {in: rows.filter((l) => l.kind === 'STATIC').map((l) => l.id)}, contact: scope}, _count: {_all: true}});
    const counts = new Map(grouped.map((g) => [g.listId, g._count._all]));
    const defs = await loadSegmentDefs(c.var.db);
    for (const l of rows) if (l.kind === 'DYNAMIC') counts.set(l.id, await c.var.db.contact.count({where: await scopedWhere(c, l, defs)}));
    return c.json({rows: rows.map((l) => ({...l, count: counts.get(l.id) ?? 0}))});
  })

  .post('/', valid('json', listBody), async (c) => {
    const me = currentUser(c);
    const db = c.var.db;
    const {contactIds, rules, ...body} = c.req.valid('json');
    if (rules && body.kind === 'DYNAMIC') await assertNoCycle(db, null, rules);
    const list = await db.contactList.create({
      data: {...body, rules: (body.kind === 'DYNAMIC' ? (rules ?? {match: 'all', groups: []}) : {}) as Prisma.InputJsonValue, ownerId: me.id},
      select: listSelect,
    });
    if (body.kind === 'STATIC' && contactIds?.length) await addToList(db, list.id, await visibleIds(c, contactIds), {actorId: me.id, source: 'bulk'});
    await audit(db, c, {action: 'list.created', entity: 'list', recordId: list.id, label: list.name, meta: {kind: list.kind, members: contactIds?.length}});
    return c.json({list}, 201);
  })

  // Live count while editing segment rules.
  .post('/preview', valid('json', z.object({rules: segmentRulesSchema, listId: z.string().optional()})), async (c) => {
    const db = c.var.db;
    const {rules, listId} = c.req.valid('json');
    await assertNoCycle(db, listId ?? null, rules);
    const where = {AND: [await segmentWhere(db, rules, {seen: new Set(listId ? [listId] : [])})], ...(await ownerScope(c))};
    const [count, sample] = await Promise.all([
      db.contact.count({where}),
      db.contact.findMany({where, take: 5, orderBy: {lastActivityAt: {sort: 'desc', nulls: 'last'}}, select: {id: true, firstName: true, lastName: true, email: true}}),
    ]);
    return c.json({count, sample});
  })

  // Lists one contact belongs to: static memberships plus segments that currently match.
  .get('/for-contact/:contactId', async (c) => {
    const db = c.var.db;
    const contactId = c.req.param('contactId');
    const contact = await db.contact.findFirst({where: {id: contactId, ...(await ownerScope(c))}, select: {id: true}});
    if (!contact) throw notFound('Contact');
    const [memberships, segments] = await Promise.all([
      db.contactListMember.findMany({where: {contactId}, include: {list: {select: {id: true, name: true, kind: true}}}, orderBy: {createdAt: 'desc'}}),
      db.contactList.findMany({where: {kind: 'DYNAMIC'}, select: {id: true, name: true, kind: true, rules: true}, orderBy: {name: 'asc'}}),
    ]);
    const defs = await loadSegmentDefs(db);
    const matches: boolean[] = [];
    for (const s of segments) matches.push((await db.contact.count({where: {AND: [{id: contactId}, await listContactWhere(db, s, {defs})]}})) > 0);
    return c.json({
      rows: [
        ...memberships.map((m) => ({...m.list, addedAt: m.createdAt, source: m.source})),
        ...segments.filter((_, i) => matches[i]).map(({rules: _r, ...s}) => ({...s, addedAt: null, source: null})),
      ],
    });
  })

  .get('/:id', async (c) => {
    const db = c.var.db;
    const list = await findList(c);
    const [count, forms, segments] = await Promise.all([
      db.contact.count({where: await scopedWhere(c, list)}),
      db.form.findMany({where: {settings: {path: ['listIds'], array_contains: [list.id]}}, select: {id: true, name: true}}),
      db.contactList.findMany({where: {kind: 'DYNAMIC', id: {not: list.id}}, select: {id: true, name: true, rules: true}}),
    ]);
    const usedBy = {forms, segments: segments.filter((s) => referencedLists(asRules(s.rules)).includes(list.id)).map(({id, name}) => ({id, name}))};
    return c.json({list: {...list, rules: asRules(list.rules), count}, usedBy});
  })

  .patch('/:id', valid('json', listBody.omit({kind: true, contactIds: true}).partial()), async (c) => {
    const db = c.var.db;
    const list = await findList(c);
    assertCanEdit(c, list);
    const {rules, ...body} = c.req.valid('json');
    if (rules && list.kind !== 'DYNAMIC') throw new HTTPException(400, {message: 'Only segments have rules'});
    if (rules) await assertNoCycle(db, list.id, rules);
    const updated = await db.contactList.update({
      where: {id: list.id},
      data: {...body, ...(rules ? {rules: rules as unknown as Prisma.InputJsonValue} : {})},
      select: listSelect,
    });
    await audit(db, c, {action: 'list.updated', entity: 'list', recordId: list.id, label: updated.name, meta: {changed: Object.keys(c.req.valid('json')), ...(body.name && body.name !== list.name ? {name: {from: list.name, to: body.name}} : {})}});
    return c.json({list: updated});
  })

  .delete('/:id', async (c) => {
    const list = await findList(c);
    assertCanEdit(c, list);
    const me = currentUser(c);
    const [bin] = await moveToBin(c.var.db, 'list', [list.id], me);
    await audit(c.var.db, c, {action: 'list.deleted', entity: 'list', recordId: list.id, label: list.name});
    return c.json({ok: true, binId: bin?.id ?? null});
  })

  .get('/:id/members', valid('query', z.object({
    q: z.string().optional(),
    sort: z.string().optional(),
    dir: z.enum(['asc', 'desc']).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })), async (c) => {
    const db = c.var.db;
    const q = c.req.valid('query');
    const list = await findList(c);
    const where: Prisma.ContactWhereInput = {AND: [await listContactWhere(db, list), contactWhere({q: q.q})], ...(await ownerScope(c))};
    const [rows, total] = await Promise.all([
      db.contact.findMany({
        where,
        include: {...contactInclude, ...(list.kind === 'STATIC' ? {listMemberships: {where: {listId: list.id}, select: {createdAt: true, source: true}}} : {})},
        orderBy: sortBy(q.sort, q.dir, ['firstName', 'lastName', 'email', 'createdAt', 'lastActivityAt', 'lifecycleStage'], 'createdAt'),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      db.contact.count({where}),
    ]);
    return c.json({rows, total, page: q.page, pageSize: q.pageSize});
  })

  .post('/:id/members', valid('json', z.object({contactIds: ids})), async (c) => {
    const list = await findList(c);
    if (list.kind !== 'STATIC') throw new HTTPException(400, {message: 'Segments update themselves from their rules'});
    const added = await addToList(c.var.db, list.id, await visibleIds(c, c.req.valid('json').contactIds), {actorId: currentUser(c).id});
    if (added) await audit(c.var.db, c, {action: 'list.members_added', entity: 'list', recordId: list.id, label: list.name, meta: {count: added}});
    return c.json({added});
  })

  .post('/:id/members/remove', valid('json', z.object({contactIds: ids})), async (c) => {
    const list = await findList(c);
    if (list.kind !== 'STATIC') throw new HTTPException(400, {message: 'Segments update themselves from their rules'});
    const removed = await removeFromList(c.var.db, list.id, await visibleIds(c, c.req.valid('json').contactIds), {actorId: currentUser(c).id});
    if (removed) await audit(c.var.db, c, {action: 'list.members_removed', entity: 'list', recordId: list.id, label: list.name, meta: {count: removed}});
    return c.json({removed});
  })

  // Freeze a segment's current members into a new static list.
  .post('/:id/snapshot', valid('json', z.object({name: z.string().trim().min(1).max(120).optional()})), async (c) => {
    const me = currentUser(c);
    const db = c.var.db;
    const list = await findList(c);
    const members = await db.contact.findMany({where: await scopedWhere(c, list), select: {id: true}, take: 10_000});
    const copy = await db.contactList.create({
      data: {name: c.req.valid('json').name ?? `${list.name} (${new Date().toISOString().slice(0, 10)})`, description: list.description, kind: 'STATIC', ownerId: me.id},
      select: listSelect,
    });
    for (let i = 0; i < members.length; i += 500) {
      await addToList(db, copy.id, members.slice(i, i + 500).map((m) => m.id), {actorId: me.id, source: 'snapshot'});
    }
    await audit(db, c, {action: 'list.created', entity: 'list', recordId: copy.id, label: copy.name, meta: {snapshotOf: list.id, members: members.length}});
    return c.json({list: copy, added: members.length}, 201);
  });
