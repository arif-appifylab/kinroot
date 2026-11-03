import type {Contact, Form, FormSubmission} from '../../../generated/prisma/client';
import {answerText, type FormSettings, type StoredAnswer} from '@/lib/forms';
import type {Db} from '../kit/db';
import {onInbound} from './routing';

/**
 * Form channel: with "Send responses to the inbox" on (FormSettings.inbox),
 * each response becomes an inbound conversation from the respondent on the
 * chosen shared account, linked to the contact. Replying from the inbox emails
 * the respondent from that account, and their answer threads back in by its
 * reply headers. Called at the end of `submitForm()`; never throws, so a
 * response is stored exactly as before even when this fails.
 * Idempotent per response (`EmailThread.formSubmissionId` is unique).
 */
export async function formConversation(db: Db, form: Pick<Form, 'id' | 'name'>, settings: FormSettings, submission: FormSubmission, contact: Pick<Contact, 'id' | 'firstName' | 'lastName' | 'email'> | null) {
  try {
    const cfg = settings.inbox;
    if (!cfg?.enabled || !cfg.accountId) return null;
    const account = await db.emailAccount.findFirst({where: {id: cfg.accountId, userId: null}});
    if (!account) return null;
    const existing = await db.emailThread.findUnique({where: {formSubmissionId: submission.id}});
    if (existing) return existing;

    const answers = ((submission.answers ?? []) as unknown as StoredAnswer[]).filter((a) => a.type !== 'hidden');
    const name = contact ? [contact.firstName, contact.lastName].filter(Boolean).join(' ') : null;
    const email = (submission.email ?? contact?.email ?? '').toLowerCase();
    const company = contact ? await db.contactCompany.findFirst({where: {contactId: contact.id}, orderBy: {isPrimary: 'desc'}, select: {companyId: true}}) : null;
    const subject = `${form.name}${name ? `: ${name}` : ''}`.slice(0, 300);
    const at = submission.createdAt;
    const thread = await db.emailThread.create({
      data: {
        subject,
        channel: 'form',
        accountId: account.id,
        contactId: contact?.id,
        companyId: company?.companyId,
        dealId: submission.dealId,
        formSubmissionId: submission.id,
        lastMessageAt: at,
        createdAt: at,
      },
    });
    const message = await db.emailMessage.create({
      data: {
        threadId: thread.id,
        accountId: account.id,
        direction: 'INBOUND',
        status: 'RECEIVED',
        fromEmail: email || 'unknown',
        fromName: name,
        to: [account.fromEmail],
        subject,
        text: answers.map((a) => `${a.label}\n${answerText(a.type, a.value)}`).join('\n\n') || '(no answers)',
        contactId: contact?.id,
        sentAt: at,
      },
    });
    const routed = await onInbound(db, thread, message);
    return routed.thread;
  } catch (e) {
    console.error('[inbox] form conversation', form.id, String((e as Error)?.message ?? e).slice(0, 200));
    return null;
  }
}
