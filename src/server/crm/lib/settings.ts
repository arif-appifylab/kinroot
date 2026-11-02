import type {Db} from '../kit/db';
import {BRAND} from '@/lib/brand';
import {randomToken} from '../kit/crypto';

export type AppSettings = {
  /** The client's own brand. "Kinroot" is only the template default. */
  brandName: string;
  /** Small logo as a data URL (PNG/JPEG/WebP/SVG), or '' for the default mark. */
  brandLogo: string;
  /** Brand colours; '' keeps the default blue → teal. */
  brandPrimary: string;
  brandSecondary: string;
  currency: string;
  /** everyone: all members see all records. owner: members only see what they own. */
  recordVisibility: 'everyone' | 'owner';
  lostReasons: string[];
  sources: string[];
  /** Secret used in the inbound webhook URL /site-api/crm/inbound/:token */
  inboundToken: string;
  /** Address users BCC to log emails, e.g. log@inbound.acme.com (configured at the inbound provider). */
  bccAddress: string;
  googleClientId: string;
  microsoftClientId: string;
  microsoftTenant: string;
  industries: string[];
  companyTypes: string[];
  taskQueues: string[];
  /** Link a contact to the company whose domain matches their work email. */
  autoAssociateCompanies: boolean;
  /** …and create that company when none exists yet. */
  autoCreateCompanies: boolean;
};

const DEFAULTS: Omit<AppSettings, 'inboundToken'> = {
  brandName: BRAND.name,
  brandLogo: '',
  brandPrimary: '',
  brandSecondary: '',
  currency: 'USD',
  recordVisibility: 'everyone',
  lostReasons: ['Price too high', 'Chose a competitor', 'No budget', 'No decision / went silent', 'Bad timing', 'Not a fit'],
  sources: ['Website', 'Referral', 'Outbound', 'Event', 'Partner', 'Ads', 'Other'],
  bccAddress: '',
  googleClientId: '',
  microsoftClientId: '',
  microsoftTenant: 'common',
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

export async function getSettings(db: Db): Promise<AppSettings> {
  const row = await db.setting.findUnique({where: {key: KEY}});
  const stored = (row?.value ?? {}) as Partial<AppSettings> & {workspaceName?: string};
  const merged = {...DEFAULTS, ...stored} as AppSettings;
  // Older installs stored the name as "workspaceName".
  if (!stored.brandName && stored.workspaceName) merged.brandName = stored.workspaceName;
  if (!merged.inboundToken) {
    merged.inboundToken = randomToken(18);
    await saveSettings(db, merged);
  }
  return merged;
}

export async function saveSettings(db: Db, patch: Partial<AppSettings>) {
  const row = await db.setting.findUnique({where: {key: KEY}});
  const value = {...((row?.value ?? {}) as object), ...patch};
  await db.setting.upsert({where: {key: KEY}, create: {key: KEY, value}, update: {value}});
}

// OAuth client secrets live in their own encrypted setting, never in the main settings row.
export const SECRETS_KEY = 'oauth-secrets';

/** Values typed straight into a dropdown become options for everyone next time. */
export async function rememberOption(db: Db, list: 'sources' | 'lostReasons' | 'industries' | 'companyTypes' | 'taskQueues', value: string | null | undefined) {
  const v = value?.trim();
  if (!v) return;
  const settings = await getSettings(db);
  if (settings[list].some((x) => x.toLowerCase() === v.toLowerCase())) return;
  await saveSettings(db, {[list]: [...settings[list], v]});
}
