import type {APIRoute} from 'astro';

import {BRAND} from '../crm/lib/brand';
import {absoluteUrl, xmlEscape as escape} from '../lib/seo';
import {SITE} from '../content/site';
import {crmBrand} from '../server/crm/page';

/**
 * `/rss.xml`: a valid RSS 2.0 feed with no items. The blog was removed (owner-approved), but the
 * platform's rule keeps `/rss.xml` answering (docs/agent/seo.md), so feed readers and checks that
 * know the address get a feed instead of a 404. Server-rendered: the channel carries the company's
 * name from Settings → Branding. Add `<item>`s here if the site publishes posts again.
 */
export const prerender = false;

export const GET: APIRoute = async ({request}) => {
  // The brand only (never the visitor): the same feed for everyone, cached an hour.
  const brand = await crmBrand(request);
  const name = brand.name || BRAND.name;
  const home = absoluteUrl('/') ?? '/';
  const self = absoluteUrl('/rss.xml');
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${escape(name)}</title>`,
    `    <link>${escape(home)}</link>`,
    `    <description>${escape(`${name}: ${BRAND.description}`)}</description>`,
    `    <language>${escape(SITE.lang)}</language>`,
    ...(self ? [`    <atom:link href="${escape(self)}" rel="self" type="application/rss+xml" />`] : []),
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
  return new Response(body, {headers: {'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600'}});
};
