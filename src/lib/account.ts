import {siteFetch} from '../platform/browser';
import type {Viewer} from '../platform/types';

/**
 * BROWSER helpers shared by the `/account/*` pages (prerendered: they know no
 * visitor until their script runs).
 */

/** `?next=` as a same-site PATH, or the fallback. Mirrors `safeNext` on the server. */
export function nextPath(fallback = '/dashboard'): string {
  const value = new URLSearchParams(window.location.search).get('next');
  if (!value || value.length > 512) return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback;
  if (/[\u0000-\u001f\\]/.test(value)) return fallback;
  return value;
}

/**
 * Reads a secret token from the URL ONCE and removes it from the address bar
 * (and so from history, bookmarks and the Referer of the next page).
 */
export function takeToken(): string | null {
  const url = new URL(window.location.href);
  const token = url.searchParams.get('token');
  if (token) {
    url.searchParams.delete('token');
    // Keep `history.state`: the client router (ClientRouter) keeps its own entry data there.
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

/** Already signed in? Then a sign-in or sign-up page has nothing to do. */
export async function signedIn(): Promise<boolean> {
  try {
    const res = await siteFetch('/site-api/me', {headers: {accept: 'application/json'}});
    const body = (await res.json()) as {viewer?: Viewer};
    return body.viewer?.state === 'user';
  } catch {
    return false;
  }
}

/** Swaps a form for a message (after a success that has nothing else to show). */
export function replaceWithMessage(form: HTMLFormElement, message: string, link?: {href: string; text: string}) {
  const box = document.createElement('div');
  box.className = 'notice notice-ok';
  box.setAttribute('role', 'status');
  const p = document.createElement('p');
  p.textContent = message;
  box.append(p);
  if (link) {
    const a = document.createElement('a');
    a.className = 'button';
    a.href = link.href;
    a.textContent = link.text;
    box.append(a);
  }
  form.replaceWith(box);
  box.tabIndex = -1;
  box.focus();
}
