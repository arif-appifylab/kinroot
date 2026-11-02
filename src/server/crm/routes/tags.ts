import {Hono} from 'hono';
import {z} from 'zod';

import type {AppEnv} from '../kit/guards';
import {valid} from '../lib/http';

const TABLES = {CONTACT: '"Contact"', COMPANY: '"Company"', DEAL: '"Deal"', TICKET: '"Ticket"'} as const;

/** Tags already in use, most used first, for tag pickers. */
export const tags = new Hono<AppEnv>().get('/', valid('query', z.object({entity: z.enum(['CONTACT', 'COMPANY', 'DEAL', 'TICKET']).optional()})), async (c) => {
  const {entity} = c.req.valid('query');
  const tables = entity ? [TABLES[entity]] : Object.values(TABLES);
  // Table names come from the fixed map above, never from input.
  const union = tables.map((t) => `SELECT unnest(tags) AS tag FROM ${t}`).join(' UNION ALL ');
  const rows = await c.var.db.$queryRawUnsafe<{tag: string; n: number}[]>(
    `SELECT tag, count(*)::int AS n FROM (${union}) t GROUP BY tag ORDER BY n DESC, tag ASC LIMIT 300`,
  );
  return c.json({rows});
});
