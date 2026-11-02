import {HTTPException} from 'hono/http-exception';

import type {EntityType} from '../../../generated/prisma/client';
import type {Db} from '../kit/db';

/** Keeps only defined custom fields, coerces by type, merges onto existing values. */
export async function cleanCustom(
  db: Db,
  entity: EntityType,
  input: Record<string, unknown> | undefined,
  existing: unknown = {},
): Promise<Record<string, unknown> | undefined> {
  if (!input) return undefined;
  const defs = await db.customFieldDef.findMany({where: {entity}});
  const out: Record<string, unknown> = {...((existing as Record<string, unknown>) ?? {})};
  for (const def of defs) {
    if (!(def.key in input)) continue;
    const raw = input[def.key];
    if (raw === null || raw === '' || raw === undefined) {
      delete out[def.key];
      continue;
    }
    switch (def.type) {
      case 'NUMBER':
      case 'CURRENCY': {
        const n = Number(raw);
        if (Number.isNaN(n)) throw new HTTPException(400, {message: `${def.label} must be a number`});
        out[def.key] = n;
        break;
      }
      case 'CHECKBOX':
        out[def.key] = raw === true || raw === 'true';
        break;
      case 'MULTISELECT':
        out[def.key] = (Array.isArray(raw) ? raw : [raw]).map(String).filter((v) => def.options.includes(v));
        break;
      case 'SELECT':
        if (!def.options.includes(String(raw))) throw new HTTPException(400, {message: `${def.label}: unknown option`});
        out[def.key] = String(raw);
        break;
      default:
        out[def.key] = String(raw).slice(0, 2000);
    }
  }
  return out;
}
