/**
 * The site's search basics (`src/lib/seo.ts`, `src/layouts/CrmPublic.astro`). The company website's
 * words (home, contact, demo) and its name and logo are Kinroot's: Settings → Website and Branding.
 */
export const SITE = {
  /** `en`, `fr`, … : the page language (screen readers, search engines). */
  lang: 'en',
  /**
   * The address search engines should treat as THE address (canonical URLs,
   * sitemap, social cards): set it to the custom domain once the owner has one
   * (`https://www.example.com`, no trailing slash). Empty = the address
   * The platform gives the site (`SITE_URL`, src/lib/seo.ts).
   */
  url: '',
};
