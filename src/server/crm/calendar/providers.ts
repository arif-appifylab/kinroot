import type {Interval} from '@/lib/scheduling';
import type {OAuthCreds} from '../email/providers';
import type {CalendarProvider} from './oauth';

/**
 * Google Calendar API and Microsoft Graph behind one small interface:
 * list calendars, read busy times, write / move / cancel events (with an
 * auto-created Meet or Teams link), and list events for the sync.
 */

export type CalendarInfo = {id: string; name: string; primary: boolean; writable: boolean};

export type EventInput = {
  title: string;
  description?: string | null;
  start: Date;
  end: Date;
  location?: string | null;
  attendees: {email: string; name?: string | null}[];
  /** Ask the provider for a Google Meet / Teams link. */
  video?: boolean;
};

export type EventResult = {id: string; meetingUrl: string | null; changeKey: string | null};

export type ExternalEvent = {
  id: string;
  title: string;
  description: string | null;
  start: Date;
  end: Date;
  allDay: boolean;
  canceled: boolean;
  location: string | null;
  meetingUrl: string | null;
  attendees: {email: string; name: string | null}[];
  changeKey: string;
};

const GOOGLE = 'https://www.googleapis.com/calendar/v3';
const GRAPH = 'https://graph.microsoft.com/v1.0';

async function call<T>(creds: OAuthCreds, url: string, init: RequestInit = {}, provider: CalendarProvider = 'google'): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${creds.accessToken}`,
      ...(init.body ? {'content-type': 'application/json'} : {}),
      ...(provider === 'microsoft' ? {prefer: 'outlook.timezone="UTC"'} : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 204) return {} as T;
  const body = (await res.json().catch(() => ({}))) as T & {error?: {message?: string} | string};
  if (!res.ok) {
    const err = body.error;
    const message = typeof err === 'string' ? err : err?.message;
    throw new Error(`${provider === 'google' ? 'Google Calendar' : 'Microsoft Graph'}: ${message ?? `HTTP ${res.status}`}`);
  }
  return body;
}

const enc = encodeURIComponent;
const graphCalendar = (id: string) => (id === 'primary' ? `${GRAPH}/me/calendar` : `${GRAPH}/me/calendars/${enc(id)}`);
/** Graph returns UTC wall times without a zone marker when asked for UTC. */
const graphDate = (v: {dateTime: string}) => new Date(/[zZ]|[+-]\d\d:\d\d$/.test(v.dateTime) ? v.dateTime : `${v.dateTime}Z`);
const graphTime = (d: Date) => ({dateTime: d.toISOString().replace(/Z$/, ''), timeZone: 'UTC'});

// ─── Calendars ──────────────────────────────────────────────────────────────

export async function listCalendars(provider: CalendarProvider, creds: OAuthCreds): Promise<CalendarInfo[]> {
  if (provider === 'google') {
    const r = await call<{items?: {id: string; summary: string; summaryOverride?: string; primary?: boolean; accessRole: string}[]}>(creds, `${GOOGLE}/users/me/calendarList?minAccessRole=reader&maxResults=100`);
    return (r.items ?? []).map((c) => ({id: c.id, name: c.summaryOverride || c.summary, primary: !!c.primary, writable: c.accessRole === 'owner' || c.accessRole === 'writer'}));
  }
  const r = await call<{value?: {id: string; name: string; isDefaultCalendar?: boolean; canEdit?: boolean}[]}>(creds, `${GRAPH}/me/calendars?$select=id,name,isDefaultCalendar,canEdit&$top=100`, {}, provider);
  return (r.value ?? []).map((c) => ({id: c.id, name: c.name, primary: !!c.isDefaultCalendar, writable: c.canEdit !== false}));
}

// ─── Busy times ─────────────────────────────────────────────────────────────

export async function busyTimes(provider: CalendarProvider, creds: OAuthCreds, calendarIds: string[], from: Date, to: Date): Promise<Interval[]> {
  if (!calendarIds.length) return [];
  if (provider === 'google') {
    const r = await call<{calendars?: Record<string, {busy?: {start: string; end: string}[]}>}>(creds, `${GOOGLE}/freeBusy`, {
      method: 'POST',
      body: JSON.stringify({timeMin: from.toISOString(), timeMax: to.toISOString(), items: calendarIds.map((id) => ({id}))}),
    });
    return Object.values(r.calendars ?? {}).flatMap((c) => (c.busy ?? []).map((b) => ({start: Date.parse(b.start), end: Date.parse(b.end)})));
  }
  const out: Interval[] = [];
  for (const id of calendarIds.slice(0, 10)) {
    let url: string | undefined = `${graphCalendar(id)}/calendarView?startDateTime=${from.toISOString()}&endDateTime=${to.toISOString()}&$select=start,end,showAs,isCancelled&$top=250`;
    for (let page = 0; url && page < 4; page++) {
      const r: {value?: {start: {dateTime: string}; end: {dateTime: string}; showAs?: string; isCancelled?: boolean}[]; '@odata.nextLink'?: string} = await call(creds, url, {}, provider);
      for (const e of r.value ?? []) {
        if (e.isCancelled || e.showAs === 'free' || e.showAs === 'workingElsewhere') continue;
        out.push({start: graphDate(e.start).getTime(), end: graphDate(e.end).getTime()});
      }
      url = r['@odata.nextLink'];
    }
  }
  return out;
}

// ─── Writing events ─────────────────────────────────────────────────────────

type GoogleEvent = {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  hangoutLink?: string;
  conferenceData?: {entryPoints?: {entryPointType: string; uri: string}[]};
  start: {dateTime?: string; date?: string};
  end: {dateTime?: string; date?: string};
  attendees?: {email: string; displayName?: string; self?: boolean; resource?: boolean}[];
  updated?: string;
  etag?: string;
};

type GraphEvent = {
  id: string;
  subject?: string;
  bodyPreview?: string;
  start: {dateTime: string};
  end: {dateTime: string};
  isAllDay?: boolean;
  isCancelled?: boolean;
  location?: {displayName?: string};
  onlineMeeting?: {joinUrl?: string} | null;
  attendees?: {emailAddress: {address: string; name?: string}; type?: string}[];
  lastModifiedDateTime?: string;
  changeKey?: string;
};

const googleMeetUrl = (e: GoogleEvent) => e.hangoutLink ?? e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri ?? null;

function googleBody(input: EventInput, withConference: boolean) {
  return {
    summary: input.title,
    description: input.description ?? undefined,
    location: input.location ?? undefined,
    start: {dateTime: input.start.toISOString()},
    end: {dateTime: input.end.toISOString()},
    attendees: input.attendees.map((a) => ({email: a.email, displayName: a.name ?? undefined})),
    ...(withConference ? {conferenceData: {createRequest: {requestId: crypto.randomUUID(), conferenceSolutionKey: {type: 'hangoutsMeet'}}}} : {}),
  };
}

function graphBody(input: EventInput, withMeeting: boolean) {
  return {
    subject: input.title,
    body: {contentType: 'text', content: input.description ?? ''},
    start: graphTime(input.start),
    end: graphTime(input.end),
    location: input.location ? {displayName: input.location} : undefined,
    attendees: input.attendees.map((a) => ({emailAddress: {address: a.email, name: a.name ?? a.email}, type: 'required'})),
    ...(withMeeting ? {isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness'} : {}),
  };
}

/** Creates the event; the provider emails the attendees its own invitation. */
export async function createEvent(provider: CalendarProvider, creds: OAuthCreds, calendarId: string, input: EventInput): Promise<EventResult> {
  if (provider === 'google') {
    const e = await call<GoogleEvent>(creds, `${GOOGLE}/calendars/${enc(calendarId)}/events?conferenceDataVersion=1&sendUpdates=all`, {method: 'POST', body: JSON.stringify(googleBody(input, !!input.video))});
    return {id: e.id, meetingUrl: googleMeetUrl(e), changeKey: e.updated ?? null};
  }
  const e = await call<GraphEvent>(creds, `${graphCalendar(calendarId)}/events`, {method: 'POST', body: JSON.stringify(graphBody(input, !!input.video))}, provider);
  return {id: e.id, meetingUrl: e.onlineMeeting?.joinUrl ?? null, changeKey: e.lastModifiedDateTime ?? null};
}

/** Moves / renames an event (attendees get the provider's update email). */
export async function updateEvent(provider: CalendarProvider, creds: OAuthCreds, calendarId: string, eventId: string, input: EventInput): Promise<EventResult> {
  if (provider === 'google') {
    const e = await call<GoogleEvent>(creds, `${GOOGLE}/calendars/${enc(calendarId)}/events/${enc(eventId)}?conferenceDataVersion=1&sendUpdates=all`, {method: 'PATCH', body: JSON.stringify(googleBody(input, false))});
    return {id: e.id, meetingUrl: googleMeetUrl(e), changeKey: e.updated ?? null};
  }
  const e = await call<GraphEvent>(creds, `${GRAPH}/me/events/${enc(eventId)}`, {method: 'PATCH', body: JSON.stringify(graphBody(input, false))}, provider);
  return {id: e.id ?? eventId, meetingUrl: e.onlineMeeting?.joinUrl ?? null, changeKey: e.lastModifiedDateTime ?? null};
}

/** Cancels the event and tells attendees. A missing event counts as done. */
export async function cancelEvent(provider: CalendarProvider, creds: OAuthCreds, calendarId: string, eventId: string, comment?: string) {
  try {
    if (provider === 'google') {
      await call(creds, `${GOOGLE}/calendars/${enc(calendarId)}/events/${enc(eventId)}?sendUpdates=all`, {method: 'DELETE'});
      return;
    }
    // /cancel notifies attendees; it fails on events without attendees, where a delete is right.
    await call(creds, `${GRAPH}/me/events/${enc(eventId)}/cancel`, {method: 'POST', body: JSON.stringify({comment: comment ?? ''})}, provider).catch(() =>
      call(creds, `${GRAPH}/me/events/${enc(eventId)}`, {method: 'DELETE'}, provider),
    );
  } catch (e) {
    if (/not ?found|deleted|HTTP 410|HTTP 404/i.test((e as Error).message)) return;
    throw e;
  }
}

// ─── Reading events (sync) ──────────────────────────────────────────────────

export async function listEvents(
  provider: CalendarProvider,
  creds: OAuthCreds,
  calendarId: string,
  range: {from: Date; to: Date; updatedSince?: Date | null},
): Promise<ExternalEvent[]> {
  const out: ExternalEvent[] = [];
  if (provider === 'google') {
    const p = new URLSearchParams({singleEvents: 'true', timeMin: range.from.toISOString(), timeMax: range.to.toISOString(), maxResults: '250'});
    if (range.updatedSince) {
      p.set('updatedMin', range.updatedSince.toISOString());
      p.set('showDeleted', 'true');
    }
    let token: string | undefined;
    for (let page = 0; page < 4; page++) {
      if (token) p.set('pageToken', token);
      const r = await call<{items?: GoogleEvent[]; nextPageToken?: string}>(creds, `${GOOGLE}/calendars/${enc(calendarId)}/events?${p}`);
      for (const e of r.items ?? []) {
        const allDay = !e.start?.dateTime;
        out.push({
          id: e.id,
          title: e.summary ?? '(no title)',
          description: e.description ?? null,
          start: new Date(e.start?.dateTime ?? `${e.start?.date}T00:00:00Z`),
          end: new Date(e.end?.dateTime ?? `${e.end?.date}T00:00:00Z`),
          allDay,
          canceled: e.status === 'cancelled',
          location: e.location ?? null,
          meetingUrl: googleMeetUrl(e),
          attendees: (e.attendees ?? []).filter((a) => !a.self && !a.resource).map((a) => ({email: a.email.toLowerCase(), name: a.displayName ?? null})),
          changeKey: e.updated ?? e.etag ?? '',
        });
      }
      token = r.nextPageToken;
      if (!token) break;
    }
    return out;
  }
  let url: string | undefined =
    `${graphCalendar(calendarId)}/calendarView?startDateTime=${range.from.toISOString()}&endDateTime=${range.to.toISOString()}&$top=100` +
    '&$select=id,subject,bodyPreview,start,end,isAllDay,isCancelled,location,onlineMeeting,attendees,lastModifiedDateTime';
  for (let page = 0; url && page < 4; page++) {
    const r: {value?: GraphEvent[]; '@odata.nextLink'?: string} = await call(creds, url, {}, provider);
    for (const e of r.value ?? []) {
      out.push({
        id: e.id,
        title: e.subject || '(no title)',
        description: e.bodyPreview ?? null,
        start: graphDate(e.start),
        end: graphDate(e.end),
        allDay: !!e.isAllDay,
        canceled: !!e.isCancelled,
        location: e.location?.displayName || null,
        meetingUrl: e.onlineMeeting?.joinUrl ?? null,
        attendees: (e.attendees ?? []).filter((a) => a.type !== 'resource').map((a) => ({email: a.emailAddress.address.toLowerCase(), name: a.emailAddress.name ?? null})),
        changeKey: e.lastModifiedDateTime ?? e.changeKey ?? '',
      });
    }
    url = r['@odata.nextLink'];
  }
  return out;
}
