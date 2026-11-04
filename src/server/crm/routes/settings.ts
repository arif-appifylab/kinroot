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
import {getPrivateSettings, getSettings, saveSettings, type StoredSettings} from '../lib/settings';
import {publicLink} from '../kit/storage';
import type {Db} from '../kit/db';

/** An SVG logo stays a data URL (storage would only offer it as a download): at most 60 KB of SVG. */
const SVG_LOGO_MAX = 60 * 1024;
const SVG_DATA_URL = /^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/;
/** A public storage link (lib/kit/storage.ts `publicLink`) of a raster image someone here uploaded. */
const STORAGE_LINK = /^https?:\/\/[^/?#]+\/__platform\/files\/(file_[0-9a-z]{26})\/[^/?#]+$/;
const RASTER = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/**
 * The logo a save may set: none, a small SVG, a public PNG / JPEG / GIF / WebP uploaded through
 * POST /files/public (its exact link), or the logo already saved (an older install's data URL keeps
 * working until it is replaced). Anything else is refused in words.
 */
async function logoProblem(db: Db, logo: string, current: string): Promise<string | null> {
  if (!logo || logo === current) return null;
  if (logo.startsWith('data:')) {
    if (!SVG_DATA_URL.test(logo)) return 'Upload the logo again: PNG, JPEG, GIF and WebP logos are stored as files now.';
    return (logo.length - 'data:image/svg+xml;base64,'.length) * 0.75 > SVG_LOGO_MAX ? 'SVG logos can be up to 60 KB. Use a smaller SVG, or a PNG.' : null;
  }
  const storageId = STORAGE_LINK.exec(logo)?.[1];
  const file = storageId ? await db.file.findFirst({where: {storageId, purpose: 'public', ready: true, mimeType: {in: RASTER}}, select: {storageId: true, name: true}}) : null;
  return file && publicLink(file) === logo ? null : 'Upload the logo again.';
}

export const settings = new Hono<AppEnv>()
  .get('/', async (c) => {
    const db = c.var.db;
    const [pub, priv, google, microsoft] = await Promise.all([getSettings(db), getPrivateSettings(db), oauthClient(db, 'google'), oauthClient(db, 'microsoft')]);
    const s: StoredSettings = {...pub, ...priv};
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
      // Checked in full below (logoProblem); an older install's saved data URL may be sent back as it is.
      brandLogo: z.string().max(450_000).optional(),
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
      // Pasted into Microsoft's sign-in URL (email/oauth.ts, calendar/oauth.ts): a name or an id, nothing else.
      microsoftTenant: z.union([z.literal(''), z.string().trim().regex(/^[A-Za-z0-9.-]{1,100}$/, 'use common, organizations, or your tenant ID (letters, numbers, dots and dashes)')]).optional(),
    })),
    async (c) => {
      const db = c.var.db;
      const patch = c.req.valid('json');
      const [pub, priv] = await Promise.all([getSettings(db), getPrivateSettings(db)]);
      const before: StoredSettings = {...pub, ...priv};
      if (patch.brandLogo !== undefined) {
        const problem = await logoProblem(db, patch.brandLogo, before.brandLogo);
        if (problem) return c.json({error: `brandLogo: ${problem}`}, 400);
      }
      // saveSettings clears the cached settings and brand right after the write.
      await saveSettings(db, patch);
      // A data-URL logo is too big for the audit entry: the change is noted, not the image.
      const {brandLogo: newLogo, ...rest} = patch;
      const short = (logo: string) => (logo.startsWith('data:') ? `${logo.slice(0, 30)}… (${logo.length} characters)` : logo);
      const changes = diff(before, rest);
      if (newLogo !== undefined && newLogo !== before.brandLogo) changes.push({field: 'brandLogo', from: short(before.brandLogo), to: short(newLogo)});
      if (changes.length) await audit(db, c, {action: 'settings.updated', meta: {changes}});
      const [after, afterPriv] = await Promise.all([getSettings(db), getPrivateSettings(db)]);
      return c.json({settings: {...after, ...afterPriv}});
    },
  );
