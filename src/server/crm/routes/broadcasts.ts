import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import type {Prisma} from '../../../generated/prisma/client';
import {isEmptyHtml} from '@/lib/email-html';
import {publicOrigin} from '../kit/config';
import {currentUser, isAdmin, type AppContext, type AppEnv} from '../kit/guards';
import {broadcastStats, cancelBroadcast, emptyStats, MAX_RECIPIENTS, resolveAudience} from '../lib/broadcasts';
import {fieldError, intParam, notFound, ownerScope, valid} from '../lib/http';
import {enqueue} from '../lib/jobs';
import {userSelect} from '../lib/users';
import {usableAccounts} from '../email/service';

const DAY = 86_400_000;

/** Members limited to their own records only see the broadcasts they sent. */
async function broadcastScope(c: AppContext): Promise<Prisma.BroadcastWhereInput> {
  return (await ownerScope(c)).ownerId ? {createdById: currentUser(c).id} : {};
}

const include = {
  createdBy: {select: userSelect},
  account: {select: {id: true, fromEmail: true, fromName: true, dailyLimit: true}},
} satisfies Prisma.BroadcastInclude;

async function findList(c: AppContext, id: string) {
  const list = await c.var.db.contactList.findUnique({where: {id}, select: {id: true, name: true, kind: true, rules: true}});
  if (!list) throw notFound('List');
  return list;
}

/** Contacts emailed from this account in the last 24 hours (the window sendEmail() limits). */
const sentToday = (c: AppContext, accountId: string) =>
  c.var.db.emailMessage.count({where: {accountId, direction: 'OUTBOUND', sentAt: {gte: new Date(Date.now() - DAY)}}});

export const broadcasts = new Hono<AppEnv>()
  // Who a broadcast to this list would reach right now, and who is left out.
  .get('/audience', valid('query', z.object({listId: z.string().min(1), accountId: z.string().optional()})), async (c) => {
    const q = c.req.valid('query');
    const list = await findList(c, q.listId);
    const {recipients, ...counts} = await resolveAudience(c.var.db, list, await ownerScope(c));
    const account = q.accountId ? (await usableAccounts(c.var.db, currentUser(c))).find((a) => a.id === q.accountId) : null;
    return c.json({
      ...counts,
      recipients: recipients.length,
      max: MAX_RECIPIENTS,
      account: account ? {dailyLimit: account.dailyLimit, sentToday: await sentToday(c, account.id)} : null,
    });
  })

  .get('/', valid('query', z.object({listId: z.string().optional(), take: intParam(1, 200).default(50)})), async (c) => {
    const q = c.req.valid('query');
    const rows = await c.var.db.broadcast.findMany({
      where: {AND: [await broadcastScope(c), q.listId ? {listId: q.listId} : {}]},
      include,
      orderBy: {createdAt: 'desc'},
      take: q.take,
    });
    const stats = await broadcastStats(c.var.db, rows.map((r) => r.id));
    return c.json({rows: rows.map(({html: _h, origin: _o, ...b}) => ({...b, stats: stats.get(b.id) ?? emptyStats()}))});
  })

  .get('/:id', async (c) => {
    const db = c.var.db;
    const b = await db.broadcast.findFirst({where: {AND: [{id: c.req.param('id')}, await broadcastScope(c)]}, include});
    if (!b) throw notFound('Broadcast');
    // Sends that need a look: failed and skipped addresses with the reason.
    const problems = await db.broadcastRecipient.findMany({
      where: {broadcastId: b.id, status: {in: ['FAILED', 'SKIPPED']}},
      select: {id: true, email: true, contactId: true, status: true, error: true},
      orderBy: {updatedAt: 'desc'},
      take: 100,
    });
    const {origin: _o, ...rest} = b;
    return c.json({broadcast: {...rest, stats: (await broadcastStats(db, [b.id])).get(b.id) ?? emptyStats()}, problems});
  })

  .post('/', valid('json', z.object({
    listId: z.string().min(1),
    accountId: z.string().min(1, 'pick an account to send from'),
    subject: z.string().trim().min(1, 'is required').max(500),
    html: z.string().max(200_000),
    preheader: z.string().trim().max(300).nullish(),
    templateId: z.string().max(40).nullish(),
    scheduledAt: z.iso.datetime({offset: true}).nullish(), // empty = send now
  })), async (c) => {
    const db = c.var.db;
    const me = currentUser(c);
    const input = c.req.valid('json');
    if (isEmptyHtml(input.html)) throw fieldError('html', 'Write the email first');
    const list = await findList(c, input.listId);
    const account = (await usableAccounts(db, me)).find((a) => a.id === input.accountId);
    if (!account) throw fieldError('accountId', 'Pick one of your email accounts or a shared one');

    const at = input.scheduledAt ? new Date(input.scheduledAt) : new Date();
    if (at.getTime() < Date.now() - 5 * 60_000) throw fieldError('scheduledAt', 'Pick a time in the future');
    if (at.getTime() > Date.now() + 365 * DAY) throw fieldError('scheduledAt', 'Schedule it within the next 12 months');

    // Checked now so nobody schedules an empty or oversized send; the recipients are frozen when it starts.
    const audience = await resolveAudience(db, list, await ownerScope(c));
    if (!audience.recipients.length) throw new HTTPException(400, {message: 'Nobody in this list can be emailed (no address, opted out or not visible to you)'});
    if (audience.recipients.length > MAX_RECIPIENTS) throw new HTTPException(400, {message: `This list has more than ${MAX_RECIPIENTS.toLocaleString('en-US')} recipients; split it into smaller lists`});

    const broadcast = await db.broadcast.create({
      data: {
        listId: list.id,
        listName: list.name,
        accountId: account.id,
        createdById: me.id,
        subject: input.subject,
        html: input.html,
        preheader: input.preheader || null,
        templateId: input.templateId || null,
        scheduledAt: at,
        origin: publicOrigin(c.req.raw),
      },
      include,
    });
    await enqueue(db, 'broadcast.start', {broadcastId: broadcast.id}, {runAt: at});
    const {html: _h, origin: _o, ...rest} = broadcast;
    return c.json({broadcast: {...rest, stats: emptyStats()}}, 201);
  })

  .post('/:id/cancel', async (c) => {
    const db = c.var.db;
    const me = currentUser(c);
    const b = await db.broadcast.findFirst({where: {AND: [{id: c.req.param('id')}, await broadcastScope(c)]}});
    if (!b) throw notFound('Broadcast');
    if (b.createdById !== me.id && !isAdmin(me)) throw new HTTPException(403, {message: 'Only the sender or an admin can cancel this broadcast'});
    await cancelBroadcast(db, b.id);
    return c.json({ok: true});
  });
