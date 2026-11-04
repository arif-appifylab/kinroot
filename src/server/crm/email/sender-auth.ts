/**
 * Was a received email's `From:` address really the sender's? (AUDIT-2 M-8)
 *
 * Anyone can write any `From:`. Ticket mail trusts the sender (a teammate's reply, the requester's
 * `[#1042]` subject) only when the mail service that received it says the domain in `From:` passed
 * DMARC, or an SPF / DKIM check ALIGNED with that domain. With no verdict, the sender is treated
 * as unverified: never a team reply, and a customer reply only when it answers a Message-ID we sent
 * (lib/ticket-mail.ts).
 *
 * What each source gives (read once, from the part the receiving service writes, never a header
 * further down the message, which the sender could have written themselves):
 *
 *   Postmark   `Headers`: its own `Received-SPF` (first) and, when present, `Authentication-Results`
 *              (first). SPF counts when its envelope-from is aligned with `From:`.
 *   Mailgun    form fields `X-Mailgun-Spf` + `sender` (envelope): SPF aligned with `From:`;
 *              `X-Mailgun-Dkim-Check-Result` names no domain, so it is not used alone;
 *              `message-headers` (JSON pairs): the first `Authentication-Results`.
 *   SendGrid   Inbound Parse fields `SPF` + `envelope.from` (aligned), `dkim` ("{@domain : pass}").
 *   Resend     the received-email API returns the message's headers as one object (a duplicate
 *              header written by the sender can't be told apart): NO verdict, unverified.
 *   Gmail      synced: Google's own `Authentication-Results: mx.google.com; …` (first header);
 *              mail in the mailbox's SENT label was sent by the mailbox itself (Google enforces it).
 *   Outlook    synced: Microsoft's `Authentication-Results` (first, from `internetMessageHeaders`);
 *              a message from the mailbox's own address with no such header was sent by it.
 *   Generic JSON payloads carry no verdict: unverified.
 */

const domainOf = (address: string | null | undefined) => {
  const raw = (address ?? '').trim().toLowerCase().replace(/^["'<]+|["'>]+$/g, '');
  return raw.slice(raw.lastIndexOf('@') + 1);
};

/** Relaxed alignment: the same domain, or one a subdomain of the other. */
function aligned(fromDomain: string, other: string | null | undefined) {
  const d = (other ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!d || !fromDomain) return false;
  return d === fromDomain || fromDomain.endsWith(`.${d}`) || d.endsWith(`.${fromDomain}`);
}

/**
 * One `Authentication-Results` value (RFC 8601): pass when DMARC passed for the `From:` domain, or
 * DKIM / SPF passed for a domain aligned with it. A DMARC fail is a fail whatever else passed.
 */
export function authResultsPass(header: string | null | undefined, fromEmail: string): boolean {
  if (!header) return false;
  const from = domainOf(fromEmail);
  let pass = false;
  for (const part of header.split(';').map((p) => p.trim().toLowerCase())) {
    const method = /^(dmarc|dkim|spf)\s*=\s*([a-z]+)/.exec(part);
    if (!method) continue;
    const [, kind, result] = method;
    const prop = (name: string) => new RegExp(`(?:^|\\s)${name.replace('.', '\\.')}=([^\\s;]+)`).exec(part)?.[1] ?? null;
    if (kind === 'dmarc') {
      if (result !== 'pass') return false;
      const hf = prop('header.from');
      if (!hf || aligned(from, hf)) pass = true;
    } else if (kind === 'dkim' && result === 'pass') {
      if (aligned(from, prop('header.d') ?? domainOf(prop('header.i')))) pass = true;
    } else if (kind === 'spf' && result === 'pass') {
      if (aligned(from, domainOf(prop('smtp.mailfrom')))) pass = true;
    }
  }
  return pass;
}

const str = (v: unknown) => (typeof v === 'string' ? v : null);

/**
 * The verdict for an inbound-webhook payload (Postmark, Mailgun, SendGrid), already proven to come
 * from the mail service (email/inbound-auth.ts). False when the payload carries none.
 */
export function inboundSenderVerified(body: Record<string, unknown>, fromEmail: string): boolean {
  const from = domainOf(fromEmail);
  // Postmark
  if (Array.isArray(body.Headers)) {
    const headers = body.Headers as {Name?: unknown; Value?: unknown}[];
    const first = (n: string) => str(headers.find((x) => str(x?.Name)?.toLowerCase() === n)?.Value);
    if (authResultsPass(first('authentication-results'), fromEmail)) return true;
    const spf = first('received-spf');
    const envelope = spf ? /envelope-from=([^\s;]+)/i.exec(spf)?.[1] : null;
    return !!spf && /^\s*pass\b/i.test(spf) && aligned(from, domainOf(envelope));
  }
  // Mailgun routes
  if ('X-Mailgun-Spf' in body || 'message-headers' in body) {
    try {
      const pairs = JSON.parse(str(body['message-headers']) ?? '[]') as unknown[];
      const ar = pairs.find((p): p is [string, string] => Array.isArray(p) && str(p[0])?.toLowerCase() === 'authentication-results');
      if (ar && authResultsPass(ar[1], fromEmail)) return true;
    } catch {
      // no readable headers: the SPF field below decides
    }
    return /^pass$/i.test(str(body['X-Mailgun-Spf'])?.trim() ?? '') && aligned(from, domainOf(str(body.sender)));
  }
  // SendGrid Inbound Parse
  if ('envelope' in body && ('SPF' in body || 'dkim' in body)) {
    const dkim = str(body.dkim) ?? '';
    for (const m of dkim.matchAll(/@([a-z0-9.-]+)\s*:\s*([a-z]+)/gi)) if (m[2]!.toLowerCase() === 'pass' && aligned(from, m[1])) return true;
    let envelopeFrom: string | null = null;
    try {
      envelopeFrom = str((JSON.parse(str(body.envelope) ?? '{}') as {from?: unknown}).from);
    } catch {
      envelopeFrom = null;
    }
    return /^pass$/i.test(str(body.SPF)?.trim() ?? '') && aligned(from, domainOf(envelopeFrom));
  }
  return false;
}
