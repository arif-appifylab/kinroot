import {defineMiddleware} from 'astro:middleware';

import {SELF_FETCH_HEADER} from './platform/api';
import {config} from './platform/config';
import {forwardPlatformFiles, PLATFORM_FILES_PREFIX} from './platform/files';
import {applySecurityHeaders} from './platform/headers';
import {inRequestScope} from './platform/request-scope';

/**
 * Runs before every on-demand page and every `/site-api` call:
 *
 * 1. Opens the request's memo (`src/platform/request-scope.ts`), so the
 *    visitor and the Site Database client are made once per request.
 * 2. Stops a page from fetching ITSELF forever: on your own machine there is
 *    no platform behind `/api`, so a server-side fetch there would land on
 *    this site's 404 page, which fetches the brand again… Every server-side
 *    platform fetch carries `SELF_FETCH_HEADER`, and such a request is
 *    answered here with a bare 404.
 * 3. In the editor Preview and on your own machine, hands file uploads and public file links
 *    (`/__platform/files/*`) to the platform, which answers them itself when deployed
 *    (`src/platform/files.ts`).
 * 4. Adds the security headers (`src/platform/headers.ts`).
 */
export const onRequest = defineMiddleware((context, next) =>
  inRequestScope(async () => {
    if (context.url.pathname.startsWith('/api/') && context.request.headers.has(SELF_FETCH_HEADER)) {
      return new Response(JSON.stringify({error: 'not_found'}), {
        status: 404,
        headers: {'content-type': 'application/json'},
      });
    }
    if (
      context.url.pathname.startsWith(PLATFORM_FILES_PREFIX) &&
      (config.preview || import.meta.env.DEV)
    ) {
      return forwardPlatformFiles(context.request, context.url);
    }
    return applySecurityHeaders(await next(), context.url);
  })
);
