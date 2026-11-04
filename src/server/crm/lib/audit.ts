import type {Prisma} from '../../../generated/prisma/client';
import {DEFAULT_AUDIT_RETENTION, type AuditCategory} from '@/lib/hygiene';
import {maskEmail} from '../../../platform/auth/admin';
import {sha256Hex, sign} from '../kit/crypto';
import type {Db} from '../kit/db';
import type {AppContext} from '../kit/guards';
import {automationOf} from './automation-context';
import {shownEmail} from './owner-account';

/**
 * Audit log: who did what, when and from where. Call `audit(db, c, {...})`
 * after a write that matters for accountability (records, sign-ins, team,
 * settings, exports, secrets). It never throws, so it can't break the write.
 * Action names are `<entity>.<verb>`; the category follows from the prefix
 * unless given. Meta is redacted: secret-looking keys, data URLs and long text
 * never reach the table. For a secret the user looked at, store
 * `await fingerprint(secret)` (a short hash) instead.
 */
export type AuditInput = {
  action: string;
  category?: AuditCategory;
  entity?: string | null;
  recordId?: string | null;
  label?: string | null;
  meta?: Record<string, unknown>;
  /** Defaults to the signed-in user. Sign-in attempts pass the account (or just the email) tried. */
  actor?: {id?: string | null; name?: string | null; email?: string | null} | null;
};

const PREFIX_CATEGORY: Record<string, AuditCategory> = {
  auth: 'auth',
  team: 'team',
  settings: 'settings',
  email_account: 'settings',
  calendar: 'settings',
  export: 'export',
  import: 'export',
  file: 'security',
  bin: 'record',
  duplicate: 'record',
};

const SECRET_KEY = /pass(word)?|secret|token|credential|api_?key|authorization|cookie|private/i;

/** Compact, secret-free copy of `value` for the meta column. */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    if (value.startsWith('data:')) return '[image]';
    return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  }
  if (typeof value !== 'object') return value;
  if (depth > 4) return '[…]';
  if (Array.isArray(value)) return value.slice(0, 25).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  const obj = value as Record<string, unknown>;
  // diff() entries ({field, from, to}) for a secret field keep the field name only.
  const secretField = typeof obj.field === 'string' && SECRET_KEY.test(obj.field);
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = SECRET_KEY.test(k) || (secretField && (k === 'from' || k === 'to')) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

/** Short, non-reversible id of a secret: shows which secret was revealed without storing it. */
export const fingerprint = async (secret: string) => (await sha256Hex(secret)).slice(0, 12);

export function clientIp(c: AppContext) {
  const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  return (c.req.header('cf-connecting-ip') ?? forwarded ?? c.req.header('x-real-ip') ?? null)?.slice(0, 64) ?? null;
}

/**
 * Where a change came from, without keeping the address (the site's rule: no raw IPs): a keyed
 * hash, the same for the same address, so entries from one place still line up.
 */
async function ipOf(c: AppContext | null) {
  const ip = c ? clientIp(c) : null;
  return ip ? `h:${await sign(`ip:${ip}`)}` : null;
}

async function row(c: AppContext | null, input: AuditInput): Promise<Prisma.AuditLogCreateManyInput> {
  const user = c?.var.user ?? null;
  const actor = input.actor === undefined ? user : input.actor;
  return {
    action: input.action,
    category: input.category ?? PREFIX_CATEGORY[input.action.split('.')[0]!] ?? 'record',
    entity: input.entity ?? null,
    recordId: input.recordId ?? null,
    label: input.label?.slice(0, 300) ?? null,
    actorId: actor?.id ?? null,
    actorName: actor?.name ?? null,
    // Never a copy of an address: masked, enough to recognise (AGENTS.md › Never).
    actorEmail: shownEmail(actor?.email) ? maskEmail(shownEmail(actor?.email)) : null,
    meta: (redact(input.meta ?? {}) ?? {}) as Prisma.InputJsonValue,
    ip: await ipOf(c),
    userAgent: c?.req.header('user-agent')?.slice(0, 300) ?? null,
  };
}

/** Changes made by an automation step (c = null) carry the automation in meta. */
function withAutomationMeta(db: Db, c: AppContext | null, input: AuditInput): AuditInput {
  const auto = c ? null : automationOf(db);
  return auto && !input.meta?.automationId ? {...input, meta: {...input.meta, automationId: auto.automationId, automation: auto.name}} : input;
}

/** Writes one audit entry. `c` gives the actor, IP and user agent; pass null from jobs. */
export async function audit(db: Db, c: AppContext | null, input: AuditInput) {
  try {
    await db.auditLog.create({data: await row(c, withAutomationMeta(db, c, input))});
  } catch (e) {
    console.error('[audit]', input.action, (e as Error).name);
  }
}

/** One entry per record for bulk actions (bulk delete, bulk assign…), in a single query. */
export async function auditMany(db: Db, c: AppContext | null, inputs: AuditInput[]) {
  if (!inputs.length) return;
  try {
    await db.auditLog.createMany({data: await Promise.all(inputs.map((i) => row(c, withAutomationMeta(db, c, i))))});
  } catch (e) {
    console.error('[audit]', inputs[0]?.action, (e as Error).name);
  }
}

// ─── Retention ───

const SETTINGS_KEY = 'audit';
export type AuditSettings = {retentionDays: number};

export async function getAuditSettings(db: Db): Promise<AuditSettings> {
  const row = await db.setting.findUnique({where: {key: SETTINGS_KEY}});
  return {retentionDays: DEFAULT_AUDIT_RETENTION, ...((row?.value ?? {}) as Partial<AuditSettings>)};
}

export async function saveAuditSettings(db: Db, value: AuditSettings) {
  await db.setting.upsert({where: {key: SETTINGS_KEY}, create: {key: SETTINGS_KEY, value}, update: {value}});
}

/** Drops entries older than the retention period (run from pruneJobs). */
export async function pruneAudit(db: Db) {
  const {retentionDays} = await getAuditSettings(db);
  await db.auditLog.deleteMany({where: {createdAt: {lt: new Date(Date.now() - retentionDays * 86_400_000)}}});
}
