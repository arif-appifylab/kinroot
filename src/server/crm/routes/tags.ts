import {Hono} from 'hono';
import {z} from 'zod';

import {Prisma} from '../../../generated/prisma/client';
import type {AppEnv} from '../kit/guards';
import {valid} from '../lib/http';

/** One prepared statement per table; table names only from this fixed map, never from input. */
const TABLES = {
  CONTACT: Prisma.sql`SELECT jsonb_array_elements_text(tags) AS tag FROM "Contact"`,
  COMPANY: Prisma.sql`SELECT jsonb_array_elements_text(tags) AS tag FROM "Company"`,
  DEAL: Prisma.sql`SELECT jsonb_array_elements_text(tags) AS tag FROM "Deal"`,
  TICKET: Prisma.sql`SELECT jsonb_array_elements_text(tags) AS tag FROM "Ticket"`,
} as const;

/** Tags already in use, most used first, for tag pickers. */
export const tags = new Hono<AppEnv>().get('/', valid('query', z.object({entity: z.enum(['CONTACT', 'COMPANY', 'DEAL', 'TICKET']).optional()})), async (c) => {
  const {entity} = c.req.valid('query');
  const parts = entity ? [TABLES[entity]] : Object.values(TABLES);
  const union = Prisma.join(parts, ' UNION ALL ');
  const rows = await c.var.db.$queryRaw<{tag: string; n: number}[]>`SELECT tag, count(*)::int AS n FROM (${union}) t GROUP BY tag ORDER BY n DESC, tag ASC LIMIT 300`;
  return c.json({rows});
});
