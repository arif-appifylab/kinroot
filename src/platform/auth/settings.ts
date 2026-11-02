import {config} from '../config';

/**
 * What a site may decide about its own sign-in. The VALUES live in
 * `src/server/auth-settings.ts` (yours to edit); the auth core reads them.
 */
export interface AuthSettings {
  /** `open`: anyone may create an account. `closed`: the register route answers 403. */
  registration: 'open' | 'closed';
  /**
   * `true`: a new account must confirm its email before it can sign in (the
   * confirmation link is relayed by the platform). `false`: sign-up signs the
   * person in at once, but the register answer then differs for a taken email
   * (a person can learn an email has an account here). Keep `true` unless the
   * owner accepts that.
   */
  requireEmailVerification: boolean;
  /**
   * Who may hold `owner` (src/platform/auth/owner.ts): the owner addresses,
   * `ownerEmails` here plus the platform's `SITE_OWNER_EMAILS` (the
   * account owner and members whose role holds `account:*`). An owner
   * address gets `owner` by pressing "Open admin" in the dashboard (one click, no
   * sign-up), or by setting its password through an emailed link here (never
   * through a confirmation link alone: anyone can register an address first).
   *
   * On the LIVE site, with no owner address at all, NOBODY becomes owner and
   * `/site-api/health` reports `ownerSetup: false`. Only in local dev and the
   * editor Preview does the first account win without a list.
   */
  firstUserBecomesOwner: boolean;
  ownerEmails: string[];
  /** The role every new account gets (a slug in `roles`). */
  defaultRole: string;
  /** Where to send a person after signing in, when the page did not say. */
  afterSignInPath: string;
}

export const DEFAULT_AUTH_SETTINGS: AuthSettings = {
  registration: 'open',
  requireEmailVerification: true,
  firstUserBecomesOwner: true,
  ownerEmails: [],
  defaultRole: 'member',
  afterSignInPath: '/dashboard',
};

/** Every address allowed to claim `owner`: the settings' list plus the platform's. */
export function ownerEmailsFor(settings: AuthSettings): string[] {
  const listed = settings.ownerEmails.map(email => email.trim().toLowerCase()).filter(Boolean);
  return [...new Set([...listed, ...config.ownerEmails])];
}

/**
 * How the owner role can be claimed here:
 *   `listed`  only by an owner address
 *   `first`   by the first account (no list; local dev and the Preview only)
 *   `off`     by nobody: `firstUserBecomesOwner` is false, or this is the live
 *             site and no owner address is set (fail closed)
 */
export function ownerClaimMode(settings: AuthSettings): 'listed' | 'first' | 'off' {
  if (!settings.firstUserBecomesOwner) return 'off';
  if (ownerEmailsFor(settings).length) return 'listed';
  return config.production ? 'off' : 'first';
}
