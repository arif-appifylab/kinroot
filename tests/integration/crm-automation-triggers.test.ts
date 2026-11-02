import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import type {Db} from '../../src/server/crm/kit/db';
import {automationTick} from '../../src/server/crm/lib/automations';
import {resetCrm} from './support/crm';
import {configureEnv, DATABASE_URL, db} from './support/harness';

/**
 * Kinroot's date and inactivity triggers (src/server/crm/lib/automations.ts): the queries that find
 * due records are tagged `Prisma.sql` with the table and column from fixed maps and every value
 * bound. One tick fires each automation once for the record that is due, and never for the rest.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms);
const day = (d: Date) => d.toISOString().slice(0, 10);

async function automation(name: string, trigger: Record<string, unknown>) {
  return db.automation.create({
    data: {name, enabled: true, object: 'deal', triggerKind: trigger.kind as string, trigger: trigger as object, steps: [], enabledAt: ago(3 * DAY)},
  });
}

describe.skipIf(!DATABASE_URL)('Kinroot automation triggers (integration, real Postgres)', () => {
  beforeAll(configureEnv);
  afterAll(async () => {
    await db.$disconnect();
  });
  beforeEach(resetCrm);

  it('fires date (built-in and custom) and inactivity triggers for the due record only', async () => {
    const pipeline = await db.pipeline.create({data: {name: 'Sales'}});
    const stage = await db.stage.create({data: {pipelineId: pipeline.id, name: 'New'}});
    await db.customFieldDef.create({data: {entity: 'DEAL', key: 'launch', label: 'Launch', type: 'DATE'}});
    const deal = (title: string, data: Record<string, unknown>) => db.deal.create({data: {title, pipelineId: pipeline.id, stageId: stage.id, ...data}});
    const due = await deal('Due', {expectedCloseDate: ago(2 * HOUR), custom: {launch: day(ago(DAY))}, lastActivityAt: ago(2 * DAY)});
    await deal('Later', {expectedCloseDate: new Date(Date.now() + 10 * DAY), custom: {launch: day(new Date(Date.now() + 10 * DAY))}, lastActivityAt: ago(HOUR)});

    const closing = await automation('Close date passed', {kind: 'date', source: 'record', field: 'expectedCloseDate', amount: 1, unit: 'hours', direction: 'after'});
    const launch = await automation('After launch', {kind: 'date', source: 'record', field: 'custom.launch', amount: 1, unit: 'hours', direction: 'after'});
    const quiet = await automation('Gone quiet', {kind: 'inactivity', rule: 'no_activity', amount: 1, unit: 'days'});

    const result = await automationTick(db as unknown as Db);
    expect(result.automations).toBe(3);

    for (const a of [closing, launch, quiet]) {
      const fires = await db.automationFire.findMany({where: {automationId: a.id}, select: {recordId: true}});
      expect(fires.map(f => f.recordId), a.name).toEqual([due.id]);
    }

    // A second tick finds nothing new: each fires once.
    await automationTick(db as unknown as Db);
    expect(await db.automationFire.count()).toBe(3);
  });
});
