import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import type {CalendarConnection} from '../../../generated/prisma/client';
import {CRM_APP, publicOrigin} from '../kit/config';
import {encryptJson, sign, verifySignature} from '../kit/crypto';
import {currentUser, type AppContext, type AppEnv} from '../kit/guards';
import {calendarAuthorizeUrl, calendarClient, exchangeCalendarCode, type CalendarProvider} from '../calendar/oauth';
import {calendarsOf, refreshCalendars, syncConnection} from '../calendar/service';
import {audit} from '../lib/audit';
import {notFound, valid} from '../lib/http';

const PROVIDERS: CalendarProvider[] = ['google', 'microsoft'];

const redirectUri = (c: AppContext, kind: CalendarProvider) => `${publicOrigin(c.req.raw)}/site-api/crm/calendar/oauth/${kind}/callback`;

/** Never send tokens to the browser. */
const view = ({credentials: _c, ...conn}: CalendarConnection) => ({...conn, calendars: calendarsOf(conn)});

async function ownConnection(c: AppContext, id: string) {
  const conn = await c.var.db.calendarConnection.findUnique({where: {id}});
  if (!conn || conn.userId !== currentUser(c).id) throw notFound('Calendar');
  return conn;
}

/** Each user connects their own calendars (Settings → Calendar). */
export const calendar = new Hono<AppEnv>()
  .get('/', async (c) => {
    const me = currentUser(c);
    const db = c.var.db;
    const rows = await db.calendarConnection.findMany({where: {userId: me.id}, orderBy: {createdAt: 'asc'}});
    const [google, microsoft] = await Promise.all(PROVIDERS.map((k) => calendarClient(db, k)));
    return c.json({
      connections: rows.map(view),
      providers: {google: !!google, microsoft: !!microsoft},
      redirectUris: {google: redirectUri(c, 'google'), microsoft: redirectUri(c, 'microsoft')},
    });
  })

  .get('/oauth/:kind/start', async (c) => {
    const me = currentUser(c);
    const kind = c.req.param('kind') as CalendarProvider;
    if (!PROVIDERS.includes(kind)) throw notFound('Provider');
    if (me.role === 'VIEWER') return c.redirect(`${CRM_APP}/settings/calendar?error=` + encodeURIComponent('Read-only accounts cannot connect a calendar'));
    const client = await calendarClient(c.var.db, kind);
    if (!client) return c.redirect(`${CRM_APP}/settings/calendar?error=` + encodeURIComponent(`An admin needs to add the ${kind === 'google' ? 'Google' : 'Microsoft'} OAuth app in Settings → Email first`));
    // Own prefix, so a mailbox OAuth state can't be replayed here (and vice versa).
    const payload = `calendar.${kind}.${me.id}.${Date.now() + 10 * 60_000}`;
    return c.redirect(calendarAuthorizeUrl(kind, client, redirectUri(c, kind), `${payload}.${await sign(payload)}`));
  })

  .get('/oauth/:kind/callback', async (c) => {
    const me = currentUser(c);
    const db = c.var.db;
    const kind = c.req.param('kind') as CalendarProvider;
    const back = (msg: string, ok = false) => c.redirect(`${CRM_APP}/settings/calendar?${ok ? 'connected' : 'error'}=${encodeURIComponent(msg)}`);
    if (c.req.query('error')) return back(c.req.query('error_description') ?? c.req.query('error')!);

    const [prefix, k, userId, exp, sig] = (c.req.query('state') ?? '').split('.');
    const payload = `${prefix}.${k}.${userId}.${exp}`;
    if (prefix !== 'calendar' || k !== kind || userId !== me.id || Number(exp) < Date.now() || !(await verifySignature(payload, sig ?? ''))) {
      return back('The sign-in link expired. Please try again.');
    }
    const client = await calendarClient(db, kind);
    if (!client) return back('OAuth app is not configured');
    try {
      const {creds, email} = await exchangeCalendarCode(kind, client, c.req.query('code') ?? '', redirectUri(c, kind));
      const credentials = await encryptJson(creds);
      const hasDefault = (await db.calendarConnection.count({where: {userId: me.id, isDefault: true}})) > 0;
      const conn = await db.calendarConnection.upsert({
        where: {userId_provider_email: {userId: me.id, provider: kind, email}},
        create: {userId: me.id, provider: kind, email, credentials, isDefault: !hasDefault},
        update: {credentials, status: 'CONNECTED', lastError: null},
      });
      await refreshCalendars(db, conn).catch(() => null);
      await audit(db, c, {action: 'calendar.connected', entity: 'calendar', recordId: conn.id, label: email, meta: {provider: kind}});
      return back(`${email} connected`, true);
    } catch (e) {
      return back((e as Error).message);
    }
  })

  .patch(
    '/connections/:id',
    valid('json', z.object({busyCalendarIds: z.array(z.string()).max(20).optional(), targetCalendarId: z.string().nullable().optional(), syncMeetings: z.boolean().optional(), isDefault: z.literal(true).optional()})),
    async (c) => {
      const db = c.var.db;
      const conn = await ownConnection(c, c.req.param('id'));
      const body = c.req.valid('json');
      const known = calendarsOf(conn);
      if (body.busyCalendarIds) body.busyCalendarIds = body.busyCalendarIds.filter((id) => known.some((k) => k.id === id));
      if (body.targetCalendarId && !known.some((k) => k.id === body.targetCalendarId && k.writable)) throw new HTTPException(400, {message: 'Pick a calendar you can add events to'});
      if (body.isDefault) await db.calendarConnection.updateMany({where: {userId: conn.userId, id: {not: conn.id}}, data: {isDefault: false}});
      return c.json({connection: view(await db.calendarConnection.update({where: {id: conn.id}, data: body}))});
    },
  )

  .post('/connections/:id/refresh', async (c) => {
    const conn = await ownConnection(c, c.req.param('id'));
    try {
      return c.json({connection: view(await refreshCalendars(c.var.db, conn))});
    } catch (e) {
      throw new HTTPException(502, {message: (e as Error).message});
    }
  })

  .post('/connections/:id/sync', async (c) => {
    const conn = await ownConnection(c, c.req.param('id'));
    return c.json(await syncConnection(c.var.db, {...conn, syncMeetings: true}));
  })

  .delete('/connections/:id', async (c) => {
    const db = c.var.db;
    const conn = await ownConnection(c, c.req.param('id'));
    // Meetings it wrote or logged stay in the CRM; only the link to the events goes.
    await db.calendarConnection.delete({where: {id: conn.id}});
    await audit(db, c, {action: 'calendar.removed', entity: 'calendar', recordId: conn.id, label: conn.email, meta: {provider: conn.provider}});
    if (conn.isDefault) {
      const next = await db.calendarConnection.findFirst({where: {userId: conn.userId}, orderBy: {createdAt: 'asc'}});
      if (next) await db.calendarConnection.update({where: {id: next.id}, data: {isDefault: true}});
    }
    return c.json({ok: true});
  });
