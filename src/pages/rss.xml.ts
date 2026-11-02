import type {APIRoute} from 'astro';

import {SITE, withName} from '../content/site';
import {postHref, publishedPosts} from '../lib/posts';
import {absoluteUrl, xmlEscape as escape} from '../lib/seo';
import {staticContext} from '../server/page';

/**
 * `/rss.xml`: the blog as an RSS 2.0 feed (the 20 newest posts), PRERENDERED
 * with the site. Every page links it from `<head>` (src/layouts/Base.astro).
 */
export const prerender = true;

const LIMIT = 20;

export const GET: APIRoute = async ({request}) => {
  const [{site}, all] = await Promise.all([staticContext(request), publishedPosts()]);
  const name = site?.name ?? 'My site';
  const posts = all.slice(0, LIMIT);
  // Feed readers need absolute links; without a known address (dev, Preview) they stay site-relative.
  const link = (path: string) => absoluteUrl(path) ?? path;
  const self = absoluteUrl('/rss.xml');
  const items = posts.map(post => {
    const url = link(postHref(post));
    return [
      '    <item>',
      `      <title>${escape(post.data.title)}</title>`,
      `      <link>${escape(url)}</link>`,
      `      <guid isPermaLink="true">${escape(url)}</guid>`,
      `      <description>${escape(post.data.description)}</description>`,
      `      <pubDate>${post.data.publishedAt.toUTCString()}</pubDate>`,
      ...post.data.tags.map(tag => `      <category>${escape(tag)}</category>`),
      '    </item>',
    ].join('\n');
  });
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${escape(name)}</title>`,
    `    <link>${escape(link('/blog/'))}</link>`,
    `    <description>${escape(withName(SITE.description, name))}</description>`,
    `    <language>${escape(SITE.lang)}</language>`,
    ...(self ? [`    <atom:link href="${escape(self)}" rel="self" type="application/rss+xml" />`] : []),
    ...(posts[0] ? [`    <lastBuildDate>${posts[0].data.publishedAt.toUTCString()}</lastBuildDate>`] : []),
    ...items,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
  return new Response(body, {headers: {'Content-Type': 'application/rss+xml; charset=utf-8'}});
};
