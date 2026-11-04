import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import type {EmailAccount} from '../../../generated/prisma/client';
import {GALLERY} from '@/lib/email-gallery';
import {toEmailHtml} from '@/lib/email-html';
import {CRM_APP, publicOrigin} from '../kit/config';
import {decryptJson, encryptJson, sign, verifySignature} from '../kit/crypto';
import {currentUser, isAdmin, requireRole, type AppContext, type AppEnv, type User} from '../kit/guards';
import {audit} from '../lib/audit';
import {fieldError, intParam, intValue, notFound, valid} from '../lib/http';
import {getSettings} from '../lib/settings';
import {userSelect} from '../lib/users';
import {emailBrand, getEmailDesign, saveEmailDesign} from '../email/design';
import {accountCredentials, authorizeUrl, exchangeCode, oauthClient, type OAuthKind} from '../email/oauth';
import {logMailboxError, mailboxErrorText, MailboxSetupError} from '../email/errors';
import {PROVIDER_INFO, secretsPresent, verifyCredentials, type Credentials} from '../email/providers';
import {htmlToText} from '../email/render';
import {receiveInbound} from '../email/replies';
import {sendEmail, usableAccounts} from '../email/service';
import {fromGallery, templateBody} from '../email/templates';
import {queueAccountSync} from '../email/sync';
import {receivedHtmlReader} from '../inbox/sanitize';
import {findReadable, inboxScope, withVisibleTickets} from '../inbox/scope';

const email = z.email().transform((v) => v.toLowerCase());

// API accounts: only what is not secret is typed in (the key is the owner's secret, providers.ts
// `API_KEY_SECRETS`). OAuth mailboxes go through /oauth/*. Custom SMTP is not available.
const credentialsInput = z.discriminatedUnion('provider', [
  z.object({provider: z.literal('RESEND')}),
  z.object({provider: z.literal('POSTMARK'), messageStream: z.string().trim().max(100).optional()}),
  z.object({provider: z.literal('SENDGRID')}),
  z.object({provider: z.literal('MAILGUN'), domain: z.string().trim().min(3).max(253).regex(/^[a-z0-9.-]+$/i, 'a domain name like mg.example.com'), region: z.enum(['us', 'eu']).default('us')}),
]);

const accountMeta = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  fromName: z.string().trim().min(1).max(120),
  fromEmail: email,
  shared: z.boolean().default(false),
  isDefault: z.boolean().optional(),
  trackOpens: z.boolean().optional(),
  trackClicks: z.boolean().optional(),
  dailyLimit: intValue(1, 10000).optional(),
  signature: z.string().max(2000).nullish(),
  signatureHtml: z.string().max(50_000).nullish(),
  replyTo: z.union([email, z.literal('')]).nullish().transform((v) => v || null),
  forwardReplies: z.boolean().optional(),
});

/**
 * How replies to this account reach the CRM: Gmail / Outlook sync their
 * mailbox; SMTP and API accounts need a Reply-To inbound address that posts to
 * the inbound webhook (/site-api/crm/inbound/:token).
 */
const replyCapture = (a: Pick<EmailAccount, 'provider' | 'replyTo'>) =>
  a.provider === 'GMAIL' || a.provider === 'OUTLOOK' ? 'sync' : a.replyTo ? 'webhook' : 'none';

/** Never send credentials to the browser. */
function safeAccount({credentials: _c, syncCursor: _s, ...a}: EmailAccount) {
  return {...a, info: PROVIDER_INFO[a.provider], replyCapture: replyCapture(a)};
}

// Templates: `html` from the editor; `body` (plain text) is derived from it, or typed for text-only templates.
const templateFields = z.object({
  name: z.string().trim().min(1).max(100),
  subject: z.string().trim().min(1).max(500),
  preheader: z.string().trim().max(300).nullish(),
  body: z.string().max(50_000).optional(),
  html: z.string().max(500_000).nullish(), // the app's 512 KB request limit (a template with inline images)
  layout: z.enum(['branded', 'plain']),
  category: z.string().trim().max(60).nullish(),
  shared: z.boolean(),
});
// Defaults only when creating; a PATCH must not reset fields it doesn't mention.
const templateInput = templateFields.extend({layout: templateFields.shape.layout.default('plain'), shared: z.boolean().default(true)});

function templateData<T extends {html?: string | null; body?: string}>(t: T) {
  return t.html ? {...t, body: templateBody(t.html)} : t;
}

/** One's own account (admins: also shared team accounts), the owner in the query: anyone else's is a 404. */
async function ownAccount(c: AppContext, id: string) {
  const me = currentUser(c);
  const account = await c.var.db.emailAccount.findFirst({where: {id, OR: [{userId: me.id}, ...(isAdmin(me) ? [{userId: null}] : [])]}});
  if (!account) throw notFound('Email account');
  return account;
}

/** Templates this person may see (shared ones and their own; admins any), in the query. */
const visibleTemplate = (me: User, id: string) => (isAdmin(me) ? {id} : {id, OR: [{shared: true}, {ownerId: me.id}]});

async function setDefault(c: AppContext, account: EmailAccount) {
  await c.var.db.emailAccount.updateMany({where: {userId: account.userId, id: {not: account.id}}, data: {isDefault: false}});
}

export const emailRoutes = new Hono<AppEnv>()
  // ─── Accounts ───
  /** Which provider keys and OAuth client secrets the owner has added (names and booleans only). */
  .get('/secrets', (c) => c.json({secrets: secretsPresent()}))

  .get('/accounts', async (c) => {
    const rows = await usableAccounts(c.var.db, currentUser(c));
    return c.json({rows: rows.map(safeAccount)});
  })

  .post('/accounts', valid('json', z.object({credentials: credentialsInput, account: accountMeta})), async (c) => {
    const me = currentUser(c);
    const {credentials, account: meta} = c.req.valid('json');
    if (meta.shared && !isAdmin(me)) throw new HTTPException(403, {message: 'Only admins can add shared team accounts'});
    const {provider, ...creds} = credentials;

    let status: 'CONNECTED' | 'ERROR' = 'CONNECTED';
    let lastError: string | null = null;
    try {
      await verifyCredentials(provider, creds as Credentials);
    } catch (e) {
      logMailboxError(`verify ${provider}`, e);
      status = 'ERROR';
      lastError = mailboxErrorText(e);
    }
    const userId = meta.shared ? null : me.id;
    const hasDefault = await c.var.db.emailAccount.count({where: {userId, isDefault: true}});
    const account = await c.var.db.emailAccount.create({
      data: {
        provider,
        label: meta.label ?? `${PROVIDER_INFO[provider].label} · ${meta.fromEmail}`,
        fromName: meta.fromName,
        fromEmail: meta.fromEmail,
        credentials: await encryptJson(creds),
        userId,
        isDefault: meta.isDefault ?? hasDefault === 0,
        trackOpens: meta.trackOpens,
        trackClicks: meta.trackClicks,
        dailyLimit: meta.dailyLimit,
        signature: meta.signature,
        signatureHtml: meta.signatureHtml,
        replyTo: meta.replyTo,
        forwardReplies: meta.forwardReplies,
        status,
        lastError,
      },
    });
    if (account.isDefault) await setDefault(c, account);
    await audit(c.var.db, c, {action: 'email_account.connected', entity: 'email_account', recordId: account.id, label: account.fromEmail, meta: {provider, shared: !userId}});
    return c.json({account: safeAccount(account)}, 201);
  })

  .patch('/accounts/:id', valid('json', accountMeta.partial().omit({shared: true}).extend({credentials: credentialsInput.optional()})), async (c) => {
    const existing = await ownAccount(c, c.req.param('id'));
    const {credentials, ...meta} = c.req.valid('json');
    const data: Record<string, unknown> = {...meta};
    if (credentials) {
      if (credentials.provider !== existing.provider) throw new HTTPException(400, {message: 'Provider cannot change; add a new account instead'});
      const {provider: _p, ...creds} = credentials;
      data.credentials = await encryptJson(creds);
      data.status = 'PENDING';
      data.lastError = null;
    }
    const account = await c.var.db.emailAccount.update({where: {id: existing.id}, data});
    if (meta.isDefault) await setDefault(c, account);
    await audit(c.var.db, c, {action: 'email_account.updated', entity: 'email_account', recordId: account.id, label: account.fromEmail, meta: {changed: Object.keys(c.req.valid('json')), credentialsChanged: !!credentials}});
    return c.json({account: safeAccount(account)});
  })

  .delete('/accounts/:id', async (c) => {
    const existing = await ownAccount(c, c.req.param('id'));
    await c.var.db.emailAccount.delete({where: {id: existing.id}});
    await audit(c.var.db, c, {action: 'email_account.removed', entity: 'email_account', recordId: existing.id, label: existing.fromEmail, meta: {provider: existing.provider, shared: !existing.userId}});
    return c.json({ok: true});
  })

  // Verifies the connection; with `to`, also sends a real test email.
  .post('/accounts/:id/test', valid('json', z.object({to: email.optional()})), async (c) => {
    const me = currentUser(c);
    const account = await ownAccount(c, c.req.param('id'));
    const {to} = c.req.valid('json');
    try {
      const detail = await verifyCredentials(account.provider, await accountCredentials(c.var.db, account));
      await c.var.db.emailAccount.update({where: {id: account.id}, data: {status: 'CONNECTED', lastError: null}});
      if (to) {
        await sendEmail(c.var.db, me, publicOrigin(c.req.raw), {
          accountId: account.id,
          to: [to],
          subject: `Test email from ${(await getSettings(c.var.db)).brandName}`,
          body: `This is a test from ${account.label}.\n\nIf you can read this, sending works. 🎉`,
        });
        return c.json({ok: true, detail: `${detail}. Test email sent to ${to}.`});
      }
      return c.json({ok: true, detail});
    } catch (e) {
      if (e instanceof HTTPException) throw e;
      logMailboxError(`test ${account.provider}`, e);
      const message = mailboxErrorText(e);
      await c.var.db.emailAccount.update({where: {id: account.id}, data: {status: 'ERROR', lastError: message}});
      return c.json({ok: false, detail: message});
    }
  })

  /**
   * "Send a test reply": answers this account's latest email to a contact and
   * stores it through the same path as the inbound webhook (no forwarding),
   * so replies can be tried before the webhook URL is public HTTPS.
   */
  .post('/accounts/:id/test-reply', async (c) => {
    const db = c.var.db;
    const account = await ownAccount(c, c.req.param('id'));
    if (account.provider === 'GMAIL' || account.provider === 'OUTLOOK') throw new HTTPException(400, {message: 'Gmail and Outlook replies come in through mailbox sync'});
    const last = await db.emailMessage.findFirst({
      where: {accountId: account.id, direction: 'OUTBOUND', status: 'SENT', messageId: {not: null}, contact: {email: {not: null}}},
      orderBy: {sentAt: 'desc'},
      include: {contact: {select: {email: true, firstName: true, lastName: true}}},
    });
    if (!last?.contact?.email) throw new HTTPException(400, {message: `Send an email from ${account.fromEmail} to a contact first; the test reply answers the latest one.`});
    const name = [last.contact.firstName, last.contact.lastName].filter(Boolean).join(' ');
    const message = await receiveInbound(
      db,
      {
        from: {email: last.contact.email, name},
        to: [{email: account.replyTo ?? account.fromEmail, name: null}],
        cc: [],
        subject: `Re: ${last.subject}`,
        text: `Test reply from Settings → Email: this went through the same path as a real reply.\n\n> ${(last.text ?? '').split('\n')[0]?.slice(0, 200) ?? ''}`,
        html: null,
        messageId: `test-reply-${Date.now().toString(36)}@crm.test`,
        inReplyTo: last.messageId,
        references: [last.messageId!],
      },
      {origin: publicOrigin(c.req.raw), account, forward: false},
    );
    if (!message) throw new HTTPException(500, {message: 'The test reply was not stored'});
    return c.json({ok: true, contact: name || last.contact.email, subject: message.subject, threadId: message.threadId});
  })

  // "Sync now": the mailbox's own sync job, queued (a busy mailbox can take longer than a request may).
  // New mail shows up in the inbox as the job stores it.
  .post('/accounts/:id/sync', async (c) => {
    const account = await ownAccount(c, c.req.param('id'));
    if (account.provider !== 'GMAIL' && account.provider !== 'OUTLOOK') return c.json({stored: 0, skipped: true});
    await queueAccountSync(c.var.db, account.id);
    return c.json({stored: 0, queued: true});
  })

  // ─── Option 3: OAuth mailboxes ───
  .get('/oauth/:kind/start', valid('query', z.object({shared: z.string().optional()})), async (c) => {
    const me = currentUser(c);
    const kind = c.req.param('kind') as OAuthKind;
    if (kind !== 'google' && kind !== 'microsoft') throw notFound('Provider');
    // Read-only accounts don't connect mailboxes (as calendar.ts refuses calendars).
    if (me.role === 'VIEWER') return c.redirect(`${CRM_APP}/settings/email?error=` + encodeURIComponent('Read-only accounts cannot connect a mailbox'));
    const client = await oauthClient(c.var.db, kind);
    if (!client) return c.redirect(`${CRM_APP}/settings/email?error=` + encodeURIComponent(`Add your ${kind === 'google' ? 'Google' : 'Microsoft'} OAuth client ID and secret first`));
    const shared = c.req.valid('query').shared === '1' && isAdmin(me);
    const payload = `${kind}.${me.id}.${shared ? 1 : 0}.${Date.now() + 10 * 60_000}`;
    const state = `${payload}.${await sign(payload)}`;
    const redirectUri = `${publicOrigin(c.req.raw)}/site-api/crm/email/oauth/${kind}/callback`;
    return c.redirect(authorizeUrl(kind, client, redirectUri, state));
  })

  .get('/oauth/:kind/callback', async (c) => {
    const me = currentUser(c);
    const kind = c.req.param('kind') as OAuthKind;
    const back = (msg: string, ok = false) => c.redirect(`${CRM_APP}/settings/email?${ok ? 'connected' : 'error'}=${encodeURIComponent(msg)}`);
    // The provider's own text stays out of the page (and the address bar): words instead.
    if (c.req.query('error')) return back(c.req.query('error') === 'access_denied' ? 'The mailbox was not connected: access was not allowed.' : 'The email provider did not connect the mailbox. Please try again.');

    const [k, userId, shared, exp, sig] = (c.req.query('state') ?? '').split('.');
    const payload = `${k}.${userId}.${shared}.${exp}`;
    if (k !== kind || userId !== me.id || Number(exp) < Date.now() || !(await verifySignature(payload, sig ?? ''))) {
      return back('The sign-in link expired. Please try again.');
    }
    if (me.role === 'VIEWER') return back('Read-only accounts cannot connect a mailbox'); // demoted since the start
    if (shared === '1' && !isAdmin(me)) return back('Only admins can add shared team accounts');
    const client = await oauthClient(c.var.db, kind);
    if (!client) return back('OAuth app is not configured');

    try {
      const redirectUri = `${publicOrigin(c.req.raw)}/site-api/crm/email/oauth/${kind}/callback`;
      const {creds, email: address, name} = await exchangeCode(kind, client, c.req.query('code') ?? '', redirectUri);
      const provider = kind === 'google' ? 'GMAIL' : 'OUTLOOK';
      const owner = shared === '1' ? null : me.id;
      const existing = await c.var.db.emailAccount.findFirst({where: {provider, fromEmail: address, userId: owner}});
      const data = {credentials: await encryptJson(creds), status: 'CONNECTED' as const, lastError: null};
      if (existing) {
        await c.var.db.emailAccount.update({where: {id: existing.id}, data});
      } else {
        const hasDefault = await c.var.db.emailAccount.count({where: {userId: owner, isDefault: true}});
        await c.var.db.emailAccount.create({
          data: {
            ...data,
            provider,
            label: `${PROVIDER_INFO[provider].label} · ${address}`,
            fromName: name,
            fromEmail: address,
            userId: owner,
            isDefault: hasDefault === 0,
          },
        });
      }
      await audit(c.var.db, c, {action: 'email_account.connected', entity: 'email_account', label: address, meta: {provider, shared: !owner, oauth: true, reconnected: !!existing}});
      return back(`${address} connected`, true);
    } catch (e) {
      logMailboxError(`connect ${kind}`, e);
      return back(e instanceof MailboxSetupError ? e.message : 'The mailbox could not be connected. Please try again.');
    }
  })

  // ─── Sending ───
  .post('/send', valid('json', z.object({
    accountId: z.string().optional(),
    to: z.array(email).min(1).max(50),
    cc: z.array(email).max(50).optional(),
    bcc: z.array(email).max(50).optional(),
    subject: z.string().trim().min(1, 'is required').max(500),
    body: z.string().trim().max(100_000).optional(),
    html: z.string().max(200_000).optional(),
    layout: z.enum(['branded', 'plain']).optional(),
    preheader: z.string().max(300).nullish(),
    threadId: z.string().optional(),
    contactId: z.string().nullish(),
    companyId: z.string().nullish(),
    dealId: z.string().nullish(),
  })), async (c) => {
    const db = c.var.db;
    const me = currentUser(c);
    const input = c.req.valid('json');
    if (!input.body && !input.html) throw fieldError('html', 'Write a message first');
    // Only into a conversation, and about records, this person may see (404 otherwise, as everywhere).
    const scope = await inboxScope(db, me);
    const owner = scope.owner;
    const [thread, contact, deal, company] = await Promise.all([
      input.threadId ? findReadable(db, scope, input.threadId) : true,
      input.contactId ? db.contact.findFirst({where: {id: input.contactId, ...owner}, select: {id: true}}) : true,
      input.dealId ? db.deal.findFirst({where: {id: input.dealId, ...owner}, select: {id: true}}) : true,
      input.companyId ? db.company.findFirst({where: {id: input.companyId, ...owner}, select: {id: true}}) : true,
    ]);
    if (!thread) throw notFound('Thread');
    if (!contact) throw notFound('Contact');
    if (!deal) throw notFound('Deal');
    if (!company) throw notFound('Company');
    const message = await sendEmail(db, me, publicOrigin(c.req.raw), input);
    return c.json({message}, 201);
  })

  // ─── Threads (contact, company and deal pages) ───
  // The inbox's own rules (inbox/scope.ts): personal mailboxes stay private, the team inbox follows
  // its access setting, ticket threads their ticket; a record filter needs that record visible.
  .get('/threads', valid('query', z.object({
    contactId: z.string().max(60).optional(),
    dealId: z.string().max(60).optional(),
    companyId: z.string().max(60).optional(),
    unread: z.string().optional(),
    q: z.string().max(200).optional(),
    take: intParam(1, 200).default(50),
  })), async (c) => {
    const db = c.var.db;
    const q = c.req.valid('query');
    const scope = await inboxScope(db, currentUser(c));
    const owner = scope.owner;
    if (owner.ownerId) {
      const [contact, deal, company] = await Promise.all([
        q.contactId ? db.contact.findFirst({where: {id: q.contactId, ...owner}, select: {id: true}}) : true,
        q.dealId ? db.deal.findFirst({where: {id: q.dealId, ...owner}, select: {id: true}}) : true,
        q.companyId ? db.company.findFirst({where: {id: q.companyId, ...owner}, select: {id: true}}) : true,
      ]);
      if (!contact) throw notFound('Contact');
      if (!deal) throw notFound('Deal');
      if (!company) throw notFound('Company');
    }
    const rows = await db.emailThread.findMany({
      where: {
        AND: [scope.readable],
        ...(q.contactId && {contactId: q.contactId}),
        ...(q.dealId && {dealId: q.dealId}),
        ...(q.companyId && {companyId: q.companyId}),
        ...(q.unread === '1' && {unread: true}),
        ...(q.q && {OR: [{subject: {contains: q.q, mode: 'insensitive'}}, {messages: {some: {fromEmail: {contains: q.q, mode: 'insensitive'}}}}]}),
      },
      include: {
        contact: {select: {id: true, firstName: true, lastName: true, email: true}},
        deal: {select: {id: true, title: true}},
        messages: {orderBy: {sentAt: 'desc'}, take: 1, select: {text: true, fromEmail: true, fromName: true, direction: true, status: true, openCount: true}},
        _count: {select: {messages: true}},
      },
      orderBy: {lastMessageAt: 'desc'},
      take: q.take,
    });
    const visible = await withVisibleTickets(db, scope, rows);
    return c.json({rows: visible.map(({messages, ...t}) => ({...t, last: messages[0] ? {...messages[0], text: messages[0].text?.slice(0, 200) ?? ''} : null}))});
  })

  .get('/threads/:id', async (c) => {
    const db = c.var.db;
    const scope = await inboxScope(db, currentUser(c));
    if (!(await findReadable(db, scope, c.req.param('id')))) throw notFound('Thread');
    const [thread, html] = await Promise.all([
      db.emailThread.findUnique({
        where: {id: c.req.param('id')},
        include: {
          contact: {select: {id: true, firstName: true, lastName: true, email: true, ownerId: true}},
          company: {select: {id: true, name: true, ownerId: true}},
          deal: {select: {id: true, title: true, ownerId: true}},
          account: {select: {id: true, fromEmail: true, provider: true}},
          // The newest 200, oldest first (a long thread is read in the inbox, which pages).
          messages: {orderBy: [{sentAt: 'desc'}, {id: 'desc'}], take: 200, include: {sender: {select: userSelect}}},
        },
      }),
      receivedHtmlReader(),
    ]);
    if (!thread) throw notFound('Thread');
    if (thread.unread) await db.emailThread.update({where: {id: thread.id}, data: {unread: false}});
    // Linked records the viewer may not see are left out, like the inbox's sidebar.
    const mine = scope.owner.ownerId;
    const shown = <T extends {ownerId: string | null}>(r: T | null) => {
      if (!r || (mine && r.ownerId !== mine)) return null;
      const {ownerId: _o, ...rest} = r;
      return rest;
    };
    return c.json({
      thread: {
        ...thread,
        contact: shown(thread.contact),
        deal: shown(thread.deal),
        company: shown(thread.company),
        // Stored HTML as cleaned when it arrived (older mail, and our own, cleaned now).
        messages: thread.messages.reverse().map((m) => ({...m, html: html(m.html)})),
      },
    });
  })

  .patch('/threads/:id', valid('json', z.object({dealId: z.string().max(60).nullish(), contactId: z.string().max(60).nullish(), unread: z.boolean().optional()})), async (c) => {
    const db = c.var.db;
    const input = c.req.valid('json');
    const scope = await inboxScope(db, currentUser(c));
    const owner = scope.owner;
    const [found, contact, deal] = await Promise.all([
      findReadable(db, scope, c.req.param('id')),
      input.contactId ? db.contact.findFirst({where: {id: input.contactId, ...owner}, select: {id: true}}) : true,
      input.dealId ? db.deal.findFirst({where: {id: input.dealId, ...owner}, select: {id: true}}) : true,
    ]);
    if (!found) throw notFound('Thread');
    // Linking: only records this person may see (AUDIT P2-19).
    if (!contact) throw notFound('Contact');
    if (!deal) throw notFound('Deal');
    const thread = await db.emailThread.update({
      where: {id: found.id},
      data: {
        ...(input.dealId !== undefined && {dealId: input.dealId}),
        ...(input.contactId !== undefined && {contactId: input.contactId}),
        ...(input.unread !== undefined && {unread: input.unread}),
      },
    });
    return c.json({thread});
  })

  // ─── Templates ───
  .get('/templates', async (c) => {
    const me = currentUser(c);
    const rows = await c.var.db.emailTemplate.findMany({where: {OR: [{shared: true}, {ownerId: me.id}]}, orderBy: {name: 'asc'}});
    return c.json({rows});
  })
  .post('/templates', valid('json', templateInput), async (c) => {
    const input = templateData(c.req.valid('json'));
    if (!input.body?.trim()) throw fieldError('html', 'Write the template first');
    const template = await c.var.db.emailTemplate.create({data: {...input, body: input.body, ownerId: currentUser(c).id}});
    await audit(c.var.db, c, {action: 'template.created', entity: 'template', recordId: template.id, label: template.name});
    return c.json({template}, 201);
  })
  // Template gallery: copies a ready-made template into the team's templates.
  .post('/templates/gallery/:id', async (c) => {
    const g = GALLERY.find((t) => t.id === c.req.param('id'));
    if (!g) throw notFound('Template');
    const template = await c.var.db.emailTemplate.create({data: {...fromGallery(g), shared: true, ownerId: currentUser(c).id}});
    await audit(c.var.db, c, {action: 'template.created', entity: 'template', recordId: template.id, label: template.name, meta: {gallery: g.id}});
    return c.json({template}, 201);
  })
  .patch('/templates/:id', valid('json', templateFields.partial()), async (c) => {
    const me = currentUser(c);
    // Another member's private template is a 404; a shared one they can see but not change says why.
    const t = await c.var.db.emailTemplate.findFirst({where: visibleTemplate(me, c.req.param('id'))});
    if (!t) throw notFound('Template');
    if (t.ownerId !== me.id && !isAdmin(me)) throw new HTTPException(403, {message: 'Only the creator can edit this template'});
    const template = await c.var.db.emailTemplate.update({where: {id: t.id}, data: templateData(c.req.valid('json'))});
    await audit(c.var.db, c, {action: 'template.updated', entity: 'template', recordId: t.id, label: template.name, meta: {changed: Object.keys(c.req.valid('json'))}});
    return c.json({template});
  })
  .delete('/templates/:id', async (c) => {
    const me = currentUser(c);
    const t = await c.var.db.emailTemplate.findFirst({where: visibleTemplate(me, c.req.param('id'))});
    if (!t) throw notFound('Template');
    if (t.ownerId !== me.id && !isAdmin(me)) throw new HTTPException(403, {message: 'Only the creator can delete this template'});
    await c.var.db.emailTemplate.delete({where: {id: t.id}});
    await audit(c.var.db, c, {action: 'template.deleted', entity: 'template', recordId: t.id, label: t.name, meta: {subject: t.subject}});
    return c.json({ok: true});
  })

  // ─── Email design (the branded layout) ───
  .get('/design', async (c) => {
    const [design, brand] = await Promise.all([getEmailDesign(c.var.db), emailBrand(c.var.db, publicOrigin(c.req.raw))]);
    return c.json({design, brand});
  })
  .put('/design', requireRole('ADMIN'), valid('json', z.object({
    logo: z.enum(['brand', 'upload', 'none']),
    logoUrl: z.union([z.literal(''), z.string().trim().max(1000).regex(/^https?:\/\//, 'must be a web address')]),
    logoWidth: intValue(40, 280),
    headerColor: z.union([z.literal(''), z.string().regex(/^#[0-9a-f]{6}$/i)]),
    accentColor: z.union([z.literal(''), z.string().regex(/^#[0-9a-f]{6}$/i)]),
    companyName: z.string().trim().max(120),
    address: z.string().trim().max(500),
    footerText: z.string().trim().max(1000),
    plainUnsubscribe: z.boolean(),
  }).partial()), async (c) => {
    const design = await saveEmailDesign(c.var.db, c.req.valid('json'));
    await audit(c.var.db, c, {action: 'settings.email_design', meta: c.req.valid('json')});
    return c.json({design});
  });

export {emailRoutes as email};
