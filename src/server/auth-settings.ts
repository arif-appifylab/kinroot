import {type AuthSettings, DEFAULT_AUTH_SETTINGS} from '../platform/auth';

/**
 * How sign-in works on THIS site (yours to edit; the auth core in
 * `src/platform/auth/` reads it). Every option is explained in
 * `src/platform/auth/settings.ts` and docs/agent/auth.md.
 *
 * Nothing here makes an owner: the owner comes only from "View as admin" in the dashboard
 * (src/platform/auth/owner.ts). Anyone signing up, with any address, is a normal user.
 */
export const authSettings: AuthSettings = {
  ...DEFAULT_AUTH_SETTINGS,
  // registration: 'open',
  // afterSignInPath: '/dashboard',
};
