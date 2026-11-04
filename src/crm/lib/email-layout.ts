/**
 * The email layouts, shared by the preview (browser) and sending (server).
 *
 *   branded: fixed header (logo or name on the brand colour), white card,
 *            fixed footer (company, address, footer text, unsubscribe link).
 *   plain:   looks like a personal email; optional unsubscribe line.
 *
 * Table layout with inline styles. Emails are light only (dark text on an
 * explicit white background): dark-mode CSS is applied unevenly by mail
 * clients and produced light-grey text on white. Clients that have their own
 * dark mode still invert the whole email consistently.
 */
import {escapeHtml} from '@/lib/email-html';

/** Settings → Email → Email design. */
export type EmailDesign = {
  /** brand: the logo from Settings → Branding; upload: `logoUrl`; none: the brand name as text. */
  logo: 'brand' | 'upload' | 'none';
  logoUrl: string;
  logoWidth: number;
  /** Header background; '' = brand primary colour. */
  headerColor: string;
  /** Buttons and links; '' = brand primary colour. */
  accentColor: string;
  /** Footer company name; '' = brand name. */
  companyName: string;
  address: string;
  footerText: string;
  /** Add an unsubscribe line to plain (one-to-one) emails too. */
  plainUnsubscribe: boolean;
};

export const DEFAULT_EMAIL_DESIGN: EmailDesign = {
  logo: 'brand',
  logoUrl: '',
  logoWidth: 140,
  headerColor: '',
  accentColor: '',
  companyName: '',
  address: '',
  footerText: '',
  plainUnsubscribe: false,
};

export type EmailLayout = 'branded' | 'plain';

export type LayoutInput = {
  /** Email-safe content (toEmailHtml output, merge fields already filled in). */
  content: string;
  layout: EmailLayout;
  preheader?: string | null;
  design: EmailDesign;
  /** Resolved brand: name, a logo URL mail clients can load ('' = none), primary colour. */
  brand: {name: string; logoSrc: string; primary: string};
  /** Unsubscribe link, or a mailto: fallback when the recipient isn't a contact. Null for transactional email (bookings, exports): no unsubscribe line. */
  unsubscribeUrl: string | null;
};

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const DEFAULT_PRIMARY = '#2563eb';

export const accentOf = (design: EmailDesign, primary: string) => design.accentColor || primary || DEFAULT_PRIMARY;

const layoutStyles = () =>
  `<style>:root{color-scheme:light only;supported-color-schemes:light}` +
  `@media only screen and (max-width:620px){.kr-wrap{padding:12px !important}.kr-pad{padding:24px 20px !important}}</style>`;

const preheaderHtml = (text?: string | null) =>
  text?.trim()
    ? `<div data-preheader style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:transparent;opacity:0">${escapeHtml(text.trim())}${'&#847;&zwnj;&nbsp;'.repeat(30)}</div>`
    : '';

function footer(input: LayoutInput) {
  const {design, brand} = input;
  const name = design.companyName || brand.name;
  const lines = [
    `<strong>${escapeHtml(name)}</strong>`,
    design.address.trim() && escapeHtml(design.address.trim()).replace(/\n/g, '<br>'),
    design.footerText.trim() && escapeHtml(design.footerText.trim()).replace(/\n/g, '<br>'),
  ].filter(Boolean);
  return (
    `<td class="kr-muted" style="padding:24px 32px 8px;font-family:${FONT};font-size:12px;line-height:1.6;color:#64748b;text-align:center">` +
    lines.map((l) => `<p style="margin:0 0 8px;font-size:12px;line-height:1.6;color:#64748b">${l}</p>`).join('') +
    (input.unsubscribeUrl
      ? `<p style="margin:12px 0 0;font-size:12px;line-height:1.6;color:#64748b">Don't want these emails? <a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#64748b;text-decoration:underline">Unsubscribe</a></p>`
      : '') +
    `</td>`
  );
}

function header(input: LayoutInput) {
  const {design, brand} = input;
  const bg = design.headerColor || brand.primary || DEFAULT_PRIMARY;
  const src = design.logo === 'upload' ? design.logoUrl : design.logo === 'brand' ? brand.logoSrc : '';
  const width = Math.min(280, Math.max(40, design.logoWidth || 140));
  const inner = src
    ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(brand.name)}" width="${width}" style="display:block;margin:0 auto;width:${width}px;max-width:100%;height:auto;border:0">`
    : `<span style="font-family:${FONT};font-size:22px;font-weight:800;letter-spacing:-0.02em;color:#ffffff">${escapeHtml(brand.name)}</span>`;
  return `<td data-kr-header style="padding:24px 32px;background:${bg};border-radius:12px 12px 0 0;text-align:center">${inner}</td>`;
}

/** Wraps finished content in the chosen layout. Returns a complete HTML document. */
export function wrapEmail(input: LayoutInput): string {
  const head =
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light">${layoutStyles()}</head>`;

  if (input.layout === 'plain') {
    const unsub = input.design.plainUnsubscribe && input.unsubscribeUrl
      ? `<p class="kr-muted" style="margin:24px 0 0;font-size:12px;line-height:1.6;color:#64748b">Don't want these emails? <a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#64748b;text-decoration:underline">Unsubscribe</a></p>`
      : '';
    return (
      `${head}<body style="margin:0;padding:0;background:#ffffff;color:#1e293b">${preheaderHtml(input.preheader)}` +
      `<div class="kr-plain" style="font-family:${FONT};font-size:15px;line-height:1.6;color:#1e293b;background:#ffffff;max-width:640px;padding:8px">${input.content}${unsub}</div></body></html>`
    );
  }

  return (
    `${head}<body class="kr-bg" style="margin:0;padding:0;background:#f1f5f9">${preheaderHtml(input.preheader)}` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="kr-bg" style="background:#f1f5f9"><tr><td class="kr-wrap" align="center" style="padding:32px 16px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px">` +
    `<tr>${header(input)}</tr>` +
    `<tr><td class="kr-card kr-pad" style="padding:32px;background:#ffffff;border:1px solid #e2e8f0;border-top:0;border-radius:0 0 12px 12px;font-family:${FONT};font-size:15px;line-height:1.6;color:#1e293b">${input.content}</td></tr>` +
    `<tr>${footer(input)}</tr>` +
    `</table></td></tr></table></body></html>`
  );
}
