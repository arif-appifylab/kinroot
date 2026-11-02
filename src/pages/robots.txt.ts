import type {APIRoute} from 'astro';

import {absoluteUrl} from '../lib/seo';

/**
 * `/robots.txt`, PRERENDERED: crawlers may read every page and learn where
 * the sitemap is. The sign-in pages (`/account/*`) and the dashboard
 * (`/dashboard`) are kept out of search by their `noindex` tag, which a crawler
 * only sees when it may fetch the page: a `Disallow` there would hide the tag
 * and let the bare URL be listed from links. `/site-api/` is JSON, not pages
 * (no tag to carry), so it stays disallowed. Only block search engines
 * entirely when the owner asks for exactly that.
 */
export const prerender = true;

export const GET: APIRoute = () => {
  const sitemap = absoluteUrl('/sitemap.xml');
  const body = [
    'User-agent: *',
    'Allow: /',
    'Disallow: /site-api/',
    ...(sitemap ? ['', `Sitemap: ${sitemap}`] : []),
    '',
  ].join('\n');
  return new Response(body, {headers: {'Content-Type': 'text/plain; charset=utf-8'}});
};
