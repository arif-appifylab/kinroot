import {Hono} from 'hono';

import {cache} from '../../../platform/cache';
import {BRAND} from '@/lib/brand';
import {loadBrand} from '../lib/brand';
import {getSettings} from '../lib/settings';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import {MAX_HIGHLIGHTS, type WebsiteSettings} from '@/lib/website';
import {requireRole, type AppEnv} from '../kit/guards';
import {diff} from '../lib/activity';
import {audit} from '../lib/audit';
import {valid} from '../lib/http';
import {ensureWebsiteDefaults, getWebsiteSettings, publicWebsite, saveWebsiteSettings, WEBSITE_CACHE_KEY, websiteChoices} from '../lib/website';

/**
 * Read on every visit of the website's pages (/, /contact/, /demo/, the sitemap) and changed rarely: kept
 * in the Site Cache for 5 minutes, cleared when Settings → Website saves. It also shows a few other
 * settings (the form's name, the booking link, the chat and support switches): those show within 5 minutes.
 */

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
  })
  /**
   * GET /site-api/crm/public/favicon.svg: Kinroot's sprout mark in the company's colours, the tab
   * icon when there is no logo. The layouts link it with `?v=<colours>`, so a new palette is a new
   * URL and this one may be kept for a day.
   */
  .get('/favicon.svg', async (c) => {
    const b = await loadBrand(c.var.db);
    return c.body(sproutFavicon(hex6(b.primary) || BRAND.primary, hex6(b.secondary) || BRAND.secondary), 200, {
      'content-type': 'image/svg+xml',
      'cache-control': 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
  })
  /**
   * GET /site-api/crm/public/logo: an older install's logo, saved as a data URL before logos became
   * storage files (lib/brand.ts `logoUrl`), so the cached brand holds a short URL instead of the
   * image. Never run as a page (sandboxed, no scripts), cached by its `?v=` content hash.
   */
  .get('/logo', async (c) => {
    const logo = (await getSettings(c.var.db)).brandLogo;
    const m = /^data:(image\/(?:png|jpeg|gif|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/.exec(logo);
    if (!m) return c.text('No logo', 404);
    const bytes = Uint8Array.from(atob(m[2]!), (ch) => ch.charCodeAt(0));
    return new Response(bytes, {
      headers: {
        'content-type': m[1]!,
        'cache-control': 'public, max-age=86400',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    });
  });

/** `#rrggbb` only (the colours go into SVG markup). */
const hex6 = (v: string) => (/^#[0-9a-f]{6}$/i.test(v) ? v : '');

/** The original Kinroot favicon (its __root.tsx `sproutFavicon`), as an SVG file. */
const sproutFavicon = (primary: string, secondary: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${primary}"/><stop offset="1" stop-color="${secondary}"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="url(#g)"/><g fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" transform="translate(4 4)"><path d="M12 16V9"/><path d="M12 10.5C12 7 14.2 4.5 18 4.5c0 3.6-2.4 6-6 6Z"/><path d="M12 12C12 9.3 10.2 7.2 7 7.2c0 2.8 2 4.8 5 4.8Z"/><path d="M5.5 16h13"/><path d="M12 16v4M12 18l-3 2.5M12 18l3 2.5"/></g></svg>`;

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
