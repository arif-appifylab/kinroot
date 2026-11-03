/**
 * The template dashboard's addresses (`/dashboard/*`, and its older `/portal/*`) now open Kinroot at
 * `/crm/`. The platform still sends people there: its one-click owner sign-in arrives as
 * `/portal/?owner_ticket=…`, so the query string is ALWAYS kept (Kinroot's host page redeems the
 * ticket). A few old screens have a Kinroot screen of their own; everything else opens Kinroot's home.
 */
const SCREENS: Record<string, string> = {
  account: '/crm/settings/profile',
  users: '/crm/settings/accounts',
  roles: '/crm/settings/roles',
  activity: '/crm/settings/audit',
};

/** `rest`: the path after `/dashboard` or `/portal` (`''`, `/`, `/account`, `/users/12`…); `search`: `?…` or `''`. */
export function kinrootAddress(rest: string, search: string): string {
  const first = rest.split('/').find(Boolean) ?? '';
  return `${SCREENS[first] ?? '/crm/'}${search}`;
}
