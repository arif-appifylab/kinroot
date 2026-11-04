import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {owner, resetCrm, teammate, userId} from './support/crm';
import {type Browser, configureEnv, DATABASE_URL, db} from './support/harness';

/**
 * Owner-only record visibility (`recordVisibility: 'owner'`) for everything attached to a record
 * (AUDIT P1-3, P1-4, P2-1, P2-7): a member gets 404, never another member's data, on merge, file
 * links, notes, tasks, interactions, files, comments, follows, deal links and search. Plus the
 * bulk actions (P2-23), the 422 validation shape (P2-32), link checks (P2-13) and number limits
 * (P2-18).
 */

const API = '/site-api/crm';
type Json = Record<string, unknown>;
type Res = {status: number; json: Json};

const ok = <T = Json>(res: Res, status = 200): T => {
  expect(res.status, JSON.stringify(res.json)).toBe(status);
  return res.json as T;
};

let own: Browser;
let amy: Browser; // member A
let ben: Browser; // member B
let amyId: string;
const ids = {} as Record<'contact' | 'company' | 'deal' | 'note' | 'task' | 'interaction' | 'file' | 'importFile' | 'activity' | 'benContact' | 'benCompany' | 'benDeal', string>;

const get = (b: Browser, path: string) => b.get(`${API}${path}`);
const post = (b: Browser, path: string, body: unknown = {}) => b.post(`${API}${path}`, body);
const patch = (b: Browser, path: string, body: unknown) => b.request('PATCH', `${API}${path}`, body);
const del = (b: Browser, path: string) => b.delete(`${API}${path}`);
const visibility = async (v: 'owner' | 'everyone') => ok(await patch(own, '/settings', {recordVisibility: v}));

describe.skipIf(!DATABASE_URL)('Kinroot owner-only visibility (integration, real Postgres)', () => {
  beforeAll(async () => {
    configureEnv();
    await resetCrm();
    own = await owner();
    await own.get(`${API}/auth/state`);
    ok(await post(own, '/auth/setup', {brandName: 'Acme', demoData: false}));
    ({browser: amy} = await teammate(own, 'amy@example.com'));
    ({browser: ben} = await teammate(own, 'ben@example.com'));
    amyId = (await db.member.findUniqueOrThrow({where: {userId: await userId('amy@example.com')}})).id;

    // Amy's records and what hangs off them.
    ids.contact = ok<{contact: {id: string}}>(await post(amy, '/contacts', {firstName: 'Ada', lastName: 'Secret'}), 201).contact.id;
    ids.company = ok<{company: {id: string}}>(await post(amy, '/companies', {name: 'Amy Co'}), 201).company.id;
    ids.deal = ok<{deal: {id: string}}>(await post(amy, '/deals', {title: 'Amy deal', contactIds: [ids.contact]}), 201).deal.id;
    ids.note = ok<{note: {id: string}}>(await post(amy, '/notes', {body: 'zebrafish pricing talk', contactId: ids.contact}), 201).note.id;
    ids.task = ok<{task: {id: string}}>(await post(amy, '/tasks', {title: 'Call Ada', contactId: ids.contact}), 201).task.id;
    ids.interaction = ok<{interaction: {id: string}}>(await post(amy, '/interactions', {kind: 'CALL', title: 'Intro', contactId: ids.contact}), 201).interaction.id;
    ids.file = (await db.file.create({data: {name: 'deck.pdf', mimeType: 'application/pdf', size: 10, ready: true, purpose: 'attachment', contactId: ids.contact, uploadedById: amyId}})).id;
    ids.importFile = (await db.file.create({data: {name: 'all.csv', mimeType: 'text/csv', size: 10, ready: true, purpose: 'import', uploadedById: amyId}})).id;
    ids.activity = (await db.activity.findFirstOrThrow({where: {type: 'note', refId: ids.note}})).id;

    // Ben's own records.
    ids.benContact = ok<{contact: {id: string}}>(await post(ben, '/contacts', {firstName: 'Bo'}), 201).contact.id;
    ids.benCompany = ok<{company: {id: string}}>(await post(ben, '/companies', {name: 'Ben Co'}), 201).company.id;
    ids.benDeal = ok<{deal: {id: string}}>(await post(ben, '/deals', {title: 'Ben deal'}), 201).deal.id;
    await visibility('owner');
  }, 120_000);
  afterAll(async () => {
    await db.$disconnect();
  });

  it('refuses to merge a contact or company the member cannot see (P1-3)', async () => {
    expect((await post(ben, `/contacts/${ids.benContact}/merge`, {otherId: ids.contact})).status).toBe(404);
    expect((await post(ben, `/contacts/${ids.benContact}/merge`, {otherId: ids.contact, keep: 'other'})).status).toBe(404);
    expect((await post(ben, `/companies/${ids.benCompany}/merge`, {otherId: ids.company})).status).toBe(404);
    expect(await db.contact.count({where: {id: ids.contact}}), 'the other contact still exists').toBe(1);
    expect(await db.company.count({where: {id: ids.company}}), 'the other company still exists').toBe(1);
  });

  it('makes public file links only for attachments the caller may open (P1-4)', async () => {
    expect((await post(ben, `/files/${ids.file}/link`, {days: 7})).status, "another member's attachment").toBe(404);
    expect((await get(ben, `/files/${ids.file}`)).status, 'download follows the same rule').toBe(404);
    expect((await post(ben, `/files/${ids.importFile}/link`, {days: 7})).status, "someone's import CSV").toBe(404);
    expect((await post(amy, `/files/${ids.importFile}/link`, {days: 7})).status, 'never an import / export file, even your own').toBe(404);
    expect((await post(own, `/files/${ids.importFile}/link`, {days: 7})).status, 'nor for an admin').toBe(404);
    const link = ok<{url: string}>(await post(amy, `/files/${ids.file}/link`, {days: 7}));
    expect(link.url).toContain(`/public/files/${ids.file}?exp=`);
    ok(await post(own, `/files/${ids.file}/link`, {days: 1})); // admins see every record
  });

  it("answers 404 for everything attached to another member's record (P2-1)", async () => {
    const q = `contactId=${ids.contact}`;
    for (const path of [`/notes?${q}`, `/tasks?${q}`, `/interactions?${q}`, `/files?${q}`, `/comments/activity/${ids.activity}`, `/notifications/follow/contact/${ids.contact}`, `/timeline?${q}`]) {
      expect((await get(ben, path)).status, `GET ${path}`).toBe(404);
    }
    expect((await post(ben, '/notes', {body: 'sneaky', contactId: ids.contact})).status, 'note').toBe(404);
    expect((await post(ben, '/tasks', {title: 'sneaky', contactId: ids.contact})).status, 'task').toBe(404);
    expect((await post(ben, '/tasks', {title: 'sneaky', dealId: ids.deal})).status, 'task on a deal').toBe(404);
    expect((await post(ben, '/interactions', {kind: 'CALL', contactId: ids.benContact, attendeeIds: [ids.contact]})).status, 'attendee').toBe(404);
    expect((await post(ben, '/interactions', {kind: 'CALL', companyId: ids.company})).status, 'interaction').toBe(404);
    expect((await post(ben, '/files', {name: 'x.pdf', contentType: 'application/pdf', size: 10, contactId: ids.contact})).status, 'file').toBe(404);
    expect((await post(ben, `/comments/activity/${ids.activity}`, {body: 'hi'})).status, 'comment').toBe(404);
    expect((await post(ben, `/notifications/follow/contact/${ids.contact}`)).status, 'follow').toBe(404);
    expect((await post(ben, `/notifications/follow/deal/${ids.deal}`)).status, 'follow a deal').toBe(404);
    expect(await db.follow.count({where: {recordId: {in: [ids.contact, ids.deal]}}})).toBe(0);
    // Tasks, notes and interactions by id.
    expect((await patch(ben, `/tasks/${ids.task}`, {title: 'mine now'})).status).toBe(404);
    expect((await del(ben, `/tasks/${ids.task}`)).status).toBe(404);
    expect((await patch(ben, `/notes/${ids.note}`, {pinned: true})).status).toBe(404);
    expect((await del(ben, `/interactions/${ids.interaction}`)).status).toBe(404);
    expect(await db.task.count({where: {id: ids.task, title: 'Call Ada'}}), 'task untouched').toBe(1);
    // Amy still sees all of it.
    expect(ok<{rows: unknown[]}>(await get(amy, `/notes?contactId=${ids.contact}`)).rows).toHaveLength(1);
    expect(ok<{rows: unknown[]}>(await get(amy, `/comments/activity/${ids.activity}`)).rows).toHaveLength(0);
    ok(await post(amy, `/notifications/follow/contact/${ids.contact}`));
  });

  it("keeps other members' tasks out of the all-tasks list and bulk actions", async () => {
    const all = ok<{rows: {id: string}[]}>(await get(ben, '/tasks?scope=all'));
    expect(all.rows.map((t) => t.id)).not.toContain(ids.task);
    expect(ok<{rows: {id: string}[]}>(await get(own, '/tasks?scope=all')).rows.map((t) => t.id), 'admins see every task').toContain(ids.task);
    ok(await post(ben, '/tasks/bulk', {ids: [ids.task], action: 'complete'}));
    ok(await post(ben, '/tasks/bulk', {ids: [ids.task], action: 'delete'}));
    expect(await db.task.findUnique({where: {id: ids.task}, select: {done: true}})).toEqual({done: false});
  });

  it("does not link another member's contacts or companies to a deal or contact", async () => {
    expect((await post(ben, '/deals', {title: 'Grab', contactIds: [ids.contact]})).status).toBe(404);
    expect((await post(ben, '/deals', {title: 'Grab', companyIds: [ids.company]})).status).toBe(404);
    expect((await patch(ben, `/deals/${ids.benDeal}`, {contactIds: [ids.contact]})).status).toBe(404);
    expect((await patch(ben, `/deals/${ids.benDeal}`, {companyId: ids.company})).status).toBe(404);
    expect((await post(ben, `/contacts/${ids.benContact}/companies`, {companyId: ids.company})).status).toBe(404);
    expect((await post(ben, `/contacts/${ids.contact}/companies`, {companyId: ids.benCompany})).status).toBe(404);
    expect(await db.dealContact.count({where: {contactId: ids.contact}}), 'only Amy’s own deal').toBe(1);
    // Her own links still work, and a deal keeps links it already has when edited.
    ok(await patch(ben, `/deals/${ids.benDeal}`, {contactIds: [ids.benContact]}));
  });

  it('searches only what the member may see, note bodies included', async () => {
    const mine = ok<{notes: {id: string}[]; contacts: {id: string}[]}>(await get(amy, '/search?q=zebrafish'));
    expect(mine.notes.map((n) => n.id)).toEqual([ids.note]);
    const theirs = ok<{notes: unknown[]; contacts: unknown[]; deals: unknown[]; companies: unknown[]}>(await get(ben, '/search?q=zebrafish'));
    expect(theirs.notes).toEqual([]);
    const byName = ok<{contacts: unknown[]; deals: unknown[]; companies: unknown[]}>(await get(ben, '/search?q=Amy'));
    expect([byName.contacts, byName.deals, byName.companies]).toEqual([[], [], []]);
  });

  it('answers 404 (not 403) for "not yours" with everyone visibility (P2-7)', async () => {
    await visibility('everyone');
    try {
      expect((await patch(ben, `/notes/${ids.note}`, {body: 'rewritten'})).status, "editing another's note").toBe(404);
      expect((await del(ben, `/notes/${ids.note}`)).status).toBe(404);
      ok(await patch(ben, `/notes/${ids.note}`, {pinned: true})); // pinning stays open to the team
      expect((await patch(ben, `/interactions/${ids.interaction}`, {title: 'x'})).status).toBe(404);
      expect((await del(ben, `/interactions/${ids.interaction}`)).status).toBe(404);
      expect((await del(ben, `/files/${ids.file}`)).status).toBe(404);
      const comment = ok<{comment: {id: string}}>(await post(amy, `/comments/activity/${ids.activity}`, {body: 'first'}), 201).comment;
      expect((await del(ben, `/comments/${comment.id}`)).status).toBe(404);
      ok(await del(own, `/comments/${comment.id}`)); // an admin may
      expect(await db.note.count({where: {id: ids.note, body: 'zebrafish pricing talk'}})).toBe(1);
    } finally {
      await visibility('owner');
    }
  });

  it('bulk actions: tag / untag only visible contacts, delete with one batch of events, complete with timeline and repeats (P2-23)', async () => {
    const make = async (firstName: string) => ok<{contact: {id: string}}>(await post(amy, '/contacts', {firstName, tags: ['old']}), 201).contact.id;
    const [c1, c2] = [await make('Bulk1'), await make('Bulk2')];
    ok(await post(amy, '/contacts/bulk', {ids: [c1, c2, ids.benContact], action: 'tag', value: 'vip'}));
    ok(await post(amy, '/contacts/bulk', {ids: [c1, c2], action: 'tag', value: 'vip'})); // never twice
    const tagged = await db.contact.findMany({where: {id: {in: [c1, c2, ids.benContact]}}, select: {id: true, tags: true}});
    expect(tagged.find((r) => r.id === c1)?.tags).toEqual(['old', 'vip']);
    expect(tagged.find((r) => r.id === c2)?.tags).toEqual(['old', 'vip']);
    expect(tagged.find((r) => r.id === ids.benContact)?.tags, "another member's contact is skipped").toEqual([]);
    ok(await post(amy, '/contacts/bulk', {ids: [c1], action: 'untag', value: 'old'}));
    expect((await db.contact.findUniqueOrThrow({where: {id: c1}})).tags).toEqual(['vip']);
    expect(await db.auditLog.count({where: {action: 'contact.bulk_updated', recordId: c1}})).toBeGreaterThanOrEqual(3);

    const before = await db.event.count({where: {type: 'contact.deleted'}});
    ok(await post(amy, '/contacts/bulk', {ids: [c1, c2, ids.benContact], action: 'delete'}));
    expect(await db.event.count({where: {type: 'contact.deleted'}}) - before, 'one event per deleted contact').toBe(2);
    expect(await db.contact.count({where: {id: {in: [c1, c2]}}})).toBe(0);
    expect(await db.contact.count({where: {id: ids.benContact}}), "another member's contact stays").toBe(1);

    const coBefore = await db.event.count({where: {type: 'company.deleted'}});
    const co = ok<{company: {id: string}}>(await post(amy, '/companies', {name: 'Bulk Co'}), 201).company.id;
    ok(await post(amy, '/companies/bulk', {ids: [co, ids.benCompany], action: 'delete'}));
    expect(await db.event.count({where: {type: 'company.deleted'}}) - coBefore).toBe(1);
    expect(await db.company.count({where: {id: ids.benCompany}})).toBe(1);

    const t1 = ok<{task: {id: string}}>(await post(amy, '/tasks', {title: 'One', contactId: ids.contact}), 201).task.id;
    const t2 = ok<{task: {id: string}}>(await post(amy, '/tasks', {title: 'Weekly', repeat: 'WEEKLY', dueAt: '2026-11-02T09:00:00.000Z', contactId: ids.contact}), 201).task.id;
    ok(await post(amy, '/tasks/bulk', {ids: [t1, t2], action: 'complete'}));
    expect(await db.task.count({where: {id: {in: [t1, t2]}, done: true}})).toBe(2);
    expect(await db.activity.count({where: {type: 'task_done', refId: {in: [t1, t2]}}}), 'a timeline entry each').toBe(2);
    expect(await db.event.count({where: {type: 'task.completed', recordId: {in: [t1, t2]}}})).toBe(2);
    const next = await db.task.findFirstOrThrow({where: {title: 'Weekly', done: false}});
    expect(next.dueAt?.toISOString(), 'the repeating task rolled forward a week').toBe('2026-11-09T09:00:00.000Z');
    ok(await post(amy, '/tasks/bulk', {ids: [t1, t2], action: 'complete'}));
    expect(await db.task.count({where: {title: 'Weekly'}}), 'completing again changes nothing').toBe(2);
  });

  it('answers validation failures 422 with every field error (P2-32), checks links (P2-13) and numbers (P2-18)', async () => {
    const res = await post(amy, '/contacts', {firstName: '', email: 'not-an-email', linkedin: 'javascript:alert(1)'});
    expect(res.status).toBe(422);
    expect(typeof res.json.error).toBe('string');
    const fields = res.json.fields as Record<string, string>;
    expect(Object.keys(fields).sort()).toEqual(['email', 'firstName', 'linkedin']);
    expect(fields.firstName).toBe('is required');

    expect((await post(amy, '/companies', {name: 'Bad', website: 'javascript:alert(1)'})).status).toBe(422);
    expect((await post(amy, '/companies', {name: 'Bad', linkedin: 'data:text/html,hi'})).status).toBe(422);
    const co = ok<{company: {website: string; linkedin: string | null}}>(await post(amy, '/companies', {name: 'Good', website: 'good.example', linkedin: 'https://linkedin.com/company/good'}), 201).company;
    expect(co.website, 'a bare domain becomes an https link').toBe('https://good.example');
    expect((await post(amy, '/interactions', {kind: 'MEETING', title: 'M', contactId: ids.contact, location: 'javascript:alert(1)'})).status).toBe(422);
    ok(await post(amy, '/interactions', {kind: 'MEETING', title: 'M', contactId: ids.contact, location: 'Room 4: second floor'}), 201);
    ok(await post(amy, '/interactions', {kind: 'MEETING', title: 'M', contactId: ids.contact, location: 'https://meet.example/abc'}), 201);

    for (const page of ['1.5', '1e3', '-1', '1001', 'x']) expect((await get(amy, `/contacts?page=${page}`)).status, `page=${page}`).toBe(422);
    expect((await get(amy, '/companies?page=1001')).status).toBe(422);
    expect((await get(amy, '/contacts?noActivityDays=abc')).status).toBe(422);
    for (const tz of ['1e3', '9999', '1.5']) expect((await get(amy, `/tasks?due=today&tzOffset=${tz}`)).status, `tzOffset=${tz}`).toBe(422);
    ok(await get(amy, '/tasks?due=today&tzOffset=-360'));
    expect((await get(amy, '/deals?take=101')).status).toBe(422);
  });

  it('pages the deals list by page number, at most 100 a page, with totals for the whole filter (P2-28)', async () => {
    for (const title of ['P1', 'P2', 'P3']) ok(await post(own, '/deals', {title, value: 100}), 201);
    type Page = {rows: {id: string}[]; total: number; page: number; pageSize: number; summary: {count: number; value: number}};
    const first = ok<Page>(await get(own, '/deals?take=2&q=P'));
    expect([first.rows.length, first.total, first.page, first.pageSize]).toEqual([2, 3, 1, 2]);
    expect(first.summary).toMatchObject({count: 3, value: 300});
    const second = ok<Page>(await get(own, '/deals?take=2&q=P&page=2'));
    expect([second.rows.length, second.total]).toEqual([1, 3]);
    expect(new Set([...first.rows, ...second.rows].map((r) => r.id)).size, 'no deal twice').toBe(3);
    expect(ok<Page>(await get(own, '/deals')).pageSize, 'default and maximum page').toBe(100);
    expect((await get(own, '/deals?take=101')).status).toBe(422);
  });

  it('only admins start a full duplicate scan (P2-6)', async () => {
    expect((await post(amy, '/duplicates/scan', {})).status).toBe(403);
    ok(await post(own, '/duplicates/scan', {entity: 'company'}));
  });
});
