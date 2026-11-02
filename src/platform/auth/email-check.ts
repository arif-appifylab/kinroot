import {SiteKeyMissing, siteKeyPostData} from '../api';

/**
 * Is this a real inbox? Asked before a sign-up creates a user and before an email
 * change sends its link, so throwaway and made-up addresses can't fill the user list:
 *
 *   POST {SITE_URL}/api/site/v1/email-check
 *   Authorization: Bearer <SITE_KEY>
 *   {"email": "a@b.c"}  →  200 {"data": {"accept": true | false}}
 *
 * The platform answers it (from its own disposable list and email checker); this site
 * only learns yes or no. It fails OPEN: no Site Key (a bare local checkout), no answer,
 * or any other status lets the address through, so a platform hiccup never blocks a
 * sign-up. Never logs the address.
 */
export const EMAIL_NOT_REAL = "Use an email address you can get mail at. Throwaway addresses don't work here.";

export async function emailAccepted(requestUrl: string | URL, email: string): Promise<boolean> {
  try {
    const {status, data} = await siteKeyPostData<{accept?: boolean}>(requestUrl, '/email-check', {email});
    return !(status === 200 && data?.accept === false);
  } catch (err) {
    if (err instanceof SiteKeyMissing) return true;
    console.warn(`email check: ${(err as Error).message}`);
    return true;
  }
}
