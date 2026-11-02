---
title: SEO: public pages search engines and social apps understand
read-when: before adding or renaming a public page, changing a title or description, a URL, a social card, the sitemap, robots.txt or the RSS feed
---
The public side of this app (home, about, blog, jobs) is real HTML at real URLs: prerendered or
rendered on the server, never painted by JavaScript. Keep it so. The sign-in pages, the
portal and the Site API stay out of search.

## Every public page
- A unique `title` and `description` (~150 characters, says what the page is for), passed to
  `<Base title description>`. The tab shows "<title> · <site name>"; the home page omits
  `title`. Without a `description` the page falls back to `SITE.description`
  (`src/content/site.ts`): write a real one for every page that should rank.
- `<Base>` writes the canonical URL, `og:site_name`, `og:type`, `og:title`, `og:description`,
  `og:url`, `og:image` (+ `og:image:alt`), the `twitter:*` card tags and, on posts
  (`type="article"`), `article:published_time` / `article:modified_time`. Pass `image` (a
  `/path` or an https URL, 1200×630, made absolute for you) where a page has a picture.
- The address comes from `src/lib/seo.ts`: `SITE.url` in `src/content/site.ts` when the owner
  set it (their custom domain, `https://www.example.com`, no trailing slash), else the address
  the platform gives the site (`{{SITE_URL_ENV}}`, `{{SITE_ORIGIN_PATTERN}}`). In `npm run dev` and
  the editor Preview it is unknown and the absolute tags are left out: that is expected.
- `<html lang>` is `SITE.lang`. One `<h1>`, headings in order, `alt` on content images.
- Public pages are real pages at real URLs, linked with plain `<a href>`; instant clicks come
  from prefetch + Astro's ClientRouter (`performance.md`), which swaps in those same server-
  rendered pages; never from moving a page into the portal SPA.

## Structured data (JSON-LD)
- Built in `src/lib/seo.ts`, written by `<Base>` as `<script type="application/ld+json">` (a
  data block: never executed, so the CSP allows it). The home page gets `WebSite` +
  `Organization` (name, logo from the platform's brand); a post passes
  `jsonLd={postJsonLd(…)}` (`BlogPosting`); an open job `jsonLd={jobJsonLd(job)}`
  (`JobPosting`, for job search).
- A new public page type with a schema.org type (an event, a product, an FAQ): add a builder
  in `seo.ts` and pass it to `<Base jsonLd>`. Only facts the page itself shows; absolute URLs
  through `absoluteUrl()`. `<Base>` drops it on `noindex` and `secretInUrl` pages.
- Always through `jsonLdText()` (escapes `<`, so data can never close the script), never a
  hand-written `<script>` or `set:html` of anything else. Check with Google's Rich Results
  Test on the live page.

## URLs
- Public page URLs end with `/` (`/about/`, `/blog/<slug>/`, `/jobs/<slug>/`): prerendered pages
  are served there (`/about` costs a redirect), and the canonical URL and the sitemap use that
  form. Link with the slash; lowercase, dashes.
- The canonical URL is the path WITHOUT the query string: `/jobs/?type=contract` and
  `/jobs/?before=40` point search engines at `/jobs/`.
- A blog post's file name is its URL; a job's `slug` is its URL. Never rename a published one
  (old links and rankings break).

## Private pages
- `noindex` on everything that is not public content: the `/account/*` pages and the 404 have
  it (`<Base noindex>`); the portal's layout (`App.astro`) has it. Add it to any thank-you,
  test or per-user page.
- A page whose URL carries a secret (a reset token) also passes `secretInUrl` (no Referer, no
  canonical).
- Never put visitor data in a prerendered page (`AGENTS.md`).

## Sitemap, robots.txt, RSS (this site's own; keep all three)
- `/sitemap.xml` (`src/pages/sitemap.xml.ts`, on request, cached 1 h): every page in
  `src/pages/` found automatically (minus `/account`, `/dashboard`, `/site-api`, the 404 and
  `EXCLUDE`), every blog post (`lastmod` from its dates) and the newest open jobs (one bounded,
  indexed query: `GET /site-api/jobs/sitemap`). A NEW public dynamic route (`[slug].astro`
  with its data in the Site Database) is not found automatically: add a small bounded
  `…/sitemap` route like the jobs one and list its URLs there. A new `noindex` page goes in
  `EXCLUDE`.
- `/robots.txt` (`src/pages/robots.txt.ts`, prerendered): allows the site, disallows only
  `/site-api/` (JSON, no page to carry a tag), names the sitemap. `/account/*` and `/dashboard` are
  NOT disallowed on purpose: their `noindex` keeps them out of search, and a crawler only sees
  it when it may fetch the page (a `Disallow` lets the bare URL be listed from links). Keep a
  private page out of search with `noindex`, never with `Disallow`. Never `Disallow: /` or
  `noindex` on real pages unless the owner asks for exactly that.
- `/rss.xml` (`src/pages/rss.xml.ts`, prerendered): the 20 newest posts; every page links it.
- Don't add `public/robots.txt` or `public/sitemap.xml` copies (they would clash with the
  routes). `/.well-known/` files only when the owner asks (domain verification).

## Check before "done"
`npm run build`, then in the Preview: view the page source (one `<title>`, a description, one
`<h1>`), `/sitemap.xml` lists the new page, and a Lighthouse SEO run on a public page is ≥ 95.
