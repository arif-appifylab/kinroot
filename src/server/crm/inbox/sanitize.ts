import {escapeHtml} from '@/lib/email-html';

/**
 * Received email HTML → a safe fragment for the inbox reader. Whitelist of
 * formatting and table tags; scripts, styles, frames, forms, SVG / MathML and
 * every event handler are dropped, links and images must be http(s) (images
 * also data:image raster), and our own open pixel and click tracking are
 * removed from quoted replies so reading a reply never counts as an open or a
 * click. The browser shows the result in a sandboxed iframe without scripts.
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
  const m = url.match(/\/site-api\/crm\/t\/c\/[^?]+\?(.*)$/);
  if (!m) return url;
  const u = new URLSearchParams(m[1]).get('u');
  return u && /^https?:\/\//i.test(u) ? u : url;
}

function safeStyle(css: string) {
  // No external resources or legacy script hooks from CSS.
  return /url\s*\(|expression\s*\(|javascript:|behaviou?r\s*:|@import|-moz-binding/i.test(css) ? '' : css;
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

function sanitizeHtml(input: string, policy: Policy): string {
  const html = input.length > 400_000 ? input.slice(0, 400_000) : input;
  const out: string[] = [];
  const stack: string[] = [];
  let drop = 0;
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[^>]*>|<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</g;
  for (const m of html.matchAll(re)) {
    const token = m[0];
    if (token.startsWith('<!') || token.startsWith('<?')) continue;
    const tag = m[1]?.toLowerCase();
    if (!tag) {
      if (!drop) out.push(token === '<' ? '&lt;' : token.replace(/>/g, '&gt;'));
      continue;
    }
    const closing = token.startsWith('</');
    if (DROP_WITH_CONTENT.has(tag)) {
      if (!token.endsWith('/>')) drop = Math.max(0, drop + (closing ? -1 : 1));
      continue;
    }
    if (drop || !policy.tags.has(tag)) continue;
    if (closing) {
      const idx = stack.lastIndexOf(tag);
      if (idx === -1) continue;
      while (stack.length > idx) out.push(`</${stack.pop()}>`);
      continue;
    }
    const kept: string[] = [];
    let skip = false;
    for (const [name, value] of attrs(m[2] ?? '')) {
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
    if (!VOID.has(tag) && !token.endsWith('/>')) stack.push(tag);
  }
  while (stack.length) out.push(`</${stack.pop()}>`);
  return out.join('');
}
