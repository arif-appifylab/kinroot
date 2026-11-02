/**
 * Lead score on the contacts report object: the score as a number (measures,
 * filters) and its band as a groupable field, so dashboards can chart
 * "contacts by band". Bands come from settings, so the fields are built per request.
 */
import {registerReportFields} from './reports';
import {getScoringSettings} from './scoring';

registerReportFields('contacts', async (db) => {
  const {bands} = await getScoringSettings(db);
  // Keys are validated slugs and minimums integers (routes/scoring.ts); checked again here because they go into SQL.
  const safe = bands.filter((b) => /^[a-z0-9_-]{1,30}$/.test(b.key) && (b.min === null || Number.isInteger(b.min)));
  const steps = safe
    .slice(1)
    .reverse()
    .map((b) => `WHEN t."score" >= ${Number(b.min)} THEN '${b.key}'`)
    .join(' ');
  const bandSql = safe.length > 1 ? `CASE ${steps} ELSE '${safe[0]!.key}' END` : `'${safe[0]?.key ?? 'all'}'`;
  return [
    {key: 'score', label: 'Lead score', kind: 'number', sql: 't."score"::float8'},
    {key: 'scoreBand', label: 'Lead score band', kind: 'enum', sql: bandSql, options: safe.map((b) => ({value: b.key, label: b.name}))},
  ];
});
