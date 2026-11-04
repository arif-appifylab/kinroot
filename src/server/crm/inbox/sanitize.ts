import {escapeHtml} from '@/lib/email-html';
import {sign} from '../kit/crypto';

/**
 * Received email HTML → a safe fragment for the inbox reader. Whitelist of
 * formatting and table tags; scripts, styles, frames, forms, SVG / MathML and
 * every event handler are dropped, links and images must be http(s) (images
 * also data:image raster), and our own open pixel and click tracking are
 * removed from quoted replies so reading a reply never counts as an open or a
 * click. The browser shows the result in an EmailFrame (a shadow root with
 * layout and paint containment; src/crm/components/email-frame.tsx), never as
 * the app's own markup.
 *
 * Every step is linear in the input (a hand-written tokenizer, no backtracking
 * patterns over the whole text): mail comes from anyone, and a crafted message
 * must never hold the CPU (AUDIT P1-6).
 */
const ALLOWED = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'center', 'code', 'col', 'colgroup', 'dd', 'del', 'div', 'dl', 'dt', 'em', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'i', 'img', 'ins', 'li', 'mark', 'ol', 'p', 'pre', 's', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'tt', 'u', 'ul',
]);
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'head', 'title', 'template', 'svg', 'math', 'form', 'textarea', 'select', 'button', 'noscript', 'audio', 'video', 'canvas', 'xml']);
const VOID = new Set(['br', 'hr', 'img', 'col']);
const ATTRS = new Set(['href', 'src', 'alt', 'title', 'width', 'height', 'align', 'valign', 'colspan', 'rowspan', 'bgcolor', 'color', 'border', 'cellpadding', 'cellspacing', 'style', 'dir', 'face', 'size']);

const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function attrs(src: string) {
  const out: [string, string][] = [];
  for (const m of src.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    out.push([m[1]!.toLowerCase(), decode(m[2] ?? m[3] ?? m[4] ?? '')]);
  }
  return out;
}

/** Our click tracker (/site-api/crm/t/c/<id>?u=<url>&s=…) → the real link. */
function untrack(url: string) {
  const at = url.indexOf('/site-api/crm/t/c/');
  const q = at === -1 ? -1 : url.indexOf('?', at + 18);
  if (q === -1 || q === at + 18) return url;
  const u = new URLSearchParams(url.slice(q + 1)).get('u');
  return u && /^https?:\/\//i.test(u) ? u : url;
}

/**
 * An inline style, or '' when it can't be shown safely. No external resources or legacy script
 * hooks from CSS; no escapes at all (`\75 rl(` is `url(`, `\70 osition` is `position`), so what is
 * checked here is what the browser reads; and `position` only as static / relative / absolute, so
 * `fixed` or `sticky` (also through `var()`) can't lay the email's own content and links over the
 * CRM (AUDIT P1-7). Comments are taken out first so `position:/**\/fixed` reads as what it is.
 */
export function safeStyle(input: string) {
  if (input.includes('\\')) return '';
  const css = withoutComments(input);
  if (/url\s*\(|image-set\s*\(|expression\s*\(|javascript:|behaviou?r\s*:|@import|-moz-binding/i.test(css)) return '';
  return css
    .split(';')
    .filter((decl) => {
      const m = /^\s*position\s*:(.*)$/is.exec(decl);
      return !m || /^\s*(static|relative|absolute)\s*(!\s*important\s*)?$/i.test(m[1]!);
    })
    .join(';')
    .trim();
}

/** CSS comments → a space, in one pass (an unclosed one runs to the end, as in the browser). */
function withoutComments(css: string) {
  let out = '';
  let i = 0;
  for (;;) {
    const open = css.indexOf('/*', i);
    if (open === -1) return out + css.slice(i);
    out += `${css.slice(i, open)} `;
    const close = css.indexOf('*/', open + 2);
    if (close === -1) return out;
    i = close + 2;
  }
}

type Policy = {tags: Set<string>; attrs: Set<string>; images: boolean; styles: boolean};

const EMAIL_POLICY: Policy = {tags: ALLOWED, attrs: ATTRS, images: true, styles: true};

/**
 * Rich text people write in the app or the support portal (tickets, saved replies): the
 * formatting the editor makes and nothing else. No styles, images, tables or classes, only
 * http(s) / mailto links, so stored HTML can be shown inline without a sandbox.
 */
const RICH_POLICY: Policy = {
  tags: new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'a', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'h2', 'h3', 'hr']),
  attrs: new Set(['href']),
  images: false,
  styles: false,
};

export const sanitizeEmailHtml = (input: string) => sanitizeHtml(input, EMAIL_POLICY);
export const sanitizeRichText = (input: string) => sanitizeHtml(input, RICH_POLICY);

type Token = {text: string} | {tag: string; closing: boolean; selfClosing: boolean; attrs: string};

const TAG_NAME = /\/?([a-zA-Z][a-zA-Z0-9:-]*)/y;

/**
 * The tokens of an HTML string, in one left-to-right pass with `indexOf` (never a pattern that can
 * rescan the rest of the input). Comments, CDATA, doctypes and processing instructions are skipped;
 * an unclosed one runs to the end, as in the browser. A tag runs to its `>` outside quotes; a `<`
 * outside quotes (or an unclosed quote) means it was not a tag, and that text is given as text,
 * so each character is read a bounded number of times.
 */
function* tokens(html: string): Generator<Token> {
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      yield {text: html.slice(i)};
      return;
    }
    if (lt > i) yield {text: html.slice(i, lt)};
    i = lt;
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html.startsWith('<![CDATA[', i)) {
      const end = html.indexOf(']]>', i + 9);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html[i + 1] === '!' || html[i + 1] === '?') {
      const end = html.indexOf('>', i + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }
    TAG_NAME.lastIndex = i + 1;
    const name = TAG_NAME.exec(html);
    if (!name) {
      yield {text: '<'};
      i += 1;
      continue;
    }
    // The attributes: up to the first `>` outside quotes.
    const start = TAG_NAME.lastIndex;
    let j = start;
    let end = -1;
    while (j < n) {
      const ch = html[j];
      if (ch === '>') {
        end = j;
        break;
      }
      if (ch === '<') break;
      if (ch === '"' || ch === "'") {
        const close = html.indexOf(ch, j + 1);
        if (close === -1) {
          j = n;
          break;
        }
        j = close + 1;
        continue;
      }
      j++;
    }
    if (end === -1) {
      // Not a tag after all: everything read so far is text (a `<` there starts the next token).
      yield {text: html.slice(i, j)};
      i = j;
      continue;
    }
    const attrs = html.slice(start, end);
    yield {tag: name[1]!.toLowerCase(), closing: html[i + 1] === '/', selfClosing: attrs.endsWith('/'), attrs};
    i = end + 1;
  }
}

function sanitizeHtml(input: string, policy: Policy): string {
  const html = input.length > 400_000 ? input.slice(0, 400_000) : input;
  const out: string[] = [];
  const stack: string[] = [];
  const open = new Map<string, number>();
  let drop = 0;
  for (const token of tokens(html)) {
    if ('text' in token) {
      if (!drop) out.push(token.text.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
      continue;
    }
    const {tag, closing} = token;
    if (DROP_WITH_CONTENT.has(tag)) {
      if (!token.selfClosing) drop = Math.max(0, drop + (closing ? -1 : 1));
      continue;
    }
    if (drop || !policy.tags.has(tag)) continue;
    if (closing) {
      // Counted, so a closing tag that was never opened costs nothing (no scan of a deep stack).
      if (!open.get(tag)) continue;
      const idx = stack.lastIndexOf(tag);
      while (stack.length > idx) {
        const t = stack.pop()!;
        open.set(t, open.get(t)! - 1);
        out.push(`</${t}>`);
      }
      continue;
    }
    const kept: string[] = [];
    let skip = false;
    for (const [name, value] of attrs(token.attrs)) {
      if (!policy.attrs.has(name)) continue;
      if (name === 'href') {
        const url = untrack(value.trim());
        if (/^(https?:|mailto:|tel:)/i.test(url)) kept.push(`href="${escapeHtml(url)}"`);
        continue;
      }
      if (name === 'src') {
        const url = value.trim();
        if (tag !== 'img' || !policy.images) continue;
        if (/\/site-api\/crm\/t\/o\//.test(url)) skip = true; // our own open pixel in a quoted reply
        else if (/^https?:\/\//i.test(url) || /^data:image\/(png|jpe?g|gif|webp);/i.test(url)) kept.push(`src="${escapeHtml(url)}"`);
        continue;
      }
      if (name === 'style') {
        if (!policy.styles) continue;
        const css = safeStyle(value);
        if (css) kept.push(`style="${escapeHtml(css)}"`);
        continue;
      }
      kept.push(`${name}="${escapeHtml(value)}"`);
    }
    if (skip || (tag === 'img' && !kept.some((a) => a.startsWith('src=')))) continue;
    // A link whose address was unsafe (javascript:, data:…) keeps only its text.
    if (tag === 'a' && !kept.some((a) => a.startsWith('href='))) continue;
    if (tag === 'a') kept.push('target="_blank"', 'rel="noopener noreferrer nofollow"');
    out.push(`<${tag}${kept.length ? ` ${kept.join(' ')}` : ''}>`);
    if (!VOID.has(tag) && !token.selfClosing) {
      stack.push(tag);
      open.set(tag, (open.get(tag) ?? 0) + 1);
    }
  }
  while (stack.length) out.push(`</${stack.pop()}>`);
  return out.join('');
}

// ─── Received mail: cleaned once, when it arrives ───────────────────────────

/** The most received HTML kept for one email (characters; bigger mail is cut, then cleaned). */
export const MAX_RECEIVED_HTML = 200_000;

/**
 * Received HTML is cleaned once, when it is stored (`ingestMessage()`), and starts with this
 * comment so reads show it as it is. The comment carries a signature made with the site's key:
 * mail stored before cleaning moved to arrival was written by its sender, who can't know the
 * signature, so such a row can never pass as clean; it is cleaned when read instead.
 * (No schema change: the marker lives in the stored HTML itself and is removed before showing.)
 */
async function cleanMarker(): Promise<string | null> {
  try {
    return `<!--kr-clean:${await sign('received-html:v1')}-->`;
  } catch {
    return null; // no site key (tests without one): store and read as before, cleaning on read
  }
}

/** Received HTML as it is stored: capped, cleaned and marked clean. */
export async function cleanReceivedHtml(html: string | null | undefined): Promise<string | null> {
  if (!html) return null;
  const input = html.length > MAX_RECEIVED_HTML ? html.slice(0, MAX_RECEIVED_HTML) : html;
  let clean = sanitizeEmailHtml(input);
  // Escaping can make the cleaned copy bigger than the input (`<` → `&lt;`): keep a shorter start then.
  if (clean.length > MAX_RECEIVED_HTML) clean = sanitizeEmailHtml(input.slice(0, Math.floor((input.length * MAX_RECEIVED_HTML * 0.9) / clean.length)));
  if (!clean.trim()) return null;
  const marker = await cleanMarker();
  return marker ? marker + clean : clean;
}

/**
 * Stored received HTML → the safe fragment to show or forward: rows cleaned at arrival as they
 * are (marker removed), older rows cleaned now. One signature per call, so build it once per request.
 */
export async function receivedHtmlReader(): Promise<(stored: string | null | undefined) => string | null> {
  const marker = await cleanMarker();
  return (stored) => {
    if (!stored) return null;
    if (marker && stored.startsWith(marker)) return stored.slice(marker.length);
    return sanitizeEmailHtml(stored.length > MAX_RECEIVED_HTML ? stored.slice(0, MAX_RECEIVED_HTML) : stored) || null;
  };
}
