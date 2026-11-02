import {SITE} from '../content/site';
import {config} from '../platform/config';

/**
 * SERVER / BUILD TIME: the site's public origin (`https://www.example.com`,
 * no trailing slash) for canonical URLs, social cards, the sitemap, robots.txt
 * and RSS. `SITE.url` when the owner set it (a custom domain), else the
 * address the platform gives the site (`config.siteUrl`, also set while a Publish
 * PRERENDERS pages). '' in `npm run dev` and the editor Preview, whose address
 * is not the site's: pages then leave absolute URLs out.
 */
export function siteOrigin(): string {
  if (import.meta.env.DEV || config.preview) return SITE.url.replace(/\/+$/, '');
  const origin = (SITE.url || config.siteUrl || '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^/\s]+$/.test(origin) ? origin : '';
}

/** `path` (or an https URL) as an absolute URL; null when the origin is not known. */
export function absoluteUrl(path: string): string | null {
  if (/^https:\/\//.test(path)) return path;
  const origin = siteOrigin();
  return origin ? new URL(path, `${origin}/`).href : null;
}

/** Escape a value for XML text or an attribute (sitemap, RSS). */
export const xmlEscape = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Structured data (schema.org JSON-LD) for search engines. `<Base>` renders it
 * as `<script type="application/ld+json">`: a data block, never executed, so
 * the CSP does not apply to it. Only facts the page itself shows; absolute
 * URLs only when the site's address is known (`siteOrigin()`).
 */
export type JsonLd = Record<string, unknown>;

/** JSON safe inside `<script>` (no `</script>`, no `<!--`): the ONLY way to render JSON-LD. */
export function jsonLdText(data: JsonLd): string {
  return JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

const organizationId = () => {
  const origin = siteOrigin();
  return origin ? `${origin}/#organization` : null;
};

/** The site as an `Organization` (name, address, logo): the publisher of posts and the hiring org of jobs. */
function organization(site: {name: string; logo?: string | null}): JsonLd {
  const id = organizationId();
  const url = absoluteUrl('/');
  const logo = site.logo ? absoluteUrl(site.logo) : null;
  return {'@type': 'Organization', ...(id && {'@id': id}), name: site.name, ...(url && {url}), ...(logo && {logo})};
}

/** The home page's `WebSite` + `Organization` (the site name in search results). */
export function siteJsonLd(site: {name: string; logo?: string | null}, description: string, lang: string): JsonLd {
  const origin = siteOrigin();
  const url = absoluteUrl('/');
  const id = organizationId();
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        ...(origin && {'@id': `${origin}/#website`}),
        name: site.name,
        description,
        inLanguage: lang,
        ...(url && {url}),
        ...(id && {publisher: {'@id': id}}),
      },
      organization(site),
    ],
  };
}

/** A blog post's `BlogPosting`, from its front matter. */
export function postJsonLd(
  site: {name: string; logo?: string | null},
  post: {path: string; title: string; description: string; publishedAt: Date; updatedAt?: Date; author?: string; image?: string | null}
): JsonLd {
  const url = absoluteUrl(post.path);
  const image = post.image ? absoluteUrl(post.image) : null;
  const publisher = organization(site);
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    description: post.description,
    datePublished: post.publishedAt.toISOString(),
    dateModified: (post.updatedAt ?? post.publishedAt).toISOString(),
    author: post.author ? {'@type': 'Person', name: post.author} : publisher,
    publisher,
    ...(url && {url, mainEntityOfPage: url}),
    ...(image && {image}),
  };
}

const EMPLOYMENT_TYPE: Record<string, string> = {
  'full-time': 'FULL_TIME',
  'part-time': 'PART_TIME',
  contract: 'CONTRACTOR',
  internship: 'INTERN',
};

/** An open job's `JobPosting` (Google for Jobs). The description is plain text, as on the page. */
export function jobJsonLd(job: {
  slug: string;
  title: string;
  company: string;
  location: string;
  type: string;
  remote: boolean;
  description: string;
  createdAt: string;
}): JsonLd {
  const url = absoluteUrl(`/jobs/${encodeURIComponent(job.slug)}/`);
  return {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: job.title,
    description: job.description,
    datePosted: job.createdAt,
    hiringOrganization: {'@type': 'Organization', name: job.company},
    jobLocation: {'@type': 'Place', address: {'@type': 'PostalAddress', addressLocality: job.location}},
    ...(job.remote && {jobLocationType: 'TELECOMMUTE'}),
    ...(EMPLOYMENT_TYPE[job.type] && {employmentType: EMPLOYMENT_TYPE[job.type]}),
    ...(url && {url}),
  };
}
