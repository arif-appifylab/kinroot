import type {EmailAccount} from '../../../generated/prisma/client';
import {toEmailHtml} from '@/lib/email-html';
import {accentOf, DEFAULT_EMAIL_DESIGN, wrapEmail, type EmailDesign, type EmailLayout} from '@/lib/email-layout';
import type {Db} from '../kit/db';
import {getSettings} from '../lib/settings';
import {htmlToText, mergeFields, textToHtml, type MergeContext} from './render';

/** Settings → Email → Email design, stored in its own Setting row. */
export const EMAIL_DESIGN_KEY = 'email.design';

export async function getEmailDesign(db: Db): Promise<EmailDesign> {
  const row = await db.setting.findUnique({where: {key: EMAIL_DESIGN_KEY}});
  return {...DEFAULT_EMAIL_DESIGN, ...((row?.value ?? {}) as Partial<EmailDesign>)};
}

export async function saveEmailDesign(db: Db, patch: Partial<EmailDesign>) {
  const value = {...(await getEmailDesign(db)), ...patch};
  await db.setting.upsert({where: {key: EMAIL_DESIGN_KEY}, create: {key: EMAIL_DESIGN_KEY, value}, update: {value}});
  return value;
}

/** Short content hash, so the hosted brand logo URL changes when the logo does. */
async function shortHash(s: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest).slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The brand as mail clients can show it. The Branding logo is a data URL,
 * which Gmail and Outlook block, so it is served from a public URL instead;
 * SVG logos don't render in most mail clients, so they fall back to the name.
 */
/** A logo uploaded to public storage (Settings → Branding checks it is ours when saving): emails link it as it is. */
const PUBLIC_LOGO = /^https?:\/\/[^/?#]+\/__platform\/files\/file_[0-9a-z]{26}\/[^/?#]+$/;

export async function emailBrand(db: Db, origin: string) {
  const s = await getSettings(db);
  // An older install's data URL goes through the brand-logo route (mail clients block data: URLs).
  const raster = /^data:image\/(png|jpeg|gif|webp);base64,/.test(s.brandLogo);
  return {
    name: s.brandName,
    logoSrc: PUBLIC_LOGO.test(s.brandLogo) ? s.brandLogo : raster ? `${origin}/site-api/crm/public/brand-logo?v=${await shortHash(s.brandLogo)}` : '',
    primary: s.brandPrimary,
  };
}

export type ComposeInput = {
  /** Editor HTML (rich composer / templates) … */
  html?: string | null;
  /** … or plain text (quick replies, older templates, the form autoresponder). */
  text?: string | null;
  layout: EmailLayout;
  preheader?: string | null;
  ctx: MergeContext;
  account: Pick<EmailAccount, 'signature' | 'signatureHtml' | 'fromEmail'>;
  origin: string;
};

/**
 * The sending pipeline before tracking: merge fields (HTML-escaped) →
 * signature → layout. Returns the final HTML, its plain-text alternative, and
 * `content`: the message text without the layout (what the CRM shows).
 */
export async function composeEmail(db: Db, input: ComposeInput): Promise<{html: string; text: string; content: string}> {
  const [design, brand] = await Promise.all([getEmailDesign(db), emailBrand(db, input.origin)]);
  const theme = {accent: accentOf(design, brand.primary)};
  const {account, ctx} = input;
  const sigHtml = account.signatureHtml ? toEmailHtml(account.signatureHtml, theme) : '';
  const sigBlock = sigHtml ? `<div class="kr-signature" style="margin-top:24px">${sigHtml}</div>` : '';

  let content: string;
  let text: string | null = null;
  if (input.html) {
    content = mergeFields(toEmailHtml(input.html, theme) + sigBlock, ctx, {html: true});
    if (!sigBlock && account.signature) content += textToHtml(mergeFields(account.signature, ctx));
  } else {
    // Plain text keeps its own wording as the text part (better than a round trip through HTML).
    const body = mergeFields(input.text ?? '', ctx);
    if (sigBlock) {
      content = textToHtml(body) + mergeFields(sigBlock, ctx, {html: true});
      text = `${body}\n\n${htmlToText(mergeFields(sigHtml, ctx, {html: true}))}`;
    } else {
      const withSig = body + (account.signature ? `\n\n${mergeFields(account.signature, ctx)}` : '');
      content = textToHtml(withSig);
      text = withSig;
    }
  }

  const unsubscribeUrl = ctx.unsubscribeUrl || `mailto:${account.fromEmail}?subject=Unsubscribe`;
  const html = wrapEmail({content, layout: input.layout, preheader: input.preheader ? mergeFields(input.preheader, ctx) : null, design, brand, unsubscribeUrl});
  const shown = text ?? htmlToText(content);
  if (input.layout === 'branded' || text === null) return {html, text: htmlToText(html), content: shown};
  return {html, text: design.plainUnsubscribe ? `${text}\n\nUnsubscribe: ${unsubscribeUrl}` : text, content: shown};
}

/**
 * System email (booking confirmations, reminders, import/export notices…) as a complete
 * document in the branded layout: a white card with explicit colours, so dark-mode mail
 * clients don't put dark text on a dark background. Transactional, so no unsubscribe line.
 */
export async function systemEmailHtml(db: Db, text: string, origin: string) {
  const [design, brand] = await Promise.all([getEmailDesign(db), emailBrand(db, origin)]);
  return wrapEmail({content: textToHtml(text, {shortLinks: true, linkColor: accentOf(design, brand.primary)}), layout: 'branded', design, brand, unsubscribeUrl: null});
}
