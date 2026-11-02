import {Hono} from 'hono';
import {z} from 'zod';

import type {AppEnv} from '../kit/guards';
import {HISTORY_ENTITIES, type HistoryEntry, type HistoryPage} from '@/lib/history';
import {historyRecord, recordHistory} from '../lib/history';
import {notFound, ownerScope, valid} from '../lib/http';
import {ticketScope} from '../lib/tickets';

/**
 * Property history of one record: `GET /history?entity=contact&id=…`, optionally
 * `field=lifecycleStage` (one property, with its value at creation), `q` (search)
 * and `cursor` (from `nextCursor`). Same visibility as the record page.
 */
export const history = new Hono<AppEnv>().get(
  '/',
  valid('query', z.object({
    entity: z.enum(HISTORY_ENTITIES),
    id: z.string().min(1).max(64),
    field: z.string().max(100).optional(),
    q: z.string().trim().max(100).optional(),
    cursor: z.coerce.number().int().min(0).default(0),
    take: z.coerce.number().int().min(1).max(200).default(50),
  })),
  async (c) => {
    const db = c.var.db;
    const q = c.req.valid('query');
    const record = await historyRecord(db, q.entity, q.id, await ownerScope(c), await ticketScope(c));
    if (!record) throw notFound(q.entity === 'ticket' ? 'Ticket' : q.entity === 'company' ? 'Company' : q.entity === 'deal' ? 'Deal' : 'Contact');
    const {entries, initialValue, labelOf} = await recordHistory(db, q.entity, record);

    const counts = new Map<string, number>();
    for (const e of entries) if (e.field) counts.set(e.field, (counts.get(e.field) ?? 0) + 1);
    const fields = [...counts].map(([field, count]) => ({field, label: labelOf(field), count})).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

    let rows: HistoryEntry[] = entries;
    if (q.field) {
      // One property: its changes, then the value it started with when the record was created.
      rows = entries.filter((e) => e.field === q.field);
      const created = entries.find((e) => e.kind === 'created');
      if (created) rows = [...rows, {...created, field: q.field, to: initialValue(q.field)}];
    }
    if (q.q) {
      const needle = q.q.toLowerCase();
      rows = rows.filter((e) => [e.label, e.from, e.to, e.note, e.actor.name, e.actor.by].some((s) => s?.toLowerCase().includes(needle)));
    }
    const page = rows.slice(q.cursor, q.cursor + q.take);
    const next = q.cursor + q.take < rows.length ? String(q.cursor + q.take) : null;
    return c.json({rows: page, nextCursor: next, total: rows.length, fieldLabel: q.field ? labelOf(q.field) : null, fields} satisfies HistoryPage);
  },
);
