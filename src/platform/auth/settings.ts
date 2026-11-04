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
  /** Ignored: nobody becomes owner from settings. The owner comes only from the dashboard (owner.ts). */
  firstUserBecomesOwner?: boolean;
  /** Ignored, as above. */
  ownerEmails?: string[];
  /** The role every new account gets (a slug in `roles`). */
  defaultRole: string;
  /** Where to send a person after signing in, when the page did not say. */
  afterSignInPath: string;
}

export const DEFAULT_AUTH_SETTINGS: AuthSettings = {
  registration: 'open',
  requireEmailVerification: true,
  defaultRole: 'member',
  afterSignInPath: '/dashboard',
};

/** Older site code may still import these. Nothing here makes an owner any more (owner.ts). */
export const ownerEmailsFor = (_settings: AuthSettings): string[] => [];
export const ownerClaimMode = (_settings: AuthSettings): 'listed' | 'first' | 'off' => 'listed';
