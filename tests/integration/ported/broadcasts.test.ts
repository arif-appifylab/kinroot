// Ported from Kinroot's scripts/integration/test-broadcasts.mjs
// Broadcasts end to end: audience exclusions, send now, tracking, scheduling and canceling, batches with the
// daily limit, pauses on delivery failures, permissions. Mail goes to a stubbed Resend API, not an SMTP sink.
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import '../../../src/server/background'; // broadcast.start / broadcast.batch run as jobs
import {app} from '../../../src/server/app';
import {drainBacklog} from '../../../src/server/crm/lib/jobs';
import {env} from '../support/cloudflare-workers';
import {resetCrm, teammate} from '../support/crm';
import {Browser, configureEnv, DATABASE_URL, db} from '../support/harness';
import {crm, meOf, must, stubFetch, tick, workspace, type Crm, type Me} from './support-lists';
import {eventually} from '../support/wait';

type Stats = {sent: number; failed: number; skipped: number; pending: number; canceled: number; opened: number; clicked: number; unsubscribed: number};
type Bc = {id: string; status: string; total: number; scheduledAt: string; waitingUntil: string | null; error: string | null; stats: Stats; excluded: {optedOut: number; noEmail: number; duplicates: number}};
type Account = {id: string; status: string; lastError: string | null};
type Sent = {from: string; to: string[]; subject: string; html: string; text?: string; at: number};

/** What the stubbed Resend API received (the old SMTP sink's mail file). */
const sent: Sent[] = [];
let failing = false;
const resend = stubFetch(
  (u) => u.hostname === 'api.resend.com',
  (url, init) => {
    if (url.pathname === '/domains') return new Response('{"data":[]}', {status: 200});
    const body = JSON.parse(String(init?.body)) as Omit<Sent, 'at'>;
    // The old sink rejected every recipient while its "fail" file existed; here the flaky account's sends fail.
    if (failing && body.from.includes('flaky')) return new Response('{"message":"mailbox unavailable"}', {status: 500});
    sent.push({...body, at: Date.now()});
    return new Response(JSON.stringify({id: `re_${sent.length}`}), {status: 200});
  },
);
const mailTo = (email: string, since: number) => sent.filter((m) => m.at >= since && m.to.includes(email.toLowerCase()));
const mailSince = (since: number) => sent.filter((m) => m.at >= since);
/** The email as a reader sees it: the HTML with its tracked links decoded, plus the plain-text part. */
const flat = (m: Sent) => `${m.html.replace(/&amp;/g, '&').replace(/%2F/gi, '/')}\n${m.text ?? ''}`;

const html = '<p>Hi {{contact.first_name|there}},</p><p>Read <a href="https://example.com/news">the news</a>.</p>';
const DAY = 86_400_000;
const TAG = 'bc';
const e = (n: string) => `${n}@kinroot-mail.io`; // not a reserved test domain: those are never sent to

let own: Crm;
let me: Me;
let mem: Crm;
let mu: Me;
let A: Account, B: Account, C: Account, Dacc: Account;
let S: {id: string};
let k1: {id: string; email: string | null}, k6: {id: string; email: string | null}, k7: {id: string; email: string | null};
let b1: Bc;
let many: {id: string}[];
let L: {id: string};
let t = Date.now() - 3_600_000;

async function contact(firstName: string, email: string | null, {optOut = false, ownerId = me.id, tags = [TAG]}: {optOut?: boolean; ownerId?: string; tags?: string[]} = {}) {
  const c = await db.contact.create({data: {firstName, email, emailOptOut: optOut, ownerId, tags, createdAt: new Date((t += 1000))}, select: {id: true, email: true}});
  return c;
}
const detail = async (id: string, c: Crm = own) => must<{broadcast: Bc; problems: {status: string; error: string | null}[]}>(await c.get(`/broadcasts/${id}`), 'detail');
/** Background work runs in-process; this only waits for what is still finishing. */
async function waitFor(id: string, status: string, c: Crm = own) {
  return eventually(async () => (await detail(id, c)).broadcast, (b) => b.status === status);
}
/** The broadcast jobs waiting in the backlog for later (the old runner's PENDING Job rows). */
const waiting = (list: string, id: string) => db.jobBacklog.findMany({where: {list, data: {path: ['broadcastId'], equals: id}}});
/** Makes the broadcast's waiting jobs due and runs the tick that sends them (the old `/jobs/run`). */
async function runDue(list: string, id: string) {
  await db.jobBacklog.updateMany({where: {list, data: {path: ['broadcastId'], equals: id}}, data: {runAt: new Date()}});
  await tick((d) => drainBacklog(d));
}

describe.skipIf(!DATABASE_URL)('ported: broadcasts (scripts/integration/test-broadcasts.mjs)', () => {
  beforeAll(async () => {
    configureEnv();
    env.RESEND_API_KEY = 're_test_ported_broadcasts';
    await resetCrm();
    ({c: own, me} = await workspace(false));
    mem = crm((await teammate(own.browser, 'broadcast-member@example.com', 'MEMBER')).browser);
    mu = await meOf(mem);

    // SMTP is gone: the accounts are Resend accounts (the key is the owner secret RESEND_API_KEY).
    const account = async (meta: Record<string, unknown>) => must<{account: Account}>(await own.post('/email/accounts', {credentials: {provider: 'RESEND'}, account: {fromName: 'Team', ...meta}}), 'account').account;
    A = await account({fromEmail: 'team@kinroot-mail.io', shared: true, dailyLimit: 1000, isDefault: true});
    B = await account({fromEmail: 'limited@kinroot-mail.io', shared: true, dailyLimit: 28});
    C = await account({fromEmail: 'owner@kinroot-mail.io', shared: false, dailyLimit: 1000});
    Dacc = await account({fromEmail: 'flaky@kinroot-mail.io', shared: true, dailyLimit: 1000});

    // A segment with every kind of exclusion.
    k1 = await contact('Ann', e('ann'));
    await contact('Ben', e('ben'));
    await contact('Cat', e('cat'), {optOut: true});
    await contact('Dan', null);
    await contact('Eve', e('ann').toUpperCase()); // duplicate of Ann
    k6 = await contact('Fay', e('fay'), {ownerId: mu.id});
    k7 = await contact('Gus', e('gus'));
    await contact('Hal', 'hal-at-example');
    await contact('Ben Two', e('ben'), {optOut: true, tags: []}); // outside the list, same address opted out
    S = must<{list: {id: string}}>(await own.post('/lists', {name: 'Newsletter', kind: 'DYNAMIC', rules: {match: 'all', groups: [{match: 'all', rules: [{field: 'tags', op: 'has_any', values: [TAG]}]}]}}), 'segment').list;
  });
  afterAll(async () => {
    resend.restore();
    delete env.RESEND_API_KEY;
    await db.$disconnect();
  });

  it('connects the accounts and counts the audience with its exclusions', async () => {
    expect(A.status, String(A.lastError)).toBe('CONNECTED');
    const aud = must<Record<string, unknown> & {account: {dailyLimit: number} | null}>(await own.get(`/broadcasts/audience?listId=${S.id}&accountId=${A.id}`), 'audience');
    expect({contacts: aud.contacts, noEmail: aud.noEmail, optedOut: aud.optedOut, duplicates: aud.duplicates, recipients: aud.recipients}, 'audience exclusions').toEqual({contacts: 8, noEmail: 2, optedOut: 2, duplicates: 1, recipients: 3});
    expect(aud.account?.dailyLimit, 'audience shows the daily limit').toBe(1000);
  });

  it('validates: empty email, a past schedule, a list nobody can be emailed in', async () => {
    expect((await own.post('/broadcasts', {listId: S.id, accountId: A.id, subject: 'x', html: '<p></p>'})).status, 'empty email rejected').toBe(400);
    const past = await own.post('/broadcasts', {listId: S.id, accountId: A.id, subject: 'x', html, scheduledAt: new Date(Date.now() - 3_600_000).toISOString()});
    expect(past.status, 'past schedule rejected').toBe(400);
    expect(past.json.fields, 'on the send time field (P2-32)').toEqual({scheduledAt: 'Pick a time in the future'});
    const empty = must<{list: {id: string}}>(await own.post('/lists', {name: 'Empty', kind: 'STATIC'}), 'empty list').list;
    const r = await own.post('/broadcasts', {listId: empty.id, accountId: A.id, subject: 'x', html});
    expect(r.status).toBe(400);
    expect(String(r.json.error), 'list without recipients rejected').toMatch(/Nobody/);
  });

  it('sends now: one email each, merge fields, unsubscribe and tracking links, timeline, inbox, events, notification', async () => {
    const since = Date.now();
    b1 = must<{broadcast: Bc}>(await own.post('/broadcasts', {listId: S.id, accountId: A.id, subject: 'News for {{contact.first_name}}', preheader: 'This month', html}), 'broadcast 1').broadcast;
    expect(b1.status, 'starts as scheduled').toBe('SCHEDULED');
    const d1 = await waitFor(b1.id, 'SENT');
    expect(d1.status).toBe('SENT');
    expect([d1.total, d1.stats.sent, d1.stats.failed], 'broadcast 1 counts').toEqual([3, 3, 0]);
    expect(d1.excluded, 'broadcast 1 exclusions frozen').toEqual({optedOut: 2, noEmail: 2, duplicates: 1});
    expect([mailTo(k1.email!, since).length, mailTo(k6.email!, since).length, mailTo(k7.email!, since).length], 'one email each to Ann, Fay, Gus').toEqual([1, 1, 1]);
    expect(mailTo(e('ben'), since).length + mailTo(e('cat'), since).length, 'no email to opted-out addresses').toBe(0);
    expect(mailSince(since), 'exactly three emails').toHaveLength(3);
    const annMail = mailTo(k1.email!, since)[0]!;
    expect(flat(annMail), 'unsubscribe link present').toMatch(/\/unsubscribe\/[A-Za-z0-9]/);
    expect(annMail.html, 'open pixel present').toMatch(/\/site-api\/crm\/t\/o\//);
    expect(annMail.html, 'tracked link present').toMatch(/\/site-api\/crm\/t\/c\//);
    expect(annMail.subject, 'merge fields filled per contact (subject)').toBe('News for Ann');
    expect(annMail.html, 'merge fields filled per contact (body)').toMatch(/Hi Ann/);

    // Timeline + inbox like a normal send.
    const recipients = await db.broadcastRecipient.findMany({where: {broadcastId: b1.id}, select: {messageId: true}});
    const msgs = await db.emailMessage.findMany({where: {id: {in: recipients.map((r) => r.messageId!)}}, select: {id: true, threadId: true}});
    expect(msgs.length === 3 && msgs.every((m) => m.threadId), 'each send is an EmailMessage in a thread').toBe(true);
    expect(await db.activity.count({where: {type: 'email_out', refId: {in: msgs.map((m) => m.id)}}}), 'timeline email_out entries').toBe(3);
    const tl = must<{rows: {type: string; email?: {subject: string}}[]}>(await own.get(`/timeline?contactId=${k1.id}&group=emails`), 'timeline');
    expect(tl.rows.some((a) => a.type === 'email_out' && a.email?.subject === 'News for Ann'), 'email on Ann’s timeline').toBe(true);
    const threads = must<{rows: {subject: string}[]}>(await own.get(`/email/threads?contactId=${k1.id}`), 'threads').rows;
    expect(threads.some((th) => th.subject === 'News for Ann'), 'thread in the inbox').toBe(true);
    const ev = await db.event.findMany({where: {type: 'broadcast.sent', recordId: b1.id}, select: {data: true}});
    expect(ev.map((x) => (x.data as {sent: number}).sent), 'broadcast.sent emitted once').toEqual([3]);
    expect(await db.event.count({where: {type: 'email.sent', recordId: {in: msgs.map((m) => m.id)}}}), 'email.sent per email').toBe(3);
    const notif = await db.notification.findMany({where: {userId: me.id, link: `/lists/${S.id}`}, select: {title: true}});
    expect(notif).toHaveLength(1);
    expect(notif[0]!.title, 'creator notified when done').toMatch(/sent to 3 contacts/);
  });

  it('tracks opens, clicks and unsubscribes (unique)', async () => {
    const recipients = await db.broadcastRecipient.findMany({where: {broadcastId: b1.id}, select: {contactId: true, messageId: true}});
    const msgs = await db.emailMessage.findMany({where: {id: {in: recipients.map((r) => r.messageId!)}}, select: {id: true, trackingId: true, contactId: true, html: true}});
    // Opens in the first 5 seconds are ignored (scanners); the script slept, here the sends are moved back.
    await db.emailMessage.updateMany({where: {id: {in: msgs.map((m) => m.id)}}, data: {sentAt: new Date(Date.now() - 10_000)}});
    const visitor = new Browser(app, '198.51.100.31');
    const ann = msgs.find((m) => m.contactId === k1.id)!;
    const fay = msgs.find((m) => m.contactId === k6.id)!;
    await visitor.get(`/site-api/crm/t/o/${ann.trackingId}.gif`);
    await visitor.get(`/site-api/crm/t/o/${ann.trackingId}.gif`);
    const click = new URL(fay.html!.match(/href="([^"]*\/site-api\/crm\/t\/c\/[^"]*)"/)![1]!.replace(/&amp;/g, '&'));
    const cr = await visitor.get(click.pathname + click.search);
    expect([301, 302], 'click redirects').toContain(cr.status);
    const gusMail = mailTo(k7.email!, 0)[0]!;
    const token = flat(gusMail).match(/\/unsubscribe\/([A-Za-z0-9_.-]+)/)![1]!;
    must(await visitor.post(`/site-api/crm/public/unsubscribe/${token}`, {optOut: true}), 'unsubscribe');
    const d1 = (await detail(b1.id)).broadcast;
    expect([d1.stats.opened, d1.stats.clicked, d1.stats.unsubscribed], 'opened / clicked / unsubscribed (unique)').toEqual([1, 1, 1]);
    const hist = must<{rows: (Bc & {html?: string})[]}>(await own.get(`/broadcasts?listId=${S.id}`), 'history').rows;
    expect(hist.map((b) => b.id), 'per-list history').toEqual([b1.id]);
    expect(hist[0]!.stats.opened).toBe(1);
    expect('html' in hist[0]!, 'history rows carry no html').toBe(false);
    expect(must<{rows: Bc[]}>(await own.get('/broadcasts'), 'overview').rows.some((b) => b.id === b1.id), 'overview history').toBe(true);
  });

  it('schedules for later, and a broadcast canceled before it starts never sends', async () => {
    const later = new Date(Date.now() + 3_600_000).toISOString();
    const b2 = must<{broadcast: Bc}>(await own.post('/broadcasts', {listId: S.id, accountId: A.id, subject: 'Canceled one', html, scheduledAt: later}), 'b2').broadcast;
    expect(b2.status).toBe('SCHEDULED');
    expect(Math.abs(Date.parse(b2.scheduledAt) - Date.parse(later)), 'scheduled for later').toBeLessThan(1000);
    const jobs = await waiting('crm-broadcast-start', b2.id);
    expect(jobs, 'start job waits for the scheduled time').toHaveLength(1);
    expect(Math.abs(jobs[0]!.runAt.getTime() - Date.parse(later))).toBeLessThan(1000);
    must(await own.post(`/broadcasts/${b2.id}/cancel`, {}), 'cancel');
    const since = Date.now();
    await runDue('crm-broadcast-start', b2.id);
    const d2 = (await detail(b2.id)).broadcast;
    expect([d2.status, d2.stats.sent, d2.total], 'canceled broadcast never starts').toEqual(['CANCELED', 0, 0]);
    expect(mailSince(since), 'nothing sent after cancel').toHaveLength(0);
    expect((await own.post(`/broadcasts/${b2.id}/cancel`, {})).status, 'cannot cancel twice').toBe(400);
  });

  it('a scheduled broadcast resolves its recipients when it starts', async () => {
    const later = new Date(Date.now() + 3_600_000).toISOString();
    const b3 = must<{broadcast: Bc}>(await own.post('/broadcasts', {listId: S.id, accountId: A.id, subject: 'Scheduled one', html, scheduledAt: later}), 'b3').broadcast;
    await db.contact.update({where: {id: k1.id}, data: {emailOptOut: true}}); // Ann opts out before it starts
    const since = Date.now();
    await runDue('crm-broadcast-start', b3.id);
    const d3 = await waitFor(b3.id, 'SENT');
    expect([d3.status, d3.total, d3.stats.sent, mailTo(k6.email!, since).length], 'scheduled broadcast: only Fay left (Ann and Gus opted out)').toEqual(['SENT', 1, 1, 1]);
    expect([d3.excluded.optedOut, d3.excluded.duplicates], 'exclusions recounted at start (Eve shares Ann’s opted-out address)').toEqual([5, 0]);
    await db.contact.update({where: {id: k1.id}, data: {emailOptOut: false}});
  });

  it('sends in batches and spills over the daily limit to the next day', async () => {
    many = [];
    for (let i = 0; i < 32; i++) many.push(await contact(`Bulk${i}`, e(`bulk${i}`), {tags: ['bc2']}));
    L = must<{list: {id: string}}>(await own.post('/lists', {name: 'Bulk', kind: 'STATIC', contactIds: many.map((m) => m.id)}), 'static list').list;
    const since = Date.now();
    const b4 = must<{broadcast: Bc}>(await own.post('/broadcasts', {listId: L.id, accountId: B.id, subject: 'Bulk', html}), 'b4').broadcast;
    let d4 = (await detail(b4.id)).broadcast;
    expect([d4.status, d4.stats.sent, d4.stats.pending], 'stops at the daily limit').toEqual(['SENDING', 28, 4]);
    const first = await db.emailMessage.findFirstOrThrow({where: {accountId: B.id}, orderBy: {sentAt: 'asc'}, select: {sentAt: true}});
    const wait = Date.parse(d4.waitingUntil!) - first.sentAt.getTime();
    expect(wait, 'continues about 24 h after the first send').toBeGreaterThan(DAY);
    expect(wait).toBeLessThan(DAY + 5 * 60_000);
    // Batches of 25, then 3, then full: the next batch waits (the old runner kept it as a PENDING Job row).
    const next = await waiting('crm-broadcast-batch', b4.id);
    expect(next, 'one batch waits for the next day').toHaveLength(1);
    expect(Math.abs(next[0]!.runAt.getTime() - Date.parse(d4.waitingUntil!)), 'next batch queued for the next day').toBeLessThan(1000);
    expect(mailSince(since), 'the API got 28').toHaveLength(28);
    // A day passes.
    await db.emailMessage.updateMany({where: {accountId: B.id}, data: {sentAt: new Date(Date.now() - 25 * 3_600_000)}});
    await runDue('crm-broadcast-batch', b4.id);
    d4 = await waitFor(b4.id, 'SENT');
    expect([d4.status, d4.stats.sent, d4.waitingUntil], 'rest sent the next day').toEqual(['SENT', 32, null]);
    expect(mailSince(since), 'the API got 32').toHaveLength(32);
  });

  it('pauses after five delivery failures in a row, then resumes and finishes', async () => {
    const six = [];
    for (let i = 0; i < 6; i++) six.push(await contact(`Flaky${i}`, e(`flaky${i}`), {tags: ['bc3']}));
    const L3 = must<{list: {id: string}}>(await own.post('/lists', {name: 'Flaky', kind: 'STATIC', contactIds: six.map((m) => m.id)}), 'flaky list').list;
    failing = true;
    let d5: Bc;
    let problems: {status: string; error: string | null}[];
    try {
      const b5 = must<{broadcast: Bc}>(await own.post('/broadcasts', {listId: L3.id, accountId: Dacc.id, subject: 'Flaky', html}), 'b5').broadcast;
      ({broadcast: d5, problems} = await detail(b5.id));
      expect([d5.status, d5.stats.failed, d5.stats.pending], 'paused after 5 failures').toEqual(['SENDING', 5, 1]);
      expect(d5.error ?? '').toMatch(/Paused/);
      expect(problems.length === 5 && problems.every((p) => p.status === 'FAILED' && p.error), 'failed addresses listed with the reason').toBe(true);
    } finally {
      failing = false;
    }
    await runDue('crm-broadcast-batch', d5.id);
    d5 = await waitFor(d5.id, 'SENT');
    expect([d5.status, d5.stats.sent, d5.stats.failed, d5.error], 'resumes and finishes').toEqual(['SENT', 1, 5, null]);
  });

  it('a broadcast canceled while it waits sends nothing more', async () => {
    must(await own.patch(`/email/accounts/${B.id}`, {dailyLimit: 4}), 'lower limit');
    const b6 = must<{broadcast: Bc}>(await own.post('/broadcasts', {listId: L.id, accountId: B.id, subject: 'Bulk again', html}), 'b6').broadcast; // B is full again: waits
    let d6 = (await detail(b6.id)).broadcast;
    expect([d6.status, d6.stats.sent, d6.stats.pending], 'waits for the limit straight away').toEqual(['SENDING', 0, 32]);
    must(await own.post(`/broadcasts/${b6.id}/cancel`, {}), 'cancel sending');
    await db.emailMessage.updateMany({where: {accountId: B.id}, data: {sentAt: new Date(Date.now() - 25 * 3_600_000)}});
    await runDue('crm-broadcast-batch', b6.id);
    d6 = (await detail(b6.id)).broadcast;
    expect([d6.status, d6.stats.sent, d6.stats.canceled], 'canceled while sending: nothing more goes out').toEqual(['CANCELED', 0, 32]);
    expect(await db.event.count({where: {type: 'broadcast.sent', recordId: b6.id}}), 'no broadcast.sent for a canceled one').toBe(0);
  });

  it('permissions: owner-only visibility, personal accounts, viewers', async () => {
    must(await own.patch('/settings', {recordVisibility: 'owner'}), 'visibility owner');
    try {
      const aud = must<{contacts: number; recipients: number}>(await mem.get(`/broadcasts/audience?listId=${S.id}`), 'member audience');
      expect([aud.contacts, aud.recipients], 'member audience: only their contacts').toEqual([1, 1]);
      expect((await mem.post('/broadcasts', {listId: S.id, accountId: C.id, subject: 'x', html})).status, 'member cannot use the owner’s personal account').toBe(400);
      const since = Date.now();
      const b7 = must<{broadcast: Bc}>(await mem.post('/broadcasts', {listId: S.id, accountId: A.id, subject: 'From member', html}), 'member broadcast').broadcast;
      const d7 = await waitFor(b7.id, 'SENT', mem);
      expect([d7.stats.sent, mailTo(k6.email!, since).length, mailSince(since).length], 'member reaches only contacts they can see').toEqual([1, 1, 1]);
      expect(must<{rows: Bc[]}>(await mem.get('/broadcasts'), 'member list').rows.map((b) => b.id), 'member sees only their broadcasts (owner visibility)').toEqual([b7.id]);
      expect((await mem.get(`/broadcasts/${b1.id}`)).status, 'member cannot open others’ broadcast').toBe(404);
      expect((await mem.post(`/broadcasts/${b1.id}/cancel`, {})).status, 'member cannot cancel others’ broadcast').toBe(404);
    } finally {
      must(await own.patch('/settings', {recordVisibility: 'everyone'}), 'visibility back');
    }
    const later = new Date(Date.now() + 3_600_000).toISOString();
    const b8 = must<{broadcast: Bc}>(await own.post('/broadcasts', {listId: S.id, accountId: A.id, subject: 'Owner later', html, scheduledAt: later}), 'b8').broadcast;
    expect(must<{rows: Bc[]}>(await mem.get('/broadcasts'), 'member list 2').rows.some((b) => b.id === b8.id), 'member sees team broadcasts (visibility everyone)').toBe(true);
    expect((await mem.post(`/broadcasts/${b8.id}/cancel`, {})).status, 'member cannot cancel someone else’s broadcast').toBe(403);
    const viewer = crm((await teammate(own.browser, 'broadcast-viewer@example.com', 'VIEWER')).browser);
    expect((await viewer.post('/broadcasts', {listId: S.id, accountId: A.id, subject: 'x', html})).status, 'viewer cannot send').toBe(403);
    expect((await viewer.get('/broadcasts')).status, 'viewer can read the history').toBe(200);
    must(await own.post(`/broadcasts/${b8.id}/cancel`, {}), 'owner cancels own');
  });

  it('timeline: list membership changes show under History, not Emails', async () => {
    const hx = must<{rows: {type: string}[]}>(await own.get(`/timeline?contactId=${many[0]!.id}&group=changes`), 'history group').rows;
    expect(hx.some((a) => a.type === 'list_added'), 'list_added under History').toBe(true);
    must(await own.post(`/lists/${L.id}/members/remove`, {contactIds: [many[0]!.id]}), 'remove');
    const hx2 = must<{rows: {type: string}[]}>(await own.get(`/timeline?contactId=${many[0]!.id}&group=changes`), 'history group 2').rows;
    expect(hx2.some((a) => a.type === 'list_removed'), 'list_removed under History').toBe(true);
    const emails = must<{rows: {type: string}[]}>(await own.get(`/timeline?contactId=${many[0]!.id}&group=emails`), 'emails group').rows;
    expect(emails.some((a) => a.type.startsWith('list_')), 'not under Emails').toBe(false);
  });
});
