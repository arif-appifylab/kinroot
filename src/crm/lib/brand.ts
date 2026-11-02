/**
 * Brand identity. Kinroot is the template's default brand; each company that
 * installs it renames it in Settings → Branding (stored in the database) or
 * changes these defaults here.
 */
export const BRAND = {
  name: 'Kinroot',
  tagline: 'Grow every relationship.',
  description: 'Contacts, companies, deals, tasks and every conversation in one place.',
  primary: '#2563eb',
  secondary: '#0d9488',
} as const;

export type Brand = {name: string; logo: string; primary: string; secondary: string};

export const DEFAULT_BRAND: Brand = {name: BRAND.name, logo: '', primary: '', secondary: ''};

// The brand currently in effect. Set by the root loader (server and browser),
// read by page titles. One install has one brand, so a module value is enough.
let current: Brand = DEFAULT_BRAND;

export function setCurrentBrand(brand: Brand) {
  current = brand;
}

export const brandName = () => current.name || BRAND.name;

/** "Deals · Acme" */
export const pageTitle = (title: string) => `${title} · ${brandName()}`;
