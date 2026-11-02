import {env} from 'cloudflare:workers';

/**
 * The ONLY file that reads the platform's environment. The names on the left
 * of each line are the hosting platform's contract (it sets them; you cannot
 * rename or add them); everything else in this project uses `config`.
 *
 *   siteUrl     SITE_URL        the site's own address, where the
 *                                   platform answers `/api/*` (a plain var).
 *   preview     SITE_PREVIEW         true ONLY in the editor Preview.
 *   siteKey     SITE_KEY  secret: the Site Key, for `/api/site/v1/...`
 *                                   (relayed emails). Server only.
 *   databaseUrl DATABASE_URL        secret: the Site Database (the Preview
 *                                   Database in the editor).
 *   jobsSecret  SITE_JOBS_SECRET  secret: checks that a background-job
 *                                   delivery really came from the dashboard
 *                                   (`src/platform/background.ts`). Platform-managed.
 *   jwtSecret   JWT_SECRET          secret: signs this site's access tokens and
 *                                   keys its rate-limit hashes. Platform-managed,
 *                                   at least 32 characters. Rotating it signs
 *                                   everyone out of their access token (their
 *                                   refresh token still works).
 *   ownerEmails SITE_OWNER_EMAILS    a plain var: the site owner's address(es),
 *                                   comma separated, set at each Deploy. Only
 *                                   these (and `ownerEmails` in
 *                                   src/server/auth-settings.ts) may claim the
 *                                   owner role on a live site.
 *   production  (no variable)       true on the deployed site: a production
 *                                   build that is not the editor Preview.
 *   ownerSecret(NAME)               a secret the OWNER added in the dashboard
 *                                   (another service's API key: a payment
 *                                   provider, mail, SMS, AI…): test value in
 *                                   `staging` (the Preview), live in
 *                                   `production`. Never a platform name.
 *
 * Server code only. Never send a value to the browser, log it, or write it to
 * a file.
 */
/** The platform's own names: never readable as an owner secret. */
const PLATFORM_NAMES = /^(SITE_|DATABASE_URL$|JWT_SECRET$)/;

export const config = {
  get siteUrl(): string | null {
    return env.SITE_URL?.replace(/\/+$/, '') || null;
  },
  get preview(): boolean {
    return env.SITE_PREVIEW === '1';
  },
  get siteKey(): string | null {
    return env.SITE_KEY || null;
  },
  get databaseUrl(): string | null {
    return env.DATABASE_URL || null;
  },
  get jobsSecret(): string | null {
    return env.SITE_JOBS_SECRET || null;
  },
  get jwtSecret(): string | null {
    const secret = env.JWT_SECRET ?? '';
    return secret.length >= 32 ? secret : null;
  },
  get ownerEmails(): string[] {
    return (env.SITE_OWNER_EMAILS ?? '')
      .split(',')
      .map(email => email.trim().toLowerCase())
      .filter(email => /^[^\s@]+@[^\s@]+$/.test(email));
  },
  ownerSecret(name: string): string | null {
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name) || PLATFORM_NAMES.test(name)) return null;
    const value = (env as unknown as Record<string, unknown>)[name];
    return typeof value === 'string' && value ? value : null;
  },
  get production(): boolean {
    return import.meta.env.PROD === true && !this.preview;
  },
};
