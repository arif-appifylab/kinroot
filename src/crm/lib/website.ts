/**
 * The company's public landing pages (module 11): home at `/` for signed-out
 * visitors, `/contact` (a CRM form) and `/demo` (a booking link). Settings →
 * Website stores the wording and which form / booking link to use; everything
 * else (name, logo, colours) comes from Settings → Branding.
 */

export type WebsiteHighlight = {title: string; text: string};

export type WebsiteSettings = {
  /** Off: `/` goes straight to sign-in and the other pages say they're unavailable. */
  enabled: boolean;
  headline: string;
  subheadline: string;
  highlights: WebsiteHighlight[];
  /** A published form for Contact us (null = the first published one). */
  contactFormId: string | null;
  /** An active booking link for Book a demo (null = the first active one). */
  demoLinkId: string | null;
  showChat: boolean;
  showSupport: boolean;
};

export const MAX_HIGHLIGHTS = 3;

export const DEFAULT_WEBSITE: WebsiteSettings = {
  enabled: true,
  headline: "Let's talk about what you need",
  subheadline: 'Tell us about your project, book a time that suits you, or chat with our team. A real person gets back to you, usually within one business day.',
  highlights: [
    {title: 'A real conversation', text: 'You talk to someone who knows the product and your situation, not a ticket queue.'},
    {title: 'Clear next steps', text: 'After every call you get a short summary of what we discussed and what happens next.'},
    {title: 'Help that stays', text: 'Once you are on board, the same team is here when questions come up.'},
  ],
  contactFormId: null,
  demoLinkId: null,
  showChat: true,
  showSupport: true,
};

/** What the public pages need, resolved on the server (no ids, no settings internals). */
export type PublicWebsite = {
  enabled: boolean;
  headline: string;
  subheadline: string;
  highlights: WebsiteHighlight[];
  contact: {slug: string; name: string} | null;
  demo: {path: string; name: string; description: string | null; minutes: number} | null;
  support: boolean;
  chat: boolean;
  /** Company address from Settings → Email (footer), or ''. */
  address: string;
};
