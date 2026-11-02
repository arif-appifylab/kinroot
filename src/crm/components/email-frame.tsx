import {useLayoutEffect, useRef} from 'react';

import {cn} from '@/lib/utils';

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
 */
export function EmailFrame({html, baseCss = '', className, interactive = true}: {html: string; baseCss?: string; className?: string; interactive?: boolean}) {
  const host = useRef<HTMLDivElement>(null);

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

    const wrapper = document.createElement('div');
    wrapper.className = 'email-root';
    wrapper.append(...[...doc.body.childNodes].map((n) => document.importNode(n, true)));

    const sheet = new CSSStyleSheet();
    const scoped = css
      .replace(/(^|[\s,{}>+~])(html|body)(?=[\s,{.:#[>+~]|$)/gi, '$1.email-root')
      .replace(/@media([^{]*)\(\s*max-width\s*:/gi, '@container email$1(max-width:');
    sheet.replaceSync(
      `:host{display:block;color-scheme:light}.email-root{container:email / inline-size;background:#fff;color:#1e293b;font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;overflow-wrap:anywhere}` +
        `.email-root img{max-width:100%;height:auto}.email-root table{max-width:100%!important}` +
        baseCss +
        scoped,
    );
    root.adoptedStyleSheets = [sheet];
    root.replaceChildren(wrapper);
    if (bodyStyle) wrapper.style.cssText += bodyStyle;

    // Map the parsed elements to their copies, then restore their inline styles (CSSOM, allowed by the CSP).
    const parsed = [...doc.body.querySelectorAll('*')];
    const copies = [...wrapper.querySelectorAll('*')];
    for (const [node, style] of inline) {
      const copy = copies[parsed.indexOf(node)];
      if (copy instanceof HTMLElement || copy instanceof SVGElement) copy.style.cssText = style;
    }
  }, [html, baseCss, interactive]);

  return <div ref={host} className={cn('block w-full overflow-hidden rounded-lg bg-white', className)} />;
}
