import {Hono} from 'hono';
import {z} from 'zod';

import {publicOrigin} from '../kit/config';
import {decryptJson, encryptJson} from '../kit/crypto';
import {currentUser, isAdmin, requireRole, type AppEnv} from '../kit/guards';
import {diff} from '../lib/activity';
import {audit} from '../lib/audit';
import {valid} from '../lib/http';
import {clearBrandCache} from '../lib/brand';
import {getSettings, saveSettings, SECRETS_KEY} from '../lib/settings';

export type OAuthSecrets = {googleClientSecret?: string; microsoftClientSecret?: string};

export const settings = new Hono<AppEnv>()
  .get('/', async (c) => {
    const db = c.var.db;
    const s = await getSettings(db);
    const secretsRow = await db.setting.findUnique({where: {key: SECRETS_KEY}});
    const secrets = secretsRow ? await decryptJson<OAuthSecrets>(secretsRow.value as string).catch(() => ({}) as OAuthSecrets) : {};
    const origin = publicOrigin(c.req.raw);
    const admin = isAdmin(currentUser(c));
    return c.json({
      settings: admin ? s : {...s, inboundToken: ''},
      oauth: {
        googleConfigured: !!(s.googleClientId && secrets.googleClientSecret),
        microsoftConfigured: !!(s.microsoftClientId && secrets.microsoftClientSecret),
        googleRedirectUri: `${origin}/site-api/crm/email/oauth/google/callback`,
        microsoftRedirectUri: `${origin}/site-api/crm/email/oauth/microsoft/callback`,
      },
      inboundWebhookUrl: admin ? `${origin}/site-api/crm/inbound/${s.inboundToken}` : '',
    });
  })

  .patch(
    '/',
    requireRole('ADMIN'),
    valid('json', z.object({
      brandName: z.string().trim().min(1).max(60).optional(),
      brandLogo: z.union([z.literal(''), z.string().max(400_000).regex(/^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/, 'must be a PNG, JPEG, WebP or SVG image')]).optional(),
      brandPrimary: z.union([z.literal(''), z.string().regex(/^#[0-9a-f]{6}$/i)]).optional(),
      brandSecondary: z.union([z.literal(''), z.string().regex(/^#[0-9a-f]{6}$/i)]).optional(),
      currency: z.string().length(3).toUpperCase().optional(),
      recordVisibility: z.enum(['everyone', 'owner']).optional(),
      lostReasons: z.array(z.string().trim().min(1).max(80)).max(100).optional(),
      sources: z.array(z.string().trim().min(1).max(60)).max(100).optional(),
      industries: z.array(z.string().trim().min(1).max(60)).max(200).optional(),
      companyTypes: z.array(z.string().trim().min(1).max(60)).max(100).optional(),
      taskQueues: z.array(z.string().trim().min(1).max(60)).max(100).optional(),
      autoAssociateCompanies: z.boolean().optional(),
      autoCreateCompanies: z.boolean().optional(),
      bccAddress: z.union([z.email(), z.literal('')]).optional(),
      googleClientId: z.string().trim().max(300).optional(),
      microsoftClientId: z.string().trim().max(300).optional(),
      microsoftTenant: z.string().trim().max(100).optional(),
      googleClientSecret: z.string().trim().max(300).optional(),
      microsoftClientSecret: z.string().trim().max(300).optional(),
    })),
    async (c) => {
      const db = c.var.db;
      const {googleClientSecret, microsoftClientSecret, ...patch} = c.req.valid('json');
      const before = await getSettings(db);
      await saveSettings(db, patch);
      const changes = diff(before, patch);
      if (changes.length) await audit(db, c, {action: 'settings.updated', meta: {changes}});
      if (googleClientSecret !== undefined) await audit(db, c, {action: 'settings.oauth_secret', label: 'Google', meta: {cleared: !googleClientSecret}});
      if (microsoftClientSecret !== undefined) await audit(db, c, {action: 'settings.oauth_secret', label: 'Microsoft', meta: {cleared: !microsoftClientSecret}});
      clearBrandCache();
      if (googleClientSecret !== undefined || microsoftClientSecret !== undefined) {
        const row = await db.setting.findUnique({where: {key: SECRETS_KEY}});
        const current = row ? await decryptJson<OAuthSecrets>(row.value as string).catch(() => ({}) as OAuthSecrets) : {};
        const next: OAuthSecrets = {
          ...current,
          ...(googleClientSecret !== undefined && {googleClientSecret}),
          ...(microsoftClientSecret !== undefined && {microsoftClientSecret}),
        };
        const value = await encryptJson(next);
        await db.setting.upsert({where: {key: SECRETS_KEY}, create: {key: SECRETS_KEY, value}, update: {value}});
      }
      return c.json({settings: await getSettings(db)});
    },
  );
