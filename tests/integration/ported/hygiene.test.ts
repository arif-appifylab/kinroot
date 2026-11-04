// Ported from Kinroot's scripts/test-hygiene.mjs
// Data hygiene: the recycle bin (delete → bin → restore, bulk, purge, permissions, events), duplicate detection
// (precision, hint, dismiss, merge from the queue, visibility, scheduled scans) and the audit log (redaction, filters, CSV, retention).
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import '../../../src/server/background';
import {pruneAudit} from '../../../src/server/crm/lib/audit';
import {scheduleDuplicateScans} from '../../../src/server/crm/lib/duplicates';
import {purgeExpiredBin} from '../../../src/server/crm/lib/recycle-bin';
import {env} from '../support/cloudflare-workers';
import {fakeStorage, resetCrm, storedFiles, teammate} from '../support/crm';
import {configureEnv, DATABASE_URL, db} from '../support/harness';
import {attach, crm, HOOK_URL, meOf, must, stubFetch, stubHooks, tick, workspace, type Crm, type Me} from './support-lists';

type Row = {id: string; [k: string]: unknown};
type BinRow = {id: string; entity: string; recordId: string; label: string; detail: string | null; counts: Record<string, number>; deletedByName: string | null; deletedAt: string; expiresAt: string};
type Restored = {path: string; warning?: string | null};
const tag = 'hyg';
const day = 86_400_000;

/** Everything hanging off a record, as comparable numbers. */
async function related(column: 'contactId' | 'companyId' | 'dealId', id: string) {
  const where = {[column]: id};
  const count = (model: string, extra: Record<string, unknown> = {}) => (db as unknown as Record<string, {count: (a: unknown) => Promise<number>}>)[model]!.count({where: {...where, ...extra}});
  const out: Record<string, number> = {
    notes: await count('note'),
    tasks: await count('task'),
    activities: await count('activity', {type: {not: 'restored'}}),
    interactions: await count('interaction'),
    files: await count('file'),
    threads: await count('emailThread'),
    tickets: await count('ticket'),
    comments: await db.activityComment.count({where: {activity: where}}),
  };
  if (column === 'contactId') {
    out.companies = await count('contactCompany');
    out.deals = await count('dealContact');
    out.lists = await count('contactListMember');
    out.messages = await count('emailMessage');
    out.submissions = await count('formSubmission');
  }
  if (column === 'companyId') {
    out.contacts = await count('contactCompany');
    out.dealLinks = await count('dealCompany');
    out.primaryDeals = await count('deal');
  }
  if (column === 'dealId') {
    out.contacts = await count('dealContact');
    out.companies = await count('dealCompany');
    out.stageChanges = await count('stageChange');
    out.submissions = await count('formSubmission');
  }
  return out;
}

const binEntry = async (c: Crm, entity: string, recordId: string) => must<{rows: BinRow[]}>(await c.get(`/recycle-bin?entity=${entity}`), 'bin').rows.find((r) => r.recordId === recordId);
const eventCount = (type: string, recordId: string) => db.event.count({where: {type, recordId}});

describe.skipIf(!DATABASE_URL)('ported: recycle bin (scripts/test-hygiene.mjs bin)', () => {
  let o: Crm;
  let me: Me;
  let m: Crm;
  let viewer: Crm;
  let hooks: ReturnType<typeof stubHooks>;
  let maya: Row;
  let file: {id: string};
  let list: Row;
  let before: Record<string, number>;
  let contactRow: Record<string, unknown>;
  let entry: BinRow;
  let company: Row;
  let cBefore: Record<string, number>;
  let deal: Row;
  let dBefore: Record<string, number>;
  let pipe: {id: string; name: string; stages: {id: string; name: string; probability: number; color: string}[]};
  let lonely: Row;
  let ticket: {id: string; number: number};
  let tMsgs: number;
  let tActs: number;
  let bulkTwo: string[];
  let victim: Row;
  let mine: Row;

  const ticketActs = (id: string) => db.activity.count({where: {data: {path: ['ticketId'], equals: id}, type: {startsWith: 'ticket_'}}});

  beforeAll(async () => {
    configureEnv();
    fakeStorage();
    await resetCrm();
    storedFiles.clear();
    hooks = stubHooks();
    ({c: o, me} = await workspace(true));
    m = crm((await teammate(o.browser, 'member@example.com', 'MEMBER')).browser);
    viewer = crm((await teammate(o.browser, 'viewer@example.com', 'VIEWER')).browser);
    await meOf(m);
    // A webhook on deleted / restored events proves the *.deleted events still fire (deliveries are made).
    const hook = await o.post('/webhooks', {url: HOOK_URL, events: ['contact.deleted', 'contact.restored', 'company.deleted', 'deal.deleted', 'ticket.deleted', 'ticket.restored']});
    expect(hook.status, 'webhook created').toBe(201);
  });
  afterAll(async () => {
    hooks.restore();
    await db.$disconnect();
  });

  it('contact: delete moves it and everything hanging off it to the bin', async () => {
    maya = must<{rows: Row[]}>(await o.get('/contacts?q=Maya'), 'maya').rows[0]!;
    expect(maya, 'found demo contact Maya').toBeTruthy();
    file = await attach(o, {contactId: maya.id}, 'notes.txt', 'hello world');
    expect(file.id, 'uploaded an attachment').toBeTruthy();
    list = must<{list: Row}>(await o.post('/lists', {name: 'Bin test list', kind: 'STATIC', contactIds: [maya.id]}), 'list').list;
    const noteAct = await db.activity.findFirstOrThrow({where: {contactId: maya.id, type: 'note'}});
    must(await o.post(`/comments/activity/${noteAct.id}`, {body: 'A comment on the note'}), 'comment');
    // Unlinked-on-delete rows: an email thread + message and a form response.
    await db.emailThread.create({data: {id: `thread_${tag}`, subject: 'Hi', contactId: maya.id}});
    await db.emailMessage.create({data: {id: `msg_${tag}`, threadId: `thread_${tag}`, direction: 'INBOUND', status: 'RECEIVED', fromEmail: 'maya@x.test', to: [], subject: 'Hi', contactId: maya.id}});
    await db.form.create({data: {id: `form_${tag}`, name: 'Bin form', slug: `bin-form-${tag}`}});
    await db.formSubmission.create({data: {id: `sub_${tag}`, formId: `form_${tag}`, contactId: maya.id, email: 'maya@x.test'}});
    await db.follow.create({data: {userId: me.id, entity: 'CONTACT', recordId: maya.id}});

    before = await related('contactId', maya.id);
    contactRow = (await db.contact.findUniqueOrThrow({where: {id: maya.id}})) as unknown as Record<string, unknown>;
    const kinds = ['notes', 'tasks', 'interactions', 'companies', 'deals', 'lists', 'comments', 'files', 'threads', 'submissions', 'tickets'];
    expect(kinds.filter((k) => !(before[k]! >= 1)), `fixture has every kind of related row ${JSON.stringify(before)}`).toEqual([]);

    const del = await o.del(`/contacts/${maya.id}`);
    expect(del.status).toBe(200);
    expect(del.json.binId, 'DELETE returns a bin id').toBeTruthy();
    expect(await db.contact.findUnique({where: {id: maya.id}}), 'contact is gone').toBeNull();
    expect((await db.file.findUnique({where: {id: file.id}}))?.purpose, 'attachment parked as trash').toBe('trash');
    expect((await o.get(`/files/${file.id}`)).status, 'trashed file is not served').toBe(404);
    expect((await db.emailThread.findUniqueOrThrow({where: {id: `thread_${tag}`}})).contactId, 'email thread unlinked by the delete').toBeNull();
    expect(await eventCount('contact.deleted', maya.id), 'contact.deleted event still fires').toBe(1);
    expect(await db.webhookDelivery.count({where: {eventType: 'contact.deleted'}}), 'webhook delivery made for contact.deleted').toBeGreaterThanOrEqual(1);
    entry = (await binEntry(o, 'contact', maya.id))!;
    expect(entry.counts.note, 'bin lists the contact with its notes').toBeGreaterThanOrEqual(1);
    expect(entry.counts.file, '…its files').toBeGreaterThanOrEqual(1);
    expect(entry.deletedByName, '…and who deleted it').toBe(me.name);
    expect(new Date(entry.expiresAt).getTime() - new Date(entry.deletedAt).getTime(), 'expires after 30 days').toBe(30 * day);
  });

  it('contact: restore brings back every related row, the same columns, the file, a timeline entry, an event, an audit entry', async () => {
    const res = must<{restored: Restored}>(await o.post(`/recycle-bin/${entry.id}/restore`), 'restore');
    expect(res.restored.path, 'restore answers with the record path').toBe(`/contacts/${maya.id}`);
    expect(await related('contactId', maya.id), 'every related row is back').toEqual(before);
    const row = (await db.contact.findUniqueOrThrow({where: {id: maya.id}})) as unknown as Record<string, unknown>;
    for (const k of ['firstName', 'lastName', 'email', 'phone', 'title', 'lifecycleStage', 'ownerId', 'tags', 'custom', 'createdAt']) expect(row[k], `contact column ${k} identical`).toEqual(contactRow[k]);
    expect((await db.file.findUniqueOrThrow({where: {id: file.id}})).purpose, 'file un-trashed and relinked').toBe('attachment');
    expect(await db.activity.count({where: {contactId: maya.id, type: 'restored'}}), 'timeline shows "Restored from the recycle bin"').toBe(1);
    expect(await eventCount('contact.restored', maya.id), 'contact.restored event emitted').toBe(1);
    expect(await db.deletedRecord.findUnique({where: {id: entry.id}}), 'bin entry removed after restore').toBeNull();
    expect(await db.auditLog.count({where: {action: 'contact.restored', recordId: maya.id}}), 'restore is audited').toBe(1);
  });

  it('company: delete unlinks its deals', async () => {
    company = must<{rows: Row[]}>(await o.get('/companies?q=Northwind'), 'companies').rows[0]!;
    cBefore = await related('companyId', company.id);
    expect((await o.del(`/companies/${company.id}`)).status, 'company deleted').toBe(200);
    expect(await db.deal.count({where: {companyId: company.id}}), 'deals unlinked by the delete').toBe(0);
  });

  it('company: restore relinks contacts, deal links, primary deals, notes, activity', async () => {
    const cEntry = (await binEntry(o, 'company', company.id))!;
    must(await o.post(`/recycle-bin/${cEntry.id}/restore`), 'company restored');
    expect(await related('companyId', company.id)).toEqual(cBefore);
  });

  it('deal: delete fires deal.deleted and the bin shows its value', async () => {
    deal = must<{rows: (Row & {contacts: unknown[]})[]}>(await o.get('/deals?status=ALL'), 'deals').rows.find((d) => d.contacts.length)!;
    dBefore = await related('dealId', deal.id);
    expect((await o.del(`/deals/${deal.id}`)).status, 'deal deleted').toBe(200);
    expect(await eventCount('deal.deleted', deal.id), 'deal.deleted event still fires').toBe(1);
    const dEntry = (await binEntry(o, 'deal', deal.id))!;
    expect(/\$|·/.test(dEntry.detail ?? ''), `deal shows value in the bin: ${dEntry.detail}`).toBe(true);
  });

  it('deal: restore brings back contacts, companies, stage changes, tasks and emits deal.restored', async () => {
    const dEntry = (await binEntry(o, 'deal', deal.id))!;
    must(await o.post(`/recycle-bin/${dEntry.id}/restore`), 'deal restored');
    expect(await related('dealId', deal.id)).toEqual(dBefore);
    expect(await eventCount('deal.restored', deal.id), 'deal.restored event').toBe(1);
  });

  it('deal: its stage can be removed while the deal is in the bin', async () => {
    pipe = must<{rows: (typeof pipe)[]}>(await o.get('/pipelines'), 'pipelines').rows[0]!;
    lonely = must<{deal: Row}>(await o.post('/deals', {title: 'Stage goes away', pipelineId: pipe.id, stageId: pipe.stages.at(-1)!.id}), 'deal').deal;
    const stagesOf = (s: typeof pipe.stages) => s.map((x) => ({id: x.id, name: x.name, probability: x.probability, color: x.color}));
    const withStage = must<{pipeline: typeof pipe}>(await o.put(`/pipelines/${pipe.id}`, {name: pipe.name, stages: [...stagesOf(pipe.stages), {name: 'Temp stage', probability: 5}]}), 'add stage').pipeline;
    const temp = withStage.stages.find((s) => s.name === 'Temp stage')!;
    must(await o.patch(`/deals/${lonely.id}`, {stageId: temp.id}), 'move');
    must(await o.del(`/deals/${lonely.id}`), 'delete');
    const removeTemp = await o.put(`/pipelines/${pipe.id}`, {name: pipe.name, stages: stagesOf(pipe.stages)});
    expect(removeTemp.status, `stage removable while its only deal is in the bin: ${JSON.stringify(removeTemp.json)}`).toBe(200);
  });

  it('deal: restored into the first stage with a warning when its stage was deleted', async () => {
    const lEntry = (await binEntry(o, 'deal', lonely.id))!;
    const lRes = must<{restored: Restored}>(await o.post(`/recycle-bin/${lEntry.id}/restore`), 'restore');
    expect(lRes.restored.warning ?? '', 'restored into the first stage with a warning').toMatch(/stage was deleted/);
    expect((await db.deal.findUniqueOrThrow({where: {id: lonely.id}})).stageId, 'deal sits in the first stage').toBe(pipe.stages[0]!.id);
  });

  it('ticket: delete removes its timeline entries and fires ticket.deleted', async () => {
    ticket = must<{rows: {id: string; number: number}[]}>(await o.get('/tickets?status=all'), 'tickets').rows[0]!;
    must(await o.post(`/tickets/${ticket.number}/messages`, {kind: 'note', body: 'Internal note before delete'}), 'note');
    tMsgs = await db.ticketMessage.count({where: {ticketId: ticket.id}});
    tActs = await ticketActs(ticket.id);
    expect((await o.del(`/tickets/${ticket.number}`)).status, 'ticket deleted (admin)').toBe(200);
    expect(await ticketActs(ticket.id), 'ticket timeline entries removed with it').toBe(0);
    expect(await eventCount('ticket.deleted', ticket.id), 'ticket.deleted event').toBe(1);
  });

  it('ticket: restore brings back the thread, the timeline and the same number', async () => {
    const tEntry = (await binEntry(o, 'ticket', ticket.id))!;
    const tRes = must<{restored: Restored}>(await o.post(`/recycle-bin/${tEntry.id}/restore`), 'restore');
    expect(tRes.restored.path, 'ticket restored, path uses the number').toBe(`/tickets/${ticket.number}`);
    expect(await db.ticketMessage.count({where: {ticketId: ticket.id}}), 'thread messages back').toBe(tMsgs);
    expect(await ticketActs(ticket.id), 'ticket timeline entries back').toBe(tActs);
    expect((await db.ticket.findUniqueOrThrow({where: {id: ticket.id}})).number, 'same ticket number').toBe(ticket.number);
    expect((await o.get(`/tickets/${ticket.number}`)).status, 'ticket opens again').toBe(200);
  });

  it('form and list: deleted into the bin', async () => {
    expect((await o.del(`/forms/form_${tag}`)).status, 'form deleted').toBe(200);
    await db.form.create({data: {id: `form2_${tag}`, name: 'Takes the slug', slug: `bin-form-${tag}`}});
    expect(await binEntry(o, 'form', `form_${tag}`), 'form in the bin').toBeTruthy();
    expect((await o.del(`/lists/${list.id}`)).status, 'list deleted').toBe(200);
    expect(await binEntry(o, 'list', list.id), 'list in the bin').toBeTruthy();
  });

  it('form: restored under a free link, with its responses (this form names no team member)', async () => {
    const fEntry = (await binEntry(o, 'form', `form_${tag}`))!;
    const fRes = must<{restored: Restored}>(await o.post(`/recycle-bin/${fEntry.id}/restore`), 'form restore');
    expect(fRes.restored.warning ?? '', 'form restored under a free link').toMatch(new RegExp(`bin-form-${tag}-2`));
    expect(await db.formSubmission.count({where: {formId: `form_${tag}`}}), 'form responses back').toBe(1);
  });

  it('list: restored with its members', async () => {
    const liEntry = (await binEntry(o, 'list', list.id))!;
    must(await o.post(`/recycle-bin/${liEntry.id}/restore`), 'list restore');
    expect(await db.contactListMember.count({where: {listId: list.id}}), 'list members back').toBe(1);
  });

  it('links whose other side is in the bin are skipped, and come back with it', async () => {
    const co2 = must<{rows: (Row & {_count: {contacts: number}})[]}>(await o.get('/companies'), 'companies').rows.find((x) => x._count.contacts > 0)!;
    const person = must<{rows: Row[]}>(await o.get(`/contacts?companyId=${co2.id}`), 'people').rows[0]!;
    await o.del(`/companies/${co2.id}`);
    await o.del(`/contacts/${person.id}`);
    const pEntry = (await binEntry(o, 'contact', person.id))!;
    must(await o.post(`/recycle-bin/${pEntry.id}/restore`), 'contact restored while its company is in the bin');
    expect(await db.contactCompany.count({where: {contactId: person.id}}), 'company link skipped').toBe(0);
    const coEntry = (await binEntry(o, 'company', co2.id))!;
    await o.post(`/recycle-bin/${coEntry.id}/restore`);
    expect(await db.contactCompany.count({where: {contactId: person.id, companyId: co2.id}}), 'restoring the company brings the link back').toBe(1);
  });

  it('bulk delete puts each record in the bin and emits contact.deleted per record', async () => {
    bulkTwo = must<{rows: Row[]}>(await o.get('/contacts?pageSize=2&sort=createdAt&dir=asc'), 'two').rows.map((r) => r.id);
    expect((await o.post('/contacts/bulk', {ids: bulkTwo, action: 'delete'})).status, 'bulk delete').toBe(200);
    const entries = must<{rows: BinRow[]}>(await o.get('/recycle-bin?entity=contact'), 'bin').rows.filter((r) => bulkTwo.includes(r.recordId));
    expect(entries, 'both contacts in the bin').toHaveLength(2);
    const events = await db.event.findMany({where: {type: 'contact.deleted', recordId: {in: bulkTwo}}, select: {recordId: true}, distinct: ['recordId']});
    expect(events, 'bulk delete still emits contact.deleted per record').toHaveLength(2);
    const cos = must<{rows: Row[]}>(await o.get('/companies?pageSize=2'), 'companies').rows.map((r) => r.id);
    must(await o.post('/companies/bulk', {ids: cos, action: 'delete'}), 'bulk company delete');
    const coBulk = must<{rows: BinRow[]}>(await o.get('/recycle-bin?entity=company'), 'bin').rows.filter((r) => cos.includes(r.recordId));
    expect(coBulk, 'bulk company delete goes to the bin').toHaveLength(2);
  });

  it('bulk restore', async () => {
    const entries = must<{rows: BinRow[]}>(await o.get('/recycle-bin?entity=contact'), 'bin').rows.filter((r) => bulkTwo.includes(r.recordId));
    const bRes = must<{restored: unknown[]; failed: unknown[]}>(await o.post('/recycle-bin/restore', {ids: entries.map((e) => e.id)}), 'bulk restore');
    expect([bRes.restored.length, bRes.failed.length]).toEqual([2, 0]);
  });

  it('permissions: members see and act on their own deletions only, viewers cannot restore', async () => {
    mine = must<{contact: Row}>(await m.post('/contacts', {firstName: 'Member', lastName: 'Made', email: `member.made.${tag}@example.test`}), 'mine').contact;
    expect((await m.del(`/contacts/${mine.id}`)).status, 'member deletes their contact').toBe(200);
    victim = must<{contact: Row}>(await o.post('/contacts', {firstName: 'Owner', lastName: 'Deleted', email: `owner.deleted.${tag}@example.test`}), 'victim').contact;
    must(await o.del(`/contacts/${victim.id}`), 'owner delete');
    const mBin = must<{rows: BinRow[]}>(await m.get('/recycle-bin'), 'member bin');
    expect(mBin.rows.map((r) => r.recordId), 'member only sees what they deleted').toEqual([mine.id]);
    const oVictim = (await binEntry(o, 'contact', victim.id))!;
    expect((await m.post(`/recycle-bin/${oVictim.id}/restore`)).status, "member can't restore someone else's deletion").toBe(404);
    expect((await m.del(`/recycle-bin/${mBin.rows[0]!.id}`)).status, "member can't delete forever").toBe(403);
    expect((await viewer.post(`/recycle-bin/${oVictim.id}/restore`)).status, 'viewer cannot restore').toBe(403);
  });

  it('permissions: a member restores their own deletion', async () => {
    const mBin = must<{rows: BinRow[]}>(await m.get('/recycle-bin'), 'member bin');
    expect((await m.post(`/recycle-bin/${mBin.rows[0]!.id}/restore`)).status, 'member restores their own').toBe(200);
  });

  it('delete forever, and the 30-day purge removes expired entries with their trashed files', async () => {
    const temp2 = must<{contact: Row}>(await o.post('/contacts', {firstName: 'Purge', lastName: 'Me'}), 'temp2').contact;
    const tempFile = await attach(o, {contactId: temp2.id}, 'bye.txt', 'bye');
    must(await o.del(`/contacts/${temp2.id}`), 'delete temp2');
    const t2Entry = (await binEntry(o, 'contact', temp2.id))!;
    const oVictim = (await binEntry(o, 'contact', victim.id))!;
    expect((await o.del(`/recycle-bin/${oVictim.id}`)).status, 'admin deletes forever').toBe(200);
    expect(await db.deletedRecord.findUnique({where: {id: oVictim.id}}), 'entry gone').toBeNull();
    expect(await db.auditLog.count({where: {action: 'bin.purged', recordId: victim.id}}), 'purge audited').toBe(1);
    await db.deletedRecord.update({where: {id: t2Entry.id}, data: {expiresAt: new Date(Date.now() - 60_000)}});
    // The daily crm-prune schedule (the old cron run).
    await tick(purgeExpiredBin);
    expect(await db.deletedRecord.findUnique({where: {id: t2Entry.id}}), 'expired entry purged').toBeNull();
    expect(await db.file.findUnique({where: {id: tempFile.id}}), 'its trashed file deleted too').toBeNull();
  });
});

describe.skipIf(!DATABASE_URL)('ported: duplicates (scripts/test-hygiene.mjs duplicates)', () => {
  let o: Crm;
  let me: Me;
  let pairs: Record<'gmail' | 'plusTag' | 'phone' | 'nameCompany' | 'similar', Row[]>;
  let lookAlikes: Record<'sameNameElsewhere' | 'switchboard' | 'colleagues' | 'closeNames', Row[]>;
  let coPairs: Record<'domain' | 'name', Row[]>;
  let coLookAlikes: Record<'differentDomains' | 'differentNames', Row[]>;

  const pairOf = (entity: string, a: Row, b: Row) => {
    const [aId, bId] = [a.id, b.id].sort();
    return db.duplicatePair.findFirst({where: {entity, aId, bId}});
  };

  beforeAll(async () => {
    configureEnv();
    await resetCrm();
    ({c: o, me} = await workspace(false));
    const company = async (name: string, extra: Record<string, unknown> = {}) => must<{company: Row}>(await o.post('/companies', {name, ...extra}), 'company').company;
    const contact = async (body: Record<string, unknown>) => {
      const r = await o.post('/contacts', body);
      expect(r.status, `create contact ${JSON.stringify(body)}: ${JSON.stringify(r.json)}`).toBe(201);
      return (r.json as {contact: Row}).contact;
    };
    const acme = await company(`Acmeco ${tag}`, {domain: `acmeco-${tag}.io`});
    const yoyo = await company(`Yoyodyne ${tag}`);
    const other1 = await company(`Hooli ${tag}`);
    const other2 = await company(`Pied Piper ${tag}`);
    pairs = {
      gmail: [await contact({firstName: 'Jordan', lastName: `Blake${tag}`, email: `jordan.blake.${tag}@gmail.com`}), await contact({firstName: 'Jordan', lastName: `Blake${tag}`, email: `jordanblake${tag}@googlemail.com`})],
      plusTag: [await contact({firstName: 'Priya', lastName: `Natarajan${tag}`, email: `priya.${tag}@example-corp.io`}), await contact({firstName: 'PRIYA', lastName: `natarajan${tag}`, email: `Priya.${tag}+crm@Example-Corp.io`})],
      phone: [await contact({firstName: 'Lukas', lastName: `Meyer${tag}`, phone: '+1 (415) 555-0134'}), await contact({firstName: 'Lukas', lastName: `Meier${tag}`, phone: '415.555.0134'})],
      nameCompany: [await contact({firstName: 'Elena', lastName: `Rossi${tag}`, email: `elena.${tag}@a-mail.io`, companyId: acme.id}), await contact({firstName: 'Elena', lastName: `Rossi${tag}`, email: `e.rossi.${tag}@b-mail.io`, companyId: acme.id})],
      similar: [await contact({firstName: 'Jon', lastName: `Smith${tag}`, companyId: yoyo.id}), await contact({firstName: 'John', lastName: `Smith${tag}`, companyId: yoyo.id})],
    };
    lookAlikes = {
      sameNameElsewhere: [await contact({firstName: 'Chris', lastName: `Taylor${tag}`, email: `chris.${tag}@hooli-x.io`, companyId: other1.id}), await contact({firstName: 'Chris', lastName: `Taylor${tag}`, email: `chris.${tag}@piedpiper-x.io`, companyId: other2.id})],
      switchboard: [await contact({firstName: 'Ana', lastName: `Lopez${tag}`, phone: '+1 212 555 0199'}), await contact({firstName: 'Mark', lastName: `Chen${tag}`, phone: '(212) 555-0199'})],
      colleagues: [await contact({firstName: 'Alice', lastName: `Wong${tag}`, companyId: acme.id}), await contact({firstName: 'Bob', lastName: `Stone${tag}`, companyId: acme.id})],
      closeNames: [await contact({firstName: 'Sam', lastName: `Lee${tag}`, email: `sam.${tag}@one-x.io`}), await contact({firstName: 'Samantha', lastName: `Leeds${tag}`, email: `samantha.${tag}@two-x.io`})],
    };
    coPairs = {
      domain: [await company(`Globex Corporation ${tag}`, {domain: `globex-${tag}.com`}), await company(`Globex Corp. ${tag}`, {website: `https://www.globex-${tag}.com/about`})],
      name: [await company(`Initech LLC ${tag}`), await company(`Initech ${tag}`)],
    };
    coLookAlikes = {
      differentDomains: [await company(`Northwind ${tag}`, {domain: `northwind-${tag}.com`}), await company(`Northwind ${tag}`, {domain: `northwind-${tag}.de`})],
      differentNames: [await company(`Acme Labs ${tag}`, {domain: `acmelabs-${tag}.com`}), await company(`Acme Logistics ${tag}`, {domain: `acmelog-${tag}.com`})],
    };
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it('detects pairs on create (no scan yet)', async () => {
    for (const [name, [a, b]] of Object.entries(pairs)) {
      const p = await pairOf('contact', a!, b!);
      expect(p?.status, `contacts · ${name}`).toBe('open');
    }
    for (const [name, [a, b]] of Object.entries(coPairs)) expect(await pairOf('company', a!, b!), `companies · ${name}`).toBeTruthy();
  });

  it('a full scan finds the same pairs with their reasons, and stays precise on look-alikes', async () => {
    const scan = await o.post('/duplicates/scan', {});
    expect(scan.status, 'scan ran').toBe(200);
    const want: Record<string, [string, number]> = {gmail: ['email', 85], plusTag: ['email', 85], phone: ['phone', 85], nameCompany: ['name_company', 85], similar: ['similar_name', 60]};
    for (const [name, [a, b]] of Object.entries(pairs)) {
      const p = await pairOf('contact', a!, b!);
      const [reason, min] = want[name]!;
      expect(p?.reasons, `${name}: ${reason}`).toContain(reason);
      expect(p?.score, `${name}: score ≥ ${min}`).toBeGreaterThanOrEqual(min);
    }
    const low = async (p: Promise<{score: number} | null>) => (await p)?.score ?? 0;
    expect(await low(pairOf('contact', lookAlikes.sameNameElsewhere[0]!, lookAlikes.sameNameElsewhere[1]!)), 'same name at different companies with different emails stays low confidence').toBeLessThan(60);
    expect(await low(pairOf('contact', lookAlikes.switchboard[0]!, lookAlikes.switchboard[1]!)), 'shared switchboard number with different names stays low confidence').toBeLessThan(60);
    expect(await pairOf('contact', lookAlikes.colleagues[0]!, lookAlikes.colleagues[1]!), 'colleagues at the same company are not paired').toBeNull();
    expect(await pairOf('contact', lookAlikes.closeNames[0]!, lookAlikes.closeNames[1]!), 'Sam Lee / Samantha Leeds with different emails are not paired').toBeNull();
    const coDomain = await pairOf('company', coPairs.domain[0]!, coPairs.domain[1]!);
    expect(coDomain?.reasons, 'company domain from website matches domain').toContain('domain');
    expect(coDomain?.score).toBeGreaterThanOrEqual(95);
    const coName = await pairOf('company', coPairs.name[0]!, coPairs.name[1]!);
    expect(coName?.reasons, 'company name ignores LLC').toContain('company_name');
    expect(coName?.score).toBeGreaterThanOrEqual(85);
    expect(await low(pairOf('company', coLookAlikes.differentDomains[0]!, coLookAlikes.differentDomains[1]!)), 'same name, different domains stays low confidence').toBeLessThan(60);
    expect(await pairOf('company', coLookAlikes.differentNames[0]!, coLookAlikes.differentNames[1]!), 'different names on different domains are not paired').toBeNull();
    const mineIds = [...Object.values(pairs), ...Object.values(lookAlikes)].flat().map((c) => c.id);
    const high = await db.duplicatePair.findMany({where: {entity: 'contact', score: {gte: 60}, aId: {in: mineIds}, bId: {in: mineIds}}});
    expect(high, 'only the 5 real pairs reach medium / high confidence').toHaveLength(Object.keys(pairs).length);
  });

  it('the queue API lists pairs by confidence, with counts and the last scan', async () => {
    const q1 = must<{rows: {id: string; score: number; a: {firstName?: string}}[]; total: number}>(await o.get('/duplicates?entity=contact'), 'queue');
    expect(q1.rows.length > 0 && q1.rows[0]!.a.firstName !== undefined, 'queue lists pairs with both records').toBe(true);
    expect(q1.rows.every((r, i, all) => i === 0 || all[i - 1]!.score >= r.score), 'sorted by confidence').toBe(true);
    const counts = must<{contact: number; company: number; lastScan: {contact?: string}}>(await o.get('/duplicates/counts'), 'counts');
    expect(counts.contact, 'counts').toBeGreaterThanOrEqual(5);
    expect(counts.company).toBeGreaterThanOrEqual(2);
    expect(counts.lastScan.contact, 'last scan time').toBeTruthy();
  });

  it('the create-time hint', async () => {
    type Hint = {matches: {reasons: string[]; label: string}[]};
    const hint = must<Hint>(await o.post('/duplicates/check', {entity: 'contact', firstName: 'Jordan', lastName: `Blake${tag}`, email: `JORDAN.blake.${tag}+new@gmail.com`}), 'hint');
    expect(hint.matches[0]?.reasons, 'contact hint finds the gmail duplicate').toContain('email');
    expect(hint.matches[0]?.label.startsWith('Jordan')).toBe(true);
    expect(must<Hint>(await o.post('/duplicates/check', {entity: 'contact', firstName: 'L', lastName: 'M', phone: '415 555 0134'}), 'phone hint').matches.length, 'phone-only hint').toBeGreaterThanOrEqual(1);
    expect(must<Hint>(await o.post('/duplicates/check', {entity: 'company', name: 'Globex', domain: `globex-${tag}.com`}), 'company hint').matches.some((x) => x.reasons.includes('domain')), 'company hint by domain').toBe(true);
    expect(must<Hint>(await o.post('/duplicates/check', {entity: 'contact', firstName: 'Zebulon', lastName: `Quartermaine${tag}`, email: `zq.${tag}@nowhere-x.io`}), 'none').matches, 'no hint for a new person').toHaveLength(0);
  });

  it('"not a duplicate" sticks through rescans and is audited; viewers cannot change the queue', async () => {
    const ncPair = (await pairOf('contact', pairs.nameCompany[0]!, pairs.nameCompany[1]!))!;
    expect((await o.post(`/duplicates/${ncPair.id}/dismiss`)).status, 'dismissed').toBe(200);
    must(await o.post('/duplicates/scan', {entity: 'contact'}), 'rescan');
    expect((await db.duplicatePair.findUniqueOrThrow({where: {id: ncPair.id}})).status, 'stays dismissed after a rescan').toBe('dismissed');
    expect(must<{rows: Row[]}>(await o.get('/duplicates?entity=contact'), 'open').rows.some((r) => r.id === ncPair.id), 'not in the open queue').toBe(false);
    expect(must<{rows: Row[]}>(await o.get('/duplicates?entity=contact&status=dismissed'), 'dismissed').rows.some((r) => r.id === ncPair.id), 'listed under not duplicates').toBe(true);
    expect(await db.auditLog.count({where: {action: 'duplicate.dismissed'}}), 'dismiss audited').toBeGreaterThanOrEqual(1);
    const viewer = crm((await teammate(o.browser, 'viewer@example.com', 'VIEWER')).browser);
    expect((await viewer.post(`/duplicates/${ncPair.id}/reopen`)).status, 'viewer cannot change the queue').toBe(403);
  });

  it('merge from the queue moves everything and clears the pair', async () => {
    const [keep, drop] = pairs.gmail as [Row, Row];
    const list = must<{list: Row}>(await o.post('/lists', {name: `Merge list ${tag}`, kind: 'STATIC', contactIds: [drop.id]}), 'list').list;
    const ticket = must<{ticket: Row}>(await o.post('/tickets', {subject: `Merge ticket ${tag}`, contactId: drop.id}), 'ticket').ticket;
    await db.booking.create({data: {id: `book_${tag}`, contactId: drop.id, title: 'Intro', startAt: new Date(), endAt: new Date(Date.now() + 30 * 60_000), name: 'Jordan', email: 'j@x.io'}});
    must(await o.post('/interactions', {kind: 'MEETING', title: 'Kickoff', contactId: keep.id, attendeeIds: [keep.id, drop.id]}), 'meeting');
    await db.follow.create({data: {userId: me.id, entity: 'CONTACT', recordId: drop.id}});
    const form = await db.form.create({data: {name: 'Dup form', slug: `dup-form-${tag}`}});
    await db.formSubmission.create({data: {id: `dsub_${tag}`, formId: form.id, contactId: drop.id}});
    const gPair = (await pairOf('contact', keep, drop))!;
    const merged = await o.post(`/contacts/${keep.id}/merge`, {otherId: drop.id, keep: 'this'});
    expect(merged.status, JSON.stringify(merged.json)).toBe(200);
    expect(await db.duplicatePair.findUnique({where: {id: gPair.id}}), 'the pair leaves the queue').toBeNull();
    expect(await db.contactListMember.count({where: {listId: list.id, contactId: keep.id}}), 'list membership moved').toBe(1);
    expect((await db.ticket.findUniqueOrThrow({where: {id: ticket.id}})).contactId, 'ticket moved').toBe(keep.id);
    expect((await db.booking.findUniqueOrThrow({where: {id: `book_${tag}`}})).contactId, 'booking moved').toBe(keep.id);
    const att = (await db.interaction.findFirst({where: {contactId: keep.id, title: 'Kickoff'}}))?.attendeeIds;
    expect(att, 'meeting attendees point at the kept contact once').toEqual([keep.id]);
    expect(await db.follow.count({where: {entity: 'CONTACT', recordId: keep.id}}), 'followers moved').toBe(1);
    expect(await db.follow.count({where: {recordId: drop.id}}), 'no followers left on the dropped id').toBe(0);
    expect((await db.formSubmission.findUnique({where: {id: `dsub_${tag}`}}))?.contactId, 'form response moved').toBe(keep.id);
    const ma = await db.auditLog.findFirst({where: {action: 'contact.merged', recordId: keep.id}});
    expect((ma?.meta as {droppedId?: string} | undefined)?.droppedId, 'merge audited with the dropped record').toBe(drop.id);
    const [ca, cb] = coPairs.domain as [Row, Row];
    expect((await o.post(`/companies/${ca.id}/merge`, {otherId: cb.id})).status).toBe(200);
    expect(await pairOf('company', ca, cb), 'company merge clears its pair').toBeNull();
    expect(await db.auditLog.count({where: {action: 'company.merged', recordId: ca.id}}), 'company merge audited').toBe(1);
  });

  it('a pair is hidden while one record is in the bin', async () => {
    const [p1] = pairs.plusTag as [Row, Row];
    const ppair = (await pairOf('contact', pairs.plusTag[0]!, pairs.plusTag[1]!))!;
    must(await o.del(`/contacts/${p1.id}`), 'delete');
    expect(must<{rows: Row[]}>(await o.get('/duplicates?entity=contact'), 'queue').rows.some((r) => r.id === ppair.id), 'pair hidden while one record is in the bin').toBe(false);
  });

  it('the pair comes back after a restore', async () => {
    const [p1] = pairs.plusTag as [Row, Row];
    const ppair = (await pairOf('contact', pairs.plusTag[0]!, pairs.plusTag[1]!))!;
    const entry = must<{rows: BinRow[]}>(await o.get('/recycle-bin?entity=contact'), 'bin').rows.find((r) => r.recordId === p1.id)!;
    must(await o.post(`/recycle-bin/${entry.id}/restore`), 'restore');
    expect(must<{rows: Row[]}>(await o.get('/duplicates?entity=contact'), 'queue').rows.some((r) => r.id === ppair.id), 'pair back after restore').toBe(true);
  });

  it('owner-only visibility: a member sees only pairs and hints of their own records', async () => {
    must(await o.patch('/settings', {recordVisibility: 'owner'}), 'visibility owner');
    try {
      const m = crm((await teammate(o.browser, 'member@example.com', 'MEMBER')).browser);
      const memberId = (await meOf(m)).id;
      const mq = must<{rows: {a: {owner?: {id: string}}; b: {owner?: {id: string}}}[]}>(await m.get('/duplicates?entity=contact'), 'member queue');
      expect(mq.rows.every((r) => r.a.owner?.id === memberId && r.b.owner?.id === memberId), 'with owner-only visibility a member only sees pairs of their own records').toBe(true);
      const mh = must<{matches: unknown[]}>(await m.post('/duplicates/check', {entity: 'contact', firstName: 'Jordan', lastName: `Blake${tag}`, email: `jordan.blake.${tag}@gmail.com`}), 'member hint');
      expect(mh.matches, "…nor others' records in the create hint").toHaveLength(0);
    } finally {
      must(await o.patch('/settings', {recordVisibility: 'everyone'}), 'visibility back');
    }
  });

  it('the schedule queues a scan per entity when none ran in 6 hours, and they run', async () => {
    await db.setting.deleteMany({where: {key: 'duplicates.lastScan'}});
    const startedAt = Date.now();
    // The daily crm-prune (the old cron run) queues them; here the jobs run as they are sent.
    await tick(scheduleDuplicateScans);
    const counts = must<{lastScan: {contact?: string; company?: string}}>(await o.get('/duplicates/counts'), 'counts');
    expect(Date.parse(counts.lastScan.contact ?? '') >= startedAt - 1000, 'contact scan ran').toBe(true);
    expect(Date.parse(counts.lastScan.company ?? '') >= startedAt - 1000, 'company scan ran').toBe(true);
  });
});

describe.skipIf(!DATABASE_URL)('ported: audit log (scripts/test-hygiene.mjs audit)', () => {
  let o: Crm;
  let me: Me;
  let mem: Me;
  let memberC: Crm;
  let t0: Date;
  let secrets: string[];
  let resend: ReturnType<typeof stubFetch>;
  let hooks: ReturnType<typeof stubHooks>;
  const since = (action: string, where: Record<string, unknown> = {}) => db.auditLog.findFirst({where: {action, createdAt: {gte: t0}, ...where}, orderBy: {createdAt: 'desc'}});

  beforeAll(async () => {
    configureEnv();
    fakeStorage();
    await resetCrm();
    storedFiles.clear();
    env.RESEND_API_KEY = 're_test_ported_audit';
    resend = stubFetch((u) => u.hostname === 'api.resend.com', () => new Response('{"data":[]}', {status: 200}));
    hooks = stubHooks();
    t0 = new Date(Date.now() - 1000);
    ({c: o, me} = await workspace(true));
  });
  afterAll(async () => {
    resend.restore();
    hooks.restore();
    delete env.RESEND_API_KEY;
    await db.$disconnect();
  });

  it('team: invite, accept, role change, deactivation, reactivation', async () => {
    memberC = crm((await teammate(o.browser, 'audit-member@example.com', 'MEMBER')).browser);
    mem = await meOf(memberC);
    expect(await since('team.invited'), 'invite').toBeTruthy();
    expect(await since('auth.invite_accepted'), 'invite accepted').toBeTruthy();
    must(await o.patch(`/team/${mem.id}`, {role: 'VIEWER'}), 'role');
    const role = await since('team.role_changed');
    expect(role?.meta, 'role change with from / to').toMatchObject({from: 'MEMBER', to: 'VIEWER'});
    must(await o.patch(`/team/${mem.id}`, {active: false}), 'deactivate');
    expect(await since('team.deactivated'), 'deactivation').toBeTruthy();
    must(await o.patch(`/team/${mem.id}`, {active: true, role: 'MEMBER'}), 'reactivate');
    expect(await since('team.reactivated'), 'reactivation').toBeTruthy();
  });

  it('settings: branding with a diff, email accounts, tickets, email design', async () => {
    must(await o.patch('/settings', {brandName: 'Kinroot QA'}), 'brand');
    const st = await since('settings.updated');
    expect((st?.meta as {changes?: {field: string; to: unknown}[]})?.changes?.some((ch) => ch.field === 'brandName' && ch.to === 'Kinroot QA'), 'branding change with a diff').toBe(true);
    must(await o.patch('/settings', {brandName: 'Kinroot'}), 'brand back');
    // SMTP is gone: a Resend account (its key is the owner secret RESEND_API_KEY, never typed in).
    const acct = await o.post('/email/accounts', {credentials: {provider: 'RESEND'}, account: {fromName: 'QA', fromEmail: 'qa@kinroot-mail.io'}});
    expect(acct.status, 'email account added').toBe(201);
    expect(await since('email_account.connected'), 'email account connected').toBeTruthy();
    must(await o.del(`/email/accounts/${(acct.json.account as Row).id}`), 'remove account');
    expect(await since('email_account.removed'), 'email account removed').toBeTruthy();
    must(await o.patch('/tickets/settings', {portalEnabled: true}), 'ticket settings');
    expect(await since('settings.tickets'), 'ticket settings').toBeTruthy();
    must(await o.put('/email/design', {footerText: 'Thanks!'}), 'design');
    expect(await since('settings.email_design'), 'email design').toBeTruthy();
  });

  it('records: every action family is logged', async () => {
    const c1 = must<{contact: Row}>(await o.post('/contacts', {firstName: 'Audit', lastName: 'Person', email: 'audit.person@example.test'}), 'contact').contact;
    must(await o.patch(`/contacts/${c1.id}`, {title: 'CFO'}), 'update');
    const upd = await since('contact.updated');
    const ch = (upd?.meta as {changes?: {field: string; to: unknown}[]})?.changes?.[0];
    expect([upd?.recordId, ch?.field, ch?.to], 'contact update with field diff').toEqual([c1.id, 'title', 'CFO']);
    must(await o.del(`/contacts/${c1.id}`), 'delete');
    expect(!!(await since('contact.created')) && !!(await since('contact.deleted')), 'contact created + deleted').toBe(true);
    const co = must<{company: Row}>(await o.post('/companies', {name: 'Audit Co'}), 'company').company;
    must(await o.patch(`/companies/${co.id}`, {industry: 'Software'}), 'company update');
    must(await o.del(`/companies/${co.id}`), 'company delete');
    expect(!!(await since('company.created')) && !!(await since('company.updated')) && !!(await since('company.deleted')), 'company created, updated, deleted').toBe(true);
    const deal = must<{deal: Row}>(await o.post('/deals', {title: 'Audit deal', value: 100}), 'deal').deal;
    must(await o.post(`/deals/${deal.id}/status`, {status: 'WON'}), 'won');
    expect((await since('deal.status_changed'))?.meta, 'deal won').toMatchObject({to: 'WON'});
    must(await o.del(`/deals/${deal.id}`), 'deal delete');
    expect(!!(await since('deal.created')) && !!(await since('deal.deleted')), 'deal created + deleted').toBe(true);
    const tk = must<{ticket: {number: number}}>(await o.post('/tickets', {subject: 'Audit ticket'}), 'ticket').ticket;
    must(await o.patch(`/tickets/${tk.number}`, {priority: 'HIGH'}), 'ticket update');
    must(await o.del(`/tickets/${tk.number}`), 'ticket delete');
    expect(!!(await since('ticket.created')) && !!(await since('ticket.updated')) && !!(await since('ticket.deleted')), 'ticket created, updated, deleted').toBe(true);
    const form = must<{form: Row}>(await o.post('/forms', {name: 'Audit form'}), 'form').form;
    must(await o.post(`/forms/${form.id}/status`, {status: 'PUBLISHED'}), 'publish');
    must(await o.patch(`/forms/${form.id}`, {name: 'Audit form 2'}), 'form update');
    expect((await o.get(`/forms/${form.id}/export`)).status, 'form responses CSV').toBe(200);
    must(await o.del(`/forms/${form.id}`), 'form delete');
    expect(!!(await since('form.created')) && !!(await since('form.status_changed')) && !!(await since('form.updated')) && !!(await since('form.deleted')), 'form created, published, updated, deleted').toBe(true);
    const list = must<{list: Row}>(await o.post('/lists', {name: 'Audit list', kind: 'STATIC'}), 'list').list;
    must(await o.patch(`/lists/${list.id}`, {name: 'Audit list 2'}), 'list update');
    must(await o.del(`/lists/${list.id}`), 'list delete');
    expect(!!(await since('list.created')) && !!(await since('list.updated')) && !!(await since('list.deleted')), 'list created, updated, deleted').toBe(true);
    const link = must<{link: Row}>(await o.post('/scheduling/links', {name: 'Audit call'}), 'link').link;
    must(await o.patch(`/scheduling/links/${link.id}`, {active: false}), 'link update');
    must(await o.del(`/scheduling/links/${link.id}`), 'link delete');
    expect(!!(await since('booking_link.created')) && !!(await since('booking_link.updated')) && !!(await since('booking_link.deleted')), 'booking link created, updated, deleted').toBe(true);
    const tpl = must<{template: Row}>(await o.post('/email/templates', {name: 'Audit tpl', subject: 'Hi', body: 'Hello'}), 'template').template;
    must(await o.patch(`/email/templates/${tpl.id}`, {name: 'Audit tpl 2'}), 'template update');
    must(await o.del(`/email/templates/${tpl.id}`), 'template delete');
    expect(!!(await since('template.created')) && !!(await since('template.updated')) && !!(await since('template.deleted')), 'template created, updated, deleted').toBe(true);
    const field = must<{field: Row}>(await o.post('/fields', {entity: 'CONTACT', label: 'Audit field', type: 'TEXT'}), 'field').field;
    must(await o.del(`/fields/${field.id}`), 'field delete');
    expect(!!(await since('custom_field.created')) && !!(await since('custom_field.deleted')), 'custom field created + deleted').toBe(true);
  });

  it('webhooks and secrets: reveal (fingerprint only), rotate, share links', async () => {
    const hook = must<{webhook: Row; secret: string}>(await o.post('/webhooks', {url: HOOK_URL, events: ['*']}), 'webhook');
    must(await o.get(`/webhooks/${hook.webhook.id}/secret`), 'reveal');
    const rev = await since('webhook.secret_revealed');
    expect(rev?.category, 'secret reveal logged as security').toBe('security');
    expect((rev?.meta as {signingKey?: string})?.signingKey, '…with a fingerprint').toMatch(/^[0-9a-f]{12}$/);
    const rot = must<{secret: string}>(await o.post(`/webhooks/${hook.webhook.id}/rotate`), 'rotate');
    expect(await since('webhook.secret_rotated'), 'secret rotation').toBeTruthy();
    must(await o.del(`/webhooks/${hook.webhook.id}`), 'webhook delete');
    expect(!!(await since('webhook.created')) && !!(await since('webhook.deleted')), 'webhook created + deleted').toBe(true);
    secrets = [hook.secret, rot.secret];
    const maya = must<{rows: Row[]}>(await o.get('/contacts?q=Maya'), 'maya').rows[0]!;
    const file = await attach(o, {contactId: maya.id}, 'share.txt', 'x');
    must(await o.post(`/files/${file.id}/link`, {days: 3}), 'share link');
    const share = await since('file.share_link');
    expect([share?.category, (share?.meta as {days?: number})?.days], 'file share link').toEqual(['security', 3]);
  });

  it('exports: CSV and JSON exports are logged, list exports with the list', async () => {
    // Small exports (one page) are written and audited during the request.
    for (const entity of ['contact', 'company', 'deal']) must(await o.post('/exports', {entity, filters: {q: entity === 'contact' ? 'Maya' : ''}, columns: ['id']}), `export ${entity}`);
    const maya = must<{rows: Row[]}>(await o.get('/contacts?q=Maya'), 'maya').rows[0]!;
    for (const path of [`/contacts/${maya.id}/export`, '/reports/forecast.csv']) expect((await o.get(path)).status, path).toBe(200);
    const exports = await db.auditLog.findMany({where: {category: 'export', createdAt: {gte: t0}}, select: {action: true}});
    expect(exports.filter((e) => e.action === 'export.completed').length, 'export.completed logged').toBeGreaterThanOrEqual(3);
    expect(exports.some((e) => e.action === 'export.csv'), 'CSV export logged').toBe(true);
    expect(exports.some((e) => e.action === 'export.json'), 'JSON export logged').toBe(true);
    const list = must<{list: Row}>(await o.post('/lists', {name: 'Export list', kind: 'STATIC', contactIds: [maya.id]}), 'list').list;
    const listExport = await o.post('/exports', {entity: 'contact', listId: list.id, columns: ['email']});
    expect(listExport.status).toBe(201);
    const logged = await db.auditLog.findMany({where: {action: 'export.completed', createdAt: {gte: t0}}, select: {meta: true}});
    expect(logged.some((l) => (l.meta as {listId?: string}).listId === list.id), 'list export logged with the list').toBe(true);
  });

  it('no secret reaches the table', async () => {
    const all = JSON.stringify(await db.auditLog.findMany({select: {meta: true, label: true}}));
    for (const s of [...secrets, 're_test_ported_audit', 'a long test passphrase']) expect(all.includes(s), `"${s.slice(0, 12)}…" not stored`).toBe(false);
  });

  it('the audit API: paging, facets, filters, search, CSV export (itself audited), admins only', async () => {
    type Page = {rows: {category: string; actorId: string | null; action: string; entity: string | null; label: string | null; ip: string | null}[]; total: number; actions: string[]};
    const page = must<Page>(await o.get('/audit?pageSize=5'), 'page');
    expect(page.rows, 'paged list').toHaveLength(5);
    expect(page.total, 'paged list total').toBeGreaterThan(50);
    expect(page.actions, 'with action facets').toContain('team.invited');
    const auth = must<Page>(await o.get('/audit?category=auth&pageSize=200'), 'auth');
    expect(auth.rows.length > 0 && auth.rows.every((r) => r.category === 'auth'), 'filter by kind').toBe(true);
    const byActor = must<Page>(await o.get(`/audit?actorId=${mem.id}&pageSize=200`), 'actor');
    expect(byActor.rows.length > 0 && byActor.rows.every((r) => r.actorId === mem.id), 'filter by user').toBe(true);
    const byAction = must<Page>(await o.get('/audit?action=team.role_changed'), 'action');
    expect(byAction.total > 0 && byAction.rows.every((r) => r.action === 'team.role_changed'), 'filter by action').toBe(true);
    const byEntity = must<Page>(await o.get('/audit?entity=ticket&pageSize=200'), 'entity');
    expect(byEntity.rows.length > 0 && byEntity.rows.every((r) => r.entity === 'ticket'), 'filter by record type').toBe(true);
    const today = new Date().toISOString().slice(0, 10);
    expect(must<Page>(await o.get(`/audit?from=${today}&to=${today}`), 'today').total, 'date range: today').toBeGreaterThan(0);
    expect(must<Page>(await o.get('/audit?to=2000-01-01'), 'old').total, 'date range: long ago').toBe(0);
    // IPs are kept as a keyed hash (never the address): entries from one browser share it, and search finds them by it.
    const ownerIps = new Set((await db.auditLog.findMany({where: {actorId: me.id, ip: {not: null}}, select: {ip: true}})).map((r) => r.ip));
    expect(ownerIps.size, 'one keyed hash for the owner’s address').toBe(1);
    const ip = [...ownerIps][0]!;
    expect(ip.startsWith('h:') && !ip.includes('203.0.113'), 'the address itself is not stored').toBe(true);
    const search = must<Page>(await o.get(`/audit?q=${encodeURIComponent(ip)}&pageSize=200`), 'ip search');
    expect(search.total > 0 && search.rows.every((r) => r.ip === ip), 'search by (hashed) IP').toBe(true);
    expect(must<Page>(await o.get('/audit?q=Audit%20deal'), 'name search').rows.some((r) => r.label === 'Audit deal'), 'search by record name').toBe(true);
    const csv = await o.get('/audit/export.csv?category=team');
    const text = String(csv.json.text ?? '');
    expect([csv.status, csv.headers.get('content-type')?.includes('text/csv')], 'CSV export').toEqual([200, true]);
    expect(text.split('\r\n')[0]!.startsWith('createdAt,actorName'), 'CSV header').toBe(true);
    expect(text, 'CSV with readable actions').toContain('Changed a role');
    expect(await since('export.csv', {entity: 'audit'}), 'exporting the audit log is itself audited').toBeTruthy();
    expect((await memberC.get('/audit')).status, 'members cannot read the audit log').toBe(403);
    expect((await memberC.get('/audit/export.csv')).status, '…or export it').toBe(403);
  });

  it('retention: the default prunes after 365 days, a shorter period prunes more, only offered periods', async () => {
    await db.auditLog.createMany({data: [
      {id: `old1_${tag}`, action: 'contact.created', category: 'record', createdAt: new Date(Date.now() - 100 * day)},
      {id: `old2_${tag}`, action: 'contact.created', category: 'record', createdAt: new Date(Date.now() - 400 * day)},
    ]});
    // The daily crm-prune (the old cron run).
    await tick(pruneAudit);
    expect([!!(await db.auditLog.findUnique({where: {id: `old1_${tag}`}})), !!(await db.auditLog.findUnique({where: {id: `old2_${tag}`}}))], 'default 365 days: older entries pruned').toEqual([true, false]);
    expect((await o.put('/audit/settings', {retentionDays: 42})).status, 'only offered periods').toBe(422);
    must(await o.put('/audit/settings', {retentionDays: 90}), 'retention 90');
    await tick(pruneAudit);
    expect(await db.auditLog.findUnique({where: {id: `old1_${tag}`}}), 'shorter retention prunes more').toBeNull();
    expect(await since('settings.audit'), 'retention change audited').toBeTruthy();
    must(await o.put('/audit/settings', {retentionDays: 365}), 'retention back');
  });
});
