import {Hono} from 'hono';
import {z} from 'zod';

import type {AppEnv} from '../kit/guards';
import {ownerScope, valid} from '../lib/http';
import {ticketScope} from '../lib/tickets';
import {companyWhere} from './companies';
import {contactWhere} from './contacts';

/** Global search for the ⌘K palette. */
export const search = new Hono<AppEnv>().get('/', valid('query', z.object({q: z.string().trim().min(1).max(100)})), async (c) => {
  const {q} = c.req.valid('query');
  const db = c.var.db;
  const scope = await ownerScope(c);
  const number = q.replace(/^#/, '');
  const [contacts, companies, deals, notes, tickets] = await Promise.all([
    db.contact.findMany({
      where: {...contactWhere({q}), ...scope},
      select: {id: true, firstName: true, lastName: true, email: true, title: true},
      take: 6,
      orderBy: {lastActivityAt: {sort: 'desc', nulls: 'last'}},
    }),
    db.company.findMany({where: {...companyWhere({q}), ...scope}, select: {id: true, name: true, domain: true}, take: 5}),
    db.deal.findMany({
      where: {title: {contains: q, mode: 'insensitive'}, ...scope},
      select: {id: true, title: true, value: true, currency: true, status: true, stage: {select: {name: true}}},
      take: 5,
    }),
    db.note.findMany({
      where: {body: {contains: q, mode: 'insensitive'}},
      select: {id: true, body: true, contactId: true, companyId: true, dealId: true},
      take: 4,
      orderBy: {createdAt: 'desc'},
    }),
    db.ticket.findMany({
      where: {AND: [await ticketScope(c), {OR: [...(/^\d{1,9}$/.test(number) ? [{number: Number(number)}] : []), {subject: {contains: q, mode: 'insensitive'}}]}]},
      select: {id: true, number: true, subject: true, status: true},
      take: 5,
      orderBy: {lastMessageAt: 'desc'},
    }),
  ]);
  return c.json({contacts, companies, deals, notes, tickets});
});
