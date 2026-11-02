import {z} from 'zod';

import {isEmptyHtml} from '@/lib/email-html';
import {htmlToText} from '../email/render';
import {sanitizeRichText} from '../inbox/sanitize';

/**
 * Rich text written in the app or the support portal (tickets, saved replies).
 * Stored twice: `html` is the sanitised editor HTML shown in the thread and sent
 * in emails, the plain text column next to it (`body`, `description`) stays what
 * search, notifications, previews, mentions and the timeline read. Callers that
 * only have plain text (automations, email replies, forms, the API) keep
 * sending text and get no HTML.
 */

/** Request field for a rich editor's HTML (sanitised by richBody(), never stored as sent). */
export const richHtml = z.string().max(200_000).nullish();

/** The editor's merge-field chips (<span data-merge="contact.first_name" data-fallback="there">) → {{key|fallback}}. */
export function chipsToTokens(html: string) {
  return html.replace(/<span\b[^>]*\bdata-merge="([a-z_.]+)"[^>]*>[\s\S]*?<\/span>/gi, (chip, key: string) => {
    const fallback = chip.match(/\bdata-fallback="([^"]*)"/i)?.[1];
    return fallback ? `{{${key}|${fallback}}}` : `{{${key}}}`;
  });
}

/**
 * What a composer sent → the stored pair. `merge` fills merge fields (agent replies);
 * it gets HTML-safe treatment from the caller (`mergeFields(…, {html: true})`).
 */
export function richBody(input: {html?: string | null; text?: string | null}, merge?: (s: string, html: boolean) => string): {html: string | null; text: string} {
  const raw = input.html?.trim();
  if (raw && !isEmptyHtml(raw)) {
    const filled = merge ? merge(chipsToTokens(raw), true) : raw;
    const html = sanitizeRichText(filled);
    return {html: isEmptyHtml(html) ? null : html, text: htmlToText(html).trim()};
  }
  const text = (input.text ?? '').trim();
  return {html: null, text: merge ? merge(text, false).trim() : text};
}
