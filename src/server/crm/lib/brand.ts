import {cache} from '../../../platform/cache';
import {BRAND} from '@/lib/brand';
import type {Db} from '../kit/db';
import {getSettings} from './settings';

export type PublicBrand = {name: string; logo: string; primary: string; secondary: string};

const DEFAULT: PublicBrand = {name: BRAND.name, logo: '', primary: '', secondary: ''};

/** The Site Cache key (docs/agent/cache.md); cleared by every route that saves the branding. */
const KEY = 'crm:brand';

/**
 * The company's name, logo and colours (Settings → Branding), for page titles, the favicon,
 * emails and public pages. Read on many requests and changed rarely: kept in the Site Cache for a
 * day, cleared the moment Settings → Branding saves (`clearBrandCache`).
 */
export async function loadBrand(db: Db): Promise<PublicBrand> {
  try {
    return await cache.getOrSet(KEY, 86_400, async () => {
      const s = await getSettings(db);
      return {name: s.brandName || BRAND.name, logo: s.brandLogo, primary: s.brandPrimary, secondary: s.brandSecondary};
    });
  } catch {
    // e.g. no database yet in a fresh preview: fall back to the defaults.
    return DEFAULT;
  }
}

export async function clearBrandCache() {
  await cache.del(KEY);
}
