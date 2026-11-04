import {Hono} from 'hono';
import {z} from 'zod';

import type {Db} from '../kit/db';
import type {AppEnv} from '../kit/guards';
import {logActivity} from '../lib/activity';
import {emit} from '../lib/events';
import {notFound, valid} from '../lib/http';
import {contactFromUnsubscribeToken} from '../lib/unsubscribe';

/** j***@example.com: enough for people to recognise their address, not enough to harvest it. */
const maskEmail = (email: string | null) => {
  if (!email) return null;
  const [user, domain] = email.split('@');
  return `${user!.slice(0, 1)}${'*'.repeat(Math.max(2, Math.min(6, user!.length - 1)))}@${domain}`;
};

async function unsubscribeState(db: Db, token: string) {
  const id = await contactFromUnsubscribeToken(token);
  const contact = id ? await db.contact.findUnique({where: {id}, select: {id: true, email: true, emailOptOut: true}}) : null;
  return contact ? {email: maskEmail(contact.email), optedOut: contact.emailOptOut} : null;
}

/** Pages anyone can open (no sign-in). Every input is a signed token. */
export const publicApi = new Hono<AppEnv>()
  .get('/unsubscribe/:token', async (c) => {
    const state = await unsubscribeState(c.var.db, c.req.param('token'));
    if (!state) throw notFound('Link');
    return c.json(state);
  })

  .post('/unsubscribe/:token', valid('json', z.object({optOut: z.boolean()})), async (c) => {
    const db = c.var.db;
    const id = await contactFromUnsubscribeToken(c.req.param('token'));
    const before = id ? await db.contact.findUnique({where: {id}}) : null;
    if (!before) throw notFound('Link');
    const {optOut} = c.req.valid('json');
    if (before.emailOptOut !== optOut) {
      const contact = await db.contact.update({where: {id: before.id}, data: {emailOptOut: optOut}});
      await logActivity(db, {
        type: 'field_changed',
        title: optOut ? 'Unsubscribed from email' : 'Subscribed to email again',
        contactId: contact.id,
        data: {changes: [{field: 'emailOptOut', from: before.emailOptOut, to: optOut}], source: {kind: 'customer', name: 'Unsubscribe page'}},
      });
      await emit(db, 'contact.updated', {recordId: contact.id, data: {...contact, changes: [{field: 'emailOptOut', from: before.emailOptOut, to: optOut}]}});
    }
    return c.json({email: maskEmail(before.email), optedOut: optOut});
  });
