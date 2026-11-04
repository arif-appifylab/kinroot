import {ImageOff} from 'lucide-react';
import {useLayoutEffect, useRef, useState} from 'react';

import {cn} from '@/lib/utils';

import {Button} from './ui/button';

/**
 * An email's HTML, shown isolated from the app: in a shadow root instead of an `<iframe srcdoc>`.
 *
 * Why: the site's Content-Security-Policy blocks inline styles, and a `srcdoc` frame inherits the
 * page's policy, so emails (all inline styles and `<style>` blocks) lost their look there. Here the
 * email is parsed in an inert document, scripts, frames, forms and event handlers are dropped, its
 * `<style>` blocks become a constructed stylesheet and its `style=""` attributes are set back through
 * the CSSOM; the CSP allows both, and nothing of the email reaches the app's own styles.
 *
 * `html` may be a whole document (editor and report previews) or a fragment (received mail, already
 * sanitised by the server). `body` / `html` rules apply to the email's root; `@media (max-width)`
 * follows the preview's width (a container query), so the mobile preview looks like a phone.
 *
 * Containment: the host and the email's root have `contain: layout paint`, so nothing in an email
 * (fixed or absolute positioning, negative margins, transforms) can be laid or painted outside this
 * box over the CRM (AUDIT P1-7; the server's style cleaner also drops `position: fixed / sticky`).
 *
 * Remote images (`remoteImages: 'ask'`, the default for received mail, i.e. interactive frames) are
 * not loaded until "Show images" is clicked, so a sender's tracking pixel can't tell them the email
 * was opened (AUDIT P3-22). Inline (`cid:` rewritten by the server, `data:`) images show as before.
 */
export function EmailFrame({
  html,
  baseCss = '',
  className,
  interactive = true,
  remoteImages = interactive ? 'ask' : 'show',
}: {
  html: string;
  baseCss?: string;
  className?: string;
  interactive?: boolean;
  remoteImages?: 'ask' | 'show';
}) {
  const host = useRef<HTMLDivElement>(null);
  const [shownFor, setShownFor] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(0);
  const showImages = remoteImages === 'show' || shownFor === html;

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const root = el.shadowRoot ?? el.attachShadow({mode: 'open'});
    // `style` attributes are renamed inside tags before parsing: the browser applies the page's CSP even to
    // this inert document (and would report each one as blocked); they are set again below, through the CSSOM.
    const renamed = html.replace(/<[a-z][^>]*>/gi, (tag) => tag.replace(/(\s)style(\s*=)/gi, '$1data-email-style$2'));
    const doc = new DOMParser().parseFromString(renamed, 'text/html');

    for (const bad of doc.querySelectorAll('script, iframe, frame, object, embed, form, link, meta, base')) bad.remove();
    const css = [...doc.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n');
    for (const s of doc.querySelectorAll('style')) s.remove();

    // Inline styles are taken off before the nodes reach the page, and set again through the CSSOM.
    const inline: [Element, string][] = [];
    for (const node of doc.body.querySelectorAll('*')) {
      for (const attr of [...node.attributes]) if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
      const style = node.getAttribute('data-email-style');
      if (style) inline.push([node, style]);
      node.removeAttribute('data-email-style');
      if (node instanceof HTMLAnchorElement) {
        node.target = '_blank';
        node.rel = 'noopener noreferrer';
        if (!interactive) node.removeAttribute('href');
      }
    }
    const bodyStyle = doc.body.getAttribute('data-email-style');

    // Remote images stay unloaded (the inert document never fetches them) until the reader asks.
    let held = 0;
    if (!showImages) {
      for (const img of doc.body.querySelectorAll('img')) {
        if (!/^https?:/i.test(img.getAttribute('src') ?? '') && !img.hasAttribute('srcset')) continue;
        img.removeAttribute('src');
        img.removeAttribute('srcset');
        img.setAttribute('alt', img.getAttribute('alt') || '');
        held++;
      }
      for (const entry of inline) if (/url\s*\(/i.test(entry[1])) entry[1] = entry[1].replace(/url\s*\([^)]*\)/gi, 'none');
    }
    setBlocked(held);

    const wrapper = document.createElement('div');
    wrapper.className = 'email-root';
    wrapper.append(...[...doc.body.childNodes].map((n) => document.importNode(n, true)));

    const sheet = new CSSStyleSheet();
    const scoped = (showImages ? css : css.replace(/url\s*\([^)]*\)/gi, 'none'))
      .replace(/(^|[\s,{}>+~])(html|body)(?=[\s,{.:#[>+~]|$)/gi, '$1.email-root')
      .replace(/@media([^{]*)\(\s*max-width\s*:/gi, '@container email$1(max-width:');
    sheet.replaceSync(
      `:host{display:block;color-scheme:light;contain:layout paint}.email-root{contain:layout paint;position:relative;container:email / inline-size;background:#fff;color:#1e293b;font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;overflow-wrap:anywhere}` +
        `.email-root img{max-width:100%;height:auto}.email-root table{max-width:100%!important}` +
        baseCss +
        scoped,
    );
    root.adoptedStyleSheets = [sheet];
    root.replaceChildren(wrapper);
    if (bodyStyle) wrapper.style.cssText += bodyStyle;

    // Map the parsed elements to their copies, then restore their inline styles (CSSOM, allowed by the CSP).
    const parsed = new Map([...doc.body.querySelectorAll('*')].map((node, i) => [node, i]));
    const copies = [...wrapper.querySelectorAll('*')];
    for (const [node, style] of inline) {
      const copy = copies[parsed.get(node) ?? -1];
      if (copy instanceof HTMLElement || copy instanceof SVGElement) copy.style.cssText = style;
    }
  }, [html, baseCss, interactive, showImages]);

  return (
    <>
      {blocked > 0 && !showImages && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <ImageOff className="size-3.5" aria-hidden="true" /> Images from the sender are hidden, so they can't tell you opened this.
          </span>
          <Button type="button" variant="secondary" size="sm" onClick={() => setShownFor(html)}>
            Show images
          </Button>
        </div>
      )}
      <div ref={host} className={cn('block w-full overflow-hidden rounded-lg bg-white', className)} />
    </>
  );
}
