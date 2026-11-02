import {BRAND} from '@/lib/brand';
import {createDb} from '../kit/db';
import {getSettings} from './settings';

export type PublicBrand = {name: string; logo: string; primary: string; secondary: string};

const DEFAULT: PublicBrand = {name: BRAND.name, logo: '', primary: '', secondary: ''};

// One deployment is one company, so a short in-memory cache is safe.
let cache: {at: number; brand: PublicBrand} | null = null;

export function clearBrandCache() {
  cache = null;
}

export async function loadBrand(): Promise<PublicBrand> {
  if (cache && Date.now() - cache.at < 30_000) return cache.brand;
  try {
    const db = await createDb();
    const s = await getSettings(db);
    const brand = {name: s.brandName || BRAND.name, logo: s.brandLogo, primary: s.brandPrimary, secondary: s.brandSecondary};
    cache = {at: Date.now(), brand};
    return brand;
  } catch {
    // e.g. no database yet in a fresh preview: fall back to the defaults.
    return DEFAULT;
  }
}
