import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {emailBrand} from '../../src/server/crm/email/design';
import {htmlToText} from '../../src/server/crm/email/render';
import {saveSettings} from '../../src/server/crm/lib/settings';
import {safeStyle, sanitizeEmailHtml} from '../../src/server/crm/inbox/sanitize';
import {env} from './support/cloudflare-workers';
import {owner, ownerAccountId, resetCrm, teammate, userId} from './support/crm';
import {Browser, configureEnv, DATABASE_URL, db} from './support/harness';
import {crmDb, outside} from './ported/support';
import {fakeResend, inbound, inJob, mailbox, restoreResend} from './ported/support-inbox';
import {inboxTick} from '../../src/server/crm/inbox/conversations';

/**
 * The inbox's safety and speed fixes (AUDIT P1-6, P1-7, P2-1, P2-4, P2-12, P2-19, P2-20, P2-22,
 * P3-22): received HTML cleaned in linear time and once, no overlays, replayed webhooks taken once,
 * read-only accounts can't connect mailboxes, email threads follow record and inbox visibility,
 * the badges agree with the inbox counts, and an open conversation's light `/updates`.
 */

const TEAM_IN = 'team-in@safety-port.io';
const OWN_IN = 'own-in@safety-port.io';
const ok = async <T = any>(p: Promise<{status: number; json: Record<string, unknown>}>, status = 200) => {
  const r = await p;
  expect(r.status, JSON.stringify(r.json)).toBe(status);
  return r.json as T;
};

let own: Browser;
let ownerId: string;
let A: {c: Browser; id: string};
let V: Browser;
let team: {id: string};
let seq = 0;
const mid = () => `safety-${++seq}@sender-port.io`;

async function seed() {
  own = await owner();
  await own.get('/site-api/crm/auth/state');
  await ok(own.post('/site-api/crm/auth/setup', {brandName: 'Kinroot', demoData: false}));
  ownerId = (await db.member.findUniqueOrThrow({where: {userId: await ownerAccountId()}, select: {id: true}})).id;
  const a = await teammate(own, 'ada@safety-port.io', 'MEMBER');
  A = {c: a.browser, id: (await db.member.findUniqueOrThrow({where: {userId: await userId('ada@safety-port.io')}, select: {id: true}})).id};
  V = (await teammate(own, 'vic@safety-port.io', 'VIEWER')).browser;
  team = await mailbox(own, {fromName: 'Support', fromEmail: 'team@safety-port.io', shared: true, replyTo: TEAM_IN});
  await saveInbox({teamAccounts: 'all', access: 'everyone', memberIds: [], visibility: 'all', assignment: 'manual', roundRobinIds: [], autoAssignReplies: false, autoCloseDays: null, blockedAddresses: [], blockedDomains: []});
}

async function saveInbox(patch: Record<string, unknown>) {
  const cur = (await ok(own.get('/site-api/crm/inbox/settings'))).settings;
  return (await ok(own.request('PUT', '/site-api/crm/inbox/settings', {...cur, ...patch}))).settings;
}
const visibility = (v: 'everyone' | 'owner') => ok(own.request('PATCH', '/site-api/crm/settings', {recordVisibility: v}));
const threadOf = async (messageId: string) => (await db.emailMessage.findFirstOrThrow({where: {messageId}, select: {threadId: true}})).threadId;
const inboundToken = async () => ((await ok(own.get('/site-api/crm/settings'))).settings as {inboundToken: string}).inboundToken;

describe('Received HTML (unit): linear time, no overlays', () => {
  it('cleans and reads a 240 KB unclosed-tag email in well under a second', () => {
    for (const html of ['<a '.repeat(80_000), '<a "'.repeat(60_000), '<!--'.repeat(60_000), '<style>'.repeat(34_000), `<p>${' '.repeat(240_000)}x</p>`]) {
      const t0 = performance.now();
      sanitizeEmailHtml(html);
      htmlToText(html);
      expect(performance.now() - t0).toBeLessThan(500);
    }
  });

  it('drops position fixed / sticky and CSS escapes, keeps ordinary styles', () => {
    expect(safeStyle('position:fixed;inset:0;z-index:99;color:red')).toBe('inset:0;z-index:99;color:red');
    expect(safeStyle('POSITION : Sticky !important; color:red')).toBe('color:red');
    expect(safeStyle('position:var(--p);--p:fixed')).toBe('--p:fixed');
    expect(safeStyle('position:/**/fixed')).toBe('');
    expect(safeStyle('background:\\75 rl(https://x.io/a.png)')).toBe('');
    expect(safeStyle('position: relative; color: red')).toBe('position: relative; color: red');
    const html = sanitizeEmailHtml('<div style="position:fixed;top:0;left:0;width:100vw;height:100vh">Sign in again</div>');
    expect(html).not.toMatch(/fixed/);
    expect(html).toContain('Sign in again');
  });

  it('never throws on an out-of-range character reference', () => {
    expect(htmlToText('<p>a &#99999999; b &#x110000; c</p>')).toBe('a &#99999999; b &#x110000; c');
  });
});

describe.skipIf(!DATABASE_URL)('Inbox safety and speed (integration, real Postgres)', () => {
  beforeAll(configureEnv);
  beforeAll(fakeResend);
  afterAll(async () => {
    restoreResend();
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetCrm();
    await seed();
  }, 60_000);
  afterEach(() => {
    delete env.RESEND_WEBHOOK_SECRET;
    delete env.MAILGUN_WEBHOOK_SIGNING_KEY;
    delete env.INCOMING_REPLAY_SECRET;
  });

  it('cleans received HTML once at arrival (capped), and older rows when read', async () => {
    const m1 = mid();
    const big = `<p style="position:fixed;inset:0">Hello</p><script>alert(1)</script>${'<a '.repeat(80_000)}`;
    const t0 = performance.now();
    await inbound(own, {from: 'Sam <sam@client-safety.io>', to: TEAM_IN, subject: 'Big one', html: big, text: 'Hello', messageId: m1});
    expect(performance.now() - t0).toBeLessThan(5_000);
    const stored = await db.emailMessage.findFirstOrThrow({where: {messageId: m1}, select: {html: true, threadId: true}});
    expect(stored.html!.startsWith('<!--kr-clean:')).toBe(true);
    expect(stored.html!.length).toBeLessThan(260_000);
    expect(stored.html).not.toMatch(/<script|position:\s*fixed/i);

    // A row stored before cleaning at arrival (no marker) is cleaned when read, and a forged marker doesn't help.
    await db.emailMessage.create({
      data: {threadId: stored.threadId, direction: 'INBOUND', status: 'RECEIVED', fromEmail: 'sam@client-safety.io', to: [TEAM_IN], subject: 'Old', html: '<!--kr-clean:forged--><p onclick="x()">Old</p><script>alert(2)</script>', sentAt: new Date(Date.now() + 1000)},
    });
    const detail = await ok(own.get(`/site-api/crm/inbox/conversations/${stored.threadId}`));
    const htmls = (detail.messages as {html: string | null}[]).map((m) => m.html ?? '');
    expect(htmls.every((h) => !/<script|onclick|kr-clean|position:\s*fixed/i.test(h))).toBe(true);
    expect(htmls.some((h) => h.includes('Old'))).toBe(true);
    expect(htmls.some((h) => h.includes('Hello'))).toBe(true);
  });

  it('takes a signed inbound email once (Svix id, Mailgun token)', async () => {
    const token = await inboundToken();
    const key = crypto.getRandomValues(new Uint8Array(24));
    env.RESEND_WEBHOOK_SECRET = `whsec_${btoa(String.fromCharCode(...key))}`;
    const body = JSON.stringify({from: 'Sam <sam@client-safety.io>', to: TEAM_IN, subject: 'Signed', text: 'Hi', messageId: mid()});
    const ts = String(Math.floor(Date.now() / 1000));
    const k = await crypto.subtle.importKey('raw', key, {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
    const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`msg_replay.${ts}.${body}`)))));
    const post = () => outside(`/site-api/crm/inbound/${token}`, {body, headers: {'content-type': 'application/json', 'svix-id': 'msg_replay', 'svix-timestamp': ts, 'svix-signature': `v1,${sig}`}});
    const first = await post();
    const again = await post();
    expect(first.status).toBe(200);
    expect(first.json.stored).toBe(true);
    expect(again.status).toBe(200);
    expect(again.json.duplicate).toBe(true);
    expect(await db.emailMessage.count({where: {subject: 'Signed'}})).toBe(1);

    env.MAILGUN_WEBHOOK_SIGNING_KEY = 'key-safety-signing';
    const mk = await crypto.subtle.importKey('raw', new TextEncoder().encode('key-safety-signing'), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
    const mgSig = [...new Uint8Array(await crypto.subtle.sign('HMAC', mk, new TextEncoder().encode(`${ts}tok-replay`)))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const form = new URLSearchParams({timestamp: ts, token: 'tok-replay', signature: mgSig, from: 'sam@client-safety.io', to: TEAM_IN, subject: 'Mailgun', 'body-plain': 'Hi'}).toString();
    const mg = () => outside(`/site-api/crm/inbound/${token}`, {body: form, headers: {'content-type': 'application/x-www-form-urlencoded'}});
    expect((await mg()).json.duplicate).toBeUndefined();
    expect((await mg()).json.duplicate).toBe(true);
  });

  it('incoming webhooks: an identical body is taken once, a timestamp must be fresh, a signed timestamp works', async () => {
    const SECRET = 'a-long-shared-secret-for-replays';
    env.INCOMING_REPLAY_SECRET = SECRET;
    const hook = (await ok(own.post('/site-api/crm/incoming-webhooks', {name: 'Replay', action: 'automations', secretName: 'INCOMING_REPLAY_SECRET'}), 201)).webhook as {id: string; url: string};
    const path = new URL(hook.url).pathname;
    const send = (body: string, headers: Record<string, string> = {}) => outside(path, {body, headers: {'content-type': 'application/json', 'x-webhook-secret': SECRET, ...headers}});
    const body = JSON.stringify({email: 'replay@northwind-safety.io'});
    const a = await send(body);
    const b = await send(body);
    expect(a.status).toBe(200);
    expect(a.json.duplicate).toBeUndefined();
    expect(b.status).toBe(200);
    expect(b.json.duplicate).toBe(true);
    // With an Idempotency-Key the sender decides what is a repeat.
    expect((await send(body, {'idempotency-key': 'k1'})).json.duplicate).toBeUndefined();
    // A timestamp, when sent, must be within 5 minutes; a new time makes the same body a new request.
    const stale = await send(body, {'x-webhook-timestamp': String(Math.floor(Date.now() / 1000) - 3600)});
    expect(stale.status).toBe(401);
    expect(String(stale.json.error)).toMatch(/X-Webhook-Timestamp/);
    const fresh = await send(body, {'x-webhook-timestamp': String(Math.floor(Date.now() / 1000))});
    expect(fresh.status).toBe(200);
    expect(fresh.json.duplicate).toBeUndefined();

    // HMAC over `<timestamp>.<body>`.
    await ok(own.request('PATCH', `/site-api/crm/incoming-webhooks/${hook.id}`, {verify: 'hmac', verifyHeader: 'X-Signature', verifyEncoding: 'hex', secretName: 'INCOMING_REPLAY_SECRET'}));
    const ts = String(Math.floor(Date.now() / 1000));
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
    const signed = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${body}`)))].map((x) => x.toString(16).padStart(2, '0')).join('');
    const h = (await outside(path, {body, headers: {'content-type': 'application/json', 'x-signature': signed, 'x-webhook-timestamp': ts}}));
    expect(h.status, JSON.stringify(h.json)).toBe(200);
  });

  it('a viewer cannot start connecting a Gmail / Outlook mailbox', async () => {
    const r = await V.get('/site-api/crm/email/oauth/google/start');
    expect(r.status).toBe(302);
    expect(decodeURIComponent(r.headers.get('location') ?? '')).toMatch(/Read-only accounts cannot connect a mailbox/);
  });

  it('email threads follow record visibility, the team-inbox setting and ticket scope', async () => {
    const contact = (await ok(own.post('/site-api/crm/contacts', {firstName: 'Kim', lastName: 'Owned', email: 'kim@client-safety.io'}), 201)).contact as {id: string};
    const deal = (await ok(own.post('/site-api/crm/deals', {title: 'Owned deal', value: 100}), 201)).deal as {id: string};
    const m1 = mid();
    await inbound(own, {from: 'Kim <kim@client-safety.io>', to: TEAM_IN, subject: 'About my order', text: 'Hi', messageId: m1});
    const teamThread = await threadOf(m1);
    // The owner's personal mailbox.
    await mailbox(own, {fromName: 'Owner', fromEmail: 'owner-box@safety-port.io', replyTo: OWN_IN});
    const m2 = mid();
    await inbound(own, {from: 'Kim <kim@client-safety.io>', to: OWN_IN, subject: 'Private', text: 'Just you', messageId: m2});
    const personal = await threadOf(m2);

    // Everyone sees everything: the member reads the team thread, never the owner's personal one.
    expect((await A.c.get(`/site-api/crm/email/threads?contactId=${contact.id}`)).status).toBe(200);
    expect((await A.c.get(`/site-api/crm/email/threads/${teamThread}`)).status).toBe(200);
    expect((await A.c.get(`/site-api/crm/email/threads/${personal}`)).status).toBe(404);
    expect((await A.c.post('/site-api/crm/email/send', {to: ['kim@client-safety.io'], subject: 'x', body: 'y', threadId: personal})).status).toBe(404);

    // Members see only their own: the owner's contact and deal are 404 for the member everywhere.
    await visibility('owner');
    expect((await A.c.get(`/site-api/crm/email/threads?contactId=${contact.id}`)).status).toBe(404);
    expect((await A.c.request('PATCH', `/site-api/crm/email/threads/${teamThread}`, {dealId: deal.id})).status).toBe(404);
    expect((await A.c.request('PATCH', `/site-api/crm/email/threads/${teamThread}`, {contactId: contact.id})).status).toBe(404);
    expect((await A.c.post('/site-api/crm/email/send', {to: ['kim@client-safety.io'], subject: 'x', body: 'y', contactId: contact.id})).status).toBe(404);
    const shown = await ok(A.c.get(`/site-api/crm/email/threads/${teamThread}`));
    expect((shown.thread as {contact: unknown}).contact).toBeNull();
    expect((await own.request('PATCH', `/site-api/crm/email/threads/${teamThread}`, {dealId: deal.id})).status).toBe(200);

    // Ticket threads follow their ticket: assigned to the owner, so not the member's.
    const ticketThread = await db.emailThread.create({data: {subject: 'Ticket mail', channel: 'ticket'}});
    await db.ticket.create({data: {subject: 'Owned ticket', emailThreadId: ticketThread.id, assigneeId: ownerId}});
    expect((await A.c.get(`/site-api/crm/inbox/conversations/${ticketThread.id}`)).status).toBe(404);
    expect((await A.c.get(`/site-api/crm/email/threads/${ticketThread.id}`)).status).toBe(404);
    expect((await own.get(`/site-api/crm/inbox/conversations/${ticketThread.id}`)).status).toBe(200);
    await visibility('everyone');
    expect((await A.c.get(`/site-api/crm/inbox/conversations/${ticketThread.id}`)).status).toBe(200);

    // Team inbox only for chosen members: the member loses the team thread.
    await saveInbox({access: 'members', memberIds: []});
    expect((await A.c.get(`/site-api/crm/email/threads/${teamThread}`)).status).toBe(404);
    expect((await A.c.get(`/site-api/crm/email/threads?contactId=${contact.id}`)).json.rows).toEqual([]);
  });

  it('badges: one capped call that agrees with the inbox counts', async () => {
    for (let i = 0; i < 3; i++) await inbound(own, {from: `Lead ${i} <lead${i}@client-safety.io>`, to: TEAM_IN, subject: `Question ${i}`, text: 'Hi', messageId: mid()});
    const assigned = await threadOf((await db.emailMessage.findFirstOrThrow({where: {subject: 'Question 0'}, select: {messageId: true}})).messageId!);
    await ok(own.post('/site-api/crm/inbox/conversations/actions', {ids: [assigned], action: 'assign', assigneeId: ownerId}));
    await db.emailThread.update({where: {id: assigned}, data: {unread: true}});
    await ok(own.post('/site-api/crm/tasks', {title: 'Overdue', dueAt: new Date(Date.now() - 86_400_000).toISOString(), assigneeId: ownerId}), 201);

    const shape = (b: Record<string, unknown>) => expect(Object.keys(b).sort()).toEqual(['inbox', 'latestNotificationId', 'notifications', 'reminders', 'tasks', 'tickets']);
    for (const c of [own, A.c]) {
      const b = await ok(c.get('/site-api/crm/badges'));
      shape(b);
      expect(b.inbox).toBe((await ok(c.get('/site-api/crm/inbox/counts'))).unread);
    }
    expect((await ok(own.get('/site-api/crm/badges'))).tasks).toBe(1);
    // A member without team-inbox access: the same rule.
    await saveInbox({access: 'members', memberIds: []});
    const b = await ok(A.c.get('/site-api/crm/badges'));
    expect(b.inbox).toBe((await ok(A.c.get('/site-api/crm/inbox/counts'))).unread);
    expect(b.inbox).toBe(0);
    // The agent "last seen" stamp the inbox counts kept.
    await db.member.update({where: {id: A.id}, data: {lastSeenAt: new Date(Date.now() - 3_600_000)}});
    await ok(A.c.get('/site-api/crm/badges'));
    expect(Date.now() - (await db.member.findUniqueOrThrow({where: {id: A.id}})).lastSeenAt!.getTime()).toBeLessThan(60_000);
  });

  it('an open conversation polls /updates: new chat messages, comments, state; load older emails', async () => {
    const cfg = (await ok(own.get('/site-api/crm/inbox/chat/settings'))).settings;
    await ok(own.request('PUT', '/site-api/crm/inbox/chat/settings', {...cfg, enabled: true, accountId: team.id, preChat: 'off', hours: {...cfg.hours, enabled: false}, allowedDomains: [], spamCheck: false}));
    const visitor = new Browser(app, '198.51.100.77');
    const meta = {page: 'https://acme-safety.io/pricing'};
    const started = await ok(visitor.post('/site-api/crm/public/chat/start', {text: 'Hello there', meta, startedAt: Date.now() - 5000}), 201);
    const session = started.session as {token: string; conversation: {id: string}};
    const id = session.conversation.id;

    const detail = await ok(own.get(`/site-api/crm/inbox/conversations/${id}`));
    expect(typeof detail.now).toBe('string');
    await new Promise((r) => setTimeout(r, 20));
    await ok(visitor.post('/site-api/crm/public/chat/messages', {token: session.token, conversationId: id, text: 'Are you there?', meta}), 201);
    await ok(A.c.post(`/site-api/crm/inbox/conversations/${id}/comments`, {body: 'I will take it'}), 201);

    const u = await ok(own.get(`/site-api/crm/inbox/conversations/${id}/updates?after=${encodeURIComponent(detail.now)}`));
    expect(Object.keys(u).sort()).toEqual(['chat', 'comments', 'now', 'state']);
    expect((u.chat.messages as {text: string}[]).some((m) => m.text === 'Are you there?')).toBe(true);
    expect((u.comments as {body: string}[]).some((c) => c.body === 'I will take it')).toBe(true);
    expect(u.state.assigneeId).toBeNull();
    // Looking at it marks the visitor's messages read.
    expect(await db.channelMessage.count({where: {threadId: id, direction: 'INBOUND', readAt: null}})).toBe(0);

    await ok(own.post('/site-api/crm/inbox/conversations/actions', {ids: [id], action: 'assign', assigneeId: ownerId}));
    const u2 = await ok(own.get(`/site-api/crm/inbox/conversations/${id}/updates?after=${encodeURIComponent(u.now)}`));
    expect(u2.state.assigneeId).toBe(ownerId);
    // Someone who can't read the conversation gets 404 here too.
    await saveInbox({access: 'members', memberIds: []});
    expect((await A.c.get(`/site-api/crm/inbox/conversations/${id}/updates?after=${encodeURIComponent(u.now)}`)).status).toBe(404);

    // A long email conversation: the newest 200 first, the rest with "load older".
    const m = mid();
    await inbound(own, {from: 'Long <long@client-safety.io>', to: TEAM_IN, subject: 'Long thread', text: 'first', messageId: m});
    const threadId = await threadOf(m);
    const base = Date.now() - 1_000_000;
    await db.emailMessage.createMany({data: Array.from({length: 205}, (_, i) => ({threadId, direction: 'INBOUND' as const, status: 'RECEIVED' as const, fromEmail: 'long@client-safety.io', to: [TEAM_IN], subject: 'Long thread', text: `n${i}`, sentAt: new Date(base + i * 1000)}))});
    const long = await ok(own.get(`/site-api/crm/inbox/conversations/${threadId}`));
    expect((long.messages as unknown[]).length).toBe(200);
    expect(long.olderMessages).toBe(true);
    const first = (long.messages as {id: string; sentAt: string}[])[0]!;
    const older = await ok(own.get(`/site-api/crm/inbox/conversations/${threadId}/messages?before=${encodeURIComponent(first.sentAt)}&beforeId=${first.id}`));
    expect((older.messages as unknown[]).length).toBe(6);
    expect(older.more).toBe(false);
  });

  it('emails use a logo from public storage as it is, a data-URL logo through the brand-logo route', async () => {
    const link = 'https://shop.example.test/__platform/files/file_0123456789abcdefghijklmnop/logo.png';
    await saveSettings(crmDb, {brandLogo: link});
    expect((await emailBrand(crmDb, 'https://shop.example.test')).logoSrc).toBe(link);
    await saveSettings(crmDb, {brandLogo: 'data:image/png;base64,iVBORw0KGgo='});
    expect((await emailBrand(crmDb, 'https://shop.example.test')).logoSrc).toMatch(/^https:\/\/shop\.example\.test\/site-api\/crm\/public\/brand-logo\?v=/);
    await saveSettings(crmDb, {brandLogo: 'https://elsewhere.example/logo.png'});
    expect((await emailBrand(crmDb, 'https://shop.example.test')).logoSrc).toBe('');
  });

  it('templates take HTML up to 500 KB (the request limit), not more', async () => {
    const html = `<p>${'Lorem ipsum dolor sit amet. '.repeat(11_000)}</p>`; // ~300 KB
    expect(html.length).toBeGreaterThan(200_000);
    const t = await own.post('/site-api/crm/email/templates', {name: 'Long one', subject: 'Hello', html, layout: 'plain'});
    expect(t.status, JSON.stringify(t.json).slice(0, 200)).toBe(201);
    expect((await own.post('/site-api/crm/email/templates', {name: 'Too long', subject: 'Hello', html: 'x'.repeat(500_001), layout: 'plain'})).status).toBeGreaterThanOrEqual(400);
  });

  it('the inbox tick stops at its deadline and wakes at most 25 conversations a pass', async () => {
    const past = new Date(Date.now() - 60_000);
    await db.emailThread.createMany({data: Array.from({length: 30}, (_, i) => ({subject: `Snoozed ${i}`, channel: 'email', firstInboundAt: past, snoozedUntil: past}))});
    expect(await inJob((d) => inboxTick(d, {until: Date.now() - 1}))).toEqual({woke: 0, closed: 0, purged: 0});
    expect((await inJob((d) => inboxTick(d, {until: Date.now() + 30_000}))).woke).toBe(25);
    expect(await db.emailThread.count({where: {snoozedUntil: {not: null}}})).toBe(5);
  });

  it('"Sync now" queues the mailbox sync instead of running it in the request', async () => {
    const gmail = await db.emailAccount.create({data: {provider: 'GMAIL', label: 'Gmail', fromName: 'Owner', fromEmail: 'owner@gmail-safety.io', userId: ownerId, credentials: 'v1.x.y', status: 'CONNECTED'}});
    const r = await ok(own.post(`/site-api/crm/email/accounts/${gmail.id}/sync`));
    expect(r).toEqual({stored: 0, queued: true});
  });
});
