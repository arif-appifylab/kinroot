import type {GalleryTemplate} from '@/lib/email-gallery';
import {toEmailHtml} from '@/lib/email-html';
import {htmlToText} from './render';

/** Plain-text version of editor HTML, stored as the template's `body` (text part, search, previews). */
export const templateBody = (html: string) => htmlToText(toEmailHtml(html, {accent: '#2563eb'})) || ' ';

/** A gallery template as EmailTemplate data (used by "Use this template" and the starter templates). */
export const fromGallery = (g: GalleryTemplate) => ({
  name: g.name,
  subject: g.subject,
  preheader: g.preheader,
  html: g.html,
  layout: g.layout,
  category: g.category,
  body: templateBody(g.html),
});
