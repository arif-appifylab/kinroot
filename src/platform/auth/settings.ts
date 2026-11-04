/**
 * What a site may decide about its own sign-in. The VALUES live in
 * `src/server/auth-settings.ts` (yours to edit); the auth core reads them.
 */
export interface AuthSettings {
  /** `open`: anyone may create an account. `closed`: the register route answers 403. */
  registration: 'open' | 'closed';
  /**
   * Ignored, always on: no account exists until an emailed code comes back in the browser that
   * signed up (`sign-up.ts`). Otherwise anyone could take an address before its owner does.
   */
  requireEmailVerification?: boolean;
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
  defaultRole: 'member',
  afterSignInPath: '/dashboard',
};

/** Older site code may still import these. Nothing here makes an owner any more (owner.ts). */
export const ownerEmailsFor = (_settings: AuthSettings): string[] => [];
export const ownerClaimMode = (_settings: AuthSettings): 'listed' | 'first' | 'off' => 'listed';
