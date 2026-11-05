import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {authResultsPass, inboundSenderVerified} from '../../src/server/crm/email/sender-auth';
import {defuseMerge, mergeFields, plainName} from '../../src/server/crm/email/render';
import {fakeResend, inbound, mailbox, mails, mailsTo, restoreResend} from './ported/support-inbox';
import {owner, ownerAt, ownerMemberId, resetCrm, teammate, userId} from './support/crm';
import {Browser, configureEnv, DATABASE_URL, db, signedIn} from './support/harness';

/**
 * AUDIT-2 (M-1 to M-8, L-1 to L-12): cancelled invites, the site owner's row, forms, tickets, the
 * company mailbox as a relay, personal senders, forged inbound mail, and the smaller leaks. Another
 * member gets 404 (never data), caps hold.
 */

const API = '/site-api/crm';
type Json = Record<string, any>;
type Res = {status: number; json: Json};

const ok = <T = Json>(res: Res, status = 200): T => {
  expect(res.status, JSON.stringify(res.json).slice(0, 400)).toBe(status);
  return res.json as T;
};

let own: Browser;
let amy: Browser;
let ben: Browser;
let amyId: string;
let benId: string;

const get = (b: Browser, path: string) => b.get(`${API}${path}`);
const post = (b: Browser, path: string, body: unknown = {}) => b.post(`${API}${path}`, body);
const patch = (b: Browser, path: string, body: unknown) => b.request('PATCH', `${API}${path}`, body);
const del = (b: Browser, path: string) => b.delete(`${API}${path}`);
const visibility = async (v: 'owner' | 'everyone') => ok(await patch(own, '/settings', {recordVisibility: v}));
const memberId = async (email: string) => (await db.member.findUniqueOrThrow({where: {userId: await userId(email)}, select: {id: true}})).id;

describe.skipIf(!DATABASE_URL)('Kinroot AUDIT-2 fixes (integration, real Postgres)', () => {
  beforeAll(async () => {
    configureEnv();
    await resetCrm();
    fakeResend();
    own = await owner();
    await get(own, '/auth/state');
    ok(await post(own, '/auth/setup', {brandName: 'Acme', demoData: false}));
    ({browser: amy} = await teammate(own, 'amy@audit2-team.io'));
    ({browser: ben} = await teammate(own, 'ben@audit2-team.io'));
    [amyId, benId] = await Promise.all([memberId('amy@audit2-team.io'), memberId('ben@audit2-team.io')]);
    // A shared team mailbox: system email (support, booking) goes out from it.
    await mailbox(own, {fromName: 'Team', fromEmail: 'team@audit2-port.io', shared: true, isDefault: true});
  });
  afterAll(async () => {
    restoreResend();
    await db.$disconnect();
  });

  // ─── M-1 ───
  it('M-1: a deactivated invite never works, and Cancel invite removes or retires it', async () => {
    const invite = ok(await post(own, '/team/invite', {name: 'Cara', email: 'cara@audit2-team.io', role: 'ADMIN'}));
    const id = invite.user.id as string;
    const token = String(invite.inviteUrl).split('/invite/')[1]!;
    ok(await patch(own, `/team/${id}`, {active: false}));
    // The link was cleared with the deactivation, and accepting never re-activates.
    expect((await db.member.findUniqueOrThrow({where: {id}})).inviteTokenHash).toBeNull();
    const cara = await signedIn(app, 'cara@audit2-team.io');
    expect((await post(cara, `/auth/invite/${token}`)).status).toBe(404);
    expect((await db.member.findUniqueOrThrow({where: {id}})).active).toBe(false);
    expect((await post(own, `/team/${id}/invite-link`)).status).toBe(400);

    // Cancel: only admins, only pending invites, same rank rule (an Admin can't cancel an Admin's invite).
    const pending = ok(await post(own, '/team/invite', {name: 'Dan', email: 'dan@audit2-team.io', role: 'MEMBER'}));
    expect((await del(amy, `/team/${pending.user.id}`)).status).toBe(403);
    expect((await del(own, `/team/${amyId}`)).status).toBe(404); // joined: deactivate instead
    expect(ok(await del(own, `/team/${pending.user.id}`))).toEqual({ok: true});
    expect(await db.member.count({where: {id: pending.user.id}})).toBe(0);
    expect((await del(own, `/team/${pending.user.id}`)).status).toBe(404);

    // A pending invite that already owns a record stays, deactivated, without its link.
    const eve = ok(await post(own, '/team/invite', {name: 'Eve', email: 'eve@audit2-team.io', role: 'VIEWER'}));
    ok(await post(own, '/contacts', {firstName: 'Owned', lastName: 'ByEve', ownerId: eve.user.id}), 201);
    ok(await del(own, `/team/${eve.user.id}`));
    const kept = await db.member.findUniqueOrThrow({where: {id: eve.user.id}});
    expect(kept).toMatchObject({active: false, inviteTokenHash: null});
  });

  // ─── M-5 ───
  it("M-5: nobody changes the site owner's access, and a changed row is restored on their next visit", async () => {
    const {browser: coOwner} = await ownerAt('co@audit2-team.io');
    const siteOwner = await ownerMemberId();
    expect((await patch(coOwner, `/team/${siteOwner}`, {active: false})).status).toBe(400);
    expect((await patch(coOwner, `/team/${siteOwner}`, {role: 'ADMIN'})).status).toBe(400);
    expect(await db.member.findUniqueOrThrow({where: {id: siteOwner}})).toMatchObject({role: 'OWNER', active: true});

    // A row changed before the rule existed: the owner's next request puts it back.
    await db.member.update({where: {id: siteOwner}, data: {role: 'VIEWER', active: false}});
    expect(ok(await get(own, '/auth/state')).user.role).toBe('OWNER');
    expect(await db.member.findUniqueOrThrow({where: {id: siteOwner}})).toMatchObject({role: 'OWNER', active: true});
  });

  // ─── M-2 / M-3 ───
  it('M-2 / M-3: only the creator or an admin edits a form; responses follow owner-only visibility', async () => {
    const form = ok<{form: {id: string}}>(await post(amy, '/forms', {name: 'Amy form'}), 201).form;
    expect((await patch(ben, `/forms/${form.id}`, {name: 'Taken'})).status).toBe(403);
    ok(await patch(amy, `/forms/${form.id}`, {name: 'Amy form 2'}));
    ok(await patch(own, `/forms/${form.id}`, {name: 'Amy form 3'}));

    const amyContact = ok(await post(amy, '/contacts', {firstName: 'Ann', email: 'ann@audit2-c.io'}), 201).contact.id as string;
    const benContact = ok(await post(ben, '/contacts', {firstName: 'Bob', email: 'bob@audit2-c.io'}), 201).contact.id as string;
    const benDeal = ok(await post(ben, '/deals', {title: 'Ben deal'}), 201).deal.id as string;
    await db.formSubmission.createMany({
      data: [
        {formId: form.id, email: 'ann@audit2-c.io', contactId: amyContact, dealId: benDeal, answers: []},
        {formId: form.id, email: 'bob@audit2-c.io', contactId: benContact, answers: []},
      ],
    });
    await visibility('owner');
    try {
      const rows = ok(await get(amy, `/forms/${form.id}/submissions`)).rows as Json[];
      expect(rows.map((r) => r.email)).toEqual(['ann@audit2-c.io']);
      expect(rows[0]!.deal).toBeNull(); // Ben's deal is not Amy's to see
      const exported = await amy.get(`${API}/forms/${form.id}/export`);
      expect(exported.json.text).toContain('ann@audit2-c.io');
      expect(exported.json.text).not.toContain('bob@audit2-c.io');
      // Admins see everything.
      expect((ok(await get(own, `/forms/${form.id}/submissions`)).rows as Json[]).length).toBe(2);
    } finally {
      await visibility('everyone');
    }
  });

  // ─── M-4 / L-5 ───
  it('M-4 / L-5: a ticket links only records the member may see; an email of a hidden contact is refused', async () => {
    const benContact = ok(await post(ben, '/contacts', {firstName: 'Hidden', lastName: 'Person', email: 'hidden@audit2-c.io', phone: '555-0100'}), 201).contact.id as string;
    const benDeal = ok(await post(ben, '/deals', {title: 'Ben secret deal'}), 201).deal.id as string;
    await visibility('owner');
    try {
      expect((await post(amy, '/tickets', {subject: 'Link', contactId: benContact})).status).toBe(404);
      expect((await post(amy, '/tickets', {subject: 'Link', dealId: benDeal})).status).toBe(404);
      const byEmail = await post(amy, '/tickets', {subject: 'Lookup', email: 'hidden@audit2-c.io'});
      expect(byEmail.status).toBe(409);
      expect(JSON.stringify(byEmail.json)).not.toContain('Hidden');
      expect(JSON.stringify(byEmail.json)).not.toContain('555-0100');
      // A new address: a new contact, Amy's own.
      const mine = ok(await post(amy, '/tickets', {subject: 'New one', email: 'fresh@audit2-c.io'}), 201).ticket;
      expect((await db.contact.findFirstOrThrow({where: {email: 'fresh@audit2-c.io'}})).ownerId).toBe(amyId);
      expect((await patch(amy, `/tickets/${mine.number}`, {dealId: benDeal})).status).toBe(404);
      ok(await patch(amy, `/tickets/${mine.number}`, {subject: 'Renamed'}));
      // L-5: a ticket assigned to Ben is a 404 for Amy (the rule is in the query).
      const bens = ok(await post(ben, '/tickets', {subject: 'Ben only'}), 201).ticket;
      expect((await get(amy, `/tickets/${bens.number}`)).status).toBe(404);
    } finally {
      await visibility('everyone');
    }
  });

  // ─── M-6 ───
  it('M-6: support confirmations repeat nothing the visitor typed and stop at 5 an hour per address', async () => {
    const victim = 'victim@audit2-victim.io';
    const before = mails.length;
    const lure = 'Click https://evil.example/login now';
    for (let i = 0; i < 6; i++) {
      const visitor = new Browser(app, `198.51.100.${120 + i}`);
      const res = await visitor.post(`${API}/public/support/tickets`, {subject: lure, description: 'Please help', email: victim, name: 'Evil https://evil.example', startedAt: Date.now() - 10_000});
      expect(res.status).toBe(201);
    }
    const sent = mailsTo(victim, before);
    expect(sent.length).toBe(5);
    for (const m of sent) {
      expect(`${m.subject}\n${m.text ?? ''}\n${m.html ?? ''}`).not.toContain('evil.example');
      expect(m.subject).toMatch(/^We received your request \[#\d+\]$/);
    }
  });

  // ─── M-7 ───
  it('M-7: a member personal API account sends only as their own sign-in address', async () => {
    const other = await post(amy, '/email/accounts', {credentials: {provider: 'RESEND'}, account: {fromName: 'CEO', fromEmail: 'ceo@audit2-port.io'}});
    expect(other.status).toBe(422);
    expect((other.json.fields as Record<string, string>)['account.fromEmail']).toBeTruthy();
    const own2 = ok(await post(amy, '/email/accounts', {credentials: {provider: 'RESEND'}, account: {fromName: 'Amy', fromEmail: 'amy@audit2-team.io'}}), 201).account;
    expect((await patch(amy, `/email/accounts/${own2.id}`, {fromEmail: 'ceo@audit2-port.io'})).status).toBe(422);
    // An account saved before the rule: sending refuses it.
    await db.emailAccount.update({where: {id: own2.id}, data: {fromEmail: 'ceo@audit2-port.io'}});
    const before = mails.length;
    const send = await post(amy, '/email/send', {accountId: own2.id, to: ['someone@audit2-victim.io'], subject: 'Wire', body: 'Pay now'});
    expect(send.status).toBe(403);
    expect(mails.length).toBe(before);
    await db.emailAccount.delete({where: {id: own2.id}});
    // Admins may still add a shared account with any address.
    ok(await post(own, '/email/accounts', {credentials: {provider: 'RESEND'}, account: {fromName: 'Sales', fromEmail: 'sales@audit2-port.io', shared: true}}), 201);
  });

  // ─── M-8 ───
  it("M-8: SPF / DKIM / DMARC verdicts are read only from the receiving service's own fields", () => {
    expect(authResultsPass('mx.google.com; dkim=pass header.i=@acme.io; spf=pass smtp.mailfrom=bounce@acme.io; dmarc=pass header.from=acme.io', 'a@acme.io')).toBe(true);
    expect(authResultsPass('spf=pass smtp.mailfrom=evil.io; dkim=pass header.d=evil.io; dmarc=fail header.from=acme.io', 'a@acme.io')).toBe(false);
    expect(authResultsPass('spf=pass smtp.mailfrom=evil.io; dkim=pass header.d=evil.io', 'a@acme.io')).toBe(false); // not aligned
    expect(authResultsPass('dkim=pass header.d=mail.acme.io', 'a@acme.io')).toBe(true); // relaxed alignment
    // Postmark: the first header is the service's; a later forged one is ignored.
    const postmark = (first: string, forged = 'dmarc=pass header.from=acme.io') => ({FromFull: {Email: 'a@acme.io'}, Headers: [{Name: 'Authentication-Results', Value: first}, {Name: 'Authentication-Results', Value: forged}]});
    expect(inboundSenderVerified(postmark('mx.postmark; dmarc=fail header.from=acme.io'), 'a@acme.io')).toBe(false);
    expect(inboundSenderVerified({Headers: [{Name: 'Received-SPF', Value: 'Pass (sender SPF authorized) identity=mailfrom; envelope-from="x@acme.io"; client-ip=1.2.3.4'}]}, 'a@acme.io')).toBe(true);
    expect(inboundSenderVerified({Headers: [{Name: 'Received-SPF', Value: 'Fail identity=mailfrom; envelope-from=x@acme.io'}]}, 'a@acme.io')).toBe(false);
    expect(inboundSenderVerified({Headers: [{Name: 'Received-SPF', Value: 'Pass (sender SPF authorized) identity=mailfrom; envelope-from=x@acme.io; client-ip=1.2.3.4'}]}, 'a@acme.io')).toBe(true);
    expect(inboundSenderVerified({'X-Mailgun-Spf': 'Pass', sender: 'bounce@acme.io', 'body-plain': 'x'}, 'a@acme.io')).toBe(true);
    expect(inboundSenderVerified({'X-Mailgun-Spf': 'Pass', sender: 'bounce@evil.io', 'body-plain': 'x'}, 'a@acme.io')).toBe(false);
    expect(inboundSenderVerified({envelope: '{"from":"x@evil.io"}', SPF: 'pass', dkim: '{@acme.io : pass}', headers: ''}, 'a@acme.io')).toBe(true);
    expect(inboundSenderVerified({envelope: '{"from":"x@evil.io"}', SPF: 'pass', dkim: '{@evil.io : pass}', headers: ''}, 'a@acme.io')).toBe(false);
    expect(inboundSenderVerified({from: 'a@acme.io', subject: 'generic', authenticated: true}, 'a@acme.io')).toBe(false);
  });

  it('M-8: forged ticket mail is never a team reply and never joins a ticket by its [#number]', async () => {
    ok(await patch(own, '/tickets/settings', {supportEmail: 'help@audit2-port.io'}));
    const ticket = ok(await post(own, '/tickets', {subject: 'Printer', email: 'cust@audit2-cust.io'}), 201).ticket as {id: string; number: number};
    const subject = `Re: Printer [#${ticket.number}]`;
    const messages = (body: string) => db.ticketMessage.findMany({where: {body: {contains: body}}, select: {ticketId: true, direction: true}});

    // Generic JSON carries no verdict: a teammate's address is not trusted…
    await inbound(own, {from: 'team@audit2-port.io', to: 'help@audit2-port.io', subject, text: 'forged team reply', messageId: 'm8-a@audit2'});
    expect(await messages('forged team reply')).toEqual([]);
    // …and the customer's address with a guessed number opens a new request instead of joining.
    await inbound(own, {from: 'cust@audit2-cust.io', to: 'help@audit2-port.io', subject, text: 'forged customer reply', messageId: 'm8-b@audit2'});
    expect((await messages('forged customer reply')).every((m) => m.ticketId !== ticket.id)).toBe(true);

    // Postmark said DMARC passed for the From: domain: trusted as before.
    const pm = (from: string, domain: string, text: string, id: string) => ({
      FromFull: {Email: from, Name: ''},
      ToFull: [{Email: 'help@audit2-port.io'}],
      Subject: subject,
      TextBody: text,
      MessageID: id,
      Headers: [{Name: 'Authentication-Results', Value: `mx.postmark; dmarc=pass header.from=${domain}`}, {Name: 'Message-ID', Value: `<${id}@audit2>`}],
    });
    await inbound(own, pm('team@audit2-port.io', 'audit2-port.io', 'real team reply', 'm8-c'));
    expect(await messages('real team reply')).toEqual([{ticketId: ticket.id, direction: 'OUTBOUND'}]);
    await inbound(own, pm('cust@audit2-cust.io', 'audit2-cust.io', 'real customer reply', 'm8-d'));
    expect(await messages('real customer reply')).toEqual([{ticketId: ticket.id, direction: 'INBOUND'}]);
  });

  // ─── L-1 / L-2 ───
  it("L-1 / L-2: exports and lists don't name records the member may not open", async () => {
    const amyContact = ok(await post(amy, '/contacts', {firstName: 'Lena', email: 'lena@audit2-c.io'}), 201).contact.id as string;
    const benDeal = ok(await post(ben, '/deals', {title: 'Ben hidden deal', contactIds: [amyContact]}), 201).deal.id as string;
    const benCompany = ok(await post(ben, '/companies', {name: 'Ben Hidden Co'}), 201).company.id as string;
    await db.contactCompany.create({data: {contactId: amyContact, companyId: benCompany, isPrimary: true}});
    await db.task.create({data: {title: 'Call Lena', assigneeId: amyId, creatorId: benId, dealId: benDeal, dueAt: new Date()}});
    await visibility('owner');
    try {
      const json = await amy.get(`${API}/contacts/${amyContact}/export`);
      expect(json.status).toBe(200);
      expect((json.json.contact as {deals: unknown[]}).deals).toEqual([]);
      expect((json.json.contact as {companies: unknown[]}).companies).toEqual([]);
      expect(ok(await get(amy, `/contacts/${amyContact}`)).contact.companies).toEqual([]);
      const list = ok(await get(amy, '/contacts?q=Lena')).rows as Json[];
      expect(list[0]!.companies).toEqual([]);
      const dash = ok(await get(amy, '/dashboard'));
      expect(JSON.stringify(dash.myTasks)).not.toContain('Ben hidden deal');
      const picker = ok(await get(amy, '/reports/refs/company')).rows as Json[];
      expect(picker.map((r) => r.label)).not.toContain('Ben Hidden Co');
    } finally {
      await visibility('everyone');
    }
  });

  // ─── L-3 ───
  it('L-3: pending uploads and other members’ ticket files are a 404', async () => {
    const pending = await db.file.create({data: {name: 'p.pdf', mimeType: 'application/pdf', size: 1, purpose: 'form_pending', ready: true}});
    expect((await amy.get(`${API}/files/${pending.id}`)).status).toBe(404);
    const t = ok(await post(ben, '/tickets', {subject: 'Ben file ticket'}), 201).ticket as {id: string};
    const file = await db.file.create({data: {name: 't.pdf', mimeType: 'application/pdf', size: 1, purpose: 'ticket', ready: true, uploadedById: benId}});
    await db.ticketMessage.create({data: {ticketId: t.id, kind: 'reply', direction: 'OUTBOUND', via: 'app', body: 'file', fileIds: [file.id]}});
    await visibility('owner');
    try {
      expect((await amy.get(`${API}/files/${file.id}`)).status).toBe(404);
    } finally {
      await visibility('everyone');
    }
  });

  // ─── L-4 ───
  it('L-4: a chat visitor typing an existing contact’s address is not linked to it', async () => {
    const existing = ok(await post(own, '/contacts', {firstName: 'Real', email: 'real@audit2-c.io'}), 201).contact.id as string;
    const {identifyVisitor} = await import('../../src/server/crm/inbox/chat');
    const identity = await db.channelIdentity.create({data: {channel: 'chat', externalId: `aud2-${Date.now()}`}});
    const {inScope, crmDb} = await import('./ported/support');
    const updated = await inScope(() => identifyVisitor(crmDb, identity as never, {name: 'Impostor', email: 'real@audit2-c.io'}));
    expect(updated.contactId).not.toBe(existing);
    expect(updated.email).toBe('real@audit2-c.io');
  });

  // ─── L-13 (company duplicate hint) ───
  it('L-13: the company hint finds look-alikes through the trigram indexes', async () => {
    const [legal, typed, other] = await Promise.all([
      db.company.create({data: {name: 'The Zorblax Holdings Ltd'}}),
      db.company.create({data: {name: 'Quintavex Systems', domain: 'www.quintavex-l13.io'}}),
      db.company.create({data: {name: 'Zorblaxian Foods'}}),
    ]);
    try {
      type Hint = {matches: {id: string; reasons: string[]}[]};
      const hint = async (body: Json) => ok<Hint>(await post(own, '/duplicates/check', {entity: 'company', ...body})).matches;
      // Legal words and "The" don't hide the same name; a different name with the same start isn't a match.
      const byName = await hint({name: 'Zorblax'});
      expect(byName.find((m) => m.id === legal.id)?.reasons).toContain('company_name');
      expect(byName.map((m) => m.id)).not.toContain(other.id);
      // The domain as typed elsewhere (www.) still matches, and a near-identical name too.
      expect((await hint({name: 'Brand new', domain: 'https://quintavex-l13.io/'})).find((m) => m.id === typed.id)?.reasons).toContain('domain');
      expect((await hint({name: 'Quintavex System'})).map((m) => m.id)).toContain(typed.id);
    } finally {
      await db.company.deleteMany({where: {id: {in: [legal.id, typed.id, other.id]}}});
    }
  });

  // ─── L-5 (duplicates) ───
  it("L-5: a member can't dismiss a duplicate pair of someone else's records", async () => {
    const a = ok(await post(ben, '/contacts', {firstName: 'Dup', lastName: 'One'}), 201).contact.id as string;
    const b = ok(await post(ben, '/contacts', {firstName: 'Dup', lastName: 'Two'}), 201).contact.id as string;
    const pair = await db.duplicatePair.create({data: {entity: 'contact', aId: a, bId: b, score: 90}});
    await visibility('owner');
    try {
      expect((await post(amy, `/duplicates/${pair.id}/dismiss`)).status).toBe(404);
      ok(await post(ben, `/duplicates/${pair.id}/dismiss`));
    } finally {
      await visibility('everyone');
    }
  });

  // ─── L-6 / M-6 merge values ───
  it('L-6: an outsider’s {{merge}} stays text; a stranger’s name loses its links', () => {
    const ctx = {contact: null, company: null, deal: {title: 'Secret', value: 99_000, currency: 'USD'}, me: {name: 'Amy', email: 'amy@x.io'}, unsubscribeUrl: null} as never;
    expect(mergeFields('Re: {{deal.value}}', ctx)).toContain('99');
    expect(mergeFields(defuseMerge('Re: {{deal.value}}'), ctx)).not.toContain('99');
    expect(plainName('Bob https://evil.example/x evil.example')).toBe('Bob');
    expect(plainName("Zoë O'Neil-Smith")).toBe("Zoë O'Neil-Smith");
  });
});
