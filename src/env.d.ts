/**
 * What the platform hands the deployed Worker, read with
 * `import {env} from 'cloudflare:workers'` in `src/platform/config.ts` ONLY.
 *
 *   SITE_URL        a plain var: the site's own address, where the
 *                       platform answers `/api/*`.
 *   SITE_PREVIEW         `'1'` ONLY in the editor Preview. Never set when deployed.
 *   DATABASE_URL        a secret: the Site Database (the Preview Database in the
 *                       editor). Empty until the owner enables the Site Database.
 *   SITE_KEY  a secret: the Site Key, for `/api/site/v1/...`.
 *   JWT_SECRET          a secret: signs access tokens (platform-managed, >= 32 chars).
 *   SITE_JOBS_SECRET  a secret: checks background-job deliveries (platform-managed).
 *   SITE_OWNER_EMAILS    a plain var: the site owner's email(s), comma separated.
 *                       Only these may claim the owner role on the live site.
 *
 * Never send a secret to the browser, log it, or write it to a file.
 */
declare namespace Cloudflare {
  interface Env {
    SITE_URL?: string;
    SITE_PREVIEW?: string;
    DATABASE_URL?: string;
    SITE_KEY?: string;
    JWT_SECRET?: string;
    SITE_JOBS_SECRET?: string;
    SITE_OWNER_EMAILS?: string;
  }
}

/** Typed `env` for `import {env} from 'cloudflare:workers'`. */
declare module 'cloudflare:workers' {
  export const env: Cloudflare.Env;
}
