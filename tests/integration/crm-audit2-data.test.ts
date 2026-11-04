import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import type {Db} from '../../src/server/crm/kit/db';
import {resolveAudience} from '../../src/server/crm/lib/broadcasts';
import {scanDuplicates} from '../../src/server/crm/lib/duplicates';
import {pruneJobs} from '../../src/server/crm/lib/jobs';
import {BIN_BATCH, moveToBin} from '../../src/server/crm/lib/recycle-bin';
import {rescoreContacts} from '../../src/server/crm/lib/scoring';
import {getSettings, saveSettings} from '../../src/server/crm/lib/settings';
import {owner, resetCrm} from './support/crm';
import {type Browser, configureEnv, DATABASE_URL, db} from './support/harness';

/**
 * AUDIT-2 data-integrity and large-data rows: the indexes the prune and the cascades need (H-2,
 * M-9), one property award per rule and contact under concurrent rescoring (M-10), a bounded
 * duplicate scan (M-12), a bounded broadcast audience (M-13), bulk delete capped and snapshotted
 * inside its transaction (M-14), and settings saves that never lose a concurrent one (L-12).
 */

const API = '/site-api/crm';
const DAY = 86_400_000;
const d = db as unknown as Db;
const rulesOf = (...rules: unknown[]) => ({match: 'all', groups: [{match: 'all', rules}]});

describe.skipIf(!DATABASE_URL)('Kinroot AUDIT-2 data rows (integration, real Postgres)', () => {
  let own: Browser;

  beforeAll(configureEnv);
  afterAll(async () => {
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetCrm();
    own = await owner();
    expect((await own.post(`${API}/auth/setup`, {brandName: 'Acme', demoData: false})).status).toBe(200);
  });

  it('H-2 / M-9: the missing indexes exist, and the prune deletes old events with their deliveries', async () => {
    const indexes = await db.$queryRaw<{indexname: string}[]>`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`;
    const names = new Set(indexes.map((i) => i.indexname));
    for (const name of ['WebhookDelivery_eventId_idx', 'Activity_refId_idx', 'EmailMessage_contactId_idx', 'EmailThread_companyId_idx', 'FormSubmission_dealId_idx', 'Interaction_attendeeIds_idx', 'ScoreEvent_property_active_key', 'JobBacklog_failedAt_priority_runAt_idx', 'Contact_email_key_idx', 'Contact_phone_key_idx']) {
      expect(names.has(name), name).toBe(true);
    }
    // A delivery lookup by event uses the index (no sequential scan of the table).
    const [, plan] = await db.$transaction([db.$executeRaw`SET LOCAL enable_seqscan = off`, db.$queryRaw<{'QUERY PLAN': string}[]>`EXPLAIN SELECT 1 FROM "WebhookDelivery" WHERE "eventId" = 'x'`]);
    expect(plan.map((p) => p['QUERY PLAN']).join('\n')).toContain('WebhookDelivery_eventId_idx');

    const hook = await db.webhook.create({data: {url: 'https://hooks.zapier.com/x', events: ['*'], secret: 's'}});
    const old = new Date(Date.now() - 100 * DAY);
    const events = await Promise.all(Array.from({length: 30}, (_, i) => db.event.create({data: {type: 'contact.created', recordId: `c${i}`, data: {}, createdAt: old}})));
    await db.webhookDelivery.createMany({data: events.flatMap((e) => Array.from({length: 5}, () => ({webhookId: hook.id, eventId: e.id, eventType: 'contact.created'})))});
    const fresh = await db.event.create({data: {type: 'contact.created', recordId: 'new', data: {}}});
    await db.webhookDelivery.create({data: {webhookId: hook.id, eventId: fresh.id, eventType: 'contact.created'}});

    const out = await pruneJobs(d);
    expect(JSON.stringify(out.events ?? null)).not.toMatch(/skipped|error/);
    expect(await db.event.count()).toBe(1);
    expect(await db.webhookDelivery.count()).toBe(1);
    // Every later step ran too.
    for (const step of ['recycle bin', 'audit log', 'data in']) expect(JSON.stringify(out[step] ?? null), step).not.toMatch(/skipped|error/);
  });

  it('M-10: two rescoring jobs on one contact at the same moment award a property rule once', async () => {
    const contact = await db.contact.create({data: {firstName: 'Ava', tags: ['vip']}});
    await db.scoreRule.create({data: {name: 'VIP', kind: 'property', points: 30, rules: rulesOf({field: 'tags', op: 'has_any', values: ['vip']}) as unknown as object}});
    const results = await Promise.all([rescoreContacts(d, [contact.id]), rescoreContacts(d, [contact.id]), rescoreContacts(d, [contact.id])]);
    const awards = await db.scoreEvent.findMany({where: {contactId: contact.id, kind: 'property', revokedAt: null}});
    expect(awards).toHaveLength(1);
    expect((await db.contact.findUniqueOrThrow({where: {id: contact.id}})).score).toBe(30);
    // Only one of them saw (and reported) the change.
    expect(results.reduce((n, r) => n + r.changed, 0)).toBe(1);
    expect(await db.event.count({where: {type: 'contact.score_changed', recordId: contact.id}})).toBeLessThanOrEqual(1);

    // A merge never moves a second active award of the same rule onto the survivor.
    const dup = await db.contact.create({data: {firstName: 'Ava', lastName: 'Two', tags: ['vip']}});
    await rescoreContacts(d, [dup.id]);
    const {moveScoreEvents} = await import('../../src/server/crm/lib/scoring');
    await moveScoreEvents(d, dup.id, contact.id);
    expect(await db.scoreEvent.count({where: {contactId: contact.id, kind: 'property', revokedAt: null}})).toBe(1);
  });

  it('M-12: a duplicate scan stops at its caps, keeps only matches and removes nothing it did not reach', async () => {
    await db.contact.createMany({data: Array.from({length: 40}, (_, i) => ({firstName: `Sam${i}`, lastName: 'Rivera', email: `sam${i}@rivera-${i}.test`}))});
    // Two real duplicates by email.
    await db.contact.createMany({data: [{firstName: 'Kim', lastName: 'Lee', email: 'kim@acme.test'}, {firstName: 'Kimberly', lastName: 'Lee', email: 'kim@acme.test'}]});
    const full = await scanDuplicates(d, 'contact');
    expect(full.partial).toBeUndefined();
    const pairs = await db.duplicatePair.count({where: {status: 'open'}});
    expect(pairs).toBeGreaterThan(0);

    // A scan capped at 10 pairs: partial, and every open pair found before is still there.
    const capped = await scanDuplicates(d, 'contact', {pairs: 10, found: 20_000});
    expect(capped.partial).toBe(true);
    expect(await db.duplicatePair.count({where: {status: 'open'}})).toBe(pairs);
    // Capped on matches: never more kept than the cap.
    const few = await scanDuplicates(d, 'contact', {pairs: 2_000_000, found: 1});
    expect(few.partial).toBe(true);
    expect(few.found).toBeLessThanOrEqual(1);
  });

  it('M-13: the broadcast audience counts the list in SQL and stops past the recipient limit', async () => {
    const list = await db.contactList.create({data: {name: 'Everyone', kind: 'STATIC'}});
    const people = [
      ...Array.from({length: 25}, (_, i) => ({firstName: `P${i}`, email: `p${i}@example.test`})),
      {firstName: 'Dup', email: 'P1@example.test'},
      {firstName: 'NoMail'},
      {firstName: 'Bad', email: 'not-an-address'},
      {firstName: 'Out', email: 'out@example.test', emailOptOut: true},
    ];
    for (const p of people) {
      const c = await db.contact.create({data: p});
      await db.contactListMember.create({data: {listId: list.id, contactId: c.id}});
    }
    // Opted out through another contact with the same address (outside the list).
    await db.contact.create({data: {firstName: 'Elsewhere', email: 'p2@example.test', emailOptOut: true}});

    const all = await resolveAudience(d, list, {});
    expect(all.capped).toBeUndefined();
    expect(all.contacts).toBe(29);
    expect(all.noEmail).toBe(2);
    expect(all.optedOut).toBe(2);
    expect(all.duplicates).toBe(1);
    expect(all.recipients).toHaveLength(24);
    expect(all.contacts).toBe(all.noEmail + all.optedOut + all.duplicates + all.recipients.length);

    const capped = await resolveAudience(d, list, {}, 10);
    expect(capped.capped).toBe(true);
    expect(capped.recipients).toHaveLength(11);
    expect(capped.contacts).toBe(29);
  });

  it('M-14: bulk delete takes at most 100 a request; the bin snapshot is taken inside the delete', async () => {
    const ids = Array.from({length: BIN_BATCH + 1}, (_, i) => `c_${i}`);
    const refused = await own.post(`${API}/contacts/bulk`, {ids, action: 'delete'});
    expect(refused.status).toBe(400);
    expect(String(refused.json.error ?? refused.json.message ?? '')).toMatch(/at most 100/);
    const refusedCompanies = await own.post(`${API}/companies/bulk`, {ids, action: 'delete'});
    expect(refusedCompanies.status).toBe(400);

    const made = await Promise.all(Array.from({length: 3}, (_, i) => db.contact.create({data: {firstName: `Gone${i}`}})));
    await db.note.create({data: {contactId: made[0]!.id, body: 'kept in the bin'}});
    const ok = await own.post(`${API}/contacts/bulk`, {ids: made.map((c) => c.id), action: 'delete'});
    expect(ok.status).toBe(200);
    expect(await db.contact.count({where: {id: {in: made.map((c) => c.id)}}})).toBe(0);
    const entries = await db.deletedRecord.findMany({where: {recordId: {in: made.map((c) => c.id)}}});
    expect(entries).toHaveLength(3);
    const first = entries.find((e) => e.recordId === made[0]!.id)!;
    expect((first.snapshot as {rows: {note?: unknown[]}}).rows.note).toHaveLength(1);

    // More than one batch through moveToBin (another caller): every record binned, in batches.
    const many = await db.contact.createManyAndReturn({data: Array.from({length: BIN_BATCH + 5}, (_, i) => ({firstName: `Many${i}`})), select: {id: true}});
    const bins = await moveToBin(d, 'contact', many.map((c) => c.id), null);
    expect(bins).toHaveLength(BIN_BATCH + 5);
    expect(await db.contact.count({where: {firstName: {startsWith: 'Many'}}})).toBe(0);
  });

  it('L-12 / L-8: opens at the same moment log and emit the first open once; hits past the cap write nothing', async () => {
    const contact = await db.contact.create({data: {firstName: 'Opal', email: 'opal@example.test'}});
    const thread = await db.emailThread.create({data: {subject: 'Hello', contactId: contact.id}});
    const message = await db.emailMessage.create({
      data: {threadId: thread.id, direction: 'OUTBOUND', status: 'SENT', fromEmail: 'me@acme.test', to: ['opal@example.test'], subject: 'Hello', contactId: contact.id, trackingId: 'trk_audit2', sentAt: new Date(Date.now() - 60_000)},
    });
    const pixel = () => own.get(`${API}/t/o/trk_audit2.gif`);
    await Promise.all([pixel(), pixel(), pixel()]);
    const after = await db.emailMessage.findUniqueOrThrow({where: {id: message.id}});
    expect(after.openCount).toBe(3);
    expect(after.firstOpenedAt).not.toBeNull();
    expect(await db.event.count({where: {type: 'email.opened', recordId: message.id}})).toBe(1);
    expect(await db.activity.count({where: {type: 'email_opened', refId: message.id}})).toBe(1);

    // A client reloading the pixel: at most 10 rows a minute for one message.
    for (let i = 0; i < 12; i++) expect((await pixel()).status).toBe(200);
    expect(await db.trackingEvent.count({where: {messageId: message.id}})).toBe(10);
    expect((await db.emailMessage.findUniqueOrThrow({where: {id: message.id}})).openCount).toBe(10);
  });

  it('L-12: two settings saves of different fields at the same moment both land', async () => {
    await Promise.all([saveSettings(d, {currency: 'EUR'}), saveSettings(d, {brandName: 'Kinroot Two'}), saveSettings(d, {bccAddress: 'log@inbound.example.test'})]);
    const s = await getSettings(d);
    expect(s.currency).toBe('EUR');
    expect(s.brandName).toBe('Kinroot Two');
    expect(s.bccAddress).toBe('log@inbound.example.test');
  });
});
