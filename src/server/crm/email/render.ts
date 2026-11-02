import {sign} from '../kit/crypto';

export type MergeContext = {
  contact?: {firstName: string; lastName: string | null; email: string | null; title: string | null} | null;
  company?: {name: string} | null;
  deal?: {title: string; value: number; currency: string} | null;
  me: {name: string; email: string};
  unsubscribeUrl?: string | null;
};

const money = (v: number, currency: string) =>
  new Intl.NumberFormat('en-US', {style: 'currency', currency, maximumFractionDigits: 0}).format(v);

/**
 * {{contact.first_name}} or {{contact.first_name|there}} (fallback after the pipe).
 * With `html`, values are HTML-escaped (the fallback is part of the template, so it already is).
 */
export function mergeFields(template: string, ctx: MergeContext, opts: {html?: boolean} = {}) {
  const values: Record<string, string | null | undefined> = {
    'contact.first_name': ctx.contact?.firstName,
    'contact.last_name': ctx.contact?.lastName,
    'contact.full_name': ctx.contact ? [ctx.contact.firstName, ctx.contact.lastName].filter(Boolean).join(' ') : null,
    'contact.email': ctx.contact?.email,
    'contact.title': ctx.contact?.title,
    'company.name': ctx.company?.name,
    'deal.title': ctx.deal?.title,
    'deal.value': ctx.deal ? money(ctx.deal.value, ctx.deal.currency) : null,
    'me.name': ctx.me.name,
    'me.first_name': ctx.me.name.split(' ')[0],
    'me.email': ctx.me.email,
    unsubscribe_url: ctx.unsubscribeUrl,
  };
  return template.replace(/\{\{\s*([a-z_.]+)\s*(?:\|([^}]*))?\}\}/gi, (_, key: string, fallback?: string) => {
    const value = values[key.toLowerCase()];
    if (value) return opts.html ? escapeHtml(value) : value;
    return fallback?.trim() ?? '';
  });
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A long URL as people read it: host + start of the path, e.g. "calendar.google.com/calendar/render…". */
function shortUrl(url: string) {
  try {
    const u = new URL(url.replace(/&amp;/g, '&'));
    const shown = (u.host + (u.pathname === '/' ? '' : u.pathname)).replace(/^www\./, '');
    return escapeHtml(shown.length > 48 ? `${shown.slice(0, 46)}…` : shown + (u.search ? '…' : ''));
  } catch {
    return url;
  }
}

/**
 * Plain text → email HTML. Links carry their own colour (dark-mode webmail would repaint them
 * light on our white card) and may break anywhere so a long URL never widens the email.
 * shortLinks shows long URLs in a readable short form; the href and the text part keep them whole.
 */
export function textToHtml(text: string, opts: {shortLinks?: boolean; linkColor?: string} = {}) {
  const color = opts.linkColor ?? '#2563eb';
  const paragraphs = text.trim().split(/\n{2,}/).map((p) => {
    const linked = escapeHtml(p).replace(
      /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g,
      (url) => `<a href="${url}" style="color:${color};text-decoration:underline;word-break:break-all">${opts.shortLinks && url.length > 48 ? shortUrl(url) : url}</a>`,
    );
    return `<p style="margin:0 0 14px">${linked.replace(/\n/g, '<br>')}</p>`;
  });
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#0f172a">${paragraphs.join('')}</div>`;
}

const decodeEntities = (s: string) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

/** HTML → readable plain text: links as "text (url)", list bullets, no hidden preheader. */
export const htmlToText = (html: string) =>
  decodeEntities(
    html
      .replace(/<(head|style|script|title)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<div data-preheader[^>]*>[\s\S]*?<\/div>/gi, '')
      .replace(/<td data-kr-header[^>]*>[\s\S]*?<\/td>/gi, '') // the branded header (logo / name)
      .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) => {
        const label = inner.replace(/<[^>]+>/g, '').trim();
        const url = decodeEntities(href);
        if (!/^https?:/i.test(url) || !label || decodeEntities(label) === url) return label || url;
        return `${label} (${url})`;
      })
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<hr\b[^>]*>/gi, '\n----\n')
      .replace(/<br\b[^>]*>/gi, '\n')
      .replace(/<\/(p|h\d|blockquote|ul|ol)>/gi, '\n\n')
      .replace(/<\/(div|tr|table)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/[ \t]*\n[ \t]*/g, '\n'),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** Rewrites links through the click tracker and appends the open pixel. */
export async function addTracking(html: string, trackingId: string, origin: string, opts: {opens: boolean; clicks: boolean}) {
  let out = html;
  if (opts.clicks) {
    const links = [...new Set([...html.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m) => m[1]!))];
    for (const url of links) {
      const real = url.replace(/&amp;/g, '&');
      const tracked = `${origin}/site-api/crm/t/c/${trackingId}?u=${encodeURIComponent(real)}&s=${await sign(`${trackingId}|${real}`)}`;
      out = out.split(`href="${url}"`).join(`href="${escapeHtml(tracked)}"`);
    }
  }
  if (opts.opens) {
    out += `<img src="${origin}/site-api/crm/t/o/${trackingId}.gif" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0" />`;
  }
  return out;
}
