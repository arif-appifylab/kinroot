// Ported from Kinroot's scripts/test-automations.mjs
// Covers automations end to end: event triggers per module, conditions, if / else, every step, waits, date and inactivity triggers, manual and segment runs, dry runs, loops, re-enrollment, retries, history, permissions.
import {randomUUID} from 'node:crypto';

import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {automationTick} from '../../../src/server/crm/lib/automations';
import {crmJob} from '../../../src/server/crm/lib/jobs';
import {env} from '../support/cloudflare-workers';
import {resetCrm, teammate} from '../support/crm';
import {app} from '../../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db} from '../support/harness';
import {ago, crmDb, crmOwner, fakeOutbound, inScope, type Member, memberOf, must, outbound, signatureValid, wakeRun, ZAPIER} from './support';

/**
 * One scenario, in order, as the original script ran it (later blocks use the records earlier
 * ones made). What changed (PLAN.md): email goes through Resend (owner secret RESEND_API_KEY),
 * webhook steps only to the listed services (Zapier here), both faked at `fetch`; jobs run
 * in-process when sent, a wait is a job kept in `JobBacklog` until due, the old `/jobs/run`
 * date / inactivity pass is `automationTick()`, and a job the platform would retry is run again
 * by calling its handler with the next attempt number. Timestamps are moved with JS dates (the
 * columns are UTC `timestamp`s; the test database's zone may differ).
 */

const TAG = 'autotest';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const MAIL = 'kinroot-mail.dev';

type Automation = {id: string; name: string; enabled: boolean; steps: unknown};
type Run = {id: string; recordId: string | null; recordLabel: string | null; status: string; error: string | null; depth: number; chainId: string; context: unknown; ownerId: string | null; startedById: string | null};
type Contact = {id: string; firstName: string; email?: string | null};
type Stage = {id: string};

const step = (id: string, type: string, rest: Record<string, unknown> = {}) => ({id, type, ...rest});
const block = (target: string, rules: unknown[], match = 'all') => ({match, blocks: [{target, rules: {match: 'all', groups: [{match: 'all', rules}]}}]});
const tagged = (values = [TAG]) => block('contact', [{field: 'tags', op: 'has_any', values}]);
const dayPlus = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

describe.skipIf(!DATABASE_URL)('Ported: automations (integration, real Postgres)', () => {
  let owner: Browser;
  let member: Browser;
  let viewer: Browser;
  let me: Member;
  let memberUser: Member;
  let shared: {id: string};
  let pipeline: {id: string};
  let stageA: Stage, stageB: Stage, stageC: Stage;
  let list: {id: string};
  let field: {key: string};
  let renewal: {key: string};
  let contactN = 0;
  // Records later blocks use.
  let a1: Automation, a5: Automation, vip: Contact, intern: Contact, outsider: Contact, small: {id: string}, big: {id: string}, booker: Contact;
  let r1: Run[] = [];
  let a32: Automation;

  const api = (path: string) => `/site-api/crm${path}`;
  const patch = (b: Browser, path: string, body: unknown) => b.request('PATCH', api(path), body);
  async function automation(body: Record<string, unknown>, {enable = true} = {}) {
    const a = must<{automation: Automation}>(await owner.post(api('/automations'), {timezone: 'UTC', ...body}), `create ${body.name}`).automation;
    if (enable) must(await owner.post(api(`/automations/${a.id}/enable`), {enabled: true}), `enable ${body.name}`);
    return a;
  }
  const off = (a: Automation) => owner.post(api(`/automations/${a.id}/enable`), {enabled: false});
  const runsOf = (a: Automation, where: Record<string, unknown> = {}) =>
    db.automationRun.findMany({where: {automationId: a.id, ...where}, orderBy: [{startedAt: 'asc'}, {id: 'asc'}]}) as unknown as Promise<Run[]>;
  const stepsOf = (run: {id: string}) => db.automationRunStep.findMany({where: {runId: run.id}, orderBy: [{startedAt: 'asc'}, {id: 'asc'}]});
  const tagsOf = async (id: string) => (await db.contact.findUnique({where: {id}, select: {tags: true}}))?.tags ?? [];
  const contact = async (extra: Record<string, unknown> = {}) =>
    must<{contact: Contact}>(await owner.post(api('/contacts'), {firstName: `Auto${++contactN}`, lastName: 'Tester', tags: [TAG], ...extra}), 'contact').contact;
  const notified = (userId: string, title: string) => db.notification.findFirst({where: {userId, title}});
  /** The old POST /jobs/run's date and inactivity pass. */
  const tick = () => inScope(() => automationTick(crmDb));

  beforeAll(async () => {
    configureEnv();
    fakeOutbound();
    env.RESEND_API_KEY = 're_test_key';
    await resetCrm();
    outbound.reset();
    // The owner's address must be one Resend could deliver to (not example.com), for the notify step's email copy.
    ({browser: owner, me} = await crmOwner(`owner@${MAIL}`));
    must(await owner.post(api('/auth/setup'), {brandName: 'Kinroot', demoData: false}), 'setup');
    member = (await teammate(owner, 'member@example.com', 'MEMBER')).browser;
    viewer = (await teammate(owner, 'viewer@example.com', 'VIEWER')).browser;
    memberUser = await memberOf(member);
    const own = must(await owner.post(api('/email/accounts'), {credentials: {provider: 'RESEND'}, account: {fromName: 'Owner', fromEmail: `owner-box@${MAIL}`, isDefault: true}}), 'own mailbox').account as {status: string};
    shared = must(await owner.post(api('/email/accounts'), {credentials: {provider: 'RESEND'}, account: {fromName: 'Team', fromEmail: `team@${MAIL}`, shared: true}}), 'shared mailbox').account as {id: string; status: string};
    expect([own.status, (shared as {status?: string}).status]).toEqual(['CONNECTED', 'CONNECTED']);
    const p = must<{rows: {id: string; stages: Stage[]}[]}>(await owner.get(api('/pipelines')), 'pipelines').rows.find((x) => x.stages.length >= 3)!;
    pipeline = p;
    [stageA, stageB, stageC] = p.stages as [Stage, Stage, Stage];
    list = must(await owner.post(api('/lists'), {name: 'Customers', kind: 'STATIC'}), 'list').list as {id: string};
    field = must(await owner.post(api('/fields'), {entity: 'CONTACT', label: 'Auto note', type: 'TEXT'}), 'custom field').field as {key: string};
    renewal = must(await owner.post(api('/fields'), {entity: 'COMPANY', label: 'Renewal', type: 'DATE'}), 'company date field').field as {key: string};
  });
  afterAll(async () => {
    delete env.RESEND_API_KEY;
    await db.$disconnect();
  });

  it('permissions and validation', async () => {
    const draftBody = {name: 'Draft', object: 'contact', trigger: {kind: 'event', event: 'contact.created', filter: {}}, steps: []};
    expect((await member.post(api('/automations'), draftBody)).status).toBe(403);
    expect((await viewer.post(api('/automations'), draftBody)).status).toBe(403);
    const empty = await automation(draftBody, {enable: false});
    const enableEmpty = await owner.post(api(`/automations/${empty.id}/enable`), {enabled: true});
    expect(enableEmpty.status).toBe(400);
    expect(String(enableEmpty.json.error)).toMatch(/Add at least one step/);
    const badList = await automation({...draftBody, name: 'Bad list', steps: [step('s1', 'add_to_list', {listId: 'nope'})]}, {enable: false});
    const enableBad = await owner.post(api(`/automations/${badList.id}/enable`), {enabled: true});
    expect(enableBad.status).toBe(400);
    expect(String(enableBad.json.error)).toMatch(/no longer exists/);
    expect((await member.get(api('/automations'))).status).toBe(200);
    expect((await patch(member, `/automations/${empty.id}`, draftBody)).status).toBe(403);
    expect((await member.post(api(`/automations/${empty.id}/enable`), {enabled: true})).status).toBe(403);
    expect((await member.delete(api(`/automations/${empty.id}`))).status).toBe(403);
    expect((await member.post(api(`/automations/${empty.id}/test`), {})).status).toBe(403);
    expect((await owner.post(api('/automations'), {...draftBody, trigger: {kind: 'date', field: 'x', amount: -1, unit: 'days', direction: 'before'}})).status).toBe(422);
  });

  it('contact.created: trigger conditions, if / else on segment rules, task, tag, custom field, timeline, audit', async () => {
    a1 = await automation({
      name: 'Welcome',
      object: 'contact',
      trigger: {kind: 'event', event: 'contact.created', filter: {}, conditions: tagged()},
      steps: [
        step('t1', 'create_task', {title: 'Welcome {{contact.full_name}}', dueDays: 1, time: '10:00', assignee: 'owner', taskType: 'CALL', priority: 'HIGH'}),
        step('if1', 'if', {conditions: block('contact', [{field: 'title', op: 'contains', value: 'VIP'}]), then: [step('y1', 'add_tag', {target: 'contact', tag: 'vip-yes'})], else: [step('n1', 'add_tag', {target: 'contact', tag: 'vip-no'})]}),
        step('u1', 'update_field', {target: 'contact', field: `custom.${field.key}`, value: 'Set by {{automation.name}}'}),
      ],
    });
    vip = await contact({title: 'VIP buyer', email: `vip@${MAIL}`});
    intern = await contact({title: 'Intern', email: `intern@${MAIL}`});
    outsider = await contact({tags: []});
    r1 = await runsOf(a1);
    expect(r1.map((r) => r.status)).toEqual(['done', 'done']);
    expect(r1.some((r) => r.recordId === outsider.id)).toBe(false);
    expect(await tagsOf(vip.id)).toContain('vip-yes');
    expect(await tagsOf(vip.id)).not.toContain('vip-no');
    expect(await tagsOf(intern.id)).toContain('vip-no');

    const task1 = await db.task.findFirst({where: {contactId: vip.id}});
    expect(task1).toMatchObject({title: 'Welcome Auto1 Tester', assigneeId: me.id, type: 'CALL'});
    expect(task1!.dueAt!.getUTCHours()).toBe(10);
    const custom1 = (await db.contact.findUniqueOrThrow({where: {id: vip.id}})).custom as Record<string, unknown>;
    expect(custom1[field.key]).toBe('Set by Welcome');
    const act = await db.activity.findFirst({where: {contactId: vip.id, type: 'field_changed'}, orderBy: {createdAt: 'desc'}});
    const actData = act?.data as {automation?: {name?: string}; changes?: {field: string}[]};
    expect(actData?.automation?.name).toBe('Welcome');
    expect(act?.actorId).toBeNull();
    expect(actData?.changes?.some((c) => c.field === `custom.${field.key}`)).toBe(true);
    const aud = await db.auditLog.findFirst({where: {recordId: vip.id, action: 'contact.updated'}, orderBy: {createdAt: 'desc'}});
    expect((aud?.meta as {automationId?: string})?.automationId).toBe(a1.id);
    expect(aud?.actorId).toBeNull();
    const s1 = await stepsOf(r1[0]!);
    expect(s1).toHaveLength(4);
    expect(s1.every((s) => s.status === 'done')).toBe(true);
    expect((s1.find((s) => s.type === 'if')?.output as {branch?: string})?.branch).toBeTruthy();
    await off(a1);
  });

  it('contact.updated: the "field changed" filter (built-in and custom fields), notify the owner', async () => {
    const a2 = await automation({
      name: 'Lifecycle watch',
      object: 'contact',
      trigger: {kind: 'event', event: 'contact.updated', filter: {field: 'lifecycleStage'}, conditions: tagged()},
      steps: [step('n', 'notify', {assignee: 'owner', title: 'Lifecycle of {{contact.full_name}} is now set', body: 'See {{record.url}}'})],
    });
    must(await patch(owner, `/contacts/${intern.id}`, {city: 'Berlin'}), 'city');
    expect(await runsOf(a2)).toHaveLength(0);
    must(await patch(owner, `/contacts/${intern.id}`, {lifecycleStage: 'QUALIFIED'}), 'lifecycle');
    expect(await runsOf(a2)).toHaveLength(1);
    const note2 = await db.notification.findFirst({where: {userId: me.id, type: 'automation', title: {startsWith: 'Lifecycle of Auto2 Tester'}}});
    expect(note2?.link).toBe(`/contacts/${intern.id}`);
    expect(note2?.body).toContain(`/contacts/${intern.id}`);

    const a2b = await automation({name: 'Custom watch', object: 'contact', trigger: {kind: 'event', event: 'contact.updated', filter: {field: `custom.${field.key}`}, conditions: tagged()}, steps: [step('t', 'add_tag', {target: 'contact', tag: 'custom-changed'})]});
    must(await patch(owner, `/contacts/${intern.id}`, {custom: {[field.key]: 'by hand'}}), 'custom by hand');
    expect(await tagsOf(intern.id)).toContain('custom-changed');
    await off(a2);
    await off(a2b);
  });

  it('companies and deals: created, stage changed (filters + property conditions), won (ticket, list, contact, new deal)', async () => {
    const a3 = await automation({name: 'Company industry', object: 'company', trigger: {kind: 'event', event: 'company.created', filter: {}, conditions: block('company', [{field: 'name', op: 'contains', value: 'Autoco'}])}, steps: [step('u', 'update_field', {target: 'company', field: 'industry', value: 'Software'})]});
    const co = must(await owner.post(api('/companies'), {name: 'Autoco'}), 'company').company as {id: string};
    expect((await db.company.findUniqueOrThrow({where: {id: co.id}})).industry).toBe('Software');
    await off(a3);

    const a4 = await automation({
      name: 'Stage B priority',
      object: 'deal',
      trigger: {kind: 'event', event: 'deal.stage_changed', filter: {pipelineId: pipeline.id, stageId: stageB.id}, conditions: block('deal', [{field: 'value', op: 'gt', value: '1000'}])},
      steps: [step('u', 'update_field', {target: 'deal', field: 'priority', value: 'High'})],
    });
    big = must(await owner.post(api('/deals'), {title: 'Big deal', value: 5000, pipelineId: pipeline.id, stageId: stageA.id, contactIds: [intern.id], companyId: co.id}), 'big deal').deal as {id: string};
    small = must(await owner.post(api('/deals'), {title: 'Small deal', value: 10, pipelineId: pipeline.id, stageId: stageA.id}), 'small deal').deal as {id: string};
    must(await patch(owner, `/deals/${small.id}`, {stageId: stageB.id}), 'small → B');
    must(await patch(owner, `/deals/${big.id}`, {stageId: stageC.id}), 'big → C');
    expect(await runsOf(a4)).toHaveLength(0);
    must(await patch(owner, `/deals/${big.id}`, {stageId: stageB.id}), 'big → B');
    expect((await db.deal.findUniqueOrThrow({where: {id: big.id}})).priority).toBe('High');
    await off(a4);

    a5 = await automation({
      name: 'Deal won onboarding',
      object: 'deal',
      trigger: {kind: 'event', event: 'deal.won', filter: {pipelineId: pipeline.id}, conditions: block('deal', [{field: 'title', op: 'contains', value: 'deal'}])},
      steps: [
        step('t', 'create_ticket', {subject: 'Onboarding: {{deal.title}}', description: 'For {{company.name}}', priority: 'HIGH', assignee: 'owner'}),
        step('l', 'add_to_list', {listId: list.id}),
        step('u', 'update_field', {target: 'contact', field: 'leadStatus', value: 'Onboarding'}),
        step('d', 'create_deal', {title: 'Expansion · {{company.name}}', pipelineId: pipeline.id, stageId: stageA.id, value: 250, assignee: 'user', userId: memberUser.id}),
      ],
    });
    must(await owner.post(api(`/deals/${big.id}/status`), {status: 'WON'}), 'won');
    const onboarding = await db.ticket.findFirst({where: {subject: 'Onboarding: Big deal'}});
    expect(onboarding).toMatchObject({priority: 'HIGH', contactId: intern.id, dealId: big.id, assigneeId: me.id});
    expect(await db.contactListMember.findFirst({where: {listId: list.id, contactId: intern.id}})).toBeTruthy();
    expect((await db.contact.findUniqueOrThrow({where: {id: intern.id}})).leadStatus).toBe('Onboarding');
    const expansion = await db.deal.findFirst({where: {title: 'Expansion · Autoco'}});
    expect(expansion).toMatchObject({ownerId: memberUser.id, value: 250, stageId: stageA.id});
    const listAct = await db.activity.findFirst({where: {contactId: intern.id, type: 'list_added'}, orderBy: {createdAt: 'desc'}});
    expect(listAct?.data).toMatchObject({automation: {id: a5.id}, source: 'automation'});
    await off(a5);
  });

  it('form.submitted (one form) and list.member_added (one list)', async () => {
    const formRes = must(await owner.post(api('/forms'), {name: 'Auto form'}), 'form') as {form?: {id: string}};
    const formId = formRes.form?.id ?? (await db.form.findFirstOrThrow({where: {name: 'Auto form'}})).id;
    must(await owner.post(api(`/forms/${formId}/status`), {status: 'PUBLISHED'}), 'publish');
    const form = must(await owner.get(api(`/forms/${formId}`)), 'form detail').form as {slug: string; fields: {id: string; type: string}[]};
    const a6 = await automation({name: 'Form follow-up', object: 'contact', trigger: {kind: 'event', event: 'form.submitted', filter: {formId}}, steps: [step('t', 'create_task', {title: 'Form follow-up {{contact.email}}', dueDays: 0, assignee: 'creator'}), step('g', 'add_tag', {target: 'contact', tag: TAG})]});
    const answers: Record<string, unknown> = {};
    for (const f of form.fields) {
      if (f.type === 'name') answers[f.id] = {first: 'Formy', last: 'Tester'};
      if (f.type === 'email') answers[f.id] = `formy@${MAIL}`;
    }
    const visitor = new Browser(app, '198.51.100.31');
    must(await visitor.post(api(`/public/forms/${form.slug}/submit`), {answers, meta: {}, startedAt: Date.now() - 10_000}), 'submit');
    expect(await db.task.findFirst({where: {title: `Form follow-up formy@${MAIL}`}})).toBeTruthy();
    await off(a6);

    const a7 = await automation({name: 'Listed', object: 'contact', trigger: {kind: 'event', event: 'list.member_added', filter: {listId: list.id}}, steps: [step('t', 'add_tag', {target: 'contact', tag: 'listed'}), step('r', 'remove_from_list', {listId: list.id})]});
    must(await owner.post(api(`/lists/${list.id}/members`), {contactIds: [vip.id]}), 'add member');
    expect(await tagsOf(vip.id)).toContain('listed');
    expect(await db.contactListMember.findFirst({where: {listId: list.id, contactId: vip.id}})).toBeNull();
    await off(a7);
  });

  it('tickets: created → round robin + priority; status changed (filter) → tag + notify the assignee', async () => {
    const a8 = await automation({
      name: 'Ticket triage',
      object: 'ticket',
      trigger: {kind: 'event', event: 'ticket.created', filter: {}, conditions: block('ticket', [{field: 'subject', op: 'contains', value: 'RR'}])},
      steps: [step('rr', 'assign_owner', {target: 'ticket', assignMode: 'round_robin', userIds: [me.id, memberUser.id], onlyIfEmpty: true}), step('p', 'update_field', {target: 'ticket', field: 'priority', value: 'URGENT'})],
    });
    const tix: {id: string; number: number}[] = [];
    for (let i = 0; i < 3; i++) tix.push(must(await owner.post(api('/tickets'), {subject: `RR #${i}`, assigneeId: null, contactId: vip.id}), 'ticket').ticket as {id: string; number: number});
    const assignees = await Promise.all(tix.map((t) => db.ticket.findUniqueOrThrow({where: {id: t.id}, select: {assigneeId: true, priority: true}})));
    expect(assignees[0]!.assigneeId).not.toBe(assignees[1]!.assigneeId);
    expect(assignees[0]!.assigneeId).toBe(assignees[2]!.assigneeId);
    expect(assignees.every((x) => [me.id, memberUser.id].includes(x.assigneeId ?? ''))).toBe(true);
    expect(assignees.every((x) => x.priority === 'URGENT')).toBe(true);
    expect(await db.ticketMessage.count({where: {ticketId: tix[0]!.id, kind: 'event', data: {path: ['type'], equals: 'assigned'}}})).toBe(1);
    await off(a8);

    const a9 = await automation({name: 'Resolved', object: 'ticket', trigger: {kind: 'event', event: 'ticket.status_changed', filter: {status: 'RESOLVED'}}, steps: [step('t', 'add_tag', {target: 'ticket', tag: 'auto-resolved'}), step('n', 'notify', {assignee: 'assignee', title: 'Ticket #{{ticket.number}} resolved: {{ticket.subject}}'})]});
    must(await patch(owner, `/tickets/${tix[1]!.number}`, {status: 'WAITING_ON_CONTACT'}), 'waiting');
    expect(await runsOf(a9)).toHaveLength(0);
    must(await patch(owner, `/tickets/${tix[1]!.number}`, {status: 'RESOLVED'}), 'resolve');
    expect((await db.ticket.findUniqueOrThrow({where: {id: tix[1]!.id}})).tags).toContain('auto-resolved');
    expect(await notified(assignees[1]!.assigneeId!, `Ticket #${tix[1]!.number} resolved: RR #1`)).toBeTruthy();
    await off(a9);
  });

  it("meeting.booked moves the contact's deal to a stage, as the automation", async () => {
    booker = await contact({email: `booker@${MAIL}`});
    const bookerDeal = must(await owner.post(api('/deals'), {title: 'Booker deal', value: 100, pipelineId: pipeline.id, stageId: stageA.id, contactIds: [booker.id]}), 'booker deal').deal as {id: string};
    const a10 = await automation({name: 'Meeting stage', object: 'deal', trigger: {kind: 'event', event: 'meeting.booked', filter: {}}, steps: [step('u', 'update_field', {target: 'deal', field: 'stageId', value: stageC.id})]});
    const link = must(await owner.post(api('/scheduling/links'), {name: 'Auto intro', timezone: 'UTC'}), 'booking link').link as {id: string};
    const slots = must<{slots: string[]}>(await owner.get(api(`/public/booking/slots?linkId=${link.id}&duration=30&from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 21 * DAY).toISOString())}`)), 'slots').slots;
    expect(slots.length).toBeGreaterThan(0);
    const visitor = new Browser(app, '198.51.100.32');
    // Bookings carry the widget's idempotency key (docs/agent/orders-and-stock.md).
    must(await visitor.request('POST', api('/public/booking/book'), {linkId: link.id, start: slots[0], duration: 30, timezone: 'UTC', name: 'Booker Tester', email: `booker@${MAIL}`, startedAt: Date.now() - 10_000}, {'idempotency-key': randomUUID()}), 'book');
    expect((await db.deal.findUniqueOrThrow({where: {id: bookerDeal.id}})).stageId).toBe(stageC.id);
    const moved = await db.activity.findFirst({where: {dealId: bookerDeal.id, type: 'stage_changed'}, orderBy: {createdAt: 'desc'}});
    expect((moved?.data as {automation?: {id?: string}})?.automation?.id).toBe(a10.id);
    expect(await db.event.findFirst({where: {type: 'deal.stage_changed', recordId: bookerDeal.id}})).toBeTruthy();
    await off(a10);
  });

  it('activity triggers: note added, task completed, call logged', async () => {
    const a11 = await automation({name: 'Noted', object: 'contact', trigger: {kind: 'event', event: 'note.created', filter: {}, conditions: tagged()}, steps: [step('t', 'add_tag', {target: 'contact', tag: 'noted'})]});
    must(await owner.post(api('/notes'), {body: 'Hello', contactId: vip.id}), 'note');
    const a12 = await automation({name: 'Task done', object: 'deal', trigger: {kind: 'event', event: 'task.completed', filter: {}}, steps: [step('n', 'notify', {assignee: 'creator', title: 'Done on {{deal.title}}'})]});
    const t12 = must(await owner.post(api('/tasks'), {title: 'Deal task', dealId: small.id}), 'task').task as {id: string};
    must(await patch(owner, `/tasks/${t12.id}`, {done: true}), 'complete');
    const a13 = await automation({name: 'Called', object: 'contact', trigger: {kind: 'event', event: 'interaction.logged', filter: {kind: 'CALL'}}, steps: [step('t', 'add_tag', {target: 'contact', tag: 'called'})]});
    must(await owner.post(api('/interactions'), {kind: 'MEETING', contactId: vip.id, title: 'Meet'}), 'meeting logged');
    must(await owner.post(api('/interactions'), {kind: 'CALL', contactId: vip.id, title: 'Call'}), 'call logged');
    expect(await tagsOf(vip.id)).toContain('noted');
    expect(await notified(me.id, 'Done on Small deal')).toBeTruthy();
    expect(await runsOf(a13)).toHaveLength(1);
    expect(await tagsOf(vip.id)).toContain('called');
    for (const a of [a11, a12, a13]) await off(a);
  });

  it('send email steps (own and shared mailbox), opt-out skipped, notify by email, email.opened', async () => {
    const optedOut = await contact({email: `optout@${MAIL}`, emailOptOut: true});
    const a14 = await automation({
      name: 'Mailer',
      object: 'contact',
      trigger: {kind: 'event', event: 'contact.updated', filter: {field: 'title'}, conditions: tagged()},
      steps: [
        step('e', 'send_email', {subject: 'Hi {{contact.first_name}} from {{owner.name}}', html: '<p>Hello {{contact.first_name|there}}, about {{automation.name}}.</p>', layout: 'branded', from: 'owner'}),
        step('e2', 'send_email', {subject: 'Shared hello {{contact.first_name}}', html: '<p>From the team</p>', layout: 'plain', from: 'shared', accountId: shared.id}),
        step('n', 'notify', {assignee: 'owner', title: 'Emailed {{contact.full_name}}', email: true}),
      ],
    });
    const mailsBefore = outbound.mails.length;
    must(await patch(owner, `/contacts/${vip.id}`, {title: 'VIP champion'}), 'title change');
    must(await patch(owner, `/contacts/${optedOut.id}`, {title: 'Anything'}), 'opted-out title');
    const sent = outbound.mails.slice(mailsBefore);
    const toVip = sent.filter((m) => m.to.includes(`vip@${MAIL}`));
    expect(toVip, JSON.stringify(sent.map((m) => m.to))).toHaveLength(2);
    expect(toVip.some((m) => m.subject === `Hi Auto1 from ${me.name}`)).toBe(true);
    expect(sent.some((m) => m.to.includes(`optout@${MAIL}`))).toBe(false);
    const optRun = (await runsOf(a14)).find((r) => r.recordId === optedOut.id);
    const optSteps = optRun ? await stepsOf(optRun) : [];
    expect(optRun?.status).toBe('done');
    const mailSteps = optSteps.filter((s) => s.type === 'send_email');
    expect(mailSteps).toHaveLength(2);
    expect(mailSteps.every((s) => s.status === 'skipped' && /opted out/.test((s.output as {summary?: string}).summary ?? ''))).toBe(true);
    expect(sent.some((m) => m.to.includes(`owner@${MAIL}`)), 'notify step also emailed the owner').toBe(true);
    const sentMsg = await db.emailMessage.findFirst({where: {contactId: vip.id, direction: 'OUTBOUND', subject: `Hi Auto1 from ${me.name}`}});
    expect(sentMsg).toMatchObject({status: 'SENT', senderId: me.id});
    const emailAct = await db.activity.findFirst({where: {refId: sentMsg!.id, type: 'email_out'}});
    expect((emailAct?.data as {automation?: {id?: string}})?.automation?.id).toBe(a14.id);
    await off(a14);

    const a15 = await automation({name: 'Opened', object: 'contact', trigger: {kind: 'event', event: 'email.opened', filter: {}}, steps: [step('t', 'create_task', {title: '{{contact.first_name}} opened the email', dueDays: 0, assignee: 'owner'})]});
    await db.emailMessage.update({where: {id: sentMsg!.id}, data: {sentAt: ago(60_000)}});
    expect(sentMsg!.trackingId).toBeTruthy();
    await owner.get(api(`/t/o/${sentMsg!.trackingId}.gif`));
    expect(await db.task.findFirst({where: {title: 'Auto1 opened the email'}})).toBeTruthy();
    await off(a15);
  });

  it('contact.score_changed with a band filter → lifecycle stage', async () => {
    must(await owner.post(api('/scoring/rules'), {kind: 'property', name: 'Hot', points: 80, rules: {match: 'all', groups: [{match: 'all', rules: [{field: 'tags', op: 'has_any', values: [`${TAG}-hot`]}]}]}}), 'score rule');
    const a16 = await automation({name: 'Hot lead', object: 'contact', trigger: {kind: 'event', event: 'contact.score_changed', filter: {band: 'hot', bandDirection: 'up'}}, steps: [step('u', 'update_field', {target: 'contact', field: 'lifecycleStage', value: 'QUALIFIED'}), step('n', 'notify', {assignee: 'owner', title: '{{contact.full_name}} is hot'})]});
    const hot = await contact({lifecycleStage: 'LEAD'});
    must(await patch(owner, `/contacts/${hot.id}`, {tags: [TAG, `${TAG}-hot`]}), 'make hot');
    expect((await db.contact.findUniqueOrThrow({where: {id: hot.id}})).lifecycleStage, JSON.stringify(await runsOf(a16))).toBe('QUALIFIED');
    await off(a16);
  });

  let goner: Contact;
  let goneBin = '';

  it('contact.deleted → signed webhook step with the record snapshot; merge fields from the snapshot', async () => {
    const a17 = await automation({name: 'Deleted hook', object: 'contact', trigger: {kind: 'event', event: 'contact.deleted', filter: {}, conditions: tagged()}, steps: [step('w', 'webhook', {url: `${ZAPIER}/deleted/`}), step('n', 'notify', {assignee: 'creator', title: '{{contact.full_name}} was deleted'})]});
    goner = await contact();
    const del = must<{binId: string}>(await owner.delete(api(`/contacts/${goner.id}`)), 'delete');
    goneBin = del.binId;
    const deletedHook = outbound.hooks.find((h) => h.path === '/hooks/catch/123456/deleted/');
    expect(deletedHook, 'webhook for contact.deleted received').toBeTruthy();
    const secret = must<{secret: string}>(await owner.post(api(`/automations/${a17.id}/secret`)), 'secret').secret;
    expect(await signatureValid(deletedHook!.body, deletedHook!.headers['x-webhook-signature'] ?? '', secret)).toBe(true);
    const payload = JSON.parse(deletedHook!.body) as {type: string; data: {record: {id: string}; trigger: {type?: string}}};
    expect(payload.type).toBe('automation.webhook');
    expect(payload.data.record.id).toBe(goner.id);
    expect(payload.data.trigger.type).toBe('contact.deleted');
    expect(await notified(me.id, `Auto${contactN} Tester was deleted`)).toBeTruthy();
    expect(await db.auditLog.count({where: {action: 'automation.secret_revealed', recordId: a17.id}})).toBe(1);
    await off(a17);
  });

  it('contact.restored → notify (restore from the recycle bin)', async () => {
    const a18 = await automation({name: 'Restored', object: 'contact', trigger: {kind: 'event', event: 'contact.restored', filter: {}}, steps: [step('n', 'notify', {assignee: 'owner', title: '{{contact.full_name}} was restored'})]});
    must(await owner.post(api(`/recycle-bin/${goneBin}/restore`)), 'restore');
    expect(await db.notification.findFirst({where: {userId: me.id, title: {endsWith: `${goner.firstName} Tester was restored`}}})).toBeTruthy();
    await off(a18);
  });

  it("contact.merged → notify the survivor's owner", async () => {
    const a19 = await automation({name: 'Merged', object: 'contact', trigger: {kind: 'event', event: 'contact.merged', filter: {}}, steps: [step('n', 'notify', {assignee: 'owner', title: 'A duplicate was merged into {{contact.full_name}}'})]});
    // Adapted: the original merged into the restored contact (restore is the bug above); any survivor shows it.
    const survivor = await contact();
    const twin = await contact({firstName: 'Twin'});
    must(await owner.post(api(`/contacts/${survivor.id}/merge`), {otherId: twin.id, keep: 'this'}), 'merge');
    expect(await notified(me.id, `A duplicate was merged into ${survivor.firstName} Tester`)).toBeTruthy();
    await off(a19);
  });

  it('waits: a duration, until a weekday, until a date (simulated time), stop, cancel', async () => {
    const a20 = await automation({
      name: 'Waiter',
      object: 'contact',
      trigger: {kind: 'manual'},
      steps: [step('a', 'add_tag', {target: 'contact', tag: 'w1'}), step('w', 'wait', {waitMode: 'duration', amount: 2, unit: 'days'}), step('b', 'add_tag', {target: 'contact', tag: 'w2'}), step('wd', 'wait', {waitMode: 'until_weekday', weekdays: [1], time: '09:00'}), step('x', 'stop'), step('c', 'add_tag', {target: 'contact', tag: 'never'})],
    });
    const waiter = await contact();
    const wrun = must<{run: Run}>(await owner.post(api(`/automations/${a20.id}/run`), {recordId: waiter.id}), 'manual run').run;
    let wr = await db.automationRun.findUniqueOrThrow({where: {id: wrun.id}});
    expect(wr.status).toBe('waiting');
    expect(Math.abs(wr.waitUntil!.getTime() - Date.now() - 2 * DAY)).toBeLessThan(120_000);
    expect(await tagsOf(waiter.id)).toContain('w1');
    expect(await tagsOf(waiter.id)).not.toContain('w2');
    // The wait is a job planned for later (on this machine it waits in the backlog).
    expect(await db.jobBacklog.findFirst({where: {list: 'crm-automation-run', data: {path: ['runId'], equals: wrun.id}, runAt: {gt: new Date(Date.now() + DAY)}}})).toBeTruthy();
    await wakeRun(wrun.id);
    wr = await db.automationRun.findUniqueOrThrow({where: {id: wrun.id}});
    const until = wr.waitUntil!;
    expect(await tagsOf(waiter.id)).toContain('w2');
    expect(wr.status).toBe('waiting');
    expect([until.getUTCDay(), until.getUTCHours()]).toEqual([1, 9]);
    expect(until.getTime()).toBeGreaterThan(Date.now());
    await wakeRun(wrun.id);
    wr = await db.automationRun.findUniqueOrThrow({where: {id: wrun.id}});
    expect(wr.status).toBe('done');
    expect(await tagsOf(waiter.id)).not.toContain('never');

    const a21 = await automation({name: 'Until close', object: 'deal', trigger: {kind: 'manual'}, steps: [step('w', 'wait', {waitMode: 'until_date', target: 'deal', field: 'expectedCloseDate', time: '10:30'}), step('t', 'add_tag', {target: 'deal', tag: 'closing'})]});
    const closeDay = new Date(Date.now() + 5 * DAY).toISOString().slice(0, 10);
    must(await patch(owner, `/deals/${small.id}`, {expectedCloseDate: closeDay}), 'close date');
    const ur = must<{run: Run}>(await owner.post(api(`/automations/${a21.id}/run`), {recordId: small.id}), 'until run').run;
    const noDate = must(await owner.post(api('/deals'), {title: 'No date deal', pipelineId: pipeline.id, stageId: stageA.id}), 'no date deal').deal as {id: string};
    must(await owner.post(api(`/automations/${a21.id}/run`), {recordId: noDate.id}), 'until run 2');
    const urow = await db.automationRun.findUniqueOrThrow({where: {id: ur.id}});
    expect(urow.status).toBe('waiting');
    expect(urow.waitUntil!.toISOString()).toBe(`${closeDay}T10:30:00.000Z`);
    expect((await db.deal.findUniqueOrThrow({where: {id: noDate.id}})).tags).toContain('closing');
    must(await owner.post(api(`/automations/runs/${ur.id}/cancel`)), 'cancel');
    await wakeRun(ur.id);
    expect((await db.automationRun.findUniqueOrThrow({where: {id: ur.id}})).status).toBe('canceled');
    expect((await db.deal.findUniqueOrThrow({where: {id: small.id}})).tags).not.toContain('closing');
    await off(a21);
  });

  it('date triggers: exactly once, re-armed by a changed date, caught up, custom date field, after a booking', async () => {
    const base = ago(HOUR);
    const hhmm = base.toISOString().slice(11, 16);
    const today = base.toISOString().slice(0, 10);
    const a22 = await automation({
      name: 'Close reminder',
      object: 'deal',
      trigger: {kind: 'date', source: 'record', field: 'expectedCloseDate', amount: 3, unit: 'days', direction: 'before', time: hhmm, zone: 'automation', conditions: block('deal', [{field: 'title', op: 'contains', value: 'Dated'}])},
      steps: [step('t', 'create_task', {title: 'Close plan {{deal.title}}', dueDays: 0, assignee: 'owner'})],
    });
    const dated = must(await owner.post(api('/deals'), {title: 'Dated deal', value: 1, pipelineId: pipeline.id, stageId: stageA.id, expectedCloseDate: dayPlus(today, 3)}), 'dated deal').deal as {id: string};
    const rewind = (id: string, ms: number) => db.automation.update({where: {id}, data: {cursorAt: ago(ms)}});
    await rewind(a22.id, 2 * HOUR);
    await tick();
    expect(await runsOf(a22), 'fires once when the moment falls between two checks').toHaveLength(1);
    await rewind(a22.id, 2 * HOUR);
    await tick();
    expect(await runsOf(a22), 'overlapping checks never fire twice').toHaveLength(1);
    expect(await db.automationFire.count({where: {automationId: a22.id, recordId: dated.id}})).toBe(1);
    must(await patch(owner, `/deals/${dated.id}`, {expectedCloseDate: dayPlus(today, 2)}), 'move date');
    await rewind(a22.id, 26 * HOUR);
    await tick();
    expect(await runsOf(a22), 'a changed date re-arms the trigger').toHaveLength(2);
    expect(await db.task.findFirst({where: {title: 'Close plan Dated deal'}})).toBeTruthy();
    const cursor = (await db.automation.findUniqueOrThrow({where: {id: a22.id}})).cursorAt!;
    expect(Date.now() - cursor.getTime()).toBeLessThan(60_000);
    await off(a22);

    const catchBase = ago(2 * DAY);
    const a23 = await automation({name: 'Renewal', object: 'company', trigger: {kind: 'date', source: 'record', field: `custom.${renewal.key}`, amount: 30, unit: 'days', direction: 'before', time: catchBase.toISOString().slice(11, 16), zone: 'automation'}, steps: [step('t', 'add_tag', {target: 'company', tag: 'renewal-soon'})]});
    const renewCo = must(await owner.post(api('/companies'), {name: 'Renewco', custom: {[renewal.key]: dayPlus(catchBase.toISOString().slice(0, 10), 30)}}), 'renewal company').company as {id: string};
    await rewind(a23.id, 3 * DAY);
    await tick();
    expect((await db.company.findUniqueOrThrow({where: {id: renewCo.id}})).tags, 'missed checks are caught up (2 days late)').toContain('renewal-soon');
    await off(a23);

    const a24 = await automation({name: 'After booking', object: 'contact', trigger: {kind: 'date', source: 'booking', field: 'startAt', amount: 1, unit: 'days', direction: 'after', time: null}, steps: [step('t', 'add_tag', {target: 'contact', tag: 'met'})]});
    await db.booking.create({data: {contactId: booker.id, status: 'CONFIRMED', title: 'Past call', startAt: ago(DAY + 30 * 60_000), endAt: ago(DAY), name: 'Booker', email: `booker@${MAIL}`}});
    await rewind(a24.id, HOUR);
    await tick();
    expect(await tagsOf(booker.id)).toContain('met');
    await off(a24);
  });

  it('inactivity: a deal quiet 14 days (re-armed), a ticket waiting 24 h, a task overdue, in a list for N days', async () => {
    const rewind = (ids: string[], ms: number) => db.automation.updateMany({where: {id: {in: ids}}, data: {cursorAt: ago(ms)}});
    const a25 = await automation({name: 'Stale deal', object: 'deal', trigger: {kind: 'inactivity', rule: 'no_activity', amount: 14, unit: 'days', conditions: block('deal', [{field: 'title', op: 'contains', value: 'Quiet'}])}, steps: [step('n', 'notify', {assignee: 'owner', title: '{{deal.title}} has had no activity for 14 days'})]});
    const quiet = must(await owner.post(api('/deals'), {title: 'Quiet deal', pipelineId: pipeline.id, stageId: stageA.id}), 'quiet deal').deal as {id: string};
    await db.deal.update({where: {id: quiet.id}, data: {lastActivityAt: ago(14 * DAY + 20 * 60_000)}});
    await rewind([a25.id], HOUR);
    await tick();
    await tick();
    expect(await runsOf(a25), 'quiet deal fires once').toHaveLength(1);
    await db.deal.update({where: {id: quiet.id}, data: {lastActivityAt: ago(14 * DAY + 10 * 60_000)}});
    await rewind([a25.id], HOUR);
    await tick();
    expect(await runsOf(a25), 'new activity re-arms it').toHaveLength(2);
    await off(a25);

    const a26 = await automation({name: 'Waiting on us', object: 'ticket', trigger: {kind: 'inactivity', rule: 'ticket_waiting', amount: 24, unit: 'hours', conditions: block('ticket', [{field: 'subject', op: 'contains', value: 'Wait'}])}, steps: [step('n', 'notify', {assignee: 'assignee', title: 'Ticket #{{ticket.number}} has waited 24 h'}), step('p', 'update_field', {target: 'ticket', field: 'priority', value: 'HIGH'})]});
    const waitT = must(await owner.post(api('/tickets'), {subject: 'Wait for us', priority: 'LOW', contactId: vip.id}), 'waiting ticket').ticket as {id: string; number: number};
    await db.ticket.update({where: {id: waitT.id}, data: {createdAt: ago(24 * HOUR + 10 * 60_000)}});
    await rewind([a26.id], HOUR);
    await tick();
    expect((await db.ticket.findUniqueOrThrow({where: {id: waitT.id}})).priority).toBe('HIGH');
    expect(await notified(me.id, `Ticket #${waitT.number} has waited 24 h`)).toBeTruthy();
    await off(a26);

    const a27 = await automation({name: 'Overdue', object: 'contact', trigger: {kind: 'inactivity', rule: 'task_overdue', amount: 2, unit: 'days', conditions: tagged()}, steps: [step('t', 'add_tag', {target: 'contact', tag: 'overdue'})]});
    const od = must(await owner.post(api('/tasks'), {title: 'Overdue task', contactId: intern.id}), 'overdue task').task as {id: string};
    await db.task.update({where: {id: od.id}, data: {dueAt: ago(2 * DAY + 10 * 60_000)}});
    const a28 = await automation({name: 'Listed 3 days', object: 'contact', trigger: {kind: 'inactivity', rule: 'in_list', listId: list.id, amount: 3, unit: 'days'}, steps: [step('t', 'add_tag', {target: 'contact', tag: 'list-3d'})]});
    await db.contactListMember.updateMany({where: {listId: list.id, contactId: intern.id}, data: {createdAt: ago(3 * DAY + 10 * 60_000)}});
    await rewind([a27.id, a28.id], HOUR);
    await tick();
    expect(await tagsOf(intern.id)).toContain('overdue');
    expect(await tagsOf(intern.id)).toContain('list-3d');
    await off(a27);
    await off(a28);
  });

  it('manual runs: on a record (members, not viewers), on a segment (one run each), owner-only visibility', async () => {
    const a29 = await automation({name: 'Manual tagger', description: 'Tags the contact', object: 'contact', trigger: {kind: 'manual'}, steps: [step('t', 'add_tag', {target: 'contact', tag: 'manual-run'})]});
    expect((await member.post(api(`/automations/${a29.id}/run`), {recordId: vip.id})).status).toBe(201);
    expect((await viewer.post(api(`/automations/${a29.id}/run`), {recordId: vip.id})).status).toBe(403);
    expect((await owner.post(api(`/automations/${a5.id}/run`), {recordId: big.id})).status).toBe(400);
    expect(await tagsOf(vip.id)).toContain('manual-run');
    const fr = must<{manual: {id: string}[]; runs: {automationId: string}[]}>(await member.get(api(`/automations/for-record?object=contact&recordId=${vip.id}`)), 'for record');
    expect(fr.manual.some((m) => m.id === a29.id)).toBe(true);
    expect(fr.runs.some((r) => r.automationId === a29.id)).toBe(true);

    const segContacts = [await contact({tags: [TAG, `${TAG}-seg`]}), await contact({tags: [TAG, `${TAG}-seg`]}), await contact({tags: [TAG, `${TAG}-seg`]})];
    const seg = must(await owner.post(api('/lists'), {name: 'Seg', kind: 'DYNAMIC', rules: {match: 'all', groups: [{match: 'all', rules: [{field: 'tags', op: 'has_any', values: [`${TAG}-seg`]}]}]}}), 'segment').list as {id: string};
    expect((await member.post(api(`/automations/${a29.id}/run-list`), {listId: seg.id})).status).toBe(200);
    for (const c of segContacts) expect(await tagsOf(c.id)).toContain('manual-run');
    expect(await runsOf(a29, {source: 'list'})).toHaveLength(3);

    must(await patch(owner, '/settings', {recordVisibility: 'owner'}), 'owner visibility');
    try {
      const memberContact = must(await member.post(api('/contacts'), {firstName: 'Mine', lastName: 'Tester', tags: [TAG]}), 'member contact').contact as {id: string};
      expect((await member.post(api(`/automations/${a29.id}/run`), {recordId: vip.id})).status).toBe(404);
      expect((await member.post(api(`/automations/${a29.id}/run`), {recordId: memberContact.id})).status).toBe(201);
      const memberRuns = must<{rows: Run[]}>(await member.get(api(`/automations/${a29.id}/runs?pageSize=100`)), 'member runs').rows;
      expect(memberRuns.length).toBeGreaterThan(0);
      expect(memberRuns.every((r) => r.ownerId === memberUser.id || r.startedById === memberUser.id)).toBe(true);
      expect((await member.get(api(`/automations/for-record?object=contact&recordId=${vip.id}`))).status).toBe(404);
    } finally {
      must(await patch(owner, '/settings', {recordVisibility: 'everyone'}), 'restore visibility');
    }
  });

  it('test run (dry run): describes every step, writes, sends and calls nothing; works on an unsaved draft', async () => {
    const a30 = await automation(
      {
        name: 'Dry',
        object: 'contact',
        trigger: {kind: 'manual', conditions: tagged()},
        steps: [
          step('u', 'update_field', {target: 'contact', field: 'lifecycleStage', value: 'CUSTOMER'}),
          step('rr', 'assign_owner', {target: 'contact', assignMode: 'round_robin', userIds: [me.id, memberUser.id]}),
          step('t', 'create_task', {title: 'Dry task {{contact.first_name}}', dueDays: 1, assignee: 'owner'}),
          step('d', 'create_deal', {title: 'Dry deal', pipelineId: pipeline.id, stageId: stageA.id, assignee: 'owner'}),
          step('k', 'create_ticket', {subject: 'Dry ticket', assignee: 'none'}),
          step('g', 'add_tag', {target: 'contact', tag: 'dry'}),
          step('l', 'add_to_list', {listId: list.id}),
          step('e', 'send_email', {subject: 'Dry email', html: '<p>Hi</p>', layout: 'branded', from: 'owner'}),
          step('n', 'notify', {assignee: 'owner', title: 'Dry notice', email: true}),
          step('w', 'webhook', {url: `${ZAPIER}/dry/`}),
          step('if', 'if', {conditions: block('contact', [{field: 'title', op: 'contains', value: 'VIP'}]), then: [step('wt', 'wait', {waitMode: 'duration', amount: 3, unit: 'days'})], else: []}),
          step('s', 'stop'),
        ],
      },
      {enable: false},
    );
    const counts = async () => {
      const c = await db.contact.findUniqueOrThrow({where: {id: vip.id}, select: {lifecycleStage: true, ownerId: true, tags: true}});
      return {
        tasks: await db.task.count(),
        deals: await db.deal.count(),
        tickets: await db.ticket.count(),
        listMembers: await db.contactListMember.count(),
        emails: await db.emailMessage.count(),
        notifications: await db.notification.count(),
        activities: await db.activity.count(),
        runs: await db.automationRun.count(),
        contact: c,
        mails: outbound.mails.length,
        hooks: outbound.hooks.length,
      };
    };
    const before = await counts();
    const dry = must<{conditions: {ok: boolean}; steps: {type: string; status: string; summary: string; branch?: string}[]}>(await owner.post(api(`/automations/${a30.id}/test`), {recordId: vip.id}), 'test run');
    expect(await counts()).toEqual(before);
    expect(dry.conditions.ok).toBe(true);
    expect(dry.steps).toHaveLength(13);
    const described = dry.steps.filter((s) => s.type !== 'if' && s.type !== 'stop' && s.status === 'done');
    expect(described.every((s) => /^Would /.test(s.summary)), JSON.stringify(dry.steps.map((s) => s.summary))).toBe(true);
    expect(dry.steps.find((s) => s.type === 'if')?.branch).toBe('then');
    expect(dry.steps.some((s) => s.type === 'wait')).toBe(true);

    const draft = {name: 'Dry draft', object: 'contact', trigger: {kind: 'manual'}, steps: [step('x', 'add_tag', {target: 'contact', tag: 'draft-only'})]};
    const dry2 = must<{steps: {summary: string}[]}>(await owner.post(api(`/automations/${a30.id}/test`), {recordId: outsider.id, draft}), 'draft test');
    expect(dry2.steps).toHaveLength(1);
    expect(dry2.steps[0]!.summary).toMatch(/draft-only/);
  });

  it('loop protection: A triggers B triggers A stops at the chain limit; an automation never re-triggers itself', async () => {
    const loopCond = tagged([`${TAG}-loop`]);
    const aA = await automation({name: 'Loop A', object: 'contact', trigger: {kind: 'event', event: 'contact.updated', filter: {field: 'phone'}, conditions: loopCond}, steps: [step('u', 'update_field', {target: 'contact', field: 'title', value: 'T{{contact.phone}}'})]});
    const aB = await automation({name: 'Loop B', object: 'contact', trigger: {kind: 'event', event: 'contact.updated', filter: {field: 'title'}, conditions: loopCond}, steps: [step('u', 'update_field', {target: 'contact', field: 'phone', value: '{{contact.title}}1'})]});
    const looper = await contact({tags: [TAG, `${TAG}-loop`]});
    must(await patch(owner, `/contacts/${looper.id}`, {phone: '5'}), 'start the loop');
    const loopRuns = [...(await runsOf(aA)), ...(await runsOf(aB))];
    const real = loopRuns.filter((r) => r.status !== 'skipped');
    expect(real.length, JSON.stringify(real.map((r) => r.depth))).toBeGreaterThanOrEqual(5);
    expect(real.length).toBeLessThanOrEqual(6);
    expect(loopRuns.some((r) => r.status === 'skipped' && /triggered each other/.test(r.error ?? ''))).toBe(true);
    expect(new Set(loopRuns.map((r) => r.chainId)).size).toBe(1);
    await off(aA);
    await off(aB);

    const self = await automation({name: 'Self', object: 'contact', trigger: {kind: 'event', event: 'contact.updated', filter: {field: 'country'}, conditions: loopCond}, steps: [step('u', 'update_field', {target: 'contact', field: 'country', value: 'C{{contact.title}}x'})]});
    must(await patch(owner, `/contacts/${looper.id}`, {country: 'Nowhere'}), 'self trigger');
    expect(await runsOf(self)).toHaveLength(1);
    await off(self);
  });

  it('re-enrollment (never / after N days / always) and the per-record rate limit', async () => {
    const ev = {kind: 'event', event: 'contact.updated', filter: {field: 'city'}, conditions: tagged([`${TAG}-re`])};
    const never = await automation({name: 'Never again', object: 'contact', trigger: ev, reenroll: 'never', steps: [step('t', 'add_tag', {target: 'contact', tag: 'n'})]});
    const after30 = await automation({name: 'After 30', object: 'contact', trigger: ev, reenroll: 'after', reenrollDays: 30, steps: [step('t', 'add_tag', {target: 'contact', tag: 'a'})]});
    const always = await automation({name: 'Always', object: 'contact', trigger: ev, reenroll: 'always', steps: [step('t', 'add_tag', {target: 'contact', tag: 'w'})]});
    const re = await contact({tags: [TAG, `${TAG}-re`]});
    for (const city of ['Oslo', 'Rome', 'Lima']) must(await patch(owner, `/contacts/${re.id}`, {city}), 'city');
    expect(await runsOf(never)).toHaveLength(1);
    expect(await runsOf(after30)).toHaveLength(1);
    expect(await runsOf(always)).toHaveLength(3);
    await db.automationRun.updateMany({where: {automationId: after30.id}, data: {startedAt: ago(31 * DAY)}});
    must(await patch(owner, `/contacts/${re.id}`, {city: 'Kyiv'}), 'city 4');
    expect(await runsOf(after30), 'runs again once the window has passed').toHaveLength(2);
    for (let i = 0; i < 9; i++) await patch(owner, `/contacts/${re.id}`, {city: `City ${i}`});
    const alwaysRuns = await runsOf(always);
    expect(alwaysRuns.filter((r) => r.status !== 'skipped')).toHaveLength(10);
    expect(alwaysRuns.filter((r) => r.status === 'skipped' && /Rate limit/.test(r.error ?? ''))).toHaveLength(1);
    for (const a of [never, after30, always]) await off(a);
  });

  it('retries without repeating side effects; permanent failures, automation.run_failed (event, webhook), creator notified', async () => {
    const a31 = await automation({name: 'Flaky', object: 'contact', trigger: {kind: 'manual'}, steps: [step('t', 'create_task', {title: 'Retry task', dueDays: 1, assignee: 'owner'}), step('w', 'webhook', {url: `${ZAPIER}/flaky/`}), step('g', 'add_tag', {target: 'contact', tag: 'after-flaky'})]});
    let flaky = 2;
    outbound.answer = (path) => (path.endsWith('/flaky/') && flaky-- > 0 ? 503 : path.endsWith('/fail400/') ? 400 : 200);
    try {
      const fr1 = must<{run: Run}>(await owner.post(api(`/automations/${a31.id}/run`), {recordId: intern.id}), 'flaky run').run;
      expect((await db.automationRun.findUniqueOrThrow({where: {id: fr1.id}})).error).toMatch(/^Retrying: /);
      // The platform retries the job (attempts 2 and 3); on this machine a job runs once, so call its handler again.
      for (const attempt of [2, 3]) {
        await inScope(() => crmJob('automation.run')({runId: fr1.id}, {id: 'job_retry', list: 'crm-automation-run', attempt, maxAttempts: 6, scheduledFor: new Date().toISOString(), group: null, local: true})).catch(() => undefined);
      }
      const fr1row = await db.automationRun.findUniqueOrThrow({where: {id: fr1.id}});
      const fr1steps = await stepsOf(fr1row);
      expect(fr1row.status, String(fr1row.error)).toBe('done');
      expect(await db.task.count({where: {title: 'Retry task'}})).toBe(1);
      const flakyHits = outbound.hooks.filter((h) => h.path.endsWith('/flaky/'));
      expect(flakyHits).toHaveLength(3);
      expect(new Set(flakyHits.map((h) => h.headers['x-webhook-id'])).size).toBe(1);
      expect(fr1steps.find((s) => s.type === 'webhook')?.attempts).toBe(3);
      expect(fr1steps.find((s) => s.type === 'create_task')?.attempts).toBe(1);
      await off(a31);

      const failHook = must(await owner.post(api('/webhooks'), {url: `${ZAPIER}/run-failed/`, events: ['automation.run_failed']}), 'run_failed webhook').webhook as {id: string};
      a32 = await automation({name: 'Broken', object: 'contact', trigger: {kind: 'manual'}, steps: [step('w', 'webhook', {url: `${ZAPIER}/fail400/`})]});
      for (let i = 0; i < 3; i++) must(await owner.post(api(`/automations/${a32.id}/run`), {recordId: intern.id}), 'broken run');
      const broken = await runsOf(a32);
      expect(broken).toHaveLength(3);
      expect(broken.every((r) => r.status === 'failed' && /HTTP 400/.test(r.error ?? '')), JSON.stringify(broken.map((r) => r.error))).toBe(true);
      expect(await db.event.count({where: {type: 'automation.run_failed', recordId: a32.id}})).toBe(3);
      expect(outbound.hooks.some((h) => h.path.endsWith('/run-failed/') && (JSON.parse(h.body) as {type: string}).type === 'automation.run_failed')).toBe(true);
      expect(await notified(me.id, 'Automation "Broken" failed 3 times in a row')).toBeTruthy();
      expect((await owner.post(api(`/automations/runs/${broken[0]!.id}/retry`))).status).toBe(200);
      await owner.delete(api(`/webhooks/${failHook.id}`));
      await off(a32);
    } finally {
      outbound.answer = () => 200;
    }
  });

  it('run history: list stats, filters, search, run detail, reports, viewers; duplicate', async () => {
    const listed = must<{rows: {id: string; lastRunAt: string | null; stats: {failed7d: number; runs7d: number}}[]}>(await owner.get(api('/automations')), 'list').rows.find((r) => r.id === a32.id)!;
    expect(listed.stats.failed7d).toBeGreaterThanOrEqual(3);
    expect(listed.stats.runs7d).toBeGreaterThanOrEqual(3);
    expect(listed.lastRunAt).toBeTruthy();
    const failedOnly = must<{rows: Run[]}>(await owner.get(api(`/automations/${a32.id}/runs?status=failed`)), 'failed filter').rows;
    expect(failedOnly.length).toBeGreaterThanOrEqual(3);
    expect(failedOnly.every((r) => r.status === 'failed')).toBe(true);
    expect(must<{rows: Run[]}>(await owner.get(api(`/automations/${a1.id}/runs?q=Auto1`)), 'search').rows).toHaveLength(1);
    const detail = must<{run: {steps: unknown[]; automation: {steps: unknown[]}}}>(await owner.get(api(`/automations/runs/${r1[0]!.id}`)), 'run detail').run;
    expect(detail.steps).toHaveLength(4);
    expect(detail.automation.steps).toHaveLength(3);
    const cat = must<{objects: {key: string}[]}>(await owner.get(api('/reports/catalogue')), 'catalogue').objects;
    expect(cat.some((o) => o.key === 'automation_runs')).toBe(true);
    const report = await owner.get(api(`/reports/run?config=${encodeURIComponent(JSON.stringify({object: 'automation_runs', measure: {op: 'count'}, groupBy: {field: 'status'}, chart: 'bar'}))}`));
    expect(report.status, JSON.stringify(report.json)).toBe(200);
    expect((await viewer.get(api(`/automations/${a1.id}/runs`))).status).toBe(200);

    const dup = must<{automation: Automation}>(await owner.post(api(`/automations/${a1.id}/duplicate`)), 'duplicate').automation;
    expect(dup.name).toBe('Welcome (copy)');
    expect(dup.enabled).toBe(false);
    expect(dup.steps).toEqual((await db.automation.findUniqueOrThrow({where: {id: a1.id}})).steps);
  });
});
