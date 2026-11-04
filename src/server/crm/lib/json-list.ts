import type {Prisma} from '../../../generated/prisma/client';

/**
 * List columns are `Json` (jsonb arrays), not Prisma scalar lists (`String[]`): the live database's
 * driver (src/platform/db-socket.ts) can't write or read Postgres arrays (docs/agent/database.md).
 * Writes pass a plain `string[]`; every read goes through these, so routes keep sending `string[]`.
 */

/** The string items of a jsonb list column (anything that isn't a string is dropped; not a list → []). */
export const strings = (v: Prisma.JsonValue | null | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** The finite number items of a jsonb list column (BookingLink.durations). */
export const numbers = (v: Prisma.JsonValue | null | undefined): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)) : []);

/** `row` with its list columns `keys` read as `string[]` (what routes send to the browser and webhooks). */
export function withStrings<T extends object, K extends keyof T>(row: T, ...keys: K[]): Omit<T, K> & {[P in K]: string[]} {
  const out = {...row} as Record<PropertyKey, unknown>;
  for (const k of keys) out[k as PropertyKey] = strings(row[k] as Prisma.JsonValue);
  return out as Omit<T, K> & {[P in K]: string[]};
}
