import {HTTPException} from 'hono/http-exception';

import type {BookingLink, Contact, Form, FormSubmission, Prisma} from '../../../generated/prisma/client';
import {fullName} from '@/lib/format';
import {isEmpty, type Answers, type FormField} from '@/lib/forms';
import type {Db} from '../kit/db';
import {claimSlot, createBooking} from './bookings';
import {numbers} from '../lib/json-list';

type Picked = {field: FormField; link: BookingLink; start: string; duration: number; timezone: string};

/**
 * "Booking slot" fields: before the submission writes anything, check each
 * picked time is still open (a taken slot fails the submit with a toast).
 */
export async function checkFormSlots(db: Db, fields: FormField[], answers: Answers, email: string | null): Promise<Picked[]> {
  const out: Picked[] = [];
  for (const field of fields) {
    const v = answers[field.id] as {start?: string; duration?: string; timezone?: string} | null;
    if (field.type !== 'booking' || isEmpty(v ?? null) || !v?.start) continue;
    const link = field.bookingLinkId ? await db.bookingLink.findUnique({where: {id: field.bookingLinkId}}) : null;
    if (!link?.active) throw new HTTPException(409, {message: `${field.label}: online booking is not available right now`});
    if (!email) throw new HTTPException(400, {message: 'Please add your email address to book a time'});
    const duration = Number(v.duration) || numbers(link.durations)[0] || 30;
    await claimSlot(db, link, new Date(v.start), duration);
    out.push({field, link, start: v.start, duration, timezone: v.timezone || link.timezone});
  }
  return out;
}

/** After the contact exists: book each slot for them and note it on the submission. */
export async function bookFormSlots(db: Db, form: Form, submission: FormSubmission, contact: Contact, picked: Picked[], origin: string) {
  const bookingIds: string[] = [];
  for (const p of picked) {
    const booking = await createBooking(db, p.link, {
      start: p.start,
      duration: p.duration,
      timezone: p.timezone,
      name: fullName(contact) || contact.email!,
      email: contact.email!,
      phone: contact.phone,
      source: 'form',
      contactId: contact.id,
      meta: {formId: form.id, submissionId: submission.id, field: p.field.label},
      origin,
      notes: `From the form "${form.name}"`,
    });
    bookingIds.push(booking.id);
  }
  await db.formSubmission.update({where: {id: submission.id}, data: {meta: {...(submission.meta as object), bookingIds} as Prisma.InputJsonValue}});
}
