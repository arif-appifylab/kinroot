import type {APIRoute} from 'astro';

import {postHref, publishedPosts} from '../lib/posts';
import {absoluteUrl, xmlEscape as escape} from '../lib/seo';
import {backend, read} from '../server/backend';

/**
 * `/sitemap.xml`, rendered ON REQUEST (it lists the open jobs from the Site
 * Database) and cached for an hour: the public pages in `src/pages/` (found
 * automatically), every blog post and the newest open jobs (one bounded,
 * indexed query: `GET /site-api/jobs/sitemap`).
 *
 * Never listed: sign-in pages, the dashboard, the API, the 404 and 500 pages. A new public
 * dynamic route (`[slug].astro`) is not found automatically: add its URLs
 * here, as posts and jobs are. A page with `<Base noindex>` goes in EXCLUDE.
 */
export const prerender = false;

const EXCLUDE = new Set(['/404/', '/500/', '/checkout/', '/thanks/']);
const PRIVATE = /^\/(account|portal|site-api)(\/|$)/;

/** `./about.astro` → `/about/`, `./blog/index.astro` → `/blog/` (every page URL ends with `/`, like the canonical). */
const pagePaths = Object.keys(import.meta.glob('./**/*.astro'))
  .filter(file => !file.includes('['))
  .map(file => `/${file.slice(2).replace(/\.astro$/, '').replace(/(^|\/)index$/, '')}/`.replace(/\/+/g, '/'))
  .filter(path => !PRIVATE.test(path) && !EXCLUDE.has(path))
  .sort();

export const GET: APIRoute = async ({request}) => {
  const [posts, jobs] = await Promise.all([
    publishedPosts(),
    read<{jobs: {slug: string; updatedAt: string}[]}>(backend(request).jobs.sitemap.$get()),
  ]);
  const entries: {path: string; lastmod?: string}[] = [
    ...pagePaths.map(path => ({path})),
    ...posts.map(post => ({path: postHref(post), lastmod: (post.data.updatedAt ?? post.data.publishedAt).toISOString()})),
    ...(jobs?.jobs ?? []).map(job => ({path: `/jobs/${encodeURIComponent(job.slug)}/`, lastmod: job.updatedAt})),
  ];
  const urls = entries.flatMap(({path, lastmod}) => {
    const loc = absoluteUrl(path);
    return loc ? [`  <url><loc>${escape(loc)}</loc>${lastmod ? `<lastmod>${lastmod.slice(0, 10)}</lastmod>` : ''}</url>`] : [];
  });
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}${urls.length ? '\n' : ''}</urlset>\n`;
  return new Response(body, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      // The same for everyone (no cookies read): browsers and caches may keep it an hour,
      // but only a complete one: without the jobs (a database outage) a few minutes.
      'Cache-Control': jobs ? 'public, max-age=3600' : 'public, max-age=300',
    },
  });
};
