import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../../src/server/app';
import {agentCameOnline} from '../../../src/server/crm/inbox/chat';
import {crmTick} from '../../../src/server/crm/lib/ticks';
import {env} from '../support/cloudflare-workers';
import {fakeStorage, owner, resetCrm, teammate, userId} from '../support/crm';
import {Browser, configureEnv, DATABASE_URL, db, ORIGIN} from '../support/harness';
import {fakeResend, inbound, inJob, mailbox, mails, mailsTo, restoreResend} from './support-inbox';

/**
 * Ported from Kinroot's scripts/test-chat.mjs
 * Website live chat: settings and the widget script, starting chats with and without the pre-chat
 * form, visitor token tampering, polling for agent replies (never comments), typing, office hours
 * and "away", emailing a reply to a visitor who left with a working continue link, transcripts,
 * contact matching with duplicate checks, allowed domains, rate limits, attachments, round robin,
 * events, scoring, an automation trigger, the one-per-conversation timeline entry, spam & block, the
 * recycle bin and the Conversations report.
 *
 * Changed by the migration: the widget is a button opening the /chat/ page (no iframe, PLAN.md
 * visible change 4); mail goes through a Resend team mailbox whose sends are captured; inbound mail
 * is signed; uploads go to platform storage in two calls (the signed visitor link redirects to the
 * storage link); later jobs wait in the job backlog and run on `crmTick`.
 */

const RUN = 'port';
const TEAM_IN = 'chat-in@kinroot-port.io';
const PAGE = `https://acme-port.io/pricing?utm_source=google&utm_campaign=spring-${RUN}`;
const ok = async <T = any>(p: Promise<{status: number; json: Record<string, unknown>}>, status = 200) => {
  const r = await p;
  expect(r.status, JSON.stringify(r.json)).toBe(status);
  return r.json as T;
};
const meta = (page = PAGE) => ({page, title: 'Pricing · Acme', referrer: 'https://search.example/?q=acme', timeZone: 'Europe/Berlin'});

let own: Browser;
let me: {id: string; name: string};
let team: {id: string};
let chatSettings: Record<string, any>;
let ipSeq = 0;

type Visitor = Browser;
const visitor = (): Visitor => new Browser(app, `198.51.100.${(++ipSeq % 250) + 1}`);
const pub = (v: Visitor, path: string, body: Record<string, unknown>) => v.post(`/site-api/crm/public/chat${path}`, body);
const startChat = (v: Visitor, body: Record<string, unknown>) => pub(v, '/start', {meta: meta(), startedAt: Date.now() - 5000, ...body});
const poll = (v: Visitor, token: string, conversationId: string, extra: Record<string, unknown> = {}) => pub(v, '/poll', {token, conversationId, meta: meta(), visible: true, ...extra});
type Session = {token: string; email: string | null; conversation: {id: string; status: string; messages: {id: string; from: string; text: string; at: string; seen: boolean; via: string | null; author: {name: string} | null; files: {id: string; image?: boolean; url: string}[]}[]}};
async function started(body: Record<string, unknown> = {}, v = visitor()) {
  const r = await ok(startChat(v, {text: 'Hi! Do you ship to Norway?', ...body}), 201);
  return {v, s: r.session as Session, id: (r.session as Session).conversation.id};
}

const thread = (id: string) => db.emailThread.findUnique({where: {id}});
const identity = (id: string) => db.channelIdentity.findUniqueOrThrow({where: {id}});
const events = (type: string, recordId: string) => db.event.findMany({where: {type, recordId}, orderBy: {createdAt: 'asc'}});
const notes = (memberId: string, contains: string) => db.notification.findMany({where: {userId: memberId, title: {contains, mode: 'insensitive'}}});
const chatActivity = (refId: string) => db.activity.findMany({where: {type: 'chat_conversation', refId}});
const detail = (c: Browser, id: string) => ok(c.get(`/site-api/crm/inbox/conversations/${id}`));
const list = async (c: Browser, query: Record<string, string>) => (await ok(c.get(`/site-api/crm/inbox/conversations?${new URLSearchParams({pageSize: '100', ...query})}`))).rows as any[];
const counts = (c: Browser) => ok(c.get('/site-api/crm/inbox/counts'));
const act = (c: Browser, ids: string[], action: string, extra: Record<string, unknown> = {}) => c.post('/site-api/crm/inbox/conversations/actions', {ids, action, ...extra});
const reply = (c: Browser, id: string, text: string, extra: Record<string, unknown> = {}) => ok(c.post(`/site-api/crm/inbox/conversations/${id}/chat`, {text, ...extra}), 201);
async function saveInbox(patch: Record<string, unknown>) {
  const cur = (await ok(own.get('/site-api/crm/inbox/settings'))).settings;
  return (await ok(own.request('PUT', '/site-api/crm/inbox/settings', {...cur, ...patch}))).settings;
}
async function saveChat(patch: Record<string, unknown>) {
  chatSettings = (await ok(own.request('PUT', '/site-api/crm/inbox/chat/settings', {...chatSettings, ...patch}))).settings;
  return chatSettings;
}
/**
 * Online = seen within the last 5 minutes; set straight in the database (a request of theirs would stamp it again).
 * "Anyone online" is kept a minute in the Site Cache (the app's own stamp clears it), so a direct write clears it too.
 */
const online = async (memberId: string, yes: boolean) => {
  await db.member.update({where: {id: memberId}, data: {lastSeenAt: yes ? new Date() : new Date(Date.now() - 3_600_000)}});
  await agentCameOnline();
};
const tick = () => inJob(d => crmTick(d));

/** The visitor's upload: ask, PUT the bytes to storage, confirm. */
async function upload(v: Visitor, token: string | null, name: string, contentType: string, bytes: Uint8Array) {
  const r = await v.post('/site-api/crm/public/chat/upload', {name, contentType, size: bytes.byteLength, token, page: PAGE});
  if (r.status !== 201) return {status: r.status, file: null};
  const {fileId, upload: grant, file} = r.json as {fileId: string; upload: {url: string; headers: Record<string, string>}; file: {id: string; token: string}};
  expect((await fetch(new URL(grant.url, ORIGIN), {method: 'PUT', headers: grant.headers, body: bytes as Uint8Array<ArrayBuffer>})).status).toBe(200);
  await ok(v.post(`/site-api/crm/public/chat/upload/${fileId}/complete`));
  return {status: 201, file};
}
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

async function seed() {
  own = await owner();
  await own.get('/site-api/crm/auth/state');
  await ok(own.post('/site-api/crm/auth/setup', {brandName: 'Kinroot', demoData: false}));
  me = await db.member.findUniqueOrThrow({where: {userId: await userId('owner@example.com')}, select: {id: true, name: true}});
  team = await mailbox(own, {fromName: 'Acme team', fromEmail: 'chat-team@kinroot-port.io', shared: true, replyTo: TEAM_IN});
  await saveInbox({teamAccounts: 'all', access: 'everyone', memberIds: [], visibility: 'all', assignment: 'manual', roundRobinIds: [], autoAssignReplies: true, autoCloseDays: null, blockedAddresses: [], blockedDomains: []});
  chatSettings = (await ok(own.get('/site-api/crm/inbox/chat/settings'))).settings;
  await saveChat({enabled: true, accountId: team.id, preChat: 'off', awayAfterMin: 5, hours: {...chatSettings.hours, enabled: false}, allowedDomains: [], spamCheck: false, greeting: `Hello from ${RUN}`, color: '#0f766e', avatarIds: [me.id]});
  await online(me.id, true);
}

describe.skipIf(!DATABASE_URL)('Ported: website live chat (integration, real Postgres)', () => {
  beforeAll(configureEnv);
  beforeAll(() => {
    fakeStorage();
    fakeResend();
  });
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

  it('serves the widget script and the config, refuses chats while off, audits and validates settings', async () => {
    const loaded = await ok(own.get('/site-api/crm/inbox/chat/settings'));
    expect(loaded.snippetUrl.endsWith('/site-api/crm/public/chat/widget.js')).toBe(true);
    await saveChat({enabled: false});
    const js = await own.request('GET', '/site-api/crm/public/chat/widget.js', undefined, {referer: PAGE});
    expect(js.headers.get('content-type')).toMatch(/javascript/);
    const jsText = String(js.json.text);
    // The button opens the /chat/ page (no iframe); the script carries the settings.
    expect(jsText).toContain("'/chat/?'");
    expect(jsText).toContain('CrmChat');
    expect(jsText).toContain('"enabled":false');
    const v = visitor();
    const off = await ok(pub(v, '/config', {meta: meta()}));
    expect(off.config.enabled).toBe(false);
    expect((await startChat(v, {text: 'hello?'})).status).toBe(404);

    const auditsBefore = await db.auditLog.count({where: {action: 'settings.chat'}});
    await saveChat({enabled: true});
    expect(await db.auditLog.count({where: {action: 'settings.chat'}})).toBe(auditsBefore + 1);
    expect((await own.request('PUT', '/site-api/crm/inbox/chat/settings', {...chatSettings, allowedDomains: ['not a domain']})).status).toBe(422);
    const cfg = (await ok(pub(v, '/config', {meta: meta()}))).config;
    expect(cfg).toMatchObject({enabled: true, allowed: true, away: false, greeting: `Hello from ${RUN}`, color: '#0f766e'});
    expect(cfg.avatars[0]?.name).toBe(me.name.split(' ')[0]);
  });

  it('starts a chat without the pre-chat form: an unassigned team conversation with the visitor’s page, UTM and events', async () => {
    const before = await counts(own);
    const {s, id} = await started({text: `Hi! Do you ship to Norway? ${RUN}`});
    expect(s.token).toBeTruthy();
    expect(s.conversation.messages).toHaveLength(1);
    const row = (await thread(id))!;
    expect(row).toMatchObject({channel: 'chat', status: 'OPEN', contactId: null, assigneeId: null, accountId: team.id});
    expect(row.firstInboundAt && row.waitingSince && row.identityId).toBeTruthy();
    const data = (await identity(row.identityId!)).data as Record<string, any>;
    expect(data).toMatchObject({page: PAGE, timeZone: 'Europe/Berlin', referrer: 'https://search.example/?q=acme'});
    expect(data.utm?.utm_source).toBe('google');
    const createdEv = await events('conversation.created', id);
    expect(createdEv).toHaveLength(1);
    expect((createdEv[0]!.data as {channel: string}).channel).toBe('chat');
    expect(await events('chat.started', id)).toHaveLength(1);
    const entry = await chatActivity(id);
    expect(entry).toHaveLength(1);
    expect(entry[0]!.contactId).toBeNull();
    expect((entry[0]!.data as {first: string}).first).toContain('Norway');
    const after = await counts(own);
    expect(after.channels.chat).toBe(before.channels.chat + 1);
    expect(after.views.unassigned).toBe(before.views.unassigned + 1);
    expect(after.chat.unread).toBeGreaterThanOrEqual(1);
    expect(after.chat.latest).toBeTruthy();
    const listed = (await list(own, {view: 'open', channel: 'chat'})).find(x => x.id === id);
    expect(listed.sender?.name).toMatch(/^Visitor [A-Z0-9]{4}$/);
    expect(listed.last?.text).toContain('Norway');
    expect(listed.online).toBe(true);
    expect((await list(own, {view: 'open', q: `Norway? ${RUN}`})).some(x => x.id === id)).toBe(true);
  });

  it('refuses tampered or someone else’s visitor tokens, and gives a returning visitor their conversation', async () => {
    const {v, s, id} = await started();
    const [vid] = s.token.split('.');
    expect((await ok(pub(v, '/session', {token: `${vid}.AAAAAAAAAAAAAAAAAAAAAA`, meta: meta()}))).session).toBeNull();
    expect((await poll(v, `${vid}.forged`, id)).status).toBe(401);
    expect((await pub(v, '/messages', {token: `x${s.token}`, conversationId: id, text: 'hi', meta: meta()})).status).toBe(401);
    expect((await ok(pub(v, '/session', {token: s.token, meta: meta()}))).session?.conversation?.id).toBe(id);
    const other = await started({text: 'Someone else'});
    expect((await poll(other.v, other.s.token, id)).status).toBe(404);
    expect((await pub(other.v, '/messages', {token: other.s.token, conversationId: id, text: 'sneaky', meta: meta()})).status).toBe(404);
  });

  it('shows the agent the visitor and their typing, the visitor the reply, "Seen" and typing, and never comments', async () => {
    const {v, s, id} = await started();
    const d = await detail(own, id);
    expect(d.chat?.messages).toHaveLength(1);
    expect(d.chat.visitor).toMatchObject({location: 'Berlin, Europe', page: PAGE, online: true});
    expect(d.canReply).toBe(true);
    expect((await db.channelMessage.findFirstOrThrow({where: {threadId: id, direction: 'INBOUND'}})).readAt).toBeTruthy();
    let r = await ok(poll(v, s.token, id, {after: null}));
    expect(r.conversation.seenUpTo).toBeTruthy();
    expect(r.conversation.messages.find((m: {from: string}) => m.from === 'visitor')?.seen).toBe(true);
    await ok(own.post(`/site-api/crm/inbox/conversations/${id}/typing`, {typing: true}));
    expect((await ok(poll(v, s.token, id))).conversation.teamTyping).toBe(true);
    await ok(pub(v, '/poll', {token: s.token, conversationId: id, typing: true, meta: meta()}));
    expect((await detail(own, id)).chat.typing).toBe(true);

    const secret = `INTERNAL-${RUN}`;
    await ok(own.post(`/site-api/crm/inbox/conversations/${id}/comments`, {body: `${secret} check the shipping table`}), 201);
    const lastAt = s.conversation.messages.at(-1)!.at;
    const sent = await reply(own, id, 'Yes we do, {{contact.first_name|friend}}! See https://acme-port.io/shipping.');
    expect(sent.message.direction).toBe('OUTBOUND');
    const row = (await thread(id))!;
    expect(row.waitingSince).toBeNull();
    expect(row.firstResponseAt).toBeTruthy();
    expect((await own.post(`/site-api/crm/inbox/conversations/${id}/reply`, {body: 'by email'})).status).toBe(400);
    r = await ok(poll(v, s.token, id, {after: lastAt}));
    const fresh = r.conversation.messages;
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({from: 'team', author: {name: me.name.split(' ')[0]}, text: 'Yes we do, friend! See https://acme-port.io/shipping.'});
    const all = (await ok(pub(v, '/session', {token: s.token, meta: meta()}))).session.conversation.messages;
    expect(JSON.stringify(all)).not.toContain(secret);
    expect(JSON.stringify(r)).not.toContain(secret);
    expect((await db.channelMessage.findFirstOrThrow({where: {threadId: id, direction: 'OUTBOUND'}})).status).toBe('READ');

    const again = await ok(pub(v, '/messages', {token: s.token, conversationId: id, text: 'Great, thanks', meta: meta('https://acme-port.io/checkout')}), 201);
    expect(again.conversation.messages.some((m: {text: string}) => m.text === 'Great, thanks')).toBe(true);
    const data = (await identity(row.identityId!)).data as {page: string; pages: unknown[]};
    expect(data.page).toBe('https://acme-port.io/checkout');
    expect(data.pages.length).toBeGreaterThanOrEqual(2);
    expect((await thread(id))!.waitingSince).toBeTruthy();
  });

  it('asks for an email when the pre-chat form is required, matches known contacts and creates new ones with a duplicate check', async () => {
    await saveChat({preChat: 'required'});
    expect((await ok(pub(visitor(), '/config', {meta: meta()}))).config.preChat).toBe('required');
    expect((await startChat(visitor(), {text: 'no email'})).status).toBe(400);
    const known = (await ok(own.post('/site-api/crm/contacts', {firstName: 'Kira', lastName: 'Known', email: 'kira@client-port.io'}), 201)).contact;
    const k = await started({text: 'Known visitor', name: 'Kira K', email: known.email.toUpperCase()});
    const row = (await thread(k.id))!;
    expect(row.contactId).toBe(known.id);
    expect((await identity(row.identityId!)).contactId).toBe(known.id);
    expect(((await events('chat.started', k.id))[0]!.data as {contactId: string}).contactId).toBe(known.id);
    expect((await chatActivity(k.id))[0]!.contactId).toBe(known.id);

    const twin = (await ok(own.post('/site-api/crm/contacts', {firstName: 'Nova', lastName: 'Twin', email: 'nova.twin@novacorp-port.io'}), 201)).contact;
    const n = await started({text: 'New person', name: 'Nova Twin', email: 'nova@novacorp-port.io'});
    const newContact = await db.contact.findUniqueOrThrow({where: {id: (await thread(n.id))!.contactId!}});
    expect(newContact).toMatchObject({source: 'Chat', email: 'nova@novacorp-port.io', firstName: 'Nova'});
    expect(await db.duplicatePair.count({where: {OR: [{aId: newContact.id, bId: twin.id}, {aId: twin.id, bId: newContact.id}]}})).toBe(1);
    await saveChat({preChat: 'optional'});
    expect((await startChat(visitor(), {text: 'Optional skip'})).status).toBe(201);
  });

  it('scores a contact and starts an automation on chat.started', async () => {
    const rule = (await ok(own.post('/site-api/crm/scoring/rules', {kind: 'behavior', name: 'Chat', points: 7, event: 'chat.started'}), 201)).rule;
    const auto = (await ok(own.post('/site-api/crm/automations', {name: 'Chat auto', timezone: 'UTC', object: 'contact', trigger: {kind: 'event', event: 'chat.started', filter: {}}, steps: [{id: 's1', type: 'add_tag', target: 'contact', tag: 'chat-auto'}]}), 201)).automation;
    await ok(own.post(`/site-api/crm/automations/${auto.id}/enable`, {enabled: true}));
    const scored = (await ok(own.post('/site-api/crm/contacts', {firstName: 'Sco', lastName: 'Red', email: 'sco@client-port.io'}), 201)).contact;
    await started({text: 'Score me', email: scored.email});
    let tagged = false;
    let points = 0;
    for (let i = 0; i < 20 && !(tagged && points); i++) {
      tagged = (await db.contact.findUniqueOrThrow({where: {id: scored.id}})).tags.includes('chat-auto');
      points = (await db.scoreEvent.aggregate({where: {contactId: scored.id, ruleId: rule.id}, _sum: {points: true}}))._sum.points ?? 0;
      if (!(tagged && points)) await new Promise(r => setTimeout(r, 50));
    }
    expect(tagged).toBe(true);
    expect(points).toBe(7);
  });

  it('is away when nobody is online or outside office hours, posts the away notice once, and takes the visitor’s email', async () => {
    await online(me.id, false);
    const v = visitor();
    const cfg = (await ok(pub(v, '/config', {meta: meta()}))).config;
    expect(cfg).toMatchObject({away: true, awayReason: 'nobody'});
    const r = await ok(startChat(v, {text: 'Anyone there?'}), 201);
    const s = r.session as Session;
    const sys = s.conversation.messages.find(m => m.from === 'system');
    expect(sys?.text).toContain(chatSettings.offlineMessage);
    expect(sys?.text).toMatch(/email/i);
    let row = (await thread(s.conversation.id))!;
    expect(row.waitingSince).toBeTruthy();
    expect(row.firstResponseAt).toBeNull();
    const next = await ok(pub(v, '/messages', {token: s.token, conversationId: s.conversation.id, text: 'hello?', meta: meta()}), 201);
    expect(next.conversation.messages.filter((m: {from: string}) => m.from === 'system')).toHaveLength(0);
    const idf = await ok(pub(v, '/identify', {token: s.token, email: 'away@visitor-port.io', name: 'Avery Away', meta: meta()}));
    expect(idf.session.email).toBe('away@visitor-port.io');
    row = (await thread(s.conversation.id))!;
    expect((await db.contact.findUniqueOrThrow({where: {id: row.contactId!}})).email).toBe('away@visitor-port.io');

    await online(me.id, true);
    const closedHours = {enabled: true, timezone: 'UTC', availability: {weekly: {}, overrides: []}};
    await saveChat({hours: closedHours});
    await online(me.id, true);
    expect((await ok(pub(v, '/config', {meta: meta()}))).config).toMatchObject({away: true, awayReason: 'hours'});
    const allWeek = Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map(k => [k, [{start: '00:00', end: '24:00'}]]));
    await saveChat({hours: {enabled: true, timezone: 'Pacific/Auckland', availability: {weekly: allWeek, overrides: []}}});
    await online(me.id, true);
    expect((await ok(pub(v, '/config', {meta: meta()}))).config.away).toBe(false);
  });

  it('emails an unread reply once the visitor has left, from the chat mailbox, with a working continue link', async () => {
    const v = visitor();
    const s = (await ok(startChat(v, {text: 'Anyone there?', email: 'away@visitor-port.io', name: 'Avery Away'}), 201)).session as Session;
    const id = s.conversation.id;
    // Visitor still on the site: the email job waits (in the backlog) until they have been gone a while.
    await reply(own, id, `Sorry for the wait ${RUN}, here is the answer.`);
    const job = await db.jobBacklog.findFirstOrThrow({where: {list: 'crm-chat-email-visitor'}});
    expect(job.runAt.getTime()).toBeGreaterThan(Date.now() + 60_000);
    await tick();
    expect(mailsTo('away@visitor-port.io')).toHaveLength(0);

    // They leave without reading it.
    await db.channelIdentity.update({where: {id: (await thread(id))!.identityId!}, data: {lastSeenAt: new Date(Date.now() - 30 * 60_000)}});
    await db.jobBacklog.update({where: {id: job.id}, data: {runAt: new Date(Date.now() - 1000)}});
    const secret2 = `SECRET2-${RUN}`;
    await ok(own.post(`/site-api/crm/inbox/conversations/${id}/comments`, {body: secret2}), 201);
    await tick();
    const gone = mailsTo('away@visitor-port.io');
    expect(gone).toHaveLength(1);
    const body = `${gone[0]!.text}\n${gone[0]!.html}`;
    expect(body).toContain(`Sorry for the wait ${RUN}`);
    expect(body).not.toContain(secret2);
    expect(gone[0]!.from).toMatch(/chat-team@kinroot-port\.io/);
    expect(gone[0]!.reply_to).toBe(TEAM_IN);
    const link = body.match(/https?:\/\/[^\s"<>]+\/chat\/c\/([A-Za-z0-9._-]+)/);
    expect(link, 'it links back to the conversation').toBeTruthy();
    const emailed = await db.channelMessage.findMany({where: {threadId: id, direction: 'OUTBOUND', kind: 'text'}, select: {emailMessageId: true}});
    expect(emailed.every(m => m.emailMessageId && m.emailMessageId !== 'sending')).toBe(true);
    await tick();
    expect(mailsTo('away@visitor-port.io')).toHaveLength(1);

    // The /chat/c/<token> page asks the Site API whether its link is good, then continues the chat.
    const browser = visitor();
    expect((await ok(browser.get(`/site-api/crm/public/chat/link/${link![1]}`))).valid).toBe(true);
    const cont = await ok(pub(browser, '/continue', {token: link![1]}));
    expect(cont.session.conversation.id).toBe(id);
    expect(cont.session.token).toBeTruthy();
    expect(cont.session.conversation.messages.some((m: {text: string}) => m.text.includes(`Sorry for the wait ${RUN}`))).toBe(true);
    expect((await poll(browser, cont.session.token, id)).status).toBe(200);
    const [tid, iid, exp] = link![1]!.split('.');
    expect((await pub(browser, '/continue', {token: `${tid}.${iid}.${Number(exp) + 1000}.forged`})).status).toBe(410);

    // The visitor answers the email: it lands in the chat, quote stripped, and in the inbox.
    const out = await db.emailMessage.findFirstOrThrow({where: {threadId: id, direction: 'OUTBOUND'}, orderBy: {sentAt: 'desc'}});
    await inbound(own, {from: 'Avery <away@visitor-port.io>', to: [TEAM_IN], subject: 'Re: New reply', text: `Thanks, got it by email ${RUN}\n\nOn Mon, someone wrote:\n> old`, messageId: 'reply-port@visitor-port.io', inReplyTo: out.messageId});
    const after = await ok(poll(browser, cont.session.token, id, {after: null}));
    const viaEmail = after.conversation.messages.find((m: {via: string | null}) => m.via === 'email');
    expect(viaEmail?.text).toBe(`Thanks, got it by email ${RUN}`);
    expect((await detail(own, id)).messages.some((m: {direction: string}) => m.direction === 'INBOUND')).toBe(true);
  });

  it('emails a transcript (never comments) to a visitor who gave an email, audited', async () => {
    const away = await started({text: 'Anyone there?', email: 'away@visitor-port.io'});
    await reply(own, away.id, `Sorry for the wait ${RUN}`);
    const secret2 = `SECRET2-${RUN}`;
    await ok(own.post(`/site-api/crm/inbox/conversations/${away.id}/comments`, {body: secret2}), 201);
    const before = mails.length;
    const r = await ok(own.post(`/site-api/crm/inbox/conversations/${away.id}/transcript`));
    expect(r.to).toBe('away@visitor-port.io');
    const tr = mailsTo('away@visitor-port.io', before)[0]!;
    const body = `${tr.text}\n${tr.html}`;
    expect(body).toContain('Anyone there?');
    expect(body).toContain(`Sorry for the wait ${RUN}`);
    expect(body).not.toContain(secret2);
    const anon = await started({text: 'no email'});
    expect((await own.post(`/site-api/crm/inbox/conversations/${anon.id}/transcript`)).status).toBe(400);
    expect(await db.auditLog.count({where: {action: 'conversation.transcript', recordId: away.id}})).toBe(1);
  });

  it('allows only the listed domains (and their subdomains), checks the embedding origin too, and always this site', async () => {
    await saveChat({allowedDomains: ['acme-port.io']});
    expect((await ok(pub(visitor(), '/config', {meta: meta('https://evil.example/')}))).config.allowed).toBe(false);
    expect((await startChat(visitor(), {text: 'from evil', meta: meta('https://evil.example/')})).status).toBe(403);
    expect((await startChat(visitor(), {text: 'from shop', meta: meta('https://shop.acme-port.io/x')})).status).toBe(201);
    expect((await startChat(visitor(), {text: 'from ancestor', meta: {...meta(), ancestor: 'https://evil.example'}})).status).toBe(403);
    // The site's own address (SITE_URL): its pages always work.
    expect((await startChat(visitor(), {text: 'from our own page', meta: meta(`${env.SITE_URL}/landing`)})).status).toBe(201);
  });

  it('limits new chats to 10 an hour per address and messages to 20 a minute per visitor', async () => {
    const v = visitor();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await startChat(v, {text: `rate ${i}`})).status);
    expect(statuses.slice(0, 10).every(s => s === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
    const {v: chatty, s} = await started({text: 'chatty'});
    const msgs: number[] = [];
    for (let i = 0; i < 21; i++) msgs.push((await pub(chatty, '/messages', {token: s.token, conversationId: s.conversation.id, text: `m${i}`, meta: meta()})).status);
    expect(msgs.slice(0, 20).every(x => x === 201)).toBe(true);
    expect(msgs[20]).toBe(429);
  });

  it('takes image attachments with signed visitor links, refuses SVG, HTML and big files, and lets agents attach files', async () => {
    const {v, s, id} = await started();
    const up = await upload(v, s.token, 'photo.png', 'image/png', PNG);
    expect(up.status).toBe(201);
    expect(up.file!.token).toBeTruthy();
    const tiny = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect((await v.post('/site-api/crm/public/chat/upload', {name: 'x.svg', contentType: 'image/svg+xml', size: tiny.byteLength, token: s.token, page: PAGE})).status).toBe(415);
    expect((await v.post('/site-api/crm/public/chat/upload', {name: 'x.html', contentType: 'text/html', size: 30, token: s.token, page: PAGE})).status).toBe(415);
    expect((await v.post('/site-api/crm/public/chat/upload', {name: 'big.pdf', contentType: 'application/pdf', size: 5 * 1024 * 1024 + 10, token: s.token, page: PAGE})).status).toBe(413);
    expect((await pub(v, '/messages', {token: s.token, conversationId: id, text: '', files: [{id: up.file!.id, token: 'forged-token'}], meta: meta()})).status).toBe(400);
    const r = await ok(pub(v, '/messages', {token: s.token, conversationId: id, text: 'Here is a photo', files: [{id: up.file!.id, token: up.file!.token}], meta: meta()}), 201);
    const withFile = (r.conversation.messages as Session['conversation']['messages']).find(m => m.files.length)!;
    expect(withFile.files[0]!.image).toBe(true);
    expect(withFile.files[0]!.url).toMatch(/\/site-api\/crm\/public\/files\/[^?]+\?exp=\d+&sig=/);
    // The signed link sends the visitor on to the storage link, which serves the image.
    const path = new URL(withFile.files[0]!.url).pathname + new URL(withFile.files[0]!.url).search;
    const served = await v.get(path);
    expect(served.status).toBe(302);
    const bytes = new Uint8Array(await (await fetch(new URL(served.headers.get('location')!, ORIGIN))).arrayBuffer());
    expect(bytes).toEqual(PNG);
    expect((await v.get(path.replace(/sig=[^&]+/, 'sig=forged'))).status).toBe(410);
    expect((await db.file.findUniqueOrThrow({where: {id: up.file!.id}})).purpose).toBe('chat');
    const d = await detail(own, id);
    expect(d.chat.messages.some((m: {files: {url: string}[]}) => m.files[0]?.url === `/site-api/crm/files/${up.file!.id}`)).toBe(true);

    const agent = await ok(own.post('/site-api/crm/inbox/chat/upload', {name: 'reply.png', contentType: 'image/png', size: PNG.byteLength}), 201);
    expect((await fetch(new URL(agent.upload.url, ORIGIN), {method: 'PUT', headers: agent.upload.headers, body: PNG as Uint8Array<ArrayBuffer>})).status).toBe(200);
    await ok(own.post(`/site-api/crm/inbox/chat/upload/${agent.fileId}/complete`));
    const sent = await reply(own, id, '', {fileIds: [agent.fileId]});
    expect(sent.message.fileIds).toContain(agent.fileId);
  });

  it('follows round robin for new chats, notifies the assignee, and is away when nobody in it is online', async () => {
    const {browser: robin} = await teammate(own, 'robin@kinroot-port.io', 'MEMBER');
    const robinId = (await db.member.findUniqueOrThrow({where: {userId: await userId('robin@kinroot-port.io')}})).id;
    await saveInbox({assignment: 'round_robin', roundRobinIds: [robinId]});
    const rr = await started({text: 'Round robin please'});
    expect((await thread(rr.id))!.assigneeId).toBe(robinId);
    expect((await notes(robinId, 'assigned you a conversation')).length).toBeGreaterThanOrEqual(1);
    await reply(robin, rr.id, 'On it');
    await ok(pub(rr.v, '/messages', {token: rr.s.token, conversationId: rr.id, text: 'One more question', meta: meta()}), 201);
    expect(await notes(robinId, 'wrote in chat')).toHaveLength(1);
    await online(robinId, false);
    await online(me.id, true);
    expect((await ok(pub(visitor(), '/config', {meta: meta()}))).config.away).toBe(true);
  });

  it('links a contact from the sidebar: the visitor, the messages and the one timeline entry follow', async () => {
    const {id} = await started();
    const linked = (await ok(own.post('/site-api/crm/contacts', {firstName: 'Lin', lastName: 'Ked', email: 'lin@client-port.io'}), 201)).contact;
    await ok(own.post(`/site-api/crm/inbox/conversations/${id}/contact`, {contactId: linked.id}));
    const row = (await thread(id))!;
    expect((await identity(row.identityId!)).contactId).toBe(linked.id);
    expect((await chatActivity(id))[0]!.contactId).toBe(linked.id);
    expect(await db.channelMessage.count({where: {threadId: id, contactId: null}})).toBe(0);
    const timeline = (await ok(own.get(`/site-api/crm/timeline?contactId=${linked.id}&group=messages`))).rows as {type: string}[];
    expect(timeline.filter(a => a.type === 'chat_conversation')).toHaveLength(1);
  });

  it('closes with a summary on the one timeline entry, and a visitor message reopens it', async () => {
    const {v, s, id} = await started();
    await reply(own, id, 'Yes');
    await ok(pub(v, '/messages', {token: s.token, conversationId: id, text: 'Great', meta: meta()}), 201);
    await ok(pub(v, '/messages', {token: s.token, conversationId: id, text: 'Thanks', meta: meta()}), 201);
    await ok(act(own, [id], 'close'));
    const entry = await chatActivity(id);
    expect(entry).toHaveLength(1);
    expect(entry[0]!.title.startsWith('Chat closed')).toBe(true);
    expect(entry[0]!.data).toMatchObject({status: 'CLOSED'});
    expect((entry[0]!.data as {fromContact: number}).fromContact).toBeGreaterThanOrEqual(3);
    expect((entry[0]!.data as {fromTeam: number}).fromTeam).toBeGreaterThanOrEqual(1);
    expect((await ok(poll(v, s.token, id))).conversation.status).toBe('CLOSED');
    await ok(pub(v, '/messages', {token: s.token, conversationId: id, text: 'One more thing', meta: meta()}), 201);
    expect((await thread(id))!.status).toBe('OPEN');
    expect(await events('conversation.reopened', id)).toHaveLength(1);
    expect(await chatActivity(id)).toHaveLength(1);
  });

  it('marks spam and blocks the visitor: their next chat goes straight to Spam and they get no session back', async () => {
    const {v, s, id} = await started({text: 'Buy cheap stuff'});
    expect((await act(own, [id], 'spam', {block: 'visitor'})).status).toBe(200);
    const row = (await thread(id))!;
    expect(row.spamAt).toBeTruthy();
    expect((await identity(row.identityId!)).blockedAt).toBeTruthy();
    const again = await ok(startChat(v, {token: s.token, text: 'again'}), 201);
    const id2 = again.session?.conversation?.id as string;
    expect((await thread(id2))!.spamAt).toBeTruthy();
    expect((await ok(pub(v, '/session', {token: s.token, meta: meta()}))).session).toBeNull();
    expect((await list(own, {view: 'open', channel: 'chat'})).some(x => x.id === id2)).toBe(false);
  });

  it('deletes a chat forever into the recycle bin with its messages, timeline entry and files', async () => {
    const known = await started({text: 'Known visitor', email: 'kira@client-port.io'});
    await ok(act(own, [known.id], 'trash'));
    const r = await ok(act(own, [known.id], 'delete'));
    expect(r.done).toBe(1);
    expect(r.binIds).toHaveLength(1);
    expect(await thread(known.id)).toBeNull();
    const bin = await db.deletedRecord.findUniqueOrThrow({where: {id: r.binIds[0]}});
    expect((bin.counts as Record<string, number>).channelMessage).toBeGreaterThanOrEqual(1);
    expect((bin.counts as Record<string, number>).activity).toBe(1);
    expect(bin.detail).toBe('Website chat');
    expect(await db.channelMessage.count({where: {threadId: known.id}})).toBe(0);

    const {v, s, id} = await started();
    const up = await upload(v, s.token, 'photo.png', 'image/png', PNG);
    const msg = await ok(pub(v, '/messages', {token: s.token, conversationId: id, text: 'Here is a photo', files: [{id: up.file!.id, token: up.file!.token}], meta: meta()}), 201);
    const url = new URL((msg.conversation.messages as Session['conversation']['messages']).find(m => m.files.length)!.files[0]!.url);
    await ok(act(own, [id], 'trash'));
    await ok(act(own, [id], 'delete'));
    expect((await db.file.findUniqueOrThrow({where: {id: up.file!.id}})).purpose).toBe('trash');
    expect((await v.get(url.pathname + url.search)).status).toBe(404);
  });

  it('restores a visitor-only chat from the recycle bin with its messages and timeline entry', async () => {
    const known = await started({text: 'Known visitor', email: 'kira@client-port.io'});
    await ok(act(own, [known.id], 'trash'));
    const r = await ok(act(own, [known.id], 'delete'));
    await ok(own.post(`/site-api/crm/recycle-bin/${r.binIds[0]}/restore`));
    expect(await thread(known.id)).toBeTruthy();
    expect(await db.channelMessage.count({where: {threadId: known.id}})).toBeGreaterThanOrEqual(1);
    expect(await chatActivity(known.id)).toHaveLength(1);
    // The "trashed" event line keeps its author (the agent).
    expect((await db.conversationComment.findFirstOrThrow({where: {threadId: known.id, kind: 'event'}})).authorId).toBe(me.id);
  });

  it('restores an answered chat with files: files back to the chat, the visitor can keep chatting', async () => {
    const {v, s, id} = await started();
    const up = await upload(v, s.token, 'photo.png', 'image/png', PNG);
    await ok(pub(v, '/messages', {token: s.token, conversationId: id, text: 'Here is a photo', files: [{id: up.file!.id, token: up.file!.token}], meta: meta()}), 201);
    await reply(own, id, 'Thanks');
    await ok(act(own, [id], 'trash'));
    const r = await ok(act(own, [id], 'delete'));
    await ok(own.post(`/site-api/crm/recycle-bin/${r.binIds[0]}/restore`));
    expect((await db.file.findUniqueOrThrow({where: {id: up.file!.id}})).purpose).toBe('chat');
    expect((await thread(id))!.identityId).toBeTruthy();
    expect((await poll(v, s.token, id)).status).toBe(200);
    // The agent's reply keeps its sender.
    expect((await db.channelMessage.findFirstOrThrow({where: {threadId: id, direction: 'OUTBOUND'}})).senderId).toBe(me.id);
  });

  it('counts chat as a channel in the Conversations report and computes first response time', async () => {
    const a = await started();
    await reply(own, a.id, 'Hi');
    await started({text: 'Second'});
    const spam = await started({text: 'Spam'});
    await ok(act(own, [spam.id], 'spam'));
    const run = async (config: Record<string, unknown>) =>
      ok(own.get(`/site-api/crm/reports/run?tz=UTC&config=${encodeURIComponent(JSON.stringify({measure: {op: 'count'}, chart: 'table', filters: {conditions: []}, ...config}))}`));
    const rep = await run({object: 'conversations', groupBy: {field: 'channel'}});
    const want = await db.emailThread.count({where: {channel: 'chat', firstInboundAt: {not: null}, spamAt: null, trashedAt: null}});
    expect(want).toBe(2);
    expect((rep.rows as {label: string; values: {value: number}}[]).find(x => x.label === 'Chat')?.values.value).toBe(want);
    const fr = await run({object: 'conversations', measure: {op: 'avg', field: 'firstResponseHours'}, filters: {conditions: [{field: 'channel', op: 'is', value: 'chat'}]}});
    expect(typeof fr.total.value).toBe('number');
    expect(fr.total.value).toBeGreaterThanOrEqual(0);
  });
});
