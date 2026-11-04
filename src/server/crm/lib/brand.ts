import {cache} from '../../../platform/cache';
import {BRAND} from '@/lib/brand';
import {CRM_API} from '../kit/config';
import {sha256Hex} from '../kit/crypto';
import type {Db} from '../kit/db';
import {BRAND_CACHE_KEY, getSettings} from './settings';

export type PublicBrand = {name: string; logo: string; primary: string; secondary: string};

const DEFAULT: PublicBrand = {name: BRAND.name, logo: '', primary: '', secondary: ''};

/** A logo data URL up to this size is used as it is (a small SVG); a bigger one is served by URL. */
const INLINE_LOGO_MAX = 8_192;

/** Where an older install's data-URL logo is served from (GET /public/logo), so the cached brand stays small. */
export async function logoUrl(logo: string) {
  if (!logo.startsWith('data:') || logo.length <= INLINE_LOGO_MAX) return logo;
  return `${CRM_API}/public/logo?v=${(await sha256Hex(logo)).slice(0, 12)}`;
}

/**
 * The company's name, logo and colours (Settings → Branding), for page titles, the favicon,
 * emails and public pages. Read on many requests and changed rarely: kept in the Site Cache for a
 * day, cleared the moment the settings are saved (lib/settings.ts `saveSettings`). Only small
 * values: the logo is a storage link, a small SVG, or the URL that serves an older install's logo.
 */
export async function loadBrand(db: Db): Promise<PublicBrand> {
  try {
    return await cache.getOrSet(BRAND_CACHE_KEY, 86_400, async () => {
      const s = await getSettings(db);
      return {name: s.brandName || BRAND.name, logo: await logoUrl(s.brandLogo), primary: s.brandPrimary, secondary: s.brandSecondary};
    });
  } catch {
    // e.g. no database yet in a fresh preview: fall back to the defaults.
    return DEFAULT;
  }
}

export async function clearBrandCache() {
  await cache.del(BRAND_CACHE_KEY);
}
