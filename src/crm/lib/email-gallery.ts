/**
 * Ready-made templates (Settings → Templates → Gallery, and the templates a
 * new install starts with). "Use this template" copies one into the team's
 * templates, where it can be edited freely.
 *
 * Content is editor HTML (see email-html.ts): merge-field chips and CTA
 * buttons included. Copy is written to be sendable as is: merge fields fill
 * in the personal parts, and only links (your-website.com) need replacing.
 * Sales emails are plain (they read like a personal email); customer,
 * marketing and billing emails use the branded layout.
 */
import type {EmailLayout} from '@/lib/email-layout';

export type GalleryTemplate = {
  id: string;
  category: string;
  name: string;
  description: string;
  subject: string;
  preheader: string;
  layout: EmailLayout;
  html: string;
};

const m = (key: string, fallback = '') => `<span data-merge="${key}"${fallback ? ` data-fallback="${fallback}"` : ''}></span>`;
const btn = (label: string, href: string, align: 'left' | 'center' = 'left') => `<div data-type="button" data-href="${href}" data-align="${align}">${label}</div>`;
const p = (...parts: string[]) => `<p>${parts.join('')}</p>`;
const list = (...items: string[]) => `<ul>${items.map((i) => `<li><p>${i}</p></li>`).join('')}</ul>`;
const steps = (...items: string[]) => `<ol>${items.map((i) => `<li><p>${i}</p></li>`).join('')}</ol>`;

const hi = p('Hi ', m('contact.first_name', 'there'), ',');
const signOff = p('Best,<br>', m('me.name'));
const teamSignOff = p('Thanks,<br>', m('me.name'));

export const GALLERY_CATEGORIES = ['Sales', 'Customers', 'Marketing', 'Billing'] as const;

export const GALLERY: GalleryTemplate[] = [
  // ─── Sales (plain: reads like a personal email) ───
  {
    id: 'intro-first-touch',
    category: 'Sales',
    name: 'Introduction',
    description: 'A short, friendly first email to a new lead.',
    subject: 'Quick question, {{contact.first_name|there}}',
    preheader: 'A short note and one question.',
    layout: 'plain',
    html: [
      hi,
      p('I came across ', m('company.name', 'your team'), ' and wanted to reach out. We help teams like yours spend less time on busywork and more time on the work that moves things forward.'),
      p('Would it be worth a 15-minute call to see if we could help you too? If the timing is not right, just let me know and I will not keep chasing.'),
      signOff,
    ].join(''),
  },
  {
    id: 'follow-up-call',
    category: 'Sales',
    name: 'Follow-up after a call',
    description: 'Thank them and confirm the next steps while it is fresh.',
    subject: 'Great speaking with you, {{contact.first_name|there}}',
    preheader: 'A quick recap and the next steps we agreed on.',
    layout: 'plain',
    html: [
      hi,
      p('Thanks for taking the time to talk today. It was great to learn more about what ', m('company.name', 'your team'), ' is working on.'),
      p('As promised, I will send over the details we discussed, and I have put a note in my calendar to follow up later this week.'),
      p('If anything comes up in the meantime, or I missed something you wanted to cover, just reply to this email.'),
      signOff,
    ].join(''),
  },
  {
    id: 'meeting-request',
    category: 'Sales',
    name: 'Meeting request',
    description: 'Ask for a short call with an easy way to say yes.',
    subject: 'Time for a quick chat, {{contact.first_name|there}}?',
    preheader: '20 minutes, at a time that suits you.',
    layout: 'plain',
    html: [
      hi,
      p('Would you have 20 minutes next week for a quick call? I would love to hear how ', m('company.name', 'your team'), ' handles this today and share a few ideas that have worked well for others.'),
      p('You can pick a time that suits you here:'),
      btn('Choose a time', 'https://your-website.com/book'),
      p('No pressure at all. If now is not a good time, just let me know.'),
      signOff,
    ].join(''),
  },
  {
    id: 'demo-recap',
    category: 'Sales',
    name: 'Demo recap',
    description: 'Summarise the demo and make the next step easy.',
    subject: 'Your demo recap and next steps',
    preheader: 'Everything we covered, plus what happens next.',
    layout: 'plain',
    html: [
      hi,
      p('Thanks again for joining the demo today. Here is a quick summary so you can share it with your team:'),
      list(
        '<strong>What we covered:</strong> a walk-through of the main features and how they fit your workflow.',
        '<strong>Questions you raised:</strong> I will send detailed answers by the end of the week.',
        '<strong>Next step:</strong> a short follow-up call with anyone else who should be involved.',
      ),
      p('You can watch the recording or try it yourself whenever you like:'),
      btn('Start your free trial', 'https://your-website.com/trial'),
      signOff,
    ].join(''),
  },
  {
    id: 'proposal-sent',
    category: 'Sales',
    name: 'Proposal sent',
    description: 'Send the proposal with a clear summary and next step.',
    subject: 'Proposal for {{company.name|your team}}',
    preheader: 'The proposal, plus a quick summary.',
    layout: 'plain',
    html: [
      hi,
      p('As promised, here is our proposal for ', m('deal.title', 'the project'), '. In short:'),
      list(
        `<strong>Investment:</strong> ${m('deal.value', 'as discussed')}`,
        '<strong>Timeline:</strong> we can start as soon as you give the go-ahead.',
        '<strong>Included:</strong> setup, training for your team and ongoing support.',
      ),
      btn('View the proposal', 'https://your-website.com/proposal'),
      p('I am happy to walk you through it on a short call or answer any questions by email.'),
      signOff,
    ].join(''),
  },
  {
    id: 'checking-in',
    category: 'Sales',
    name: 'Checking in',
    description: 'A polite nudge when someone has gone quiet.',
    subject: 'Checking in, {{contact.first_name|there}}',
    preheader: 'Just making sure my last email did not get buried.',
    layout: 'plain',
    html: [
      hi,
      p('I know inboxes get busy, so I wanted to bring my last email back to the top.'),
      p('Is this still a priority for ', m('company.name', 'your team'), '? If it is, I am happy to find a time that works. If not, just let me know and I will close the loop on my side.'),
      signOff,
    ].join(''),
  },
  {
    id: 're-engagement',
    category: 'Sales',
    name: 'Re-engagement',
    description: 'Restart a conversation that went quiet a while ago.',
    subject: 'Still on your list, {{contact.first_name|there}}?',
    preheader: 'A quick check-in, no pressure.',
    layout: 'plain',
    html: [
      hi,
      p('It has been a little while since we last spoke, so I wanted to check in. A lot has changed on our side since then, and some of it may be useful for ', m('company.name', 'your team'), '.'),
      p('Would a short catch-up be helpful? If your priorities have moved on, that is completely fine. A one-word reply is enough.'),
      signOff,
    ].join(''),
  },

  // ─── Customers (branded) ───
  {
    id: 'welcome-onboarding',
    category: 'Customers',
    name: 'Welcome aboard',
    description: 'Welcome a new customer and show the first steps.',
    subject: 'Welcome aboard, {{contact.first_name|there}}!',
    preheader: 'Three quick steps to get you started.',
    layout: 'branded',
    html: [
      '<h1>Welcome aboard!</h1>',
      hi,
      p('We are thrilled to have ', m('company.name', 'you'), ' with us. Here is how to get the most out of your first week:'),
      steps('<strong>Set up your account</strong> and invite your team.', '<strong>Import your data</strong> so everything is in one place.', '<strong>Book your onboarding call</strong> and we will tailor the setup to you.'),
      btn('Get started', 'https://your-website.com/start'),
      p('If you have any questions, just reply to this email. A real person reads every message.'),
      teamSignOff,
    ].join(''),
  },
  {
    id: 'thank-you',
    category: 'Customers',
    name: 'Thank you',
    description: 'A warm thank-you after a purchase or a milestone.',
    subject: 'Thank you, {{contact.first_name|there}}',
    preheader: 'We really appreciate it.',
    layout: 'branded',
    html: [
      '<h1>Thank you!</h1>',
      hi,
      p('Thank you for choosing us. We know you have plenty of options, and we do not take your trust for granted.'),
      p('Our goal is simple: to make sure ', m('company.name', 'your team'), ' gets real value from day one. If anything is not working the way you expected, tell us and we will fix it.'),
      teamSignOff,
    ].join(''),
  },
  {
    id: 'feedback-request',
    category: 'Customers',
    name: 'Feedback request',
    description: 'Ask how things are going, with a one-click answer.',
    subject: 'How are we doing, {{contact.first_name|there}}?',
    preheader: 'One quick question, it takes 10 seconds.',
    layout: 'branded',
    html: [
      '<h2>How are we doing?</h2>',
      hi,
      p('We would love to know how your experience has been so far. Your feedback goes straight to the team and helps us decide what to improve next.'),
      btn('Share your feedback', 'https://your-website.com/feedback'),
      p('Prefer to tell us directly? Just hit reply.'),
      teamSignOff,
    ].join(''),
  },
  {
    id: 'referral-request',
    category: 'Customers',
    name: 'Referral request',
    description: 'Ask a happy customer for an introduction.',
    subject: 'A small favour, {{contact.first_name|there}}?',
    preheader: 'Know someone who would find this useful?',
    layout: 'plain',
    html: [
      hi,
      p('I hope things are going well at ', m('company.name', 'your end'), '. Working with you has been a real pleasure.'),
      p('If you know someone who is facing the same challenges you were, I would be grateful for an introduction. A quick reply with their name, or forwarding this email, is all it takes.'),
      p('Thanks either way, I appreciate you.'),
      signOff,
    ].join(''),
  },
  {
    id: 'renewal-reminder',
    category: 'Customers',
    name: 'Renewal reminder',
    description: 'A friendly heads-up before the renewal date.',
    subject: 'Your renewal is coming up',
    preheader: 'A quick reminder and how to reach us.',
    layout: 'branded',
    html: [
      '<h2>Your renewal is coming up</h2>',
      hi,
      p('A quick reminder that the plan for ', m('company.name', 'your team'), ' renews soon. There is nothing you need to do: everything continues as it is today.'),
      p('If you would like to change your plan, add more people or talk through what is coming next, we are happy to help.'),
      btn('Review your plan', 'https://your-website.com/account'),
      teamSignOff,
    ].join(''),
  },

  // ─── Marketing (branded) ───
  {
    id: 'event-invite',
    category: 'Marketing',
    name: 'Event invitation',
    description: 'Invite contacts to a webinar or event.',
    subject: "You're invited, {{contact.first_name|there}}",
    preheader: 'Save your seat: places are limited.',
    layout: 'branded',
    html: [
      "<h1>You're invited</h1>",
      hi,
      p('We are hosting a live session with practical tips you can use straight away, followed by an open Q&amp;A with our team.'),
      list('<strong>When:</strong> Thursday, 3:00 PM (45 minutes)', '<strong>Where:</strong> online, the link arrives when you register', '<strong>Who should join:</strong> anyone who wants to work smarter with their team'),
      btn('Save my seat', 'https://your-website.com/event', 'center'),
      p('Cannot make it live? Register anyway and we will send you the recording.'),
      teamSignOff,
    ].join(''),
  },
  {
    id: 'product-update',
    category: 'Marketing',
    name: 'Product update',
    description: 'Share what is new with customers and prospects.',
    subject: "What's new this month",
    preheader: 'New features, improvements and what is coming next.',
    layout: 'branded',
    html: [
      "<h1>What's new this month</h1>",
      hi,
      p('Here is a quick look at what we have been working on, all based on feedback from customers like ', m('company.name', 'you'), '.'),
      '<h2>Faster, simpler everyday work</h2>',
      p('We have streamlined the most common tasks so you can get more done in fewer clicks.'),
      '<h2>Also new</h2>',
      list('A cleaner, faster dashboard', 'Better search across all your records', 'Lots of small fixes and polish'),
      btn('See all updates', 'https://your-website.com/updates'),
      '<hr>',
      p('Have an idea for what we should build next? Just reply and tell us.'),
    ].join(''),
  },

  // ─── Billing (branded) ───
  {
    id: 'payment-reminder',
    category: 'Billing',
    name: 'Payment reminder',
    description: 'A polite reminder about an open invoice.',
    subject: 'A friendly reminder about your invoice',
    preheader: 'Your invoice is still open; here is how to settle it.',
    layout: 'branded',
    html: [
      '<h2>A friendly reminder</h2>',
      hi,
      p('Our records show an open invoice for ', m('company.name', 'your account'), '. If you have already paid, thank you, and please ignore this email.'),
      p('If not, you can view and settle it in a couple of minutes:'),
      btn('View invoice', 'https://your-website.com/billing'),
      p('Questions about the invoice? Just reply and we will sort it out.'),
      teamSignOff,
    ].join(''),
  },
];

/** The templates a new install starts with (copied from the gallery). */
export const STARTER_TEMPLATE_IDS = ['intro-first-touch', 'follow-up-call', 'proposal-sent', 'welcome-onboarding'] as const;
