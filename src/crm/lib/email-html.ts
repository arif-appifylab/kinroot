/**
 * Editor HTML → email-safe HTML. Shared by the browser (live preview) and the
 * server (sending), so the preview is exactly what goes out.
 *
 * The rich-text editor stores plain semantic HTML (p, h2, strong, a, ul, img,
 * hr…) plus two custom elements:
 *   <span data-merge="contact.first_name" data-fallback="there"></span>  merge-field chip
 *   <div data-type="button" data-href="https://…" data-align="center">Book a call</div>  CTA button
 * This module whitelists those tags (dropping scripts, styles and unknown
 * attributes) and writes them out with inline styles and a table-based
 * button, which is what Gmail, Outlook and Apple Mail render reliably.
 */

export type EmailTheme = {accent: string};

const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'head', 'title', 'template', 'svg', 'math', 'form', 'textarea', 'select', 'button']);
const VOID = new Set(['br', 'hr', 'img']);
const ALIAS: Record<string, string> = {b: 'strong', i: 'em', h4: 'h3', h5: 'h3', h6: 'h3', strike: 's', del: 's'};

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const INK = '#1e293b';

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const unescape = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function parseAttrs(src: string) {
  const out: Record<string, string> = {};
  for (const m of src.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    out[m[1]!.toLowerCase()] = unescape(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

/** http(s), mailto:, tel: and merge fields such as {{unsubscribe_url}}; anything else is dropped. */
export function safeUrl(url: string | undefined, {images = false} = {}) {
  const u = (url ?? '').trim();
  if (/^\{\{\s*[a-z_.]+\s*\}\}$/i.test(u)) return u;
  if (/^https?:\/\//i.test(u)) return u;
  if (!images && /^(mailto|tel):/i.test(u)) return u;
  return null;
}

const align = (a: Record<string, string>) => {
  const v = (a.style?.match(/text-align:\s*(left|center|right|justify)/i)?.[1] ?? a['data-align'] ?? '').toLowerCase();
  return ['left', 'center', 'right', 'justify'].includes(v) ? v : '';
};

const mergeToken = (key: string, fallback?: string) => {
  const k = key.replace(/[^a-z_.]/gi, '');
  const f = (fallback ?? '').replace(/[{}|]/g, '').trim();
  return k ? `{{${k}${f ? `|${escapeHtml(f)}` : ''}}}` : '';
};

/**
 * A bulletproof button: table + padded link, no images or VML needed. It sits
 * in a full-width row aligned with `align` on the cell: `align` on the button
 * table itself would float it, and the next paragraph would wrap beside it.
 */
export function buttonHtml(label: string, href: string, theme: EmailTheme, alignTo = 'left') {
  const a = alignTo === 'center' || alignTo === 'right' ? alignTo : 'left';
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px"><tr><td align="${a}">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"${a === 'left' ? '' : ` align="${a}"`}>` +
    `<tr><td style="border-radius:8px;background:${theme.accent}">` +
    `<a class="kr-btn" href="${escapeHtml(href)}" style="display:inline-block;padding:12px 24px;font-family:${FONT};font-size:15px;font-weight:600;line-height:1.2;color:#ffffff;text-decoration:none;border-radius:8px">${label}</a>` +
    `</td></tr></table>` +
    `</td></tr></table>`
  );
}

const STYLE: Record<string, (theme: EmailTheme) => string> = {
  p: () => `margin:0 0 16px;font-size:15px;line-height:1.6;color:${INK}`,
  h1: () => `margin:0 0 16px;font-size:26px;line-height:1.25;font-weight:800;color:#0f172a`,
  h2: () => `margin:24px 0 12px;font-size:20px;line-height:1.3;font-weight:700;color:#0f172a`,
  h3: () => `margin:20px 0 8px;font-size:16px;line-height:1.4;font-weight:700;color:#0f172a`,
  ul: () => `margin:0 0 16px;padding-left:24px;font-size:15px;line-height:1.6;color:${INK}`,
  ol: () => `margin:0 0 16px;padding-left:24px;font-size:15px;line-height:1.6;color:${INK}`,
  li: () => 'margin:0 0 6px',
  blockquote: () => 'margin:0 0 16px;padding:4px 0 4px 16px;border-left:3px solid #cbd5e1;color:#475569',
  a: (t) => `color:${t.accent};text-decoration:underline`,
  hr: () => 'border:none;border-top:1px solid #e2e8f0;margin:24px 0',
};

/**
 * Sanitises editor HTML and inlines the email styles. Text content is kept
 * as-is (the editor already escaped it); unknown tags are unwrapped.
 */
export function toEmailHtml(input: string, theme: EmailTheme): string {
  const out: string[] = [];
  const stack: string[] = []; // open tags as written (or '' for unwrapped ones)
  let drop = 0; // inside a DROP_WITH_CONTENT element
  let button: {href: string; align: string; label: string[]} | null = null;
  let merge = false;
  let liDepth = 0;

  const re = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</g;
  for (const m of input.matchAll(re)) {
    const token = m[0];
    const tag = m[1] ? (ALIAS[m[1].toLowerCase()] ?? m[1].toLowerCase()) : undefined;
    if (token.startsWith('<!--')) continue;
    if (!tag) {
      if (drop || merge) continue;
      const text = token === '<' ? '&lt;' : token.replace(/>/g, '&gt;');
      (button ? button.label : out).push(text);
      continue;
    }
    const closing = token.startsWith('</');
    if (DROP_WITH_CONTENT.has(tag)) {
      if (VOID.has(tag) || token.endsWith('/>')) continue;
      drop += closing ? -1 : 1;
      drop = Math.max(0, drop);
      continue;
    }
    if (drop) continue;
    const a = closing ? {} : parseAttrs(m[2] ?? '');

    if (closing) {
      if (button && tag === 'div') {
        const href = safeUrl(button.href) ?? '#';
        out.push(buttonHtml(button.label.join('').trim() || 'Learn more', href, theme, button.align));
        button = null;
        stack.pop();
        continue;
      }
      if (merge && tag === 'span') {
        merge = false;
        stack.pop();
        continue;
      }
      // Pop to the matching open tag; anything unclosed in between gets closed.
      let idx = stack.length - 1;
      while (idx >= 0 && stack[idx] !== tag && stack[idx] !== `~${tag}`) idx--;
      if (idx === -1) continue;
      while (stack.length > idx) {
        const t = stack.pop()!;
        if (t === 'li') liDepth--;
        if (t && !t.startsWith('~')) out.push(`</${t}>`);
      }
      continue;
    }

    // Inside a button only text and inline marks count (as label).
    if (button) continue;

    switch (tag) {
      case 'span':
        if (a['data-merge']) {
          out.push(mergeToken(a['data-merge'], a['data-fallback']));
          if (!token.endsWith('/>')) {
            merge = true;
            stack.push('~span');
          }
        } else stack.push('~span');
        break;
      case 'div':
        if (a['data-type'] === 'button') {
          button = {href: a['data-href'] ?? '', align: a['data-align'] ?? 'left', label: []};
          stack.push('~div');
        } else stack.push('~div');
        break;
      case 'p': {
        // Lists from the editor wrap items in <p>; keep them tight.
        if (liDepth) {
          stack.push('~p');
          break;
        }
        const al = align(a);
        out.push(`<p style="${STYLE.p!(theme)}${al ? `;text-align:${al}` : ''}">`);
        stack.push('p');
        break;
      }
      case 'h1':
      case 'h2':
      case 'h3': {
        const al = align(a);
        out.push(`<${tag} style="${STYLE[tag]!(theme)};font-family:${FONT}${al ? `;text-align:${al}` : ''}">`);
        stack.push(tag);
        break;
      }
      case 'ul':
      case 'ol':
      case 'blockquote':
        out.push(`<${tag} style="${STYLE[tag]!(theme)}">`);
        stack.push(tag);
        break;
      case 'li':
        out.push(`<li style="${STYLE.li!(theme)}">`);
        stack.push('li');
        liDepth++;
        break;
      case 'strong':
      case 'em':
      case 'u':
      case 's':
        out.push(`<${tag}>`);
        stack.push(tag);
        break;
      case 'a': {
        const href = safeUrl(a.href);
        if (!href) {
          stack.push('~a');
          break;
        }
        out.push(`<a href="${escapeHtml(href)}" style="${STYLE.a!(theme)}">`);
        stack.push('a');
        break;
      }
      case 'br':
        out.push('<br>');
        break;
      case 'hr':
        out.push(`<hr style="${STYLE.hr!(theme)}">`);
        break;
      case 'img': {
        const src = safeUrl(a.src, {images: true});
        if (!src) break;
        const width = Math.min(600, Math.max(16, Number.parseInt(a.width ?? a['data-width'] ?? '', 10) || 0));
        const al = (a['data-align'] ?? '').toLowerCase();
        const margin = al === 'center' ? 'margin:0 auto 16px' : al === 'right' ? 'margin:0 0 16px auto' : 'margin:0 0 16px';
        out.push(
          `<img src="${escapeHtml(src)}" alt="${escapeHtml(a.alt ?? '')}"${width > 16 ? ` width="${width}"` : ''} style="display:block;${margin};${width > 16 ? `width:${width}px;` : ''}max-width:100%;height:auto;border:0;outline:none">`,
        );
        break;
      }
      default:
        // Unknown tags (table, font, section…) are unwrapped: their text stays.
        if (!VOID.has(tag) && !token.endsWith('/>')) stack.push(`~${tag}`);
    }
  }
  if (button) out.push(buttonHtml(button.label.join('').trim() || 'Learn more', safeUrl(button.href) ?? '#', theme, button.align));
  while (stack.length) {
    const t = stack.pop()!;
    if (t && !t.startsWith('~')) out.push(`</${t}>`);
  }
  return out.join('');
}

/** Plain text (old templates, quick replies) → editor HTML paragraphs. */
export function textToEditorHtml(text: string) {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/** Merge fields offered in the editors, with sample values for the preview. */
export const MERGE_FIELDS = [
  {key: 'contact.first_name', label: 'First name', sample: 'Alex'},
  {key: 'contact.last_name', label: 'Last name', sample: 'Morgan'},
  {key: 'contact.full_name', label: 'Full name', sample: 'Alex Morgan'},
  {key: 'contact.email', label: 'Email', sample: 'alex@example.com'},
  {key: 'contact.title', label: 'Job title', sample: 'Head of Operations'},
  {key: 'company.name', label: 'Company', sample: 'Northwind'},
  {key: 'deal.title', label: 'Deal name', sample: 'Northwind annual plan'},
  {key: 'deal.value', label: 'Deal value', sample: '$12,000'},
  {key: 'me.name', label: 'My name', sample: ''},
  {key: 'me.first_name', label: 'My first name', sample: ''},
  {key: 'me.email', label: 'My email', sample: ''},
  {key: 'unsubscribe_url', label: 'Unsubscribe link', sample: '#unsubscribe'},
] as const;

export const mergeLabel = (key: string) => MERGE_FIELDS.find((f) => f.key === key)?.label ?? key;

/** Preview only: fills merge fields with sample values (escaped, like the server does). */
export function sampleMerge(html: string, me: {name: string; email: string}) {
  const values: Record<string, string> = Object.fromEntries(MERGE_FIELDS.map((f) => [f.key, f.sample]));
  Object.assign(values, {'me.name': me.name, 'me.first_name': me.name.split(' ')[0] ?? '', 'me.email': me.email});
  return html.replace(/\{\{\s*([a-z_.]+)\s*(?:\|([^}]*))?\}\}/gi, (_, key: string, fallback?: string) => {
    const v = values[key.toLowerCase()];
    return v ? escapeHtml(v) : (fallback?.trim() ?? '');
  });
}

/** True when editor HTML has no visible content (empty paragraphs only). */
export const isEmptyHtml = (html: string) => !/<(img|hr)\b|data-type="button"|data-merge=/i.test(html) && !html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim();
