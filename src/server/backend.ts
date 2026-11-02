import {hc} from 'hono/client';

import {app, type AppType} from './app';

/**
 * The Site API, called IN-PROCESS by Astro pages: the same Hono app the
 * browser reaches at `/site-api/*`, invoked directly (`app.request`) with no
 * network hop and nothing in between. Pages are only the view; every read and
 * write goes through Hono, so one set of routes, validators and guards serves
 * the pages, the portal and any other client.
 *
 *   const api = backend(Astro.request);
 *   const page = await read<JobsPage>(api.jobs.$get({query: {search: '', type: '', remote: '', before: ''}}));
 *
 * The visitor's own credentials (their `cookie` header) are passed through, so
 * `withViewer` sees the same visitor the page does. Never `fetch()` this
 * site's own hostname for a Site API path instead: it is a second Worker
 * invocation (slower, billed twice) and loses the per-request memo.
 */
const FORWARDED = ['cookie', 'authorization', 'user-agent', 'accept-language'];

export function backend(request: Request) {
  const origin = new URL(request.url).origin;
  return hc<AppType>(origin, {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      for (const name of FORWARDED) {
        const value = request.headers.get(name);
        if (value && !headers.has(name)) headers.set(name, value);
      }
      return app.request(input instanceof Request ? input : String(input), {...init, headers});
    },
  })['site-api'];
}

/** The JSON body of a Site API answer, or `null` on any error status. Pages render a fallback for `null`. */
export async function read<T>(response: Promise<Response>): Promise<T | null> {
  try {
    const res = await response;
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}
