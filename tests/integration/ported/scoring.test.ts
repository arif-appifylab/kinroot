// Ported from Kinroot's scripts/test-scoring.mjs
// Covers lead scoring: property and behaviour rules, limits, bands, decay, recalculation, the periodic pass, merge, reads, permissions, webhooks.
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {scoringTick} from '../../../src/server/crm/lib/scoring';
import {resetCrm, teammate} from '../support/crm';
import {type Browser, configureEnv, DATABASE_URL, db} from '../support/harness';
import {crmDb, crmOwner, fakeOutbound, inScope, type Member, must, outbound, ZAPIER} from './support';

/**
 * One scenario, in order, as the original script ran it: each block builds on the scores the
 * blocks before it left. Scoring jobs run in-process as the request that queued them ends, so
 * there is nothing to wait for; the periodic pass (the old /jobs/run) is `scoringTick()`.
 */

const TAG = 'scoretest';
const BANDS = [
  {key: 'cold', name: 'Cold', min: null, tone: 'blue'},
  {key: 'warm', name: 'Warm', min: 20, tone: 'amber'},
  {key: 'hot', name: 'Hot', min: 50, tone: 'rose'},
];
const fixture = {field: 'tags', op: 'has_any', values: [TAG]};
const rulesOf = (...rules: unknown[]) => ({match: 'all', groups: [{match: 'all', rules}]});

type Contact = {id: string; firstName: string};
type Rule = {id: string};
type Band = {oldBand: {key: string}; newBand: {key: string}; oldScore: number; newScore: number; direction: string};

describe.skipIf(!DATABASE_URL)('Ported: lead scoring (integration, real Postgres)', () => {
  let owner: Browser;
  let me: Member;
  let A: Contact, B: Contact, C: Contact;
  let P1: Rule, LR: Rule, D1: Rule;
  let L: {id: string};
  let notesBefore = 0;

  const scoreOf = async (id: string) => (await db.contact.findUnique({where: {id}, select: {score: true}}))?.score;
  const rule = async (body: Record<string, unknown>) => must<{rule: Rule}>(await owner.post('/site-api/crm/scoring/rules', body), `rule ${body.name}`).rule;
  const scoreNotes = () => db.notification.count({where: {type: 'score', link: `/contacts/${A.id}`}});
  const lastBandEvent = async (id: string) => (await db.event.findFirst({where: {type: 'contact.score_changed', recordId: id}, orderBy: {createdAt: 'desc'}}))?.data as Band | undefined;
  const contact = async (firstName: string, title: string) =>
    must<{contact: Contact}>(await owner.post('/site-api/crm/contacts', {firstName, lastName: 'Scorer', title, tags: [TAG]}), firstName).contact;

  beforeAll(async () => {
    configureEnv();
    fakeOutbound();
    await resetCrm();
    outbound.reset();
    ({browser: owner, me} = await crmOwner());
    must(await owner.post('/site-api/crm/auth/setup', {brandName: 'Kinroot', demoData: false}), 'setup');
    must(await owner.request('PATCH', '/site-api/crm/scoring/settings', {bands: BANDS, decay: {mode: 'off', days: 90}, notify: 'up'}), 'settings');
    A = await contact('Ava', 'VP Sales');
    B = await contact('Ben', 'Intern');
    C = await contact('Cy', 'Intern');
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it('property rules: score matching contacts, refuse loops and incomplete rules, follow contact and company edits', async () => {
    P1 = await rule({kind: 'property', name: 'VP', points: 15, rules: rulesOf(fixture, {field: 'title', op: 'contains', value: 'VP'})});
    expect(await scoreOf(A.id)).toBe(15);
    expect(await scoreOf(B.id)).toBe(0);

    expect((await owner.post('/site-api/crm/scoring/rules', {kind: 'property', name: 'loop', points: 5, rules: rulesOf({field: 'score', op: 'gt', value: '10'})})).status).toBe(400);
    const scoreSeg = must(await owner.post('/site-api/crm/lists', {name: 'Score seg', kind: 'DYNAMIC', rules: rulesOf({field: 'score', op: 'gt', value: '10'})}), 'score segment').list as {id: string};
    expect((await owner.post('/site-api/crm/scoring/rules', {kind: 'property', name: 'loop2', points: 5, rules: rulesOf({field: 'list', op: 'in', value: scoreSeg.id})})).status).toBe(400);
    expect((await owner.post('/site-api/crm/scoring/rules', {kind: 'property', name: 'empty', points: 5, rules: rulesOf({field: 'title', op: 'contains', value: ''})})).status).toBe(400);
    expect((await owner.post('/site-api/crm/scoring/rules', {kind: 'behavior', name: 'zero', points: 0, event: 'email.opened'})).status).toBe(400);
    expect((await owner.post('/site-api/crm/scoring/rules', {kind: 'behavior', name: 'bad', points: 5, event: 'contact.deleted'})).status).toBe(400);

    must(await owner.request('PATCH', `/site-api/crm/contacts/${B.id}`, {title: 'VP Marketing'}), 'B → VP');
    expect(await scoreOf(B.id)).toBe(15);
    must(await owner.request('PATCH', `/site-api/crm/contacts/${B.id}`, {title: 'Intern'}), 'B → Intern');
    expect(await scoreOf(B.id)).toBe(0);
    expect(await db.scoreEvent.count({where: {contactId: B.id, revokedAt: {not: null}}})).toBe(1);

    // A company change rescores its contacts; deleting a rule removes its points.
    const co = must(await owner.post('/site-api/crm/companies', {name: 'Scoreco', industry: 'Retail'}), 'company').company as {id: string};
    must(await owner.post(`/site-api/crm/contacts/${C.id}/companies`, {companyId: co.id, isPrimary: true}), 'link C');
    const P2 = await rule({kind: 'property', name: 'Software', points: 7, rules: rulesOf(fixture, {field: 'company.industry', op: 'is', value: 'Software'})});
    expect(await scoreOf(C.id)).toBe(0);
    must(await owner.request('PATCH', `/site-api/crm/companies/${co.id}`, {industry: 'Software'}), 'company → Software');
    expect(await scoreOf(C.id)).toBe(7);
    must(await owner.delete(`/site-api/crm/scoring/rules/${P2.id}`), 'delete P2');
    expect(await scoreOf(C.id)).toBe(0);
  });

  it('behaviour rules: email opened once per contact, list filter with "2 per 30 days", deal won; band crossings', async () => {
    await rule({kind: 'behavior', name: 'Opened', points: 5, event: 'email.opened', limitCount: 1});
    L = must(await owner.post('/site-api/crm/lists', {name: 'Hot list', kind: 'STATIC'}), 'list L').list as {id: string};
    const L2 = must(await owner.post('/site-api/crm/lists', {name: 'Other list', kind: 'STATIC'}), 'list L2').list as {id: string};
    LR = await rule({kind: 'behavior', name: 'Listed', points: 10, event: 'list.member_added', filter: {listId: L.id}, limitCount: 2, limitDays: 30});
    const pipes = must<{rows: {id: string; stages: {id: string}[]}[]}>(await owner.get('/site-api/crm/pipelines'), 'pipelines').rows;
    D1 = await rule({kind: 'behavior', name: 'Won', points: 30, event: 'deal.won', filter: {pipelineId: pipes[0]!.id}});

    // Two tracked emails to A, opened through the pixel.
    const thread = await db.emailThread.create({data: {subject: 'Scoring', contactId: A.id}});
    for (const n of [1, 2]) {
      await db.emailMessage.create({
        data: {id: `msg${n}`, threadId: thread.id, direction: 'OUTBOUND', status: 'SENT', fromEmail: 'rep@example.com', to: ['ava@example.com'], subject: `Hello ${n}`, trackingId: `trk${n}`, contactId: A.id, sentAt: new Date(Date.now() - 60_000)},
      });
    }
    notesBefore = await scoreNotes();
    await owner.get('/site-api/crm/t/o/trk1.gif');
    await owner.get('/site-api/crm/t/o/trk1.gif'); // second open of the same email: no new event
    expect(await scoreOf(A.id)).toBe(20);
    expect(await db.event.count({where: {type: 'email.opened', recordId: 'msg1'}})).toBe(1);
    await owner.get('/site-api/crm/t/o/trk2.gif');
    expect(await scoreOf(A.id), '"once per contact" holds for a second email').toBe(20);

    // Cold → Warm at 20: event, notification, timeline; lifecycle untouched.
    expect(await lastBandEvent(A.id)).toMatchObject({oldBand: {key: 'cold'}, newBand: {key: 'warm'}, oldScore: 15, newScore: 20, direction: 'up'});
    expect(await db.notification.count({where: {type: 'score', link: `/contacts/${A.id}`, userId: me.id}})).toBe(notesBefore + 1);
    const band = await db.activity.findMany({where: {type: 'score_band', contactId: A.id}, select: {title: true}});
    expect(band).toHaveLength(1);
    expect(band[0]!.title).toContain('Warm');
    expect((await db.contact.findUnique({where: {id: A.id}}))?.lifecycleStage).toBe('LEAD');

    // List rule: only list L counts, at most twice in 30 days.
    for (let i = 0; i < 3; i++) {
      must(await owner.post(`/site-api/crm/lists/${L.id}/members`, {contactIds: [A.id]}), 'add to L');
      must(await owner.post(`/site-api/crm/lists/${L.id}/members/remove`, {contactIds: [A.id]}), 'remove from L');
    }
    must(await owner.post(`/site-api/crm/lists/${L2.id}/members`, {contactIds: [A.id]}), 'add to L2');
    expect(await scoreOf(A.id)).toBe(40);

    // Deal won in the filtered pipeline: through the deal's contacts.
    const deal = must(await owner.post('/site-api/crm/deals', {title: 'Score deal', pipelineId: pipes[0]!.id, stageId: pipes[0]!.stages[0]!.id, value: 100, contactIds: [A.id]}), 'deal').deal as {id: string};
    must(await owner.post(`/site-api/crm/deals/${deal.id}/status`, {status: 'WON'}), 'won');
    expect(await scoreOf(A.id)).toBe(70);
    expect((await lastBandEvent(A.id))?.newBand.key).toBe('hot');
  });

  it('breakdown, test on a contact, contacts table, segments and reports', async () => {
    const bd = must<{score: number; band: {key: string}; rules: {ruleId: string; points: number}[]; history: {reason: string}[]}>(await owner.get(`/site-api/crm/scoring/contacts/${A.id}`), 'breakdown');
    expect(bd.score).toBe(70);
    expect(bd.band.key).toBe('hot');
    expect(bd.rules.find((r) => r.ruleId === LR.id)?.points).toBe(20);
    expect(bd.rules.find((r) => r.ruleId === P1.id)?.points).toBe(15);
    expect(bd.history.some((h) => h.reason.startsWith('Opened an email'))).toBe(true);

    const draft = {rules: rulesOf({field: 'firstName', op: 'is', value: 'Ava'}), points: 3};
    const t = must<{computed: number; stored: number; draft: {matches: boolean}}>(await owner.post('/site-api/crm/scoring/test', {contactId: A.id, draft}), 'test');
    expect(t).toMatchObject({computed: 70, stored: 70, draft: {matches: true}});
    const tB = must<{draft: {matches: boolean}; rules: {ruleId: string; matches: boolean}[]}>(await owner.post('/site-api/crm/scoring/test', {contactId: B.id, draft}), 'test B');
    expect(tB.draft.matches).toBe(false);
    expect(tB.rules.find((r) => r.ruleId === P1.id)?.matches).toBe(false);

    const hotRows = must<{rows: {id: string}[]}>(await owner.get(`/site-api/crm/contacts?tag=${TAG}&scoreBand=hot`), 'hot').rows;
    expect(hotRows.map((r) => r.id)).toEqual([A.id]);
    expect(must<{rows: unknown[]}>(await owner.get(`/site-api/crm/contacts?tag=${TAG}&scoreBand=cold`), 'cold').rows).toHaveLength(2);
    const sorted = must<{rows: {id: string; score: unknown}[]}>(await owner.get(`/site-api/crm/contacts?tag=${TAG}&sort=score&dir=desc`), 'sorted').rows;
    expect(sorted[0]!.id).toBe(A.id);
    expect(typeof sorted[0]!.score).toBe('number');

    expect(must<{count: number}>(await owner.post('/site-api/crm/lists/preview', {rules: rulesOf(fixture, {field: 'score', op: 'gt', value: '60'})}), 'segment gt').count).toBe(1);
    expect(must<{count: number}>(await owner.post('/site-api/crm/lists/preview', {rules: rulesOf(fixture, {field: 'score', op: 'lt', value: '1'})}), 'segment lt').count).toBe(2);

    const cat = must<{objects: {key: string; fields: {key: string; numeric?: boolean; groupable?: boolean; options?: unknown[]}[]}[]}>(await owner.get('/site-api/crm/reports/catalogue'), 'catalogue').objects.find((o) => o.key === 'contacts')!;
    expect(cat.fields.some((f) => f.key === 'score' && f.numeric)).toBe(true);
    expect(cat.fields.some((f) => f.key === 'scoreBand' && f.groupable && f.options?.length === 3)).toBe(true);
    const config = {object: 'contacts', measure: {op: 'count'}, groupBy: {field: 'scoreBand'}, filters: {conditions: []}, chart: 'bar'};
    const rep = must<{rows: {key: string; total: number}[]}>(await owner.get(`/site-api/crm/reports/run?config=${encodeURIComponent(JSON.stringify(config))}`), 'report by band');
    expect(rep.rows.find((r) => r.key === 'hot')?.total).toBe(await db.contact.count({where: {score: {gte: 50}}}));
    const max = must<{total: {value: number}}>(await owner.get(`/site-api/crm/reports/run?config=${encodeURIComponent(JSON.stringify({...config, measure: {op: 'max', field: 'score'}, groupBy: null, chart: 'kpi'}))}`), 'report max score');
    expect(max.total.value).toBeGreaterThanOrEqual(70);
  });

  it('decay: half counts old behaviour points half, expire drops them, off restores them', async () => {
    await db.scoreEvent.updateMany({where: {contactId: A.id, kind: 'behavior'}, data: {createdAt: new Date(Date.now() - 100 * 86_400_000)}});
    const half = must<{recalculating: boolean}>(await owner.request('PATCH', '/site-api/crm/scoring/settings', {bands: BANDS, decay: {mode: 'half', days: 90}, notify: 'up'}), 'decay half');
    expect(half.recalculating).toBe(true);
    expect(await scoreOf(A.id)).toBe(43); // 15 + 55 / 2 = 42.5 → 43
    expect(await lastBandEvent(A.id)).toMatchObject({direction: 'down', newBand: {key: 'warm'}});
    // notify = up: moving down a band notifies nobody (the two are cold → warm and warm → hot).
    expect(await scoreNotes()).toBe(notesBefore + 2);

    must(await owner.request('PATCH', '/site-api/crm/scoring/settings', {bands: BANDS, decay: {mode: 'expire', days: 90}, notify: 'up'}), 'decay expire');
    expect(await scoreOf(A.id)).toBe(15);
    const bdx = must<{history: {status: string}[]}>(await owner.get(`/site-api/crm/scoring/contacts/${A.id}`), 'breakdown expired');
    expect(bdx.history.some((h) => h.status === 'expired')).toBe(true);
    must(await owner.request('PATCH', '/site-api/crm/scoring/settings', {bands: BANDS, decay: {mode: 'off', days: 90}, notify: 'up'}), 'decay off');
    expect(await scoreOf(A.id)).toBe(70);
  });

  it('switching rules off and on, new points, recalculate all, and the periodic pass', async () => {
    must(await owner.request('PATCH', `/site-api/crm/scoring/rules/${P1.id}`, {enabled: false}), 'P1 off');
    expect(await scoreOf(A.id)).toBe(55);
    must(await owner.request('PATCH', `/site-api/crm/scoring/rules/${P1.id}`, {enabled: true}), 'P1 on');
    must(await owner.request('PATCH', `/site-api/crm/scoring/rules/${D1.id}`, {points: 25}), 'D1 25');
    expect(await scoreOf(A.id), 'new points apply to past awards').toBe(65);
    must(await owner.request('PATCH', `/site-api/crm/scoring/rules/${D1.id}`, {points: 30}), 'D1 30');

    await db.contact.update({where: {id: A.id}, data: {score: 999}});
    must(await owner.post('/site-api/crm/scoring/recalculate'), 'recalculate');
    expect(await scoreOf(A.id)).toBe(70);
    const st = must<{recalc: {finishedAt: string | null} | null; bands: unknown[]}>(await owner.get('/site-api/crm/scoring/status'), 'status');
    expect(st.recalc?.finishedAt).toBeTruthy();
    expect(st.bands).toHaveLength(3);

    // The periodic pass (crm-tick; the old /jobs/run) recomputes stored totals, then rests.
    await db.contact.update({where: {id: A.id}, data: {score: 998}});
    await db.setting.deleteMany({where: {key: 'scoring.cursor'}});
    let tick: Awaited<ReturnType<typeof scoringTick>> | undefined;
    for (let i = 0; i < 50; i++) {
      tick = await inScope(() => scoringTick(crmDb));
      const cursor = (await db.setting.findUnique({where: {key: 'scoring.cursor'}}))?.value as {after?: string | null} | undefined;
      if (!cursor?.after) break;
    }
    expect(tick && 'processed' in tick).toBe(true);
    expect(await scoreOf(A.id)).toBe(70);
    expect(await inScope(() => scoringTick(crmDb))).toEqual({skipped: 'resting'});
  });

  it("merging keeps the dropped contact's points", async () => {
    must(await owner.post(`/site-api/crm/lists/${L.id}/members`, {contactIds: [C.id]}), 'C into L');
    expect(await scoreOf(C.id)).toBe(10);
    must(await owner.post(`/site-api/crm/contacts/${A.id}/merge`, {otherId: C.id, keep: 'this'}), 'merge');
    expect(await scoreOf(A.id)).toBe(80);
  });

  it('members read bands and breakdowns they may see, and change nothing', async () => {
    const {browser: member} = await teammate(owner, 'scorer@example.com', 'MEMBER');
    const BANDS_OFF = {bands: BANDS, decay: {mode: 'off', days: 90}, notify: 'off'};
    expect((await member.get('/site-api/crm/scoring/settings')).status).toBe(200);
    expect((await member.request('PATCH', '/site-api/crm/scoring/settings', BANDS_OFF)).status).toBe(403);
    expect((await member.post('/site-api/crm/scoring/rules', {kind: 'behavior', name: 'x', points: 5, event: 'email.opened'})).status).toBe(403);
    expect((await member.request('PATCH', `/site-api/crm/scoring/rules/${P1.id}`, {enabled: false})).status).toBe(403);
    expect((await member.post('/site-api/crm/scoring/recalculate')).status).toBe(403);
    expect((await member.get('/site-api/crm/scoring/status')).status).toBe(403);
    expect((await member.get(`/site-api/crm/scoring/contacts/${A.id}`)).status).toBe(200);
    must(await owner.request('PATCH', '/site-api/crm/settings', {recordVisibility: 'owner'}), 'visibility owner');
    try {
      expect((await member.get(`/site-api/crm/scoring/contacts/${A.id}`)).status).toBe(404);
      expect((await member.post('/site-api/crm/scoring/test', {contactId: A.id})).status).toBe(404);
    } finally {
      must(await owner.request('PATCH', '/site-api/crm/settings', {recordVisibility: 'everyone'}), 'visibility back');
    }
  });

  it('outgoing webhooks get contact.score_changed for band crossings only', async () => {
    // Adapted: the URL must be one of the webhook services (src/crm/lib/webhook-targets.ts).
    const hook = must(await owner.post('/site-api/crm/webhooks', {url: `${ZAPIER}/scores/`, events: ['contact.score_changed']}), 'webhook').webhook as {id: string};
    must(await owner.request('PATCH', `/site-api/crm/scoring/rules/${P1.id}`, {points: 50}), 'P1 50'); // A 80 → 115, still hot
    must(await owner.request('PATCH', `/site-api/crm/contacts/${B.id}`, {title: 'VP Ops'}), 'B → VP'); // B 0 → 50: cold → hot
    expect(await db.webhookDelivery.count({where: {webhookId: hook.id, eventType: 'contact.score_changed'}})).toBe(1);
    // Delivered to the (faked) service.
    expect(outbound.hooks.filter((h) => h.path === '/hooks/catch/123456/scores/')).toHaveLength(1);
  });
});
