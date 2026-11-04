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
    .replace(/&#(\d+);/g, (m: string, n: string) => codePoint(Number(n), m))
    .replace(/&#x([0-9a-f]+);/gi, (m: string, n: string) => codePoint(parseInt(n, 16), m))
    .replace(/&amp;/g, '&');

/** A numeric entity's character; one that is out of range stays as written (fromCodePoint would throw). */
const codePoint = (n: number, raw: string) => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : raw);

/** Block content that is never text: `<style>…</style>` and co. */
const HIDDEN = new Set(['head', 'style', 'script', 'title']);

/** Strips spaces and tabs at the start and / or end of a line, in one pass (no backtracking pattern). */
function trimLine(line: string, start: boolean, end: boolean) {
  let a = 0;
  let b = line.length;
  if (start) while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  if (end) while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return line.slice(a, b);
}

/**
 * HTML → readable plain text: links as "text (url)", list bullets, no hidden preheader.
 *
 * One left-to-right pass (AUDIT P1-6: received mail is written by anyone, and the old chain of
 * lazy patterns took ~45 s on 240 KB of unclosed tags). Searches ahead (`</style>`, `</a>`, `>`)
 * remember where they found, or did not find, their target, so no part of the input is searched
 * twice for the same thing.
 */
export function htmlToText(html: string) {
  const lower = html.toLowerCase();
  const n = html.length;
  const searched = new Map<string, {from: number; at: number}>();
  const find = (needle: string, from: number) => {
    const last = searched.get(needle);
    // Nothing between the last search's start and its answer: the same answer holds from here.
    if (last && from >= last.from && (last.at === -1 || from <= last.at)) return last.at;
    const at = lower.indexOf(needle, from);
    searched.set(needle, {from, at});
    return at;
  };

  const out: string[] = [];
  // Which pieces came from tags (line breaks, bullets): a link's label is only its words.
  const fromTag: boolean[] = [];
  let link: {href: string; at: number} | null = null;
  const tagText = (s: string) => {
    out.push(s);
    fromTag[out.length - 1] = true;
  };
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      out.push(html.slice(i));
      break;
    }
    if (lt > i) out.push(html.slice(i, lt));
    i = lt;
    if (html.startsWith('<!--', i)) {
      const end = find('-->', i + 4);
      if (end !== -1) {
        i = end + 3;
        continue;
      }
    }
    const gt = find('>', i + 1);
    if (gt === -1 || gt === i + 1) {
      out.push('<'); // not a tag: `<` with no `>` after it, or `<>`
      i += 1;
      continue;
    }
    const tag = html.slice(i + 1, gt);
    i = gt + 1;
    const name = /^\/?([a-z][a-z0-9]*)/i.exec(tag)?.[1]?.toLowerCase() ?? '';
    const closing = tag.startsWith('/');
    if (!closing && HIDDEN.has(name)) {
      const end = find(`</${name}>`, i);
      if (end !== -1) i = end + name.length + 3;
      continue;
    }
    if (!closing && (/^div data-preheader/i.test(tag) || /^td data-kr-header/i.test(tag))) {
      // The hidden preheader and the branded header (logo / name).
      const close = name === 'div' ? '</div>' : '</td>';
      const end = find(close, i);
      if (end !== -1) i = end + close.length;
      continue;
    }
    if (name === 'a') {
      if (closing && link && /^\/a$/i.test(tag)) {
        const label = out.splice(link.at).filter((_, k) => !fromTag[link!.at + k]).join('').trim();
        fromTag.length = out.length;
        const url = decodeEntities(link.href);
        out.push(!/^https?:/i.test(url) || !label || decodeEntities(label) === url ? label || url : `${label} (${url})`);
        link = null;
      } else if (!closing && !link) {
        const href = /href="([^"]*)"/i.exec(tag);
        if (href && find('</a>', i) !== -1) link = {href: href[1]!, at: out.length};
      }
      continue;
    }
    if (closing) {
      if (/^\/(p|h\d|blockquote|ul|ol)$/i.test(tag)) tagText('\n\n');
      else if (/^\/(div|tr|table)$/i.test(tag)) tagText('\n');
      continue;
    }
    if (name === 'li') tagText('\n- ');
    else if (name === 'hr') tagText('\n----\n');
    else if (name === 'br') tagText('\n');
  }

  const lines = out.join('').split('\n');
  const joined = lines.map((line, k) => trimLine(line, k > 0, k < lines.length - 1)).join('\n');
  return decodeEntities(joined).replace(/\n{3,}/g, '\n\n').trim();
}

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
