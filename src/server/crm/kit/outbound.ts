/**
 * Calls to other services (mail providers, Google / Microsoft): every one with a timeout, as the
 * site's rules ask (docs/agent/security.md › Calling other services). Keys come only from
 * `config.ownerSecret` or a mailbox's own OAuth tokens; hosts are fixed in the calling code.
 */
export function fetchOut(input: string | URL, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
  return fetch(input, {...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs)});
}
