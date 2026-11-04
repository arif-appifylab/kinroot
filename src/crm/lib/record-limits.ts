/**
 * The longest text each main record field takes (AUDIT P3-14): the API's max (`contactBody`,
 * `companyBody`, `dealBody`, the forms and booking-link routes), the app's `maxLength`, and the
 * column's VARCHAR(n) in the database (migration 20261104110000_crm_text_lengths_3). Data in's
 * catalogue (src/crm/lib/data-in.ts) stays at or below these.
 *
 * Values Kinroot makes itself (a name split from a booking or a chat, " (copy)", a slug made from a
 * name, an automation's "update field") are cut to these with `clip()`; what a person types is
 * refused with a field error instead.
 */
export const CONTACT_LIMITS = {
  firstName: 100,
  lastName: 100,
  email: 254,
  phone: 50,
  title: 200,
  source: 100,
  leadStatus: 100,
  buyingRole: 100,
  city: 100,
  country: 100,
} as const;

export const COMPANY_LIMITS = {
  name: 200,
  domain: 253,
  industry: 100,
  type: 100,
  size: 50,
  timezone: 100,
  phone: 50,
  address: 300,
  city: 100,
  state: 100,
  postalCode: 30,
  country: 100,
} as const;

export const DEAL_LIMITS = {title: 200, type: 100, priority: 50, lostReason: 200} as const;

export const FORM_LIMITS = {name: 120, slug: 60} as const;

export const BOOKING_LINK_LIMITS = {slug: 60} as const;

/** `text` cut to `max` characters (trailing space dropped); null and undefined stay as they are. */
export function cut<T extends string | null | undefined>(text: T, max: number): T {
  return (typeof text === 'string' && text.length > max ? text.slice(0, max).trimEnd() : text) as T;
}

/** A copy of `data` with every string field named in `limits` cut to its limit; other fields untouched. */
export function clip<T extends Record<string, unknown>>(data: T, limits: Readonly<Record<string, number>>): T {
  const out: Record<string, unknown> = {...data};
  for (const [key, max] of Object.entries(limits)) if (typeof out[key] === 'string') out[key] = cut(out[key] as string, max);
  return out as T;
}

/** "Name (copy)" within `max`: the name is shortened, never the suffix. */
export const copyName = (name: string, max: number, suffix = ' (copy)') => `${cut(name, max - suffix.length)}${suffix}`;
