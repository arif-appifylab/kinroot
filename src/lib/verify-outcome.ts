/**
 * What the confirm-email page shows after `/site-api/auth/verify-email` says yes.
 * PURE (no DOM), so it is unit tested.
 *
 * `setPassword: true` means the address was an unclaimed owner address, or it
 * was signed up more than once: the password chosen at sign-up was dropped and
 * a link to choose one was emailed.
 * Signing in now would always fail, so the page points to the inbox, not to
 * Sign in.
 */
export function verifyOutcome(data: Record<string, unknown> | null): {
  message: string;
  link?: {href: string; text: string};
} {
  const message = typeof data?.message === 'string' ? data.message : null;
  if (data?.setPassword === true) {
    return {
      message: message ?? 'Your email is confirmed. Check your inbox for a link to choose your password.',
    };
  }
  return {
    message: message ?? 'Your email is confirmed.',
    link: {href: '/account/login/', text: 'Sign in'},
  };
}
