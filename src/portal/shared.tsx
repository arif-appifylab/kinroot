import {useQuery} from '@tanstack/react-query';

import type {Abilities, Viewer} from '../lib/types';
import {meQuery, siteQuery} from './queries';

/** Data helpers every portal screen uses. The visual pieces are the kit: `./ui`. */

export const when = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat('en-GB', {dateStyle: 'medium', timeStyle: 'short'}).format(new Date(iso))
    : '—';

/** "3 min ago", "yesterday", "12 Oct": for activity feeds and "last seen". */
export function ago(iso: string | null): string {
  if (!iso) return '—';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat('en', {numeric: 'auto'});
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return rtf.format(-Math.floor(seconds / 60), 'minute');
  if (seconds < 86_400) return rtf.format(-Math.floor(seconds / 3600), 'hour');
  if (seconds < 7 * 86_400) return rtf.format(-Math.floor(seconds / 86_400), 'day');
  return new Intl.DateTimeFormat('en-GB', {dateStyle: 'medium'}).format(new Date(iso));
}

export interface Me {
  viewer: Viewer;
  roles: string[];
  abilities: Abilities;
}

/** Who is signed in, and what the portal may SHOW them. Shared by every screen. */
export function useMe() {
  return useQuery(meQuery);
}

/** The brand, for the sidebar. Public and cached on the server. */
export function useSite() {
  return useQuery(siteQuery);
}

/**
 * A count for a stat tile from the FIRST page of a keyset list: "12", or
 * "25+" when there are more. Never a COUNT query per request; a total that
 * must be exact comes from a counter kept in the Site Database on write.
 */
export const pageCount = (rows: unknown[] | undefined, more: boolean) =>
  rows ? `${rows.length}${more ? '+' : ''}` : null;
