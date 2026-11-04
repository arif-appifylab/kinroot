import type {LifecycleStage} from '../../../generated/prisma/client';
import type {Db} from '../kit/db';
import {GALLERY, STARTER_TEMPLATE_IDS} from '@/lib/email-gallery';
import {fromGallery} from '../email/templates';
import {changeStatus, createTicket} from './tickets';
import {strings} from './json-list';

/**
 * A sample teammate who owns part of the demo data. Not an account: nobody signs in as them (the
 * site's sign-in is the template's; a demo password would be a backdoor). Found again by name.
 */
const DEMO_MEMBER = {name: 'Demo User', color: '#0d9488'};

async function ensureDemoUser(db: Db) {
  if (await db.member.findFirst({where: {name: DEMO_MEMBER.name, userId: null, inviteEmail: null}})) return;
  await db.member.create({data: {...DEMO_MEMBER, role: 'ADMIN'}});
}

const STAGES = [
  {name: 'Lead in', probability: 10, color: '#94a3b8'},
  {name: 'Qualified', probability: 25, color: '#38bdf8'},
  {name: 'Meeting', probability: 40, color: '#0ea5e9'},
  {name: 'Proposal', probability: 60, color: '#2563eb'},
  {name: 'Negotiation', probability: 80, color: '#7c3aed'},
];

/** Default pipeline + templates, and optionally a believable demo dataset. */
export async function seedApp(db: Db, ownerId: string, demo: boolean) {
  const pipeline = await db.pipeline.create({
    data: {name: 'Sales pipeline', isDefault: true, rottingDays: 14, stages: {create: STAGES.map((s, i) => ({...s, position: i}))}},
    include: {stages: {orderBy: {position: 'asc'}}},
  });
  const starters = STARTER_TEMPLATE_IDS.map((id) => GALLERY.find((g) => g.id === id)!);
  await db.emailTemplate.createMany({data: starters.map((g) => ({...fromGallery(g), ownerId, shared: true}))});
  if (!demo) return;
  await ensureDemoUser(db);

  const day = 86400_000;
  const now = Date.now();
  const ago = (d: number) => new Date(now - d * day);
  const ahead = (d: number) => new Date(now + d * day);

  const companies = await Promise.all(
    [
      {name: 'Northwind Labs', domain: 'northwind.io', industry: 'Software', size: '51-200', tags: ['saas', 'priority']},
      {name: 'Bluepeak Logistics', domain: 'bluepeak.com', industry: 'Logistics', size: '201-500', tags: ['enterprise']},
      {name: 'Fernway Health', domain: 'fernway.health', industry: 'Healthcare', size: '11-50', tags: []},
      {name: 'Orbit Retail', domain: 'orbitretail.co', industry: 'Retail', size: '501-1000', tags: ['enterprise']},
      {name: 'Kestrel Finance', domain: 'kestrel.finance', industry: 'Financial services', size: '51-200', tags: ['fintech']},
      {name: 'Sundial Studio', domain: 'sundial.studio', industry: 'Design agency', size: '1-10', tags: ['agency']},
    ].map((c, i) => db.company.create({data: {...c, website: `https://${c.domain}`, ownerId, lastActivityAt: ago(2), createdAt: ago(45 - i * 2)}})),
  );

  const people: [string, string, string, number, LifecycleStage, string][] = [
    ['Maya', 'Chen', 'VP Operations', 0, 'OPPORTUNITY', 'Referral'],
    ['Daniel', 'Okafor', 'CTO', 0, 'QUALIFIED', 'Website'],
    ['Priya', 'Raman', 'Head of Supply Chain', 1, 'OPPORTUNITY', 'Event'],
    ['Lucas', 'Meyer', 'Procurement Lead', 1, 'LEAD', 'Outbound'],
    ['Amara', 'Diallo', 'Founder & CEO', 2, 'CUSTOMER', 'Referral'],
    ['Sofia', 'García', 'Director of IT', 3, 'OPPORTUNITY', 'Ads'],
    ['Tom', 'Becker', 'Store Systems Manager', 3, 'LEAD', 'Website'],
    ['Hana', 'Sato', 'CFO', 4, 'QUALIFIED', 'Partner'],
    ['Noah', 'Williams', 'Creative Director', 5, 'CUSTOMER', 'Referral'],
    ['Elena', 'Petrova', 'Finance Manager', 4, 'LEAD', 'Outbound'],
  ];
  const contacts = await Promise.all(
    people.map(([firstName, lastName, title, ci, lifecycleStage, source], i) => {
      const company = companies[ci]!;
      return db.contact.create({
        data: {
          firstName,
          lastName,
          title,
          lifecycleStage,
          source,
          email: `${firstName.normalize('NFD').toLowerCase().replace(/[^a-z]/g, '')}.${lastName.normalize('NFD').toLowerCase().replace(/[^a-z]/g, '')}@${company.domain}`,
          phone: `+1 555 01${String(ci).padStart(2, '0')}`,
          ownerId,
          lastActivityAt: ago(ci + 1),
          createdAt: ago(i === 0 ? 34 : 30 - i),
          companies: {create: {companyId: company.id, isPrimary: true}},
        },
      });
    }),
  );

  // Creation entries, so every record's timeline and property history start somewhere.
  await db.activity.createMany({
    data: [
      ...companies.map((c) => ({type: 'company_created', title: 'Company created', actorId: ownerId, companyId: c.id, createdAt: c.createdAt})),
      ...contacts.map((c) => ({type: 'contact_created', title: 'Contact created', actorId: ownerId, contactId: c.id, createdAt: c.createdAt})),
    ],
  });

  // Maya's path from lead to opportunity, as it would have been edited on her record.
  const mayaId = contacts[0]!.id;
  await db.contact.update({where: {id: mayaId}, data: {leadStatus: 'Open deal'}});
  const edits: [number, {field: string; from: string | null; to: string}[]][] = [
    [30, [{field: 'title', from: 'Director of Operations', to: 'VP Operations'}]],
    [27, [{field: 'leadStatus', from: null, to: 'Attempted to contact'}]],
    [24, [{field: 'leadStatus', from: 'Attempted to contact', to: 'Connected'}, {field: 'lifecycleStage', from: 'LEAD', to: 'QUALIFIED'}]],
    [21, [{field: 'lifecycleStage', from: 'QUALIFIED', to: 'OPPORTUNITY'}, {field: 'leadStatus', from: 'Connected', to: 'Open deal'}]],
  ];
  await db.activity.createMany({
    data: edits.map(([days, changes]) => ({type: 'field_changed', title: 'Contact updated', actorId: ownerId, contactId: mayaId, data: {changes}, createdAt: ago(days)})),
  });

  const s = pipeline.stages;
  const deals: {title: string; value: number; stage: number; ci: number; contacts: number[]; close: number; idle: number}[] = [
    {title: 'Northwind: annual platform plan', value: 48000, stage: 3, ci: 0, contacts: [0, 1], close: 12, idle: 1},
    {title: 'Bluepeak: fleet analytics pilot', value: 22000, stage: 2, ci: 1, contacts: [2], close: 25, idle: 3},
    {title: 'Bluepeak: warehouse rollout', value: 96000, stage: 0, ci: 1, contacts: [3], close: 60, idle: 18},
    {title: 'Orbit Retail: 40 store licences', value: 64000, stage: 4, ci: 3, contacts: [5], close: 6, idle: 2},
    {title: 'Orbit Retail: POS integration', value: 15000, stage: 1, ci: 3, contacts: [6], close: 30, idle: 5},
    {title: 'Kestrel: compliance add-on', value: 18500, stage: 2, ci: 4, contacts: [7], close: 20, idle: 9},
    {title: 'Kestrel: team expansion', value: 9000, stage: 0, ci: 4, contacts: [9], close: 45, idle: 1},
    {title: 'Fernway: renewal + upsell', value: 12000, stage: 3, ci: 2, contacts: [4], close: 9, idle: 16},
  ];
  const created: string[] = [];
  for (const [i, d] of deals.entries()) {
    const deal = await db.deal.create({
      data: {
        title: d.title,
        value: d.value,
        pipelineId: pipeline.id,
        stageId: s[d.stage]!.id,
        companyId: companies[d.ci]!.id,
        ownerId,
        position: i,
        expectedCloseDate: ahead(d.close),
        stageEnteredAt: ago(d.idle + 2),
        lastActivityAt: ago(d.idle),
        createdAt: ago(d.idle + 20),
        contacts: {create: d.contacts.map((ci) => ({contactId: contacts[ci]!.id}))},
        companies: {create: {companyId: companies[d.ci]!.id, isPrimary: true}},
      },
    });
    created.push(deal.id);
    // Stage history: walk the deal from the first stage up to where it sits now.
    for (let st = 0; st <= d.stage; st++) {
      await db.stageChange.create({
        data: {dealId: deal.id, fromStageId: st ? s[st - 1]!.id : null, toStageId: s[st]!.id, userId: ownerId, createdAt: ago(d.idle + 2 + (d.stage - st) * 4)},
      });
    }
    await db.activity.create({
      data: {type: 'deal_created', title: `Deal created: ${deal.title}`, actorId: ownerId, dealId: deal.id, companyId: deal.companyId, createdAt: ago(d.idle + 20)},
    });
  }

  // Closed deals feed the dashboard's won/lost numbers.
  const closed = [
    {title: 'Sundial: brand portal', value: 14000, status: 'WON' as const, ci: 5, days: 8},
    {title: 'Fernway: starter plan', value: 6000, status: 'WON' as const, ci: 2, days: 21},
    {title: 'Orbit Retail: kiosk trial', value: 11000, status: 'LOST' as const, ci: 3, days: 12, lostReason: 'Chose a competitor'},
  ];
  for (const d of closed) {
    await db.deal.create({
      data: {
        title: d.title,
        value: d.value,
        status: d.status,
        lostReason: d.lostReason,
        pipelineId: pipeline.id,
        stageId: s[s.length - 1]!.id,
        companyId: companies[d.ci]!.id,
        ownerId,
        closedAt: ago(d.days),
        createdAt: ago(d.days + 30),
        lastActivityAt: ago(d.days),
        companies: {create: {companyId: companies[d.ci]!.id, isPrimary: true}},
      },
    });
  }

  const maya = contacts[0]!;
  const note = await db.note.create({
    data: {
      body: 'Maya wants SSO and an audit log before signing. Legal review is booked for next week; budget is approved for Q4.',
      pinned: true,
      authorId: ownerId,
      contactId: maya.id,
      companyId: companies[0]!.id,
    },
  });
  await db.activity.create({
    data: {type: 'note', title: 'Note added', refId: note.id, actorId: ownerId, contactId: maya.id, companyId: companies[0]!.id, data: {body: note.body, pinned: true}, createdAt: ago(1)},
  });

  // A logged call and an upcoming meeting, so the activity timeline isn't empty.
  const call = await db.interaction.create({
    data: {kind: 'CALL', body: 'Walked Maya through the security roadmap. She wants SSO before Q4 sign-off.', outcome: 'Connected', direction: 'OUTBOUND', durationMin: 18, occurredAt: ago(2), authorId: ownerId, contactId: maya.id, companyId: companies[0]!.id, dealId: created[0], attendeeIds: [maya.id]},
  });
  const meeting = await db.interaction.create({
    data: {kind: 'MEETING', title: 'Security & SSO deep dive', body: 'Agenda: SSO options, audit log, rollout plan.', outcome: 'Scheduled', durationMin: 45, location: 'Google Meet', occurredAt: ahead(3), authorId: ownerId, contactId: maya.id, companyId: companies[0]!.id, dealId: created[0], attendeeIds: [maya.id, contacts[1]!.id]},
  });
  for (const i of [call, meeting]) {
    await db.activity.create({
      data: {
        type: `interaction_${i.kind}`,
        title: i.kind === 'CALL' ? 'Logged call' : `Meeting scheduled: ${i.title}`,
        refId: i.id,
        actorId: ownerId,
        contactId: i.contactId,
        companyId: i.companyId,
        dealId: i.dealId,
        createdAt: i.occurredAt,
        text: [i.title, i.body].filter(Boolean).join('\n'),
        data: {
          kind: i.kind, title: i.title, body: i.body, outcome: i.outcome, direction: i.direction, durationMin: i.durationMin, location: i.location, occurredAt: i.occurredAt.toISOString(),
          attendees: strings(i.attendeeIds).map((id) => {
            const p = contacts.find((c) => c.id === id)!;
            return {id, name: `${p.firstName} ${p.lastName ?? ''}`.trim()};
          }),
        },
      },
    });
  }

  await db.task.createMany({
    data: [
      {title: 'Send security questionnaire to Maya', type: 'EMAIL', priority: 'HIGH', dueAt: ago(1), assigneeId: ownerId, creatorId: ownerId, contactId: maya.id, dealId: created[0]},
      {title: 'Pricing call with Sofia', type: 'CALL', dueAt: new Date(now + 3 * 3600_000), assigneeId: ownerId, creatorId: ownerId, contactId: contacts[5]!.id, dealId: created[3]},
      {title: 'Demo for Kestrel compliance team', type: 'MEETING', dueAt: ahead(2), assigneeId: ownerId, creatorId: ownerId, contactId: contacts[7]!.id, dealId: created[5]},
      {title: 'Check in on Fernway renewal', type: 'TODO', dueAt: ahead(4), assigneeId: ownerId, creatorId: ownerId, contactId: contacts[4]!.id, dealId: created[7]},
    ],
  });

  // Support tickets: a few across the pipeline, plus canned replies.
  const owner = {id: ownerId, name: 'Owner'};
  await createTicket(db, {subject: 'CSV export stops at 1,000 rows', description: 'Our export only contains the first 1,000 contacts. We have about 4,000.', priority: 'HIGH', category: 'Problem', queue: 'Technical', source: 'EMAIL', contactId: maya.id, assigneeId: ownerId, actorId: ownerId, at: ago(1)});
  await createTicket(db, {subject: 'Add a second billing contact', description: 'Please also send invoices to finance@ our domain.', priority: 'LOW', category: 'Billing', queue: 'Billing', source: 'PORTAL', contactId: contacts[2]!.id, at: new Date(now - 3 * 3600_000)});
  const answered = await createTicket(db, {subject: 'How do I invite my team?', description: 'Where do I add colleagues?', category: 'Question', queue: 'Support', source: 'MANUAL', contactId: contacts[5]!.id, assigneeId: ownerId, actorId: ownerId, at: ago(2)});
  await db.ticket.update({where: {id: answered.id}, data: {firstResponseAt: ago(2)}});
  await changeStatus(db, answered, 'RESOLVED', owner, {quiet: true});
  await db.cannedReply.createMany({
    data: [
      {name: 'Thanks, looking into it', body: 'Hi {{contact.first_name|there}},\n\nThanks for reaching out. We are looking into this and will get back to you shortly.\n\n{{me.first_name}}', position: 0},
      {name: 'Invite teammates', body: 'Hi {{contact.first_name|there}},\n\nYou can invite colleagues from Settings → Team → Invite. They get an email with a link to join.\n\n{{me.first_name}}', position: 1},
    ],
  });
}
