import type {Prisma} from '../../../generated/prisma/client';
import {answerText, type StoredAnswer} from '@/lib/forms';
import {config} from '../kit/config';
import type {Db} from '../kit/db';
import {sendEmail, sendSystemEmail} from '../email/service';
import {getSettings} from './settings';
import {formSettings} from './form-submit';

type Meta = Record<string, unknown> & {origin?: string; teamEmailedAt?: string; autoresponderAt?: string; autoresponderError?: string};

/**
 * Job "form.after_submit": the team notification email and the autoresponder.
 * Each step records when it ran, so a retry never sends twice.
 */
export async function formAfterSubmit(db: Db, submissionId: string) {
  const sub = await db.formSubmission.findUnique({where: {id: submissionId}, include: {form: true, contact: true}});
  if (!sub) return;
  const settings = formSettings(sub.form);
  const meta = (sub.meta ?? {}) as Meta;
  const origin = config.siteUrl() || meta.origin || '';
  const answers = (sub.answers ?? []) as unknown as StoredAnswer[];
  const save = (patch: Partial<Meta>) => db.formSubmission.update({where: {id: sub.id}, data: {meta: {...meta, ...patch} as Prisma.InputJsonValue}});

  if (settings.notifyEmails?.length && !meta.teamEmailedAt) {
    const brand = (await getSettings(db)).brandName;
    const who = sub.contact ? [sub.contact.firstName, sub.contact.lastName].filter(Boolean).join(' ') : sub.email ?? 'Someone';
    const lines = answers.map((a) => `${a.label}\n${answerText(a.type, a.value)}`).join('\n\n');
    const link = sub.contact ? `${origin}/contacts/${sub.contact.id}` : `${origin}/forms/${sub.formId}?tab=results`;
    const sent = await sendSystemEmail(db, {
      to: settings.notifyEmails,
      subject: `New ${sub.form.name} response from ${who}`,
      text: `${who} submitted "${sub.form.name}".\n\n${lines}\n\nOpen in ${brand}: ${link}`,
      replyTo: sub.email,
    });
    meta.teamEmailedAt = sent ? new Date().toISOString() : 'no-account';
    await save({teamEmailedAt: meta.teamEmailedAt});
  }

  if (settings.autoresponder?.enabled && sub.contact?.email && !meta.autoresponderAt && !sub.contact.emailOptOut) {
    // Sent as the form's creator (or the first owner), from their mailbox or a shared one.
    const sender =
      (sub.form.createdById && (await db.member.findFirst({where: {id: sub.form.createdById, active: true}}))) ||
      (await db.member.findFirst({where: {role: 'OWNER', active: true}, orderBy: {createdAt: 'asc'}}));
    if (!sender) return;
    try {
      await sendEmail(db, sender, origin, {
        to: [sub.contact.email],
        subject: settings.autoresponder.subject,
        body: settings.autoresponder.body,
        layout: 'branded', // a reply from the company: header, footer and unsubscribe link
        contactId: sub.contact.id,
        dealId: sub.dealId,
      });
      await save({autoresponderAt: new Date().toISOString()});
    } catch (e) {
      // No connected mailbox is not worth retrying for hours; note it and stop.
      const message = (e as Error).message;
      if (/Connect an email account|opted out|Daily limit/.test(message)) await save({autoresponderAt: 'skipped', autoresponderError: message});
      else throw e;
    }
  }
}
