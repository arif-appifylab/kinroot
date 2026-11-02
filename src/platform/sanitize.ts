import {FilterXSS, getDefaultWhiteList} from 'xss';

/**
 * Cleans HTML that does NOT come from this repo (rich text a user saved, an
 * imported document) before a page renders it with `set:html`. Markdown in
 * `src/content/` is repo content and needs none of this. It keeps the
 * formatting (headings, lists, links, images, tables, code, `class` for
 * alignment) and drops scripts, event handlers and `javascript:` URLs.
 * Pure JavaScript: it runs on the Worker, no DOM needed.
 */
const whiteList = getDefaultWhiteList();
for (const tag of Object.keys(whiteList)) {
  whiteList[tag] = [...(whiteList[tag] ?? []), 'class'];
}
whiteList.iframe = ['src', 'width', 'height', 'allow', 'allowfullscreen', 'title'];

/** Only video embeds may be framed. */
const EMBED_HOSTS = ['www.youtube.com', 'youtube.com', 'www.youtube-nocookie.com', 'player.vimeo.com'];

const filter = new FilterXSS({
  whiteList,
  stripIgnoreTagBody: ['script', 'style'],
  onTagAttr(tag, name, value) {
    if (tag === 'iframe' && name === 'src') {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' && EMBED_HOSTS.includes(url.hostname)
          ? `src="${value.replace(/"/g, '&quot;')}"`
          : '';
      } catch {
        return '';
      }
    }
    return undefined;
  },
});

export function sanitizeHtml(html: string): string {
  return filter.process(html);
}
