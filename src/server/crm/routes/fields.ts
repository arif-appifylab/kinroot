import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import {requireRole, type AppEnv} from '../kit/guards';
import {audit} from '../lib/audit';
import {valid} from '../lib/http';

const entity = z.enum(['CONTACT', 'COMPANY', 'DEAL']);
const fieldBody = z.object({
  entity,
  label: z.string().trim().min(1).max(60),
  type: z.enum(['TEXT', 'NUMBER', 'CURRENCY', 'DATE', 'SELECT', 'MULTISELECT', 'URL', 'CHECKBOX']),
  options: z.array(z.string().trim().min(1).max(60)).max(100).default([]),
  required: z.boolean().default(false),
});

const toKey = (label: string) =>
  label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'field';

export const fields = new Hono<AppEnv>()
  .get('/', valid('query', z.object({entity: entity.optional()})), async (c) => {
    const {entity: e} = c.req.valid('query');
    const rows = await c.var.db.customFieldDef.findMany({where: e ? {entity: e} : {}, orderBy: [{entity: 'asc'}, {position: 'asc'}]});
    return c.json({rows});
  })

  .post('/', requireRole('ADMIN'), valid('json', fieldBody), async (c) => {
    const body = c.req.valid('json');
    const db = c.var.db;
    let key = toKey(body.label);
    for (let n = 2; await db.customFieldDef.findUnique({where: {entity_key: {entity: body.entity, key}}}); n++) key = `${toKey(body.label)}_${n}`;
    if ((body.type === 'SELECT' || body.type === 'MULTISELECT') && !body.options.length) {
      throw new HTTPException(400, {message: 'Add at least one option'});
    }
    const position = await db.customFieldDef.count({where: {entity: body.entity}});
    const field = await db.customFieldDef.create({data: {...body, key, position}});
    await audit(db, c, {action: 'custom_field.created', entity: 'custom_field', recordId: field.id, label: `${field.entity.toLowerCase()} · ${field.label}`, meta: {type: field.type}});
    return c.json({field}, 201);
  })

  .patch('/:id', requireRole('ADMIN'), valid('json', fieldBody.omit({entity: true, type: true}).partial().extend({position: z.number().int().optional()})), async (c) => {
    const field = await c.var.db.customFieldDef.update({where: {id: c.req.param('id')}, data: c.req.valid('json')});
    if (Object.keys(c.req.valid('json')).some((k) => k !== 'position')) await audit(c.var.db, c, {action: 'custom_field.updated', entity: 'custom_field', recordId: field.id, label: `${field.entity.toLowerCase()} · ${field.label}`, meta: c.req.valid('json')});
    return c.json({field});
  })

  // Values stay in each record's `custom` JSON; they simply stop being shown.
  .delete('/:id', requireRole('ADMIN'), async (c) => {
    const field = await c.var.db.customFieldDef.delete({where: {id: c.req.param('id')}});
    await audit(c.var.db, c, {action: 'custom_field.deleted', entity: 'custom_field', recordId: field.id, label: `${field.entity.toLowerCase()} · ${field.label}`});
    return c.json({ok: true});
  });
