import {Hono} from 'hono';
import {z} from 'zod';

import {Prisma} from '../../../generated/prisma/client';
import type {AppEnv} from '../kit/guards';
import {ownerScope, valid} from '../lib/http';

/**
 * One prepared statement per table; table names only from this fixed map, never from input. With
 * "members see only their own records" on, only tags of records the caller may see (as the lists
 * and `ticketScope` show them): a tag name can say something about a record.
 */
function tables(ownerId: string | undefined) {
  const own = ownerId ? Prisma.sql`"ownerId" = ${ownerId}` : Prisma.sql`TRUE`;
  const ticket = ownerId ? Prisma.sql`("assigneeId" = ${ownerId} OR "assigneeId" IS NULL)` : Prisma.sql`TRUE`;
  return {
    CONTACT: Prisma.sql`SELECT jsonb_array_elements_text(tags) AS tag FROM "Contact" WHERE ${own}`,
    COMPANY: Prisma.sql`SELECT jsonb_array_elements_text(tags) AS tag FROM "Company" WHERE ${own}`,
    DEAL: Prisma.sql`SELECT jsonb_array_elements_text(tags) AS tag FROM "Deal" WHERE ${own}`,
    TICKET: Prisma.sql`SELECT jsonb_array_elements_text(tags) AS tag FROM "Ticket" WHERE ${ticket}`,
  } as const;
}

/** Tags already in use, most used first, for tag pickers. */
export const tags = new Hono<AppEnv>().get('/', valid('query', z.object({entity: z.enum(['CONTACT', 'COMPANY', 'DEAL', 'TICKET']).optional()})), async (c) => {
  const {entity} = c.req.valid('query');
  const TABLES = tables((await ownerScope(c)).ownerId);
  const parts = entity ? [TABLES[entity]] : Object.values(TABLES);
  const union = Prisma.join(parts, ' UNION ALL ');
  const rows = await c.var.db.$queryRaw<{tag: string; n: number}[]>`SELECT tag, count(*)::int AS n FROM (${union}) t GROUP BY tag ORDER BY n DESC, tag ASC LIMIT 300`;
  return c.json({rows});
});
