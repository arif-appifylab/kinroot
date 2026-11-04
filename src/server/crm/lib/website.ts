import type {Prisma} from '../../../generated/prisma/client';
import {cache} from '../../../platform/cache';
import {defaultSettings, FORM_TEMPLATES, slugify} from '@/lib/forms';
import {defaultAvailability, defaultQuestions} from '@/lib/scheduling';
import {DEFAULT_WEBSITE, type PublicWebsite, type WebsiteSettings} from '@/lib/website';
import type {Db} from '../kit/db';
import {getEmailDesign} from '../email/design';
import {getChatSettings} from '../inbox/chat';
import {linkPaths, uniqueLinkSlug} from '../scheduling/links';
import {audit} from './audit';
import {getTicketSettings} from './tickets';
import {numbers} from './json-list';

const KEY = 'website';

export async function getWebsiteSettings(db: Db): Promise<WebsiteSettings> {
  const row = await db.setting.findUnique({where: {key: KEY}});
  return {...DEFAULT_WEBSITE, ...((row?.value ?? {}) as Partial<WebsiteSettings>)};
}

/**
 * The public website's answer (`GET /public/website`), kept 5 minutes: read by every public page,
 * cleared on every save here. It also shows forms and booking links by name, which their own screens
 * change without clearing it: that is the 5 minutes' leeway.
 */
export const WEBSITE_CACHE_KEY = 'crm:public-website';

export async function saveWebsiteSettings(db: Db, next: WebsiteSettings) {
  const value = next as unknown as Prisma.InputJsonValue;
  await db.setting.upsert({where: {key: KEY}, create: {key: KEY, value}, update: {value}});
  // Every save path clears it (the settings screen, and `ensureWebsiteDefaults` at setup).
  await cache.del(WEBSITE_CACHE_KEY);
  return next;
}

/** The forms and booking links an admin can pick, in the order the fallbacks use. */
export async function websiteChoices(db: Db) {
  const [forms, links] = await Promise.all([
    db.form.findMany({where: {status: 'PUBLISHED'}, orderBy: {createdAt: 'asc'}, select: {id: true, name: true, slug: true}}),
    db.bookingLink.findMany({where: {active: true}, orderBy: {createdAt: 'asc'}, take: 500, select: {id: true, kind: true, slug: true, userId: true, name: true, description: true, durations: true}}),
  ]);
  // Every link's path from ONE query for the owners' handles (never one per link).
  const paths = await linkPaths(db, links);
  return {
    forms,
    links: links.map((l) => ({id: l.id, name: l.name, path: paths.get(l.id)!, description: l.description, minutes: numbers(l.durations)[0] ?? 30})),
  };
}

/**
 * The website's own Contact us form and Product demo booking link, created the first time
 * they're needed (or when the picked one was unpublished / turned off) and saved as the
 * picks, so the pages never borrow some other form or a test link. Both are normal records,
 * edited in Forms and Meetings like any other.
 */
export async function ensureWebsiteDefaults(db: Db, s: WebsiteSettings): Promise<WebsiteSettings> {
  const [form, link] = await Promise.all([
    s.contactFormId ? db.form.findFirst({where: {id: s.contactFormId, status: 'PUBLISHED'}, select: {id: true}}) : null,
    s.demoLinkId ? db.bookingLink.findFirst({where: {id: s.demoLinkId, active: true}, select: {id: true}}) : null,
  ]);
  if (form && link) return s;
  const admins = await db.member.findMany({where: {active: true, role: {in: ['OWNER', 'ADMIN']}}, orderBy: {createdAt: 'asc'}, select: {id: true}});
  const owner = admins[0];
  if (!owner) return s;
  const next = {...s};

  if (!form) {
    const template = FORM_TEMPLATES.find((t) => t.id === 'contact')!;
    let slug = slugify('Contact us');
    for (let i = 2; await db.form.findFirst({where: {slug}, select: {id: true}}); i++) slug = `${slugify('Contact us')}-${i}`;
    const created = await db.form.create({
      data: {
        name: 'Contact us',
        slug,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        fields: template.fields() as unknown as Prisma.InputJsonValue,
        settings: {...defaultSettings(), title: 'Contact us', notifyUserIds: admins.map((a) => a.id), ...template.settings} as Prisma.InputJsonValue,
        createdById: owner.id,
      },
      select: {id: true, name: true},
    });
    await audit(db, null, {action: 'form.created', entity: 'form', recordId: created.id, label: created.name, meta: {for: 'website'}});
    next.contactFormId = created.id;
  }

  if (!link) {
    const profile = await db.schedulingProfile.findUnique({where: {userId: owner.id}, select: {timezone: true}});
    const created = await db.bookingLink.create({
      data: {
        kind: 'team',
        userId: owner.id,
        hostIds: admins.map((a) => a.id),
        name: 'Product demo',
        slug: await uniqueLinkSlug(db, {kind: 'team', userId: owner.id}, 'product-demo'),
        description: 'A 30-minute walkthrough tailored to your team, with time for your questions.',
        durations: [30],
        timezone: profile?.timezone ?? 'UTC',
        availability: defaultAvailability() as unknown as Prisma.InputJsonValue,
        questions: defaultQuestions() as unknown as Prisma.InputJsonValue,
      },
      select: {id: true, name: true, slug: true},
    });
    await audit(db, null, {action: 'booking_link.created', entity: 'booking_link', recordId: created.id, label: created.name, meta: {kind: 'team', slug: created.slug, for: 'website'}});
    next.demoLinkId = created.id;
  }

  return saveWebsiteSettings(db, next);
}

/** Settings resolved for the public pages, with the website's own form and booking link in place. */
export async function publicWebsite(db: Db): Promise<PublicWebsite> {
  const stored = await getWebsiteSettings(db);
  const s = stored.enabled ? await ensureWebsiteDefaults(db, stored) : stored;
  const [choices, tickets, chat, design] = await Promise.all([websiteChoices(db), getTicketSettings(db), getChatSettings(db), getEmailDesign(db)]);
  const form = choices.forms.find((f) => f.id === s.contactFormId) ?? null;
  const link = choices.links.find((l) => l.id === s.demoLinkId) ?? null;
  return {
    enabled: s.enabled,
    headline: s.headline,
    subheadline: s.subheadline,
    highlights: s.highlights,
    contact: form ? {slug: form.slug, name: form.name} : null,
    demo: link ? {path: link.path, name: link.name, description: link.description, minutes: link.minutes} : null,
    support: s.showSupport && tickets.portalEnabled,
    chat: s.showChat && chat.enabled,
    address: design.address.trim(),
  };
}
