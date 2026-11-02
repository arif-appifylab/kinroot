import {SiteKeyMissing, siteKeyPost} from '../api';

/**
 * Account emails, RELAYED by the platform (its sender, its templates, no
 * mail provider key on the site): the site asks the platform to send them,
 * with its Site Key:
 *
 *   POST {SITE_URL}/api/site/v1/emails
 *   Authorization: Bearer <SITE_KEY>
 *   {"kind": "password_reset", "to": "a@b.c", "path": "/account/reset/?token=…", "expiresInMinutes": 30}
 *
 * The site sends a PATH, never a full URL: the platform builds the link on
 * the site's own primary domain, so a forged `Host` header can never point a
 * reset link at somebody else's server. The platform renders the email
 * (the site's name and brand), rate-limits per site and keeps only a hash
 * of `to` (`site_email_sends`).
 *
 * Answers: 202 queued · 401 bad key · 422 bad payload · 429 site limit.
 * Never throws: the caller's answer to the visitor must not depend on it.
 */
export type SiteEmailKind =
  | 'verify_email'
  | 'password_reset'
  | 'password_changed'
  | 'account_exists'
  | 'confirm_email_change'
  | 'email_changed'
  | 'sign_in_code';

export interface SiteEmail {
  kind: SiteEmailKind;
  to: string;
  /** Site-relative link (`/account/…`), or omitted for a notice. */
  path?: string;
  expiresInMinutes?: number;
  /** `sign_in_code` only: the 6 digits the email shows (never a link). */
  code?: string;
}

export async function sendSiteEmail(requestUrl: string | URL, email: SiteEmail): Promise<boolean> {
  try {
    const status = await siteKeyPost(requestUrl, '/emails', email);
    if (status !== 202 && status !== 200) {
      // The status only: the body carries an email address.
      console.warn(`site email ${email.kind}: platform answered ${status || 'nothing'}`);
      return false;
    }
    return true;
  } catch (err) {
    if (err instanceof SiteKeyMissing) {
      console.warn(`site email ${email.kind}: no Site Key here, not sent`);
      return false;
    }
    throw err;
  }
}
