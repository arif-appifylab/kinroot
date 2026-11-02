import {config as site} from '../../../platform/config';

/**
 * Kinroot's view of the environment, read ONLY through the template's `config`
 * (src/platform/config.ts). Kinroot adds no environment names of its own: keys for other
 * services are owner-added secrets (`site.ownerSecret`), named where they are used.
 */
export const config = {
  siteUrl: () => site.siteUrl ?? '',
};

/** Public origin used in tracking pixels, OAuth redirects and invite links. */
export function publicOrigin(request: Request): string {
  return config.siteUrl() || new URL(request.url).origin;
}

/**
 * Where Kinroot's Site API lives. Every Kinroot route is mounted under it
 * (src/server/app.ts), apart from the template's own `/site-api/*` routes.
 */
export const CRM_API = '/site-api/crm';

/** Where the CRM app lives (src/pages/crm/[...path].astro). */
export const CRM_APP = '/crm';
