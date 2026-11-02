import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import {MAX_HIGHLIGHTS, type WebsiteSettings} from '@/lib/website';
import {requireRole, type AppEnv} from '../kit/guards';
import {diff} from '../lib/activity';
import {audit} from '../lib/audit';
import {valid} from '../lib/http';
import {ensureWebsiteDefaults, getWebsiteSettings, publicWebsite, saveWebsiteSettings, websiteChoices} from '../lib/website';

/** GET /site-api/crm/public/website: what the landing pages show (no sign-in). */
export const websitePublic = new Hono<AppEnv>().get('/website', async (c) => c.json(await publicWebsite(c.var.db)));

const settingsSchema = z.object({
  enabled: z.boolean(),
  headline: z.string().trim().min(1, 'Add a headline').max(120),
  subheadline: z.string().trim().max(400),
  highlights: z.array(z.object({title: z.string().trim().min(1, 'Each highlight needs a title').max(60), text: z.string().trim().max(200)})).max(MAX_HIGHLIGHTS),
  contactFormId: z.string().max(60).nullable(),
  demoLinkId: z.string().max(60).nullable(),
  showChat: z.boolean(),
  showSupport: z.boolean(),
});

/** Settings → Website (admins). */
export const website = new Hono<AppEnv>()
  .get('/settings', requireRole('ADMIN'), async (c) => {
    const db = c.var.db;
    const settings = await ensureWebsiteDefaults(db, await getWebsiteSettings(db));
    return c.json({settings, ...(await websiteChoices(db))});
  })

  .put('/settings', requireRole('ADMIN'), valid('json', settingsSchema), async (c) => {
    const db = c.var.db;
    const before = await getWebsiteSettings(db);
    const next: WebsiteSettings = c.req.valid('json');
    const {forms, links} = await websiteChoices(db);
    if (next.contactFormId && !forms.some((f) => f.id === next.contactFormId)) throw new HTTPException(400, {message: 'Pick a published form for Contact us'});
    if (next.demoLinkId && !links.some((l) => l.id === next.demoLinkId)) throw new HTTPException(400, {message: 'Pick an active booking link for Book a demo'});
    await saveWebsiteSettings(db, next);
    await audit(db, c, {action: 'settings.website', meta: {changes: diff(before as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>)}});
    return c.json({settings: next});
  });
