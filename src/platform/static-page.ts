import {logout, refreshSession, siteFetch} from './browser';
import type {Site, Viewer} from './types';

/**
 * BROWSER: brings a PRERENDERED page up to date after it loads. The page was
 * built once and is served as a static file (fast, no server work), so it
 * shows the signed-out header and the site name as it was at build time.
 *
 * 1. `/site-api/me`: a signed-in visitor gets their header (Dashboard, name,
 *    Sign out); `[data-user-only]` elements show and `[data-guest-only]`
 *    ones hide. An expired session is refreshed ONCE first.
 * 2. `/site-api/site`: a site renamed since the last build shows its new
 *    name in every `[data-brand-text]` element (`{name}`, `{year}` filled).
 *
 * DOM is built with `textContent` only: nothing from an answer is parsed as HTML.
 */
export async function hydrateStaticPage(): Promise<void> {
  await Promise.all([hydrateBrand(), hydrateSession()]);
}

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await siteFetch(path, {headers: {accept: 'application/json'}});
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

async function hydrateBrand(): Promise<void> {
  const site = (await getJson<{site: Site | null}>('/site-api/site'))?.site;
  if (!site?.name) return;
  const year = String(new Date().getUTCFullYear());
  for (const el of document.querySelectorAll<HTMLElement>('[data-brand-text]')) {
    const text = el.dataset.brandText!.replaceAll('{name}', site.name).replaceAll('{year}', year);
    if (el.textContent !== text) el.textContent = text;
  }
  const builtName = document.querySelector<HTMLElement>('.brand-name')?.dataset.builtName;
  if (builtName && builtName !== site.name) document.title = document.title.replace(builtName, site.name);
}

/** Initials for the avatar chip. */
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(word => word[0]?.toUpperCase() ?? '')
    .join('');

async function hydrateSession(): Promise<void> {
  let me = await getJson<{viewer: Viewer}>('/site-api/me');
  if (me?.viewer.state === 'returning' && (await refreshSession())) {
    me = await getJson<{viewer: Viewer}>('/site-api/me');
  }
  const viewer = me?.viewer;
  if (!viewer || viewer.state !== 'user') return;

  document.body.dataset.viewer = viewer.state;
  for (const el of document.querySelectorAll<HTMLElement>('[data-user-only]')) el.hidden = false;
  for (const el of document.querySelectorAll<HTMLElement>('[data-guest-only]')) el.hidden = true;

  const session = document.querySelector<HTMLElement>('[data-session]');
  if (!session) return;
  session.replaceChildren();

  const avatar = document.createElement('span');
  avatar.className = 'viewer';
  avatar.title = viewer.name ?? '';
  const fallback = document.createElement('span');
  fallback.className = 'avatar-fallback';
  fallback.setAttribute('aria-hidden', 'true');
  fallback.textContent = initials(viewer.name ?? '');
  avatar.append(fallback);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button link small-button';
  button.textContent = 'Sign out';
  button.addEventListener('click', () => {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = 'Signing out…';
    void logout();
  });
  session.append(avatar, button);
}
