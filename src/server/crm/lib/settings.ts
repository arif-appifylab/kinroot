import {cache} from '../../../platform/cache';
import type {Db} from '../kit/db';
import {BRAND} from '@/lib/brand';
import {randomToken} from '../kit/crypto';

export type AppSettings = {
  /** The client's own brand. "Kinroot" is only the template default. */
  brandName: string;
  /**
   * The logo: the public storage link of an uploaded PNG / JPEG / GIF / WebP, a small SVG as a data
   * URL, or '' for the default mark. Older installs may still hold a raster data URL; it keeps working.
   */
  brandLogo: string;
  /** Brand colours; '' keeps the default blue → teal. */
  brandPrimary: string;
  brandSecondary: string;
  currency: string;
  /** everyone: all members see all records. owner: members only see what they own. */
  recordVisibility: 'everyone' | 'owner';
  lostReasons: string[];
  sources: string[];
  /** Address users BCC to log emails, e.g. log@inbound.acme.com (configured at the inbound provider). */
  bccAddress: string;
  industries: string[];
  companyTypes: string[];
  taskQueues: string[];
  /** Link a contact to the company whose domain matches their work email. */
  autoAssociateCompanies: boolean;
  /** …and create that company when none exists yet. */
  autoCreateCompanies: boolean;
};

/**
 * Settings that are never put in the Site Cache (the owner and the platform's staff can open
 * cached values, and the cache refuses token-like values): the inbound webhook's secret and the
 * OAuth app ids. Read with `getPrivateSettings` where they are needed.
 */
export type PrivateSettings = {
  /** Secret used in the inbound webhook URL /site-api/crm/inbound/:token */
  inboundToken: string;
  googleClientId: string;
  microsoftClientId: string;
  microsoftTenant: string;
};

export type StoredSettings = AppSettings & PrivateSettings;

const DEFAULTS: AppSettings = {
  brandName: BRAND.name,
  brandLogo: '',
  brandPrimary: '',
  brandSecondary: '',
  currency: 'USD',
  recordVisibility: 'everyone',
  lostReasons: ['Price too high', 'Chose a competitor', 'No budget', 'No decision / went silent', 'Bad timing', 'Not a fit'],
  sources: ['Website', 'Referral', 'Outbound', 'Event', 'Partner', 'Ads', 'Other'],
  bccAddress: '',
  industries: [
    'Software',
    'Financial services',
    'Healthcare',
    'Retail',
    'E-commerce',
    'Manufacturing',
    'Education',
    'Real estate',
    'Marketing & advertising',
    'Logistics',
    'Consulting',
    'Media & entertainment',
    'Hospitality',
    'Construction',
    'Telecommunications',
    'Non-profit',
    'Government',
    'Other',
  ],
  companyTypes: ['Prospect', 'Partner', 'Reseller', 'Vendor', 'Other'],
  taskQueues: ['Follow-ups', 'Renewals', 'Onboarding'],
  autoAssociateCompanies: true,
  autoCreateCompanies: false,
};

const KEY = 'workspace'; // storage key kept for existing installs

/** Site Cache keys (docs/agent/cache.md), cleared by `saveSettings` right after every write. */
const CACHE_KEY = 'crm:settings';
/** The brand (lib/brand.ts) is made from these settings: cleared with them. */
export const BRAND_CACHE_KEY = 'crm:brand';
/** Read on most requests, changed rarely, cleared on every save: a day. */
const CACHE_TTL = 86_400;
/** An older install's logo data URL this big stays out of the cached value (the cache keeps values small). */
const CACHED_LOGO_MAX = 60_000;

const PRIVATE_DEFAULTS: Omit<PrivateSettings, 'inboundToken'> = {googleClientId: '', microsoftClientId: '', microsoftTenant: 'common'};

async function readStored(db: Db) {
  const row = await db.setting.findUnique({where: {key: KEY}, select: {value: true}});
  return (row?.value ?? {}) as Partial<StoredSettings> & {workspaceName?: string};
}

/** The workspace settings everyone's requests use, from the Site Cache (a day; cleared on save). */
export async function getSettings(db: Db): Promise<AppSettings> {
  const cached = await cache.getOrSet(CACHE_KEY, CACHE_TTL, async () => {
    const stored = await readStored(db);
    // Only the known public fields: never the private ones, nor anything else an old row holds.
    const merged = Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, stored[k as keyof AppSettings] ?? DEFAULTS[k as keyof AppSettings]])) as AppSettings;
    // Older installs stored the name as "workspaceName".
    if (!stored.brandName && stored.workspaceName) merged.brandName = stored.workspaceName;
    return merged.brandLogo.length > CACHED_LOGO_MAX ? {...merged, brandLogo: '', bigLogo: true} : merged;
  });
  if (!('bigLogo' in cached)) return cached;
  // An older install's large logo: read on its own (only that field), until it is uploaded again.
  const {bigLogo: _big, ...rest} = cached as AppSettings & {bigLogo?: true};
  const rows = await db.$queryRaw<{logo: string | null}[]>`SELECT value->>'brandLogo' AS logo FROM "Setting" WHERE key = ${KEY}`;
  return {...rest, brandLogo: rows[0]?.logo ?? ''};
}

/** The inbound webhook token and OAuth app ids: read from the database, never cached. */
export async function getPrivateSettings(db: Db): Promise<PrivateSettings> {
  const stored = await readStored(db);
  const s: PrivateSettings = {
    inboundToken: stored.inboundToken ?? '',
    googleClientId: stored.googleClientId ?? PRIVATE_DEFAULTS.googleClientId,
    microsoftClientId: stored.microsoftClientId ?? PRIVATE_DEFAULTS.microsoftClientId,
    microsoftTenant: stored.microsoftTenant || PRIVATE_DEFAULTS.microsoftTenant,
  };
  if (!s.inboundToken) {
    // Create-if-absent in ONE statement: two first reads at once must not save two different tokens.
    const candidate = randomToken(18);
    const [row] = await db.$queryRaw<{token: string}[]>`
      INSERT INTO "Setting" ("key", "value", "updatedAt")
      VALUES (${KEY}, jsonb_build_object('inboundToken', ${candidate}::text), ${new Date()})
      ON CONFLICT ("key") DO UPDATE
        SET "value" = "Setting"."value" || jsonb_build_object('inboundToken', ${candidate}::text), "updatedAt" = ${new Date()}
        WHERE coalesce("Setting"."value"->>'inboundToken', '') = ''
      RETURNING "value"->>'inboundToken' AS token`;
    // No row back: another request set it first; read the winner.
    s.inboundToken = row?.token ?? ((await readStored(db)).inboundToken ?? '');
    await Promise.all([cache.del(CACHE_KEY), cache.del(BRAND_CACHE_KEY)]);
  }
  return s;
}

/**
 * Saves a patch and clears the cached settings and brand right after the write. One statement
 * merges the patch into the stored row (`jsonb ||`), so two saves of different fields at the same
 * moment both land (a read-then-write lost one of them: AUDIT-2 L-12).
 */
export async function saveSettings(db: Db, patch: Partial<StoredSettings>) {
  const json = JSON.stringify(patch);
  const now = new Date();
  await db.$executeRaw`
    INSERT INTO "Setting" ("key", "value", "updatedAt") VALUES (${KEY}, ${json}::jsonb, ${now})
    ON CONFLICT ("key") DO UPDATE
      SET "value" = (CASE WHEN jsonb_typeof("Setting"."value") = 'object' THEN "Setting"."value" ELSE '{}'::jsonb END) || EXCLUDED."value",
          "updatedAt" = EXCLUDED."updatedAt"`;
  await Promise.all([cache.del(CACHE_KEY), cache.del(BRAND_CACHE_KEY)]);
}

// OAuth client secrets live in their own encrypted setting, never in the main settings row.

/** Values typed straight into a dropdown become options for everyone next time. */
export async function rememberOption(db: Db, list: 'sources' | 'lostReasons' | 'industries' | 'companyTypes' | 'taskQueues', value: string | null | undefined) {
  const v = value?.trim();
  if (!v) return;
  const settings = await getSettings(db);
  if (settings[list].some((x) => x.toLowerCase() === v.toLowerCase())) return;
  await saveSettings(db, {[list]: [...settings[list], v]});
}
