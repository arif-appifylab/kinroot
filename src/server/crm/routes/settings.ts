import {Hono} from 'hono';
import {z} from 'zod';

import {publicOrigin} from '../kit/config';
import {config as site} from '../../../platform/config';
import {INBOUND_SECRETS} from '../email/inbound-auth';
import {oauthClient} from '../email/oauth';
import {currentUser, isAdmin, requireRole, type AppEnv} from '../kit/guards';
import {diff} from '../lib/activity';
import {audit} from '../lib/audit';
import {valid} from '../lib/http';
import {clearBrandCache} from '../lib/brand';
import {getSettings, saveSettings} from '../lib/settings';

export const settings = new Hono<AppEnv>()
  .get('/', async (c) => {
    const db = c.var.db;
    const [s, google, microsoft] = await Promise.all([getSettings(db), oauthClient(db, 'google'), oauthClient(db, 'microsoft')]);
    const origin = publicOrigin(c.req.raw);
    const admin = isAdmin(currentUser(c));
    return c.json({
      settings: admin ? s : {...s, inboundToken: ''},
      oauth: {
        // The client secrets are the owner's secrets (GOOGLE_CLIENT_SECRET, MICROSOFT_CLIENT_SECRET), never stored here.
        googleConfigured: !!google,
        microsoftConfigured: !!microsoft,
        googleRedirectUri: `${origin}/site-api/crm/email/oauth/google/callback`,
        microsoftRedirectUri: `${origin}/site-api/crm/email/oauth/microsoft/callback`,
      },
      inboundWebhookUrl: admin ? `${origin}/site-api/crm/inbound/${s.inboundToken}` : '',
      // Which signing secrets the owner added (names and yes / no only): email/inbound-auth.ts.
      inboundSecrets: admin ? Object.fromEntries(INBOUND_SECRETS.map((n) => [n, !!site.ownerSecret(n)])) : {},
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
    })),
    async (c) => {
      const db = c.var.db;
      const patch = c.req.valid('json');
      const before = await getSettings(db);
      await saveSettings(db, patch);
      const changes = diff(before, patch);
      if (changes.length) await audit(db, c, {action: 'settings.updated', meta: {changes}});
      await clearBrandCache();
      return c.json({settings: await getSettings(db)});
    },
  );
