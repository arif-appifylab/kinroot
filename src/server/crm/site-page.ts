import type {Brand} from '@/lib/brand';
import type {PublicWebsite} from '@/lib/website';
import {crmBrand, crmGet} from './page';

/**
 * What the company website's pages (src/pages/index.astro, contact.astro, demo.astro) need: Settings →
 * Website and the brand, read in-process and at the same time. `site` is null when the read failed
 * (the page answers 503, never a 404). Nothing here reads the visitor, so the HTML can be cached.
 */
export async function websitePage(request: Request): Promise<{site: PublicWebsite | null; brand: Brand}> {
  const [res, brand] = await Promise.all([crmGet<PublicWebsite>(request, '/public/website'), crmBrand(request)]);
  return {site: res.data, brand};
}

/** Settings → Website changes show within a minute; no visitor data is in these pages. */
export const WEBSITE_CACHE = 'public, max-age=60';
