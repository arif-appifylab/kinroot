import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../../src/server/app';
import {owner, resetCrm} from '../support/crm';
import {Browser, configureEnv, DATABASE_URL, db} from '../support/harness';
import {fakeResend, mailbox, mails, mailsTo, restoreResend} from './support-inbox';

/**
 * Ported from Kinroot's scripts/integration/test-ticket-rich-text.mjs
 * Rich text on tickets end to end: descriptions, replies (merge fields, emailed as HTML), notes, saved
 * replies, plain-text edits and the support portal; sanitising and the plain-text twin.
 * The original's local SMTP sink is replaced by a Resend team mailbox whose sends are captured.
 */

const EMAIL = 'rita@client-rich.io';

let own: Browser;
let contact: {id: string};

describe.skipIf(!DATABASE_URL)('Ported: ticket rich text (integration, real Postgres)', () => {
  beforeAll(configureEnv);
  beforeAll(fakeResend);
  afterAll(async () => {
    restoreResend();
    await db.$disconnect();
  });
  afterEach(() => {
    mails.length = 0;
  });
  beforeEach(async () => {
    await resetCrm();
    own = await owner();
    await own.get('/site-api/crm/auth/state');
    await mailbox(own, {fromName: 'Support', fromEmail: 'support@kinroot-port.io', shared: true, isDefault: true});
    const res = await own.post('/site-api/crm/contacts', {firstName: 'Rita', lastName: 'Rich', email: EMAIL});
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    contact = res.json.contact as {id: string};
  });

  const createTicket = async () => {
    const res = await own.post('/site-api/crm/tickets', {
      subject: 'Rich',
      contactId: contact.id,
      descriptionHtml:
        '<p>It <strong>fails</strong> at checkout</p><ul><li><p>Step one</p></li></ul><script>alert(1)</script><img src="https://x.test/a.png" onerror="alert(2)"><p><a href="javascript:alert(3)">click</a> <a href="https://docs.example.com/x" onclick="alert(4)">docs</a></p>',
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    return res.json.ticket as {number: number; description: string; descriptionHtml: string};
  };
  const message = async (number: number, body: Record<string, unknown>) => {
    const res = await own.post(`/site-api/crm/tickets/${number}/messages`, body);
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    return res.json.message as {html: string | null; body: string};
  };

  it('keeps a description’s formatting, strips the unsafe parts and works out its plain text', async () => {
    const t = await createTicket();
    expect(t.descriptionHtml).toMatch(/<strong>fails<\/strong>/);
    expect(t.descriptionHtml).toMatch(/<ul><li><p>Step one<\/p><\/li><\/ul>/);
    expect(t.descriptionHtml).not.toMatch(/script|onerror|onclick|<img|javascript:/i);
    expect(t.descriptionHtml).toMatch(/<a href="https:\/\/docs\.example\.com\/x" target="_blank" rel="noopener noreferrer nofollow">docs<\/a>/);
    expect(t.descriptionHtml).not.toMatch(/<a[^>]*>click<\/a>/);
    expect(t.descriptionHtml).toMatch(/click/);
    expect(t.description).toContain('It fails at checkout');
    expect(t.description).toContain('Step one');
    expect(t.description).not.toContain('<');

    // A plain-text description edit clears the HTML.
    const patched = await own.request('PATCH', `/site-api/crm/tickets/${t.number}`, {description: 'Only text now'});
    expect(patched.status).toBe(200);
    expect(patched.json.ticket).toMatchObject({description: 'Only text now', descriptionHtml: null});
  });

  it('stores a reply as merged, sanitised HTML with its plain text, and emails it as HTML', async () => {
    const t = await createTicket();
    const reply = await message(t.number, {
      kind: 'reply',
      html: '<p>Hi <span data-merge="contact.first_name" data-fallback="there" class="merge-chip" contenteditable="false">First name</span>, it is <strong>fixed</strong>.</p><blockquote><p>Order #123</p></blockquote>',
      status: 'RESOLVED',
    });
    expect(reply.html).toBe('<p>Hi Rita, it is <strong>fixed</strong>.</p><blockquote><p>Order #123</p></blockquote>');
    expect(reply.body.startsWith('Hi Rita, it is fixed.')).toBe(true);
    expect(reply.body).toContain('Order #123');
    const [sent] = mailsTo(EMAIL);
    expect(sent, 'the reply is emailed to the contact').toBeTruthy();
    expect(sent!.html).toMatch(/<strong>fixed<\/strong>/);
    expect(sent!.html).toMatch(/Hi Rita/);

    // Plain-text callers keep working; an empty reply is refused.
    const plain = await message(t.number, {kind: 'reply', body: 'Plain {{contact.first_name}}'});
    expect(plain).toMatchObject({html: null, body: 'Plain Rita'});
    expect((await own.post(`/site-api/crm/tickets/${t.number}/messages`, {kind: 'reply', html: '<p><br></p>'})).status).toBe(400);

    // Notes keep formatting; merge fields are not filled in notes.
    const note = await message(t.number, {kind: 'note', html: '<p>Checked <em>logs</em> <span data-merge="contact.first_name">x</span></p>'});
    expect(note).toMatchObject({html: '<p>Checked <em>logs</em> x</p>', body: 'Checked logs x'});
  });

  it('stores saved replies as rich text and plain text; a plain-text edit clears the HTML', async () => {
    expect((await own.post('/site-api/crm/tickets/canned', {name: 'Steps', html: '<p>Try <strong>this</strong></p><ol><li><p>One</p></li></ol>'})).status).toBeLessThan(300);
    const row = await db.cannedReply.findFirstOrThrow({where: {name: 'Steps'}, select: {id: true, body: true, html: true}});
    expect(row.html).toBe('<p>Try <strong>this</strong></p><ol><li><p>One</p></li></ol>');
    expect(row.body.startsWith('Try this')).toBe(true);
    expect((await own.request('PATCH', `/site-api/crm/tickets/canned/${row.id}`, {body: 'Just text'})).status).toBe(200);
    expect(await db.cannedReply.findUniqueOrThrow({where: {id: row.id}, select: {body: true, html: true}})).toEqual({body: 'Just text', html: null});
    expect((await own.delete(`/site-api/crm/tickets/canned/${row.id}`)).status).toBe(200);
  });

  it('takes rich portal requests without frames or styles, and refuses an empty one', async () => {
    const settings = await own.get('/site-api/crm/tickets/settings');
    if (!(settings.json.settings as {portalEnabled: boolean}).portalEnabled) {
      expect((await own.request('PATCH', '/site-api/crm/tickets/settings', {portalEnabled: true})).status).toBe(200);
    }
    const guest = new Browser(app, '198.51.100.41');
    const sent = await guest.post('/site-api/crm/public/support/tickets', {
      email: 'pat@client-rich.io',
      name: 'Pat Portal',
      subject: 'Portal request',
      descriptionHtml: '<p>My <u>invoice</u> is wrong</p><iframe src="https://evil.test"></iframe><p style="color:red">styled</p>',
      startedAt: Date.now() - 5000,
    });
    expect(sent.status, JSON.stringify(sent.json)).toBe(201);
    const pt = await db.ticket.findFirstOrThrow({where: {subject: 'Portal request'}, select: {description: true, descriptionHtml: true}});
    expect(pt.descriptionHtml).toBe('<p>My <u>invoice</u> is wrong</p><p>styled</p>');
    expect(pt.description).toContain('My invoice is wrong');
    const blank = await guest.post('/site-api/crm/public/support/tickets', {email: 'pat@client-rich.io', subject: 'x', descriptionHtml: '<p></p>', startedAt: Date.now() - 5000});
    expect(blank.status).toBe(400);
  });
});
