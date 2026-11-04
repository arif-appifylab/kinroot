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
 *   dbTransport SITE_DB_TRANSPORT  a plain var, set only by the platform: `https` turns the
 *                                  database socket off (`db-socket.ts`). Normally unset.
 *   jobsSecret  SITE_JOBS_SECRET  secret: checks that a background-job
 *                                   delivery really came from the dashboard
 *                                   (`src/platform/background.ts`). Platform-managed.
 *   jwtSecret   JWT_SECRET          secret: signs this site's access tokens and
 *                                   keys its rate-limit hashes. Platform-managed,
 *                                   at least 32 characters. Rotating it signs
 *                                   everyone out of their access token (their
 *                                   refresh token still works).
 *   ownerId     SITE_OWNER_ID   a plain var: the platform's opaque id for the account's owner. Never an
 *                                   email. A change means the site changed hands (auth/owner-seat.ts).
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
  get dbTransport(): string | null {
    return env.SITE_DB_TRANSPORT || null;
  },
  get jobsSecret(): string | null {
    return env.SITE_JOBS_SECRET || null;
  },
  get jwtSecret(): string | null {
    const secret = env.JWT_SECRET ?? '';
    return secret.length >= 32 ? secret : null;
  },
  get ownerId(): string | null {
    return env.SITE_OWNER_ID || null;
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
