import {Hono} from 'hono';

import {cache} from '../../../platform/cache';
import {loadBrand} from '../lib/brand';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import {MAX_HIGHLIGHTS, type WebsiteSettings} from '@/lib/website';
import {requireRole, type AppEnv} from '../kit/guards';
import {diff} from '../lib/activity';
import {audit} from '../lib/audit';
import {valid} from '../lib/http';
import {ensureWebsiteDefaults, getWebsiteSettings, publicWebsite, saveWebsiteSettings, websiteChoices} from '../lib/website';

/**
 * Read on every visit of the website's pages (/, /contact/, /demo/, the sitemap) and changed rarely: kept
 * in the Site Cache for 5 minutes, cleared when Settings → Website saves. It also shows a few other
 * settings (the form's name, the booking link, the chat and support switches): those show within 5 minutes.
 */
const WEBSITE_CACHE_KEY = 'crm:public-website';

/** GET /site-api/crm/public/website: what the landing pages show (no sign-in). */
export const websitePublic = new Hono<AppEnv>()
  .get('/website', async (c) => c.json(await cache.getOrSet(WEBSITE_CACHE_KEY, 300, () => publicWebsite(c.var.db))))
  /** GET /site-api/crm/public/brand: the company's name, logo and colours (titles, favicon, public pages). */
  .get('/brand', async (c) => c.json(await loadBrand(c.var.db)))
  /**
   * GET /site-api/crm/public/brand.css: the company's colours over the default palette, in both
   * themes (the CSP allows no inline style, so it is a stylesheet from this site). Only `#rgb` /
   * `#rrggbb` values ever reach the CSS.
   */
  .get('/brand.css', async (c) => {
    const b = await loadBrand(c.var.db);
    const hex = (v: string) => (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v) ? v : '');
    const primary = hex(b.primary);
    const secondary = hex(b.secondary);
    const vars = [primary && `--primary:${primary};--ring:${primary};`, secondary && `--secondary:${secondary};`].filter(Boolean).join('');
    return c.body(vars ? `:root,:root.dark{${vars}}` : '', 200, {'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=300'});
  });

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
    await cache.del(WEBSITE_CACHE_KEY);
    await audit(db, c, {action: 'settings.website', meta: {changes: diff(before as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>)}});
    return c.json({settings: next});
  });
