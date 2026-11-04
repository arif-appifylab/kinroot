import {siteKeyPost, SiteKeyMissing} from '../../../platform/api';
import {OWNER_EMAIL_DOMAIN} from '../../../platform/auth/owner';
import {config} from '../kit/config';

/**
 * The site owner's account (docs/agent/auth.md › THE OWNER ACCOUNT) has no email address the site
 * knows: `users.email` holds a placeholder at `owner.invalid` and the viewer's email is empty. In
 * Kinroot's server code the owner's `User.email` is `OWNER_ADDRESS`, so mail meant for them goes the
 * one way that reaches them: the platform's `notification` email, sent with no `to` (the platform
 * delivers it to the account's owner). It is never shown: `shownEmail` blanks it.
 */
export const OWNER_ADDRESS = `owner@${OWNER_EMAIL_DOMAIN}`;

/** The owner's placeholder (any `…@owner.invalid`, which no person can type: the forms refuse it). */
export function isOwnerAddress(email: string | null | undefined): boolean {
  return !!email && email.toLowerCase().endsWith(`@${OWNER_EMAIL_DOMAIN}`);
}

/** An address as people may see it, or use it in a merge field or a Reply-To: never the owner's placeholder. */
export function shownEmail(email: string | null | undefined): string {
  return email && !isOwnerAddress(email) ? email : '';
}

const SUBJECT_MAX = 200;
const TEXT_MAX = 10_000;

/**
 * Emails the site owner through the platform (kind `notification`, no `to`). Plain text only: no
 * attachments. False when it could not be sent (no Site Key on this machine, or the platform said no).
 */
export async function notifyOwner(input: {subject: string; text: string}): Promise<boolean> {
  try {
    const status = await siteKeyPost(config.siteUrl() || 'http://localhost', '/emails', {
      kind: 'notification',
      subject: input.subject.slice(0, SUBJECT_MAX),
      text: input.text.slice(0, TEXT_MAX),
    });
    if (status === 200 || status === 202) return true;
    console.warn(`[crm] owner notification: platform answered ${status || 'nothing'}`);
    return false;
  } catch (err) {
    if (err instanceof SiteKeyMissing) {
      console.warn('[crm] owner notification: no Site Key here, not sent');
      return false;
    }
    throw err;
  }
}
