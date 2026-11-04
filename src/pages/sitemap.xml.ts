import type {APIRoute} from 'astro';

import {absoluteUrl, xmlEscape as escape} from '../lib/seo';
import {crmRead} from '../server/crm/page';
import type {PublicWebsite} from '../crm/lib/website';

/**
 * `/sitemap.xml`, rendered ON REQUEST (it asks Kinroot which website pages are on) and cached for an
 * hour: the public pages in `src/pages/` (found automatically), less the website pages that are off.
 *
 * Never listed: sign-in pages, Kinroot (`/crm`), the old dashboard addresses, the API, the 404 and
 * 500 pages. A new public dynamic route (`[slug].astro`) is not found automatically: add its URLs
 * here. A page with `noindex` goes in EXCLUDE.
 */
export const prerender = false;

// Kinroot: the chat popup and a customer's own requests are noindex pages.
const EXCLUDE = new Set(['/404/', '/500/', '/chat/', '/support/tickets/']);
const PRIVATE = /^\/(account|crm|dashboard|portal|site-api)(\/|$)/;

/** `./contact.astro` → `/contact/`, `./support/index.astro` → `/support/` (every page URL ends with `/`, like the canonical). */
const pagePaths = Object.keys(import.meta.glob('./**/*.astro'))
  .filter(file => !file.includes('['))
  .map(file => `/${file.slice(2).replace(/\.astro$/, '').replace(/(^|\/)index$/, '')}/`.replace(/\/+/g, '/'))
  .filter(path => !PRIVATE.test(path) && !EXCLUDE.has(path))
  .sort();

export const GET: APIRoute = async ({request}) => {
  const website = await crmRead<PublicWebsite>(request, '/public/website');
  // Kinroot's website pages only when they show something (off: `/` opens the CRM, the others are 404s).
  const hidden = new Set([
    ...(website && !website.enabled ? ['/', '/contact/', '/demo/'] : []),
    ...(website && !website.contact ? ['/contact/'] : []),
    ...(website && !website.demo ? ['/demo/'] : []),
    // The customer portal's pages only while the portal is on (AUDIT-2 L-15).
    ...(website && !website.support ? ['/support/'] : []),
  ]);
  const urls = pagePaths
    .filter(path => !hidden.has(path))
    .flatMap(path => {
      const loc = absoluteUrl(path);
      return loc ? [`  <url><loc>${escape(loc)}</loc></url>`] : [];
    });
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}${urls.length ? '\n' : ''}</urlset>\n`;
  return new Response(body, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      // The same for everyone (no cookies read): browsers and caches may keep it an hour,
      // but only a complete one: without Kinroot's answer (a database outage) a few minutes.
      'Cache-Control': website ? 'public, max-age=3600' : 'public, max-age=300',
    },
  });
};
