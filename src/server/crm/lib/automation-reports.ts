import {OBJECTS, RUN_SOURCES, RUN_STATUS} from '@/lib/automations';
import {registerReportObject, registerReportRef} from './reports';

/**
 * Automation runs in the report builder and on dashboards ("failed runs per
 * week", "runs by automation"). Imported for its side effect from
 * src/server/app.ts. Owner = the owner of the record the run was about.
 */

registerReportRef('automation', {
  sql: `SELECT id, name AS label, NULL::float8 AS ord, NULL::text AS ctx FROM "Automation" WHERE id = ANY($1::text[])`,
  list: `SELECT id, name AS label FROM "Automation" ORDER BY name LIMIT 500`,
});

registerReportObject({
  key: 'automation_runs',
  label: 'Automation runs',
  noun: ['automation run', 'automation runs'],
  table: '"AutomationRun"',
  where: 't."test" IS NULL', // test runs from the editor are not real runs
  ownerSql: 't."ownerId"',
  ownerLabel: 'Record owner',
  defaultDate: 'startedAt',
  fields: [
    {key: 'durationMin', label: 'Duration (minutes)', kind: 'number', sql: '(EXTRACT(EPOCH FROM t."finishedAt" - t."startedAt") / 60.0)::float8'},
    {key: 'automation', label: 'Automation', kind: 'ref', ref: 'automation', sql: 't."automationId"', empty: 'Deleted automation'},
    {key: 'status', label: 'Status', kind: 'enum', sql: 't."status"', options: Object.entries(RUN_STATUS).map(([value, s]) => ({value, label: s.label}))},
    {key: 'source', label: 'Started by', kind: 'enum', sql: 't."source"', options: Object.entries(RUN_SOURCES).filter(([value]) => value !== 'test').map(([value, label]) => ({value, label}))},
    {key: 'object', label: 'Record type', kind: 'enum', sql: 't."object"', options: [...Object.entries(OBJECTS).map(([value, o]) => ({value, label: o.label})), {value: 'none', label: 'No record'}]},
    {key: 'owner', label: 'Record owner', kind: 'ref', ref: 'user', sql: 't."ownerId"', empty: 'No owner'},
    {key: 'startedAt', label: 'Started', kind: 'date', sql: 't."startedAt"'},
    {key: 'finishedAt', label: 'Finished', kind: 'date', sql: 't."finishedAt"'},
  ],
});
