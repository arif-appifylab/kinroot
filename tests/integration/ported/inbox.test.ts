import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../../src/server/app';
import {crmTick} from '../../../src/server/crm/lib/ticks';
import {owner, ownerAccountId, resetCrm, teammate, userId} from '../support/crm';
import {Browser, configureEnv, DATABASE_URL, db} from '../support/harness';
import {fakeResend, inbound as postInbound, inJob, mailbox, mails, mailsTo, restoreResend} from './support-inbox';
import {eventually} from '../support/wait';

/**
 * Ported from Kinroot's scripts/test-inbox.mjs
 * The shared inbox: views and counts, privacy of personal mailboxes, team-inbox access and
 * visibility, manual and round-robin assignment, replies (threading headers, Reply-To, first
 * response) and internal comments with mentions, snooze wake-up, close / reopen by reply, spam and
 * blocked senders, trash / restore / delete forever and the 30-day purge, auto-close, the form
 * channel, sanitised HTML, contact / deal / ticket from the sidebar, events, audit entries and the
 * Conversations report object.
 *
 * Changed by the migration: mailboxes are Resend accounts (SMTP is gone) whose sends are captured;
 * inbound mail is posted signed with `INBOUND_BASIC_AUTH`; the original's `POST /jobs/run` is
 * `crmTick` (the platform's `crm-tick` schedule); addresses are on real-looking domains because
 * example.com / .test recipients are never emailed.
 */

const TEAM_IN = 'team-in@kinroot-port.io';
const ADA_IN = 'ada-in@kinroot-port.io';
const BILLING_IN = 'billing-in@kinroot-port.io';
const ok = async <T = any>(p: Promise<{status: number; json: Record<string, unknown>}>, status = 200) => {
  const r = await p;
  expect(r.status, JSON.stringify(r.json)).toBe(status);
  return r.json as T;
};

type Person = {c: Browser; id: string; name: string};
let own: Browser;
let me: {id: string; name: string};
let A: Person;
let B: Person;
let C: Person;
let team: {id: string};
let known: {id: string; email: string};
let personalContact: {id: string; email: string};
let seq = 0;

async function person(email: string): Promise<Person> {
  const {browser} = await teammate(own, email, 'MEMBER');
  const m = await db.member.findUniqueOrThrow({where: {userId: await userId(email)}, select: {id: true, name: true}});
  return {c: browser, ...m};
}

async function seed() {
  own = await owner();
  await own.get('/site-api/crm/auth/state');
  await ok(own.post('/site-api/crm/auth/setup', {brandName: 'Kinroot', demoData: false}));
  me = await db.member.findUniqueOrThrow({where: {userId: await ownerAccountId()}, select: {id: true, name: true}});
  A = await person('ada@kinroot-port.io');
  B = await person('bea@kinroot-port.io');
  C = await person('cal@kinroot-port.io');
  team = await mailbox(own, {fromName: 'Support team', fromEmail: 'team@kinroot-port.io', shared: true, replyTo: TEAM_IN});
  await mailbox(own, {fromName: 'Billing', fromEmail: 'billing@kinroot-port.io', shared: true, replyTo: BILLING_IN});
  await mailbox(A.c, {fromName: 'Ada', fromEmail: 'ada-box@kinroot-port.io', replyTo: ADA_IN});
  await saveSettings({teamAccounts: [team.id], access: 'everyone', memberIds: [], visibility: 'all', assignment: 'manual', roundRobinIds: [], autoAssignReplies: true, autoCloseDays: null, blockedAddresses: [], blockedDomains: []});
  known = (await ok(own.post('/site-api/crm/contacts', {firstName: 'Kim', lastName: 'Known', email: 'kim@client-port.io'}), 201)).contact;
  personalContact = (await ok(own.post('/site-api/crm/contacts', {firstName: 'Pat', lastName: 'Private', email: 'pat@client-port.io'}), 201)).contact;
}

const inbound = (payload: Record<string, unknown>) => postInbound(own, payload);
const mid = (tag: string) => `${tag}-${++seq}@sender-port.io`;
const conv = (c: Browser, id: string) => c.get(`/site-api/crm/inbox/conversations/${id}`);
const list = async (c: Browser, query: Record<string, string>) => ok<{rows: any[]; total: number}>(c.get(`/site-api/crm/inbox/conversations?${new URLSearchParams({pageSize: '100', ...query})}`));
const has = async (c: Browser, query: Record<string, string>, id: string) => (await list(c, query)).rows.some(x => x.id === id);
const counts = (c: Browser) => ok(c.get('/site-api/crm/inbox/counts'));
const act = (c: Browser, ids: string[], action: string, extra: Record<string, unknown> = {}) => c.post('/site-api/crm/inbox/conversations/actions', {ids, action, ...extra});
const threadOf = async (messageId: string) => (await db.emailMessage.findFirstOrThrow({where: {messageId}, select: {threadId: true}})).threadId;
const thread = (id: string) => db.emailThread.findUnique({where: {id}});
const notes = (memberId: string, contains: string) => db.notification.findMany({where: {userId: memberId, title: {contains, mode: 'insensitive'}}});
const events = (type: string, recordId: string) => db.event.findMany({where: {type, recordId}, orderBy: {createdAt: 'asc'}});
const audits = (action: string, recordId: string) => db.auditLog.findMany({where: {action, recordId}});
async function saveSettings(patch: Record<string, unknown>) {
  const cur = (await ok(own.get('/site-api/crm/inbox/settings'))).settings;
  return (await ok(own.request('PUT', '/site-api/crm/inbox/settings', {...cur, ...patch}))).settings;
}
/** A new team conversation from an unknown sender. */
async function start(from: string, subject: string, text = 'Hello, do you ship to Norway?') {
  const messageId = mid('m');
  const r = await inbound({from, to: [TEAM_IN], subject, text, messageId});
  expect(r.stored).toBe(true);
  return {id: await threadOf(messageId), messageId};
}
const tick = () => inJob(d => crmTick(d));

describe.skipIf(!DATABASE_URL)('Ported: shared inbox (integration, real Postgres)', () => {
  beforeAll(configureEnv);
  beforeAll(fakeResend);
  afterAll(async () => {
    restoreResend();
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetCrm();
    await seed();
  });
  afterEach(() => {
    mails.length = 0;
  });

  it('starts team conversations for unknown senders and keeps personal mail private', async () => {
    // The team, billing and personal mailboxes connected (Resend, key from the owner secret).
    expect((await db.emailAccount.findMany({select: {status: true}})).map(a => a.status)).toEqual(['CONNECTED', 'CONNECTED', 'CONNECTED']);
    const before = await counts(own);
    const t1 = await start('Una Known <una@stranger-port.io>', 'Question');
    const row = await thread(t1.id);
    expect(row).toMatchObject({status: 'OPEN', contactId: null, unread: true});
    expect(row!.firstInboundAt && row!.waitingSince).toBeTruthy();
    const after = await counts(own);
    expect(after.views.unassigned).toBe(before.views.unassigned + 1);
    expect(after.channels.team).toBe(before.channels.team + 1);
    expect(await has(own, {view: 'unassigned'}, t1.id)).toBe(true);
    expect(await events('conversation.created', t1.id)).toHaveLength(1);

    expect((await inbound({from: 'nobody@stranger-port.io', to: [BILLING_IN], subject: 'Billing', text: 'x', messageId: mid('other')})).stored).toBe(false);
    expect((await inbound({from: 'stranger@stranger-port.io', to: [ADA_IN], subject: 'Hi Ada', text: 'x', messageId: mid('up')})).stored).toBe(false);

    const mP = mid('p');
    expect((await inbound({from: `Pat <${personalContact.email}>`, to: [ADA_IN], subject: 'Private note', text: 'Just between us', messageId: mP})).stored).toBe(true);
    const tp = await threadOf(mP);
    expect((await thread(tp))!.assigneeId).toBe(A.id);
    expect(await has(A.c, {view: 'mine'}, tp)).toBe(true);
    expect(await has(A.c, {view: 'open', channel: 'personal'}, tp)).toBe(true);
    expect(await has(own, {view: 'open'}, tp)).toBe(false);
    expect((await conv(own, tp)).status).toBe(404);
    expect((await conv(B.c, tp)).status).toBe(404);
    expect((await own.get(`/site-api/crm/email/threads/${tp}`)).status).toBe(404);
    expect((await list(own, {view: 'open', q: 'Private note'})).rows).toHaveLength(0);
    expect((await list(A.c, {view: 'open', q: 'Private note'})).rows).toHaveLength(1);
    expect((await act(B.c, [tp], 'close')).status).toBe(404);
    expect((await act(A.c, [tp], 'assign', {assigneeId: B.id})).status).toBe(400);

    // Mentions on a personal conversation never reach people who cannot open it; its comments stay off the timeline.
    const r = await ok(A.c.post(`/site-api/crm/inbox/conversations/${tp}/comments`, {body: `@${me.name} and @${B.name}, private note`}), 201);
    expect(r.comment.data.mentions).toEqual([]);
    expect(await notes(B.id, 'mentioned you')).toHaveLength(0);
    expect(await db.activity.count({where: {type: 'conversation_comment', refId: r.comment.id}})).toBe(0);
  });

  it('sanitises received HTML and links a known sender to their contact', async () => {
    const mH = mid('html');
    await inbound({
      from: `Kim <${known.email}>`,
      to: [TEAM_IN],
      subject: 'Html',
      html: '<p onclick="alert(1)">Hi <b>there</b></p><script>alert(2)</script><a href="javascript:alert(3)">x</a><a href="https://ok.test/a">ok</a><img src="https://shop.example.test/site-api/crm/t/o/abc.gif"><img src="data:image/svg+xml;base64,AAA"><svg><circle/></svg><iframe src="https://evil.test"></iframe>',
      text: 'Hi there',
      messageId: mH,
    });
    const tH = await threadOf(mH);
    const detail = await ok(conv(own, tH));
    const html = detail.messages.find((m: {direction: string}) => m.direction === 'INBOUND').html as string;
    expect(html).toContain('<b>there</b>');
    expect(html).toContain('href="https://ok.test/a"');
    expect(html).not.toMatch(/script|onclick|javascript:|<svg|<iframe|\/t\/o\/|svg\+xml/i);
    expect(detail.conversation.contactId).toBe(known.id);
    expect(detail.sidebar.contact?.id).toBe(known.id);
    expect((await thread(tH))!.unread).toBe(false);
  });

  it('assigns manually (notified, evented, audited), replies with threading headers and keeps comments internal', async () => {
    const t1 = await start('Una Known <una@stranger-port.io>', 'Question');
    expect((await act(own, [t1.id], 'assign', {assigneeId: B.id})).status).toBe(200);
    let row = await thread(t1.id);
    expect(row!.assigneeId).toBe(B.id);
    expect(row!.assignedAt).toBeTruthy();
    expect(await notes(B.id, 'assigned you a conversation')).toHaveLength(1);
    expect(await notes(me.id, 'assigned you a conversation')).toHaveLength(0);
    const ev = await events('conversation.assigned', t1.id);
    expect(ev).toHaveLength(1);
    expect((ev[0]!.data as Record<string, unknown>).assigneeId).toBe(B.id);
    expect('contactId' in (ev[0]!.data as object)).toBe(true);
    expect(ev[0]!.actorId).toBe(me.id);
    expect(await audits('conversation.assigned', t1.id)).toHaveLength(1);
    expect(await has(B.c, {view: 'mine'}, t1.id)).toBe(true);
    expect(await has(own, {view: 'unassigned'}, t1.id)).toBe(false);
    expect((await act(own, [t1.id], 'assign', {assigneeId: 'nobody'})).status).toBe(400);

    const r = await ok(own.post(`/site-api/crm/inbox/conversations/${t1.id}/reply`, {html: '<p>Yes, we ship to {{contact.first_name|you}}!</p>'}), 201);
    const reply = r.message as {messageId: string};
    expect(mails.map(m => m.to)).toEqual([['una@stranger-port.io']]);
    const out = mails[0]!;
    expect(out.headers?.['In-Reply-To']).toBe(`<${t1.messageId}>`);
    expect(out.reply_to).toBe(TEAM_IN);
    expect(out.from).toMatch(/team@kinroot-port\.io/);
    row = await thread(t1.id);
    expect(row!.waitingSince).toBeNull();
    expect(row!.firstResponseAt).toBeTruthy();

    const com = await ok(own.post(`/site-api/crm/inbox/conversations/${t1.id}/comments`, {body: `@${B.name} can you take the customs question? @${C.name} fyi`}), 201);
    expect(com.comment.kind).toBe('comment');
    expect(mails).toHaveLength(1); // comments are never emailed
    expect(await notes(B.id, 'mentioned you')).toHaveLength(1);
    expect(await notes(C.id, 'mentioned you')).toHaveLength(1);
    const detail = await ok(conv(own, t1.id));
    expect(detail.comments.some((x: {kind: string}) => x.kind === 'comment')).toBe(true);
    expect(detail.comments.some((x: {kind: string; data: {type?: string}}) => x.kind === 'event' && x.data.type === 'assigned')).toBe(true);

    // The contact answers; Bea (assignee) hears about it.
    const m1b = mid('m1b');
    await inbound({from: 'una@stranger-port.io', to: [TEAM_IN], subject: 'Re: Question', text: 'Great, thanks!', messageId: m1b, inReplyTo: reply.messageId, references: [t1.messageId, reply.messageId]});
    expect(await threadOf(m1b)).toBe(t1.id);
    expect(await notes(B.id, 'replied')).toHaveLength(1);
    row = await thread(t1.id);
    expect(row!.unread).toBe(true);
    expect(row!.waitingSince).toBeTruthy();
  });

  it('creates the contact from the sender, associates a deal and creates a ticket from the sidebar', async () => {
    const t1 = await start('Una Known <una@stranger-port.io>', 'Question');
    await ok(own.post(`/site-api/crm/inbox/conversations/${t1.id}/reply`, {body: 'Yes'}), 201);
    await ok(own.post(`/site-api/crm/inbox/conversations/${t1.id}/comments`, {body: 'internal'}), 201);
    const r = await ok(own.post(`/site-api/crm/inbox/conversations/${t1.id}/contact`, {create: {firstName: 'Una', lastName: 'Known', email: 'una@stranger-port.io'}}));
    const una = r.conversation.contactId as string;
    expect(una).toBeTruthy();
    expect((await db.emailMessage.findMany({where: {threadId: t1.id}, select: {contactId: true}})).every(m => m.contactId === una)).toBe(true);
    const tl = (await db.activity.findMany({where: {contactId: una}, select: {type: true}})).map(x => x.type);
    expect(tl).toEqual(expect.arrayContaining(['email_in', 'email_out', 'conversation_comment']));
    expect((await own.post(`/site-api/crm/inbox/conversations/${t1.id}/contact`, {create: {firstName: 'Dup', email: 'una@stranger-port.io'}})).status).toBe(409);
    const pipeline = (await ok(own.get('/site-api/crm/pipelines'))).rows[0];
    const deal = (await ok(own.post('/site-api/crm/deals', {title: 'Inbox deal', pipelineId: pipeline.id, stageId: pipeline.stages[0].id, contactIds: [una]}), 201)).deal;
    const patched = await ok(own.request('PATCH', `/site-api/crm/inbox/conversations/${t1.id}`, {dealId: deal.id}));
    expect(patched.conversation.dealId).toBe(deal.id);
    let detail = await ok(conv(own, t1.id));
    expect(detail.sidebar.deals.some((d: {id: string}) => d.id === deal.id)).toBe(true);
    expect(detail.sidebar.deal?.id).toBe(deal.id);
    const ticket = (await ok(own.post(`/site-api/crm/inbox/conversations/${t1.id}/ticket`, {}), 201)).ticket;
    expect(ticket.contactId).toBe(una);
    detail = await ok(conv(own, t1.id));
    expect(detail.sidebar.tickets.some((x: {id: string}) => x.id === ticket.id)).toBe(true);
  });

  it('snoozes out of the open views and wakes up unread, once', async () => {
    const t1 = await start('una@stranger-port.io', 'Question');
    await ok(act(own, [t1.id], 'assign', {assigneeId: B.id}));
    expect((await act(B.c, [t1.id], 'snooze', {until: new Date(Date.now() + 3_600_000).toISOString()})).status).toBe(200);
    expect(await has(B.c, {view: 'mine'}, t1.id)).toBe(false);
    expect(await has(B.c, {view: 'snoozed'}, t1.id)).toBe(true);
    // An hour passes: the `inbox.wake` job (waiting in the backlog) is due, and so is the snooze.
    await db.emailThread.update({where: {id: t1.id}, data: {snoozedUntil: new Date(Date.now() - 60_000), unread: false}});
    await db.jobBacklog.updateMany({where: {list: 'crm-inbox-wake'}, data: {runAt: new Date(Date.now() - 60_000)}});
    await tick();
    const row = await thread(t1.id);
    expect(row!.snoozedUntil).toBeNull();
    expect(row!.unread).toBe(true);
    expect(await has(B.c, {view: 'mine'}, t1.id)).toBe(true);
    expect(await notes(B.id, 'Snoozed conversation is back')).toHaveLength(1);
    await tick();
    expect(await notes(B.id, 'Snoozed conversation is back')).toHaveLength(1);
  });

  it('closes and reopens on a reply (kept with the assignee) or by hand, evented and audited', async () => {
    const t1 = await start('una@stranger-port.io', 'Question');
    const una = (await ok(own.post(`/site-api/crm/inbox/conversations/${t1.id}/contact`, {create: {firstName: 'Una', email: 'una@stranger-port.io'}}))).conversation.contactId;
    await ok(act(own, [t1.id], 'assign', {assigneeId: B.id}));
    expect((await act(B.c, [t1.id], 'close')).status).toBe(200);
    let row = await thread(t1.id);
    expect(row!.status).toBe('CLOSED');
    expect(row!.closedAt).toBeTruthy();
    expect(await has(B.c, {view: 'closed'}, t1.id)).toBe(true);
    expect(await has(B.c, {view: 'open'}, t1.id)).toBe(false);
    expect(await events('conversation.closed', t1.id)).toHaveLength(1);
    expect(await audits('conversation.closed', t1.id)).toHaveLength(1);
    expect(await db.activity.count({where: {contactId: una, title: {contains: 'closed', mode: 'insensitive'}}})).toBe(0);

    await inbound({from: 'una@stranger-port.io', to: [TEAM_IN], subject: 'Re: Question', text: 'One more thing', messageId: mid('m1c'), inReplyTo: t1.messageId});
    row = await thread(t1.id);
    expect(row).toMatchObject({status: 'OPEN', closedAt: null, assigneeId: B.id});
    let ev = await events('conversation.reopened', t1.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.data).toMatchObject({reason: 'reply', contactId: una});
    expect((await act(B.c, [t1.id], 'close')).status).toBe(200);
    expect((await act(B.c, [t1.id], 'reopen')).status).toBe(200);
    ev = await events('conversation.reopened', t1.id);
    expect(ev).toHaveLength(2);
    expect(await audits('conversation.reopened', t1.id)).toHaveLength(1);
  });

  it('alternates round-robin assignments, and sends a reply to a closed one back through the queue when auto-assign is off', async () => {
    const t1 = await start('una@stranger-port.io', 'Question');
    await ok(act(own, [t1.id], 'assign', {assigneeId: B.id}));
    await saveSettings({assignment: 'round_robin', roundRobinIds: [A.id, C.id]});
    const rr: (string | null)[] = [];
    for (const n of [1, 2, 3]) rr.push((await thread((await start(`rr${n}@stranger-port.io`, `RR ${n}`)).id))!.assigneeId);
    expect(rr[0] && rr[1] && rr[0] !== rr[1]).toBeTruthy();
    expect(rr[2]).toBe(rr[0]);
    expect([A.id, C.id]).toContain(rr[0]);
    const rrEvents = (await db.event.findMany({where: {type: 'conversation.assigned'}, select: {data: true}})).filter(e => (e.data as {via?: string}).via === 'round_robin');
    expect(rrEvents.length).toBeGreaterThanOrEqual(3);

    await saveSettings({autoAssignReplies: false, roundRobinIds: [C.id]});
    await ok(act(B.c, [t1.id], 'close'));
    await inbound({from: 'una@stranger-port.io', to: [TEAM_IN], subject: 'Re: Question', text: 'Still there?', messageId: mid('m1d'), inReplyTo: t1.messageId});
    expect(await thread(t1.id)).toMatchObject({status: 'OPEN', assigneeId: C.id});
  });

  it('validates and audits inbox settings, admins only', async () => {
    expect((await saveSettings({assignment: 'round_robin', roundRobinIds: [A.id]})).assignment).toBe('round_robin');
    expect((await saveSettings({assignment: 'manual', roundRobinIds: [], autoAssignReplies: true})).assignment).toBe('manual');
    const cur = await saveSettings({});
    expect((await own.request('PUT', '/site-api/crm/inbox/settings', {...cur, assignment: 'round_robin', roundRobinIds: []})).status).toBe(400);
    expect((await A.c.request('PUT', '/site-api/crm/inbox/settings', cur)).status).toBe(403);
    expect(await db.auditLog.count({where: {action: 'settings.inbox'}})).toBeGreaterThan(0);
  });

  it('limits the team inbox to its members and, when asked, to their own and unassigned conversations', async () => {
    const t1 = await start('una@stranger-port.io', 'Question');
    const tH = await start(`Kim <${known.email}>`, 'Other');
    await ok(act(own, [t1.id], 'assign', {assigneeId: C.id}));
    await saveSettings({access: 'members', memberIds: [A.id, B.id]});
    expect((await counts(C.c)).teamAccess).toBe(false);
    expect((await conv(C.c, t1.id)).status).toBe(404);
    expect(await has(C.c, {view: 'open'}, t1.id)).toBe(false);
    expect((await act(own, [tH.id], 'assign', {assigneeId: C.id})).status).toBe(400);
    await saveSettings({access: 'everyone', memberIds: [], visibility: 'mine_and_unassigned'});
    expect((await conv(A.c, t1.id)).status).toBe(404);
    expect((await conv(C.c, t1.id)).status).toBe(200);
    expect((await conv(own, t1.id)).status).toBe(200);
  });

  it('marks spam, blocks the sender’s domain and sends their next mail straight to Spam, unassigned and silent', async () => {
    const tS = await start('promo@spammy-port.io', 'Buy now', 'cheap');
    expect((await act(own, [tS.id], 'spam', {block: 'domain'})).status).toBe(200);
    expect((await thread(tS.id))!.spamAt).toBeTruthy();
    expect((await saveSettings({})).blockedDomains).toContain('spammy-port.io');
    expect(((await audits('conversation.spam', tS.id))[0]!.meta as {blocked?: string}).blocked).toBe('spammy-port.io');
    expect(await has(own, {view: 'spam'}, tS.id)).toBe(true);
    expect(await has(own, {view: 'open'}, tS.id)).toBe(false);
    await saveSettings({assignment: 'round_robin', roundRobinIds: [A.id]});
    const notifBefore = await db.notification.count();
    const mS2 = mid('spam2');
    await inbound({from: 'other@spammy-port.io', to: [TEAM_IN], subject: 'Again', text: 'cheap', messageId: mS2});
    const tS2 = await threadOf(mS2);
    const row = await thread(tS2);
    expect(row!.spamAt).toBeTruthy();
    expect(row!.assigneeId).toBeNull();
    expect(await db.notification.count()).toBe(notifBefore);
    expect((await act(own, [tS2], 'not_spam')).status).toBe(200);
    expect((await thread(tS2))!.spamAt).toBeNull();
    expect(await audits('conversation.not_spam', tS2)).toHaveLength(1);
  });

  it('acts in bulk, filters and sorts', async () => {
    const ids: string[] = [];
    for (const n of [1, 2, 3]) ids.push((await start(`rr${n}@stranger-port.io`, `RR ${n}`)).id);
    const found = (await list(own, {view: 'open', q: 'RR '})).rows.map(x => x.id);
    expect(found.sort()).toEqual([...ids].sort());
    expect((await ok(act(own, ids, 'read'))).done).toBe(3);
    expect(await db.emailThread.count({where: {id: {in: ids}, unread: true}})).toBe(0);
    expect((await ok(act(own, ids, 'unread'))).done).toBe(3);
    expect((await list(own, {view: 'open', unread: '1', q: 'RR '})).rows).toHaveLength(3);
    expect((await ok(act(own, ids, 'assign', {assigneeId: A.id}))).done).toBe(3);
    expect((await list(own, {view: 'open', assigneeId: A.id, q: 'RR '})).rows).toHaveLength(3);
    for (const [i, id] of ids.entries()) await db.emailThread.update({where: {id}, data: {waitingSince: new Date(Date.now() - (i + 1) * 3_600_000)}});
    const waiting = (await list(own, {view: 'open', sort: 'waiting', q: 'RR '})).rows.map(x => x.id);
    expect(waiting).toEqual([...ids].reverse());
    const oldest = (await list(own, {view: 'open', sort: 'oldest'})).rows.map(x => x.lastMessageAt as string);
    expect(oldest.every((v, i) => i === 0 || v >= oldest[i - 1]!)).toBe(true);
    expect((await list(own, {view: 'open', channel: 'form'})).rows.every(x => x.channel === 'form')).toBe(true);
    expect((await ok(act(own, ids, 'close'))).done).toBe(3);
    expect((await list(own, {view: 'closed', status: 'CLOSED', q: 'RR '})).rows).toHaveLength(3);
    expect((await ok(act(own, ids, 'reopen'))).done).toBe(3);
  });

  /** Three team conversations; the second is deleted forever (with a comment) into the recycle bin. */
  async function binned() {
    const ids: string[] = [];
    for (const n of [1, 2, 3]) ids.push((await start(`rr${n}@stranger-port.io`, `RR ${n}`)).id);
    await ok(act(own, [ids[1]!], 'trash'));
    await ok(own.post(`/site-api/crm/inbox/conversations/${ids[1]}/comments`, {body: 'note before delete'}), 201);
    const del = await ok(act(own, [ids[1]!], 'delete'));
    return {ids, del};
  }

  it('trashes, restores from Trash, and deletes forever (admins, from Trash only) into the recycle bin', async () => {
    const ids: string[] = [];
    for (const n of [1, 2]) ids.push((await start(`rr${n}@stranger-port.io`, `RR ${n}`)).id);
    expect((await act(own, [ids[0]!], 'trash')).status).toBe(200);
    expect(await has(own, {view: 'trash'}, ids[0]!)).toBe(true);
    expect(await has(own, {view: 'open'}, ids[0]!)).toBe(false);
    expect(await audits('conversation.trashed', ids[0]!)).toHaveLength(1);
    expect((await act(own, [ids[0]!], 'restore')).status).toBe(200);
    expect((await thread(ids[0]!))!.trashedAt).toBeNull();
    expect((await ok(act(own, [ids[1]!], 'delete'))).errors).toHaveLength(1); // only from Trash
    await ok(act(own, [ids[1]!], 'trash'));
    await ok(own.post(`/site-api/crm/inbox/conversations/${ids[1]}/comments`, {body: 'note before delete'}), 201);
    expect((await ok(act(A.c, [ids[1]!], 'delete'))).errors).toHaveLength(1); // members cannot delete team conversations
    const del = await ok(act(own, [ids[1]!], 'delete'));
    expect(del.done).toBe(1);
    expect(del.binIds).toHaveLength(1);
    expect(await thread(ids[1]!)).toBeNull();
    expect(await audits('conversation.deleted', ids[1]!)).toHaveLength(1);
    const bin = await db.deletedRecord.findUniqueOrThrow({where: {id: del.binIds[0]}});
    expect(bin.entity).toBe('conversation');
    const binCounts = bin.counts as Record<string, number>;
    expect(binCounts.emailMessage).toBeGreaterThanOrEqual(1);
    expect(binCounts.conversationComment).toBeGreaterThanOrEqual(1);
  });

  it('deletes several trashed conversations at once: one bin entry and one audit row each, the rest refused in words', async () => {
    const ids: string[] = [];
    for (const n of [1, 2, 3, 4]) ids.push((await start(`many${n}@stranger-port.io`, `Many ${n}`)).id);
    await ok(act(own, ids.slice(0, 3), 'trash'));
    expect((await ok(act(A.c, ids.slice(0, 3), 'delete'))).errors, 'members cannot delete team conversations').toHaveLength(3);
    const del = await ok(act(own, ids, 'delete'));
    expect([del.done, del.errors.length, del.binIds.length]).toEqual([3, 1, 3]);
    for (const id of ids.slice(0, 3)) {
      expect(await thread(id)).toBeNull();
      expect(await audits('conversation.deleted', id)).toHaveLength(1);
    }
    expect(await thread(ids[3]!), 'not in Trash: kept').not.toBeNull();
    expect(await db.deletedRecord.count({where: {entity: 'conversation', recordId: {in: ids}}})).toBe(3);
  });

  it('restores a conversation from the recycle bin with its messages and comments', async () => {
    const {ids, del} = await binned();
    const restored = await ok(own.post(`/site-api/crm/recycle-bin/${del.binIds[0]}/restore`));
    expect(restored.restored.path).toBe(`/inbox?thread=${ids[1]}`);
    expect((await thread(ids[1]!))!.trashedAt).toBeNull();
    expect(await db.emailMessage.count({where: {threadId: ids[1]}})).toBeGreaterThanOrEqual(1);
    expect(await db.conversationComment.count({where: {threadId: ids[1], kind: 'comment'}})).toBe(1);
    // The comment keeps its author (a team member).
    expect((await db.conversationComment.findFirstOrThrow({where: {threadId: ids[1], kind: 'comment'}})).authorId).toBe(me.id);
  });

  it('purges trash older than 30 days into the recycle bin', async () => {
    const {ids} = await binned();
    await ok(act(own, [ids[2]!], 'trash'));
    await db.emailThread.update({where: {id: ids[2]}, data: {trashedAt: new Date(Date.now() - 31 * 86_400_000)}});
    await tick();
    expect(await thread(ids[2]!)).toBeNull();
    expect(await db.deletedRecord.count({where: {recordId: ids[2], entity: 'conversation'}})).toBe(1);
  });

  it('auto-closes conversations answered and quiet for N days, as System, and keeps the waiting ones open', async () => {
    const answered = await start('rr1@stranger-port.io', 'RR 1');
    const waiting = await start('una@stranger-port.io', 'Question');
    await saveSettings({autoCloseDays: 3});
    await ok(own.post(`/site-api/crm/inbox/conversations/${answered.id}/reply`, {body: 'Anything else?'}), 201);
    await db.emailThread.updateMany({where: {id: {in: [answered.id, waiting.id]}}, data: {lastMessageAt: new Date(Date.now() - 4 * 86_400_000)}});
    await tick();
    expect((await thread(answered.id))!.status).toBe('CLOSED');
    expect((await events('conversation.closed', answered.id)).some(e => (e.data as {reason?: string}).reason === 'auto' && !e.actorId)).toBe(true);
    expect((await thread(waiting.id))!.status).toBe('OPEN');
  });

  it('turns a form response into a form conversation that replies to the respondent and threads their answer', async () => {
    const form = (await ok(own.post('/site-api/crm/forms', {name: 'Contact us', templateId: 'contact'}), 201)).form;
    const fd = (await ok(own.get(`/site-api/crm/forms/${form.id}`))).form;
    await ok(own.request('PATCH', `/site-api/crm/forms/${form.id}`, {settings: {...fd.settings, inbox: {enabled: true, accountId: team.id}}}));
    await ok(own.post(`/site-api/crm/forms/${form.id}/status`, {status: 'PUBLISHED'}));
    type Field = {id: string; type: string; required?: boolean};
    const fields = fd.fields as Field[];
    const answers: Record<string, unknown> = {[fields.find(f => f.type === 'email')!.id]: 'fran@client-port.io'};
    const nameField = fields.find(f => f.type === 'name');
    if (nameField) answers[nameField.id] = {first: 'Fran', last: 'Form'};
    for (const f of fields) if (f.required && !(f.id in answers)) answers[f.id] = f.type === 'consent' ? true : 'Please call me back';
    const formCountBefore = (await counts(own)).channels.form;
    const submitted = await new Browser(app, '198.51.100.60').post(`/site-api/crm/public/forms/${fd.slug}/submit`, {answers, startedAt: Date.now() - 10_000});
    expect(submitted.status, JSON.stringify(submitted.json)).toBe(200);
    const sub = await db.formSubmission.findFirstOrThrow({where: {formId: form.id}});
    const ft = await db.emailThread.findFirstOrThrow({where: {formSubmissionId: sub.id}});
    expect(ft).toMatchObject({channel: 'form', accountId: team.id, status: 'OPEN'});
    expect(ft.contactId).toBeTruthy();
    expect((await counts(own)).channels.form).toBe(formCountBefore + 1);
    expect(await db.formSubmission.count({where: {formId: form.id}})).toBe(1);
    expect(((await events('conversation.created', ft.id))[0]!.data as {channel: string}).channel).toBe('form');
    const detail = await ok(conv(own, ft.id));
    expect(detail.replyTo).toBe('fran@client-port.io');
    expect(detail.messages[0].text).toMatch(/Please call me back|Fran/);
    const before = mails.length;
    const r = await ok(own.post(`/site-api/crm/inbox/conversations/${ft.id}/reply`, {body: 'Calling you tomorrow.'}), 201);
    expect(mailsTo('fran@client-port.io', before)).toHaveLength(1);
    const mF = mid('form');
    await inbound({from: 'fran@client-port.io', to: [TEAM_IN], subject: `Re: ${ft.subject}`, text: 'Great', messageId: mF, inReplyTo: r.message.messageId});
    expect(await threadOf(mF)).toBe(ft.id);
  });

  it('puts contactId and conversationId on conversation events and starts automations on conversation.created', async () => {
    const t1 = await start('una@stranger-port.io', 'Question');
    await ok(act(own, [t1.id], 'assign', {assigneeId: B.id}));
    await ok(act(own, [t1.id], 'close'));
    await ok(act(own, [t1.id], 'reopen'));
    for (const type of ['conversation.created', 'conversation.assigned', 'conversation.closed', 'conversation.reopened']) {
      const e = await db.event.findFirstOrThrow({where: {type}, orderBy: {createdAt: 'desc'}});
      expect('contactId' in (e.data as object) && 'conversationId' in (e.data as object), type).toBe(true);
    }
    const a = (await ok(own.post('/site-api/crm/automations', {name: 'Inbox auto', timezone: 'UTC', object: 'contact', trigger: {kind: 'event', event: 'conversation.created', filter: {}}, steps: [{id: 's1', type: 'add_tag', target: 'contact', tag: 'conv-auto'}]}), 201)).automation;
    await ok(own.post(`/site-api/crm/automations/${a.id}/enable`, {enabled: true}));
    const autoContact = (await ok(own.post('/site-api/crm/contacts', {firstName: 'Auto', lastName: 'Run', email: 'auto@client-port.io'}), 201)).contact;
    await inbound({from: autoContact.email, to: [TEAM_IN], subject: 'Automation', text: 'x', messageId: mid('auto')});
    const tags = await eventually(async () => (await db.contact.findUniqueOrThrow({where: {id: autoContact.id}})).tags as string[], (t) => t.includes('conv-auto'));
    expect(tags).toContain('conv-auto');
  });

  it('reports conversations by channel (team inbox only, no personal mail) and first response time', async () => {
    await start('una@stranger-port.io', 'Question');
    const answered = await start('rr1@stranger-port.io', 'RR 1');
    await ok(own.post(`/site-api/crm/inbox/conversations/${answered.id}/reply`, {body: 'Hi'}), 201);
    const mP = mid('p');
    await inbound({from: `Pat <${personalContact.email}>`, to: [ADA_IN], subject: 'Private note', text: 'x', messageId: mP});
    const tp = await threadOf(mP);

    const cat = (await ok(own.get('/site-api/crm/reports/catalogue'))).objects.find((o: {key: string}) => o.key === 'conversations');
    for (const k of ['channel', 'status', 'owner', 'createdAt', 'firstResponseHours', 'closedAt', 'closeHours']) expect(cat.fields.some((f: {key: string}) => f.key === k), k).toBe(true);
    const run = async (c: Browser, config: Record<string, unknown>) =>
      ok(c.get(`/site-api/crm/reports/run?tz=UTC&config=${encodeURIComponent(JSON.stringify({measure: {op: 'count'}, chart: 'table', filters: {conditions: []}, ...config}))}`));
    const rep = await run(own, {object: 'conversations', groupBy: {field: 'channel'}});
    const want = await db.$queryRaw<{channel: string; n: number}[]>`SELECT t.channel, count(*)::int n FROM "EmailThread" t LEFT JOIN "EmailAccount" a ON a.id = t."accountId"
      WHERE t."firstInboundAt" IS NOT NULL AND t."spamAt" IS NULL AND t."trashedAt" IS NULL AND (t.channel = 'form' OR (t.channel = 'email' AND (t."accountId" IS NULL OR a."userId" IS NULL))) GROUP BY 1`;
    const got = Object.fromEntries((rep.rows as {label: string; values: {value: number}}[]).map(x => [x.label, x.values.value]));
    expect(want.length).toBeGreaterThan(0);
    for (const w of want) expect(got[w.channel === 'form' ? 'Forms' : 'Email']).toBe(w.n);
    expect(await db.emailThread.count({where: {id: tp}})).toBe(1); // the personal one exists, and is left out above
    expect(got.Email).toBe(2);
    const fr = await run(own, {object: 'conversations', measure: {op: 'avg', field: 'firstResponseHours'}});
    expect(fr.total.value).toBeGreaterThanOrEqual(0);
    const memberRep = await run(B.c, {object: 'conversations', measure: {op: 'count'}});
    expect(memberRep.total.value).toBeLessThanOrEqual(rep.total.value);
  });

  it('keeps the counts in step with the lists', async () => {
    const t1 = await start('una@stranger-port.io', 'Question');
    const t2 = await start('rr1@stranger-port.io', 'RR 1');
    await start('rr2@stranger-port.io', 'RR 2');
    await ok(act(own, [t1.id], 'assign', {assigneeId: B.id}));
    await ok(act(own, [t2.id], 'trash'));
    const fresh = await counts(own);
    expect((await list(own, {view: 'open'})).total).toBe(fresh.views.open);
    expect((await list(own, {view: 'unassigned'})).total).toBe(fresh.views.unassigned);
    expect((await list(own, {view: 'trash'})).total).toBe(fresh.folders.trash);
  });
});
