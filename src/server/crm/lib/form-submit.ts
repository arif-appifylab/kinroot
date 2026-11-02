import {HTTPException} from 'hono/http-exception';

import type {Contact, Form, LifecycleStage, Prisma} from '../../../generated/prisma/client';
import {
  activeFields,
  answerText,
  defaultSettings,
  isEmpty,
  pickEnding,
  validateField,
  type AnswerValue,
  type Answers,
  type FormField,
  type FormSettings,
  type StoredAnswer,
} from '@/lib/forms';
import {decryptJson, encryptJson, sign, verifySignature} from '../kit/crypto';
import type {Db} from '../kit/db';
import {mergeFields} from '../email/render';
import {defaultPipeline} from '../routes/deals';
import {customDiff, diff, logActivity} from './activity';
import {cleanCustom} from './custom-fields';
import {associateByDomain, workDomain} from './domains';
import {emit} from './events';
import {enqueue, kickJobs} from './jobs';
import {notify, recordLink} from './notify';
import {addToList} from './segments';
import {rememberOption} from './settings';
import {createTicket} from './tickets';
import {formConversation} from '../inbox/forms';
import {bookFormSlots, checkFormSlots} from '../scheduling/form-booking';

export const formSettings = (form: Pick<Form, 'settings'>): FormSettings => ({...defaultSettings(), ...(form.settings as Partial<FormSettings>)});
export const formFields = (form: Pick<Form, 'fields'>) => (form.fields ?? []) as FormField[];

/** Why a form can't take responses right now, or null when it's open. */
export function closedReason(form: Form): string | null {
  const s = formSettings(form);
  const now = Date.now();
  if (form.status !== 'PUBLISHED') return form.status === 'DRAFT' ? 'This form is not published yet.' : s.closedMessage || 'This form is closed.';
  if (s.opensAt && new Date(s.opensAt).getTime() > now) return `This form opens on ${new Date(s.opensAt).toUTCString().slice(0, 16)}.`;
  if (s.closesAt && new Date(s.closesAt).getTime() < now) return s.closedMessage || 'This form is closed.';
  if (s.responseLimit && form.submissionCount >= s.responseLimit) return s.closedMessage || 'This form has reached its response limit.';
  return null;
}

// ─── Uploaded files (answers carry {id, token}) ─────────────────────────────

export const fileToken = (id: string) => sign(`formfile:${id}`);

// ─── Submit ─────────────────────────────────────────────────────────────────

export type SubmitInput = {
  answers: Record<string, unknown>;
  meta: Record<string, string | undefined>;
  honeypot?: string;
  startedAt?: number;
  ip: string | null;
  userAgent: string | null;
  origin: string;
};

const STAGE_RANK: Record<LifecycleStage, number> = {LEAD: 0, QUALIFIED: 1, OPPORTUNITY: 2, CUSTOMER: 3, CHURNED: -1, OTHER: -1};

const str = (v: AnswerValue | undefined) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

/** Normalises one raw answer to the shape its field type stores. */
async function cleanValue(db: Db, f: FormField, raw: unknown): Promise<AnswerValue> {
  if (raw === undefined || raw === null) return null;
  switch (f.type) {
    case 'name': {
      const r = raw as {first?: unknown; last?: unknown};
      return {first: String(r.first ?? '').trim().slice(0, 100), last: String(r.last ?? '').trim().slice(0, 100)};
    }
    case 'address': {
      const r = raw as Record<string, unknown>;
      return Object.fromEntries(['street', 'city', 'state', 'postalCode', 'country'].map((k) => [k, String(r[k] ?? '').trim().slice(0, 200)]));
    }
    case 'email':
      return String(raw).trim().toLowerCase().slice(0, 200);
    case 'website': {
      const v = String(raw).trim().slice(0, 300);
      return v && !/^https?:\/\//i.test(v) ? `https://${v}` : v;
    }
    case 'number':
    case 'rating':
      return raw === '' ? null : Number(raw);
    case 'consent':
      return raw === true || raw === 'true';
    case 'multiple_choice':
      return (Array.isArray(raw) ? raw : [raw]).map(String);
    case 'booking': {
      const r = raw as Record<string, unknown>;
      return r.start ? {start: String(r.start).slice(0, 40), duration: String(r.duration ?? '').slice(0, 4), timezone: String(r.timezone ?? 'UTC').slice(0, 80)} : null;
    }
    case 'file': {
      const list = (Array.isArray(raw) ? raw : []) as {id?: string; token?: string}[];
      const ok: {id: string; name: string; size: number}[] = [];
      for (const item of list.slice(0, 5)) {
        if (!item.id || !item.token || !(await verifySignature(`formfile:${item.id}`, item.token))) continue;
        const file = await db.file.findUnique({where: {id: item.id}, select: {id: true, name: true, size: true, purpose: true}});
        if (file && file.purpose === 'form_pending') ok.push({id: file.id, name: file.name, size: file.size});
      }
      return ok;
    }
    default:
      return String(raw).trim().slice(0, 10_000);
  }
}

/**
 * Runs a public submission: spam checks, validation against the visible
 * fields, contact create/update (dedupe by email), company link, optional
 * deal, timeline + events + notifications, and queues the emails.
 */
export async function submitForm(db: Db, form: Form, input: SubmitInput) {
  const fields = formFields(form);
  const settings = formSettings(form);

  const closed = closedReason(form);
  if (closed) throw new HTTPException(403, {message: closed});

  // Spam: a filled honeypot or an inhumanly fast submit is dropped silently.
  const tooFast = input.startedAt && Date.now() - input.startedAt < 1500;
  if (input.honeypot || tooFast) return {spam: true as const, ending: pickEnding(settings, fields, {})};

  // Answers → typed values. Hidden fields fall back to their default.
  const answers: Answers = {};
  for (const f of fields) {
    const raw = input.answers[f.id];
    answers[f.id] = await cleanValue(db, f, raw === undefined && f.type === 'hidden' ? f.defaultValue : raw);
  }
  const active = activeFields(fields, answers);
  for (const f of active) {
    if (f.type === 'hidden') continue;
    const error = validateField(f, answers[f.id]);
    if (error) throw new HTTPException(400, {message: `${f.label}: ${error}`});
  }
  const stored: StoredAnswer[] = active.filter((f) => !isEmpty(answers[f.id])).map((f) => ({fieldId: f.id, label: f.label, type: f.type, value: answers[f.id]!}));

  // What the answers say about the person, their company and the deal.
  const contactData: Prisma.ContactUncheckedUpdateInput & Record<string, unknown> = {};
  const custom: Record<string, unknown> = {};
  const company: Record<string, unknown> = {};
  let dealValue: number | null = settings.createDeal?.value ?? null;
  for (const f of active) {
    const v = answers[f.id];
    if (isEmpty(v)) continue;
    if (f.type === 'name') {
      const n = v as {first: string; last: string};
      if (n.first) contactData.firstName = n.first;
      if (n.last) contactData.lastName = n.last;
    } else if (f.type === 'email') contactData.email = str(v);
    else if (f.type === 'phone') contactData.phone = str(v);
    else if (f.type === 'company') company.name = str(v);
    else if (f.type === 'website') company.website = str(v);
    else if (f.type === 'address') {
      const a = v as Record<string, string>;
      if (a.city) contactData.city = a.city;
      if (a.country) contactData.country = a.country;
    } else if (f.mapTo) {
      const [entity, prop, key] = f.mapTo.split('.');
      const text = Array.isArray(v) ? v.join(', ') : answerText(f.type, v);
      if (entity === 'contact' && prop === 'custom' && key) custom[key] = v;
      else if (entity === 'contact' && prop && ['title', 'linkedin', 'city', 'country', 'leadStatus', 'buyingRole'].includes(prop)) contactData[prop] = text.slice(0, 300);
      else if (entity === 'company' && prop && ['industry', 'size'].includes(prop)) company[prop] = text.slice(0, 200);
      else if (entity === 'company' && prop === 'employees' && !Number.isNaN(Number(v))) company.employees = Math.round(Number(v));
      else if (entity === 'deal' && prop === 'value' && !Number.isNaN(Number(v))) dealValue = Number(v);
    }
  }
  const email = (contactData.email as string | undefined) ?? null;
  // Booking slots are checked before anything is written.
  const bookings = await checkFormSlots(db, active, answers, email);

  if (settings.onePerContact && email) {
    const dupe = await db.formSubmission.findFirst({where: {formId: form.id, email}, select: {id: true}});
    if (dupe) throw new HTTPException(409, {message: "You've already responded to this form."});
  }

  // Owner for new records: fixed user or round-robin.
  let ownerId: string | null = null;
  const owner = settings.owner;
  if (owner?.mode === 'user' && owner.userId) ownerId = owner.userId;
  if (owner?.mode === 'round_robin' && owner.userIds?.length) {
    const active = await db.member.findMany({where: {id: {in: owner.userIds}, active: true}, select: {id: true}, orderBy: {createdAt: 'asc'}});
    if (active.length) {
      const next = owner.next ?? 0;
      ownerId = active[next % active.length]!.id;
      await db.form.update({where: {id: form.id}, data: {settings: {...settings, owner: {...owner, next: next + 1}} as Prisma.InputJsonValue}});
    }
  }

  // Contact: update the existing one (by email) or create one.
  let contact: Contact | null = email ? await db.contact.findFirst({where: {email: {equals: email, mode: 'insensitive'}}}) : null;
  const isNew = !contact;
  const identifiable = email || contactData.firstName || contactData.phone;
  if (identifiable) {
    const tags = settings.tags ?? [];
    const stage = settings.lifecycleStage as LifecycleStage | null | undefined;
    if (contact) {
      const before = contact;
      const customValue = Object.keys(custom).length ? await cleanCustom(db, 'CONTACT', custom, contact.custom).catch(() => undefined) : undefined;
      const patch = {
        ...contactData,
        tags: tags.length ? [...new Set([...contact.tags, ...tags])] : undefined,
        lifecycleStage: stage && STAGE_RANK[stage] > STAGE_RANK[contact.lifecycleStage] ? stage : undefined,
        ownerId: contact.ownerId ?? ownerId,
      };
      contact = await db.contact.update({where: {id: contact.id}, data: {...patch, custom: customValue as Prisma.InputJsonValue | undefined}});
      // What the submission changed shows on the timeline and in property history as "Form: <name>".
      const changes = [...diff(before, patch), ...(customValue ? customDiff(before.custom, contact.custom) : [])];
      if (changes.length) {
        await logActivity(db, {type: 'field_changed', title: `Updated from ${form.name}`, contactId: contact.id, data: {changes, source: {kind: 'form', name: form.name}} as Prisma.InputJsonValue});
      }
    } else {
      const source = settings.contactSource?.trim() || `Form: ${form.name}`;
      const customValue = Object.keys(custom).length ? await cleanCustom(db, 'CONTACT', custom).catch(() => undefined) : undefined;
      contact = await db.contact.create({
        data: {
          ...(contactData as Prisma.ContactUncheckedCreateInput),
          firstName: (contactData.firstName as string | undefined) || email?.split('@')[0] || 'Unknown',
          source,
          tags,
          lifecycleStage: stage ?? 'LEAD',
          ownerId,
          custom: (customValue ?? {}) as Prisma.InputJsonValue,
          lastActivityAt: new Date(),
        },
      });
      await rememberOption(db, 'sources', source);
      await logActivity(db, {type: 'contact_created', title: `Contact created from ${form.name}`, contactId: contact.id, data: {source: {kind: 'form', name: form.name}}});
    }
  }

  // Company: by the name they typed, else by their work email domain.
  let companyId: string | null = null;
  if (contact) {
    const name = company.name as string | undefined;
    const website = company.website as string | undefined;
    const domain = website ? website.replace(/^https?:\/\//i, '').replace(/^www\./, '').split('/')[0]!.toLowerCase() : workDomain(email);
    let found = name
      ? await db.company.findFirst({where: {name: {equals: name, mode: 'insensitive'}}, select: {id: true}})
      : domain
        ? await db.company.findFirst({where: {domain}, select: {id: true}})
        : null;
    const extra = {industry: company.industry as string | undefined, size: company.size as string | undefined, employees: company.employees as number | undefined};
    if (!found && name) {
      found = await db.company.create({data: {name, domain, website: website ?? (domain ? `https://${domain}` : null), ownerId: contact.ownerId, lastActivityAt: new Date(), ...extra}, select: {id: true}});
      await logActivity(db, {type: 'company_created', title: `Company created from ${form.name}`, companyId: found.id});
    } else if (found && (extra.industry || extra.size || extra.employees || website)) {
      await db.company.update({where: {id: found.id}, data: {...extra, website: website || undefined}});
    }
    if (found) {
      companyId = found.id;
      const links = await db.contactCompany.findMany({where: {contactId: contact.id}, select: {companyId: true}});
      if (!links.some((l) => l.companyId === found!.id)) await db.contactCompany.create({data: {contactId: contact.id, companyId: found.id, isPrimary: links.length === 0}});
    } else if (!name) {
      companyId = (await associateByDomain(db, contact.id))?.id ?? null;
    }
  }

  // Optional deal.
  let dealId: string | null = null;
  if (settings.createDeal?.enabled && contact) {
    const pipeline = await defaultPipeline(db, settings.createDeal.pipelineId ?? undefined).catch(() => null);
    if (pipeline) {
      const stageId = pipeline.stages.find((s) => s.id === settings.createDeal!.stageId)?.id ?? pipeline.stages[0]!.id;
      const companyRow = companyId ? await db.company.findUnique({where: {id: companyId}, select: {name: true}}) : null;
      const ctx = {contact, company: companyRow, deal: null, me: {name: form.name, email: ''}};
      const title = mergeFields(settings.createDeal.title || `${form.name}: {{contact.full_name}}`, ctx).trim() || form.name;
      const deal = await db.deal.create({
        data: {
          title: title.slice(0, 200),
          value: dealValue ?? 0,
          pipelineId: pipeline.id,
          stageId,
          ownerId: contact.ownerId,
          companyId,
          position: -Date.now() / 1e6,
          contacts: {create: {contactId: contact.id}},
          ...(companyId ? {companies: {create: {companyId, isPrimary: true}}} : {}),
        },
      });
      dealId = deal.id;
      await db.stageChange.create({data: {dealId: deal.id, toStageId: stageId}});
      await logActivity(db, {type: 'deal_created', title: `Deal created from ${form.name}: ${deal.title}`, dealId: deal.id, contactId: contact.id, companyId});
      await emit(db, 'deal.created', {recordId: deal.id, data: deal});
    }
  }

  // Optional support ticket (answers become its description).
  if (settings.createTicket?.enabled && contact) {
    const ctx = {contact, company: null, deal: null, me: {name: form.name, email: ''}};
    await createTicket(db, {
      subject: mergeFields(settings.createTicket.subject || `${form.name}: {{contact.full_name}}`, ctx).trim() || form.name,
      description: stored.filter((a) => a.type !== 'hidden').map((a) => `${a.label}\n${answerText(a.type, a.value)}`).join('\n\n'),
      source: 'FORM',
      priority: settings.createTicket.priority ?? undefined,
      category: settings.createTicket.category,
      contactId: contact.id,
      companyId,
      dealId,
    });
  }

  const ending = pickEnding(settings, fields, answers);
  const submission = await db.formSubmission.create({
    data: {
      formId: form.id,
      answers: stored as unknown as Prisma.InputJsonValue,
      meta: {...input.meta, userAgent: input.userAgent?.slice(0, 300), endingId: ending.id, origin: input.origin} as Prisma.InputJsonValue,
      email,
      contactId: contact?.id,
      dealId,
    },
  });

  if (contact && settings.listIds?.length) {
    for (const listId of settings.listIds) await addToList(db, listId, [contact.id], {source: 'form'});
  }
  if (contact && bookings.length) await bookFormSlots(db, form, submission, contact, bookings, input.origin);

  // Uploaded files now belong to the contact (and deal).
  const fileIds = stored.filter((a) => a.type === 'file').flatMap((a) => (a.value as {id: string}[]).map((x) => x.id));
  if (fileIds.length) await db.file.updateMany({where: {id: {in: fileIds}, purpose: 'form_pending'}, data: {purpose: 'form', contactId: contact?.id, dealId}});

  await db.form.update({where: {id: form.id}, data: {submissionCount: {increment: 1}, lastSubmissionAt: new Date()}});
  // Shared inbox: the response as an inbound conversation (never fails the submission).
  await formConversation(db, form, settings, submission, contact);

  const who = contact ? [contact.firstName, contact.lastName].filter(Boolean).join(' ') : 'Someone';
  if (contact) {
    await logActivity(db, {
      type: 'form_submitted',
      title: `Submitted ${form.name}`,
      refId: submission.id,
      contactId: contact.id,
      companyId,
      dealId,
      data: {formId: form.id, formName: form.name, answers: stored.slice(0, 40).map((a) => ({label: a.label, text: answerText(a.type, a.value).slice(0, 500)}))},
      text: stored.map((a) => `${a.label}: ${answerText(a.type, a.value)}`).join('\n'),
    });
    await emit(db, isNew ? 'contact.created' : 'contact.updated', {recordId: contact.id, data: contact});
  }
  await emit(db, 'form.submitted', {
    entity: 'form',
    recordId: form.id,
    data: {form: {id: form.id, name: form.name, slug: form.slug}, submissionId: submission.id, answers: stored, meta: input.meta, contactId: contact?.id ?? null, dealId},
  });
  await notify(db, [...(settings.notifyUserIds ?? []), contact?.ownerId], {
    type: 'form',
    title: `New ${form.name} response from ${who}`,
    body: stored.slice(0, 4).map((a) => `${a.label}: ${answerText(a.type, a.value)}`).join(' · '),
    link: contact ? recordLink.contact(contact.id) : `/forms/${form.id}?tab=results`,
  });

  if (settings.notifyEmails?.length || (settings.autoresponder?.enabled && email)) {
    await enqueue(db, 'form.after_submit', {submissionId: submission.id});
    kickJobs();
  }
  return {spam: false as const, submission, ending};
}
