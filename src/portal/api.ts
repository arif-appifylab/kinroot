import {hc} from 'hono/client';

import {siteFetch} from '../platform/browser';
import type {AppType} from '../server/app';

/**
 * The typed Site API client for the browser: same origin, so the visitor's
 * cookies ride along. Every call goes through `siteFetch`, which adds the
 * CSRF header on writes and refreshes an expired session ONCE. Only the TYPE
 * of the server app is imported — no server code reaches the browser.
 */
export const api = hc<AppType>('/', {fetch: siteFetch})['site-api'];

/** An error carrying the server's field errors, for `form.setServerErrors`. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly fields: Record<string, string> = {}
  ) {
    super(message);
  }
}

/** The JSON body of a Site API response, or an `ApiError` carrying its message. */
export async function read<T>(response: Promise<Response>): Promise<T> {
  const res = await response;
  const body = (await res.json().catch(() => null)) as
    | (T & {message?: string; fields?: Record<string, string>})
    | null;
  if (!res.ok) throw new ApiError(body?.message ?? `Request failed (${res.status})`, res.status, body?.fields);
  return body as T;
}
