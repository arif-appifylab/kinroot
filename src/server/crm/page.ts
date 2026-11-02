import {DEFAULT_BRAND, type Brand} from '@/lib/brand';
import {app} from '../app';

/**
 * A Kinroot Site API read for a page (`/public/...` routes), IN-PROCESS like `backend()`: the parsed
 * JSON, or null on any error (the page renders its fallback).
 */
export async function crmRead<T>(request: Request, path: string): Promise<T | null> {
  return (await crmGet<T>(request, path)).data;
}

/**
 * The same with the answer's status, for pages that must tell "not there" (404) from "the
 * database is down" (503, never a 404): `status` is 0 when the call itself failed.
 */
export async function crmGet<T>(request: Request, path: string): Promise<{status: number; data: T | null}> {
  try {
    const res = await app.request(new URL(`/site-api/crm${path}`, request.url).toString(), {headers: {'user-agent': request.headers.get('user-agent') ?? ''}});
    return {status: res.status, data: res.ok ? ((await res.json()) as T) : null};
  } catch {
    return {status: 0, data: null};
  }
}

/**
 * The company's brand for a page that renders Kinroot (the `/crm` host page, public CRM pages):
 * Kinroot's own Site API route, called IN-PROCESS like `backend()` (src/server/backend.ts), never a
 * fetch of this site's own address. Falls back to the defaults on any error.
 */
export async function crmBrand(request: Request): Promise<Brand> {
  try {
    const res = await app.request(new URL('/site-api/crm/public/brand', request.url).toString(), {headers: {'user-agent': request.headers.get('user-agent') ?? ''}});
    if (!res.ok) return DEFAULT_BRAND;
    const b = (await res.json()) as Partial<Brand>;
    return {name: b.name ?? '', logo: b.logo ?? '', primary: b.primary ?? '', secondary: b.secondary ?? ''};
  } catch {
    return DEFAULT_BRAND;
  }
}
