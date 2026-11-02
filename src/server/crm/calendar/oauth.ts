import type {CalendarConnection} from '../../../generated/prisma/client';
import {decryptJson, encryptJson} from '../kit/crypto';
import type {Db} from '../kit/db';
import {oauthClient, type OAuthKind} from '../email/oauth';
import type {OAuthCreds} from '../email/providers';
import {fetchOut} from '../kit/outbound';

/**
 * Calendar OAuth. Same Google Cloud / Azure apps as the mailboxes
 * (`oauthClient()`), but its own scopes, state and callback
 * (/site-api/crm/calendar/oauth/:kind/callback), so connecting a calendar never
 * touches a mailbox and vice versa.
 */
const GOOGLE_SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events'];
const MS_SCOPES = ['offline_access', 'openid', 'email', 'profile', 'User.Read', 'Calendars.ReadWrite'];

export type CalendarProvider = OAuthKind;

type Client = {clientId: string; clientSecret: string; tenant: string};

export const calendarClient = (db: Db, kind: CalendarProvider) => oauthClient(db, kind);

export function calendarAuthorizeUrl(kind: CalendarProvider, client: Pick<Client, 'clientId' | 'tenant'>, redirectUri: string, state: string) {
  if (kind === 'google') {
    const p = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
  }
  const p = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    response_mode: 'query',
    scope: MS_SCOPES.join(' '),
    prompt: 'select_account',
    state,
  });
  return `https://login.microsoftonline.com/${client.tenant}/oauth2/v2.0/authorize?${p}`;
}

type TokenResponse = {access_token: string; refresh_token?: string; expires_in: number; scope?: string; error?: string; error_description?: string};

async function tokenRequest(kind: CalendarProvider, client: Client, params: Record<string, string>) {
  const url = kind === 'google' ? 'https://oauth2.googleapis.com/token' : `https://login.microsoftonline.com/${client.tenant}/oauth2/v2.0/token`;
  const res = await fetchOut(url, {
    method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({client_id: client.clientId, client_secret: client.clientSecret, ...params}),
  });
  const body = (await res.json()) as TokenResponse;
  if (!res.ok || body.error) throw new Error(body.error_description ?? body.error ?? `Token request failed (${res.status})`);
  return body;
}

export async function exchangeCalendarCode(kind: CalendarProvider, client: Client, code: string, redirectUri: string) {
  const t = await tokenRequest(kind, client, {code, redirect_uri: redirectUri, grant_type: 'authorization_code'});
  if (!t.refresh_token) throw new Error('No refresh token returned. Remove the app from your account permissions and connect again.');
  const creds: OAuthCreds = {accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000, scope: t.scope};
  const profileUrl = kind === 'google' ? 'https://openidconnect.googleapis.com/v1/userinfo' : 'https://graph.microsoft.com/v1.0/me';
  const profile = (await (await fetchOut(profileUrl, {headers: {authorization: `Bearer ${creds.accessToken}`}})).json()) as Record<string, string>;
  const email = (kind === 'google' ? profile.email : profile.mail || profile.userPrincipalName)?.toLowerCase();
  if (!email) throw new Error('Could not read the calendar account address');
  return {creds, email};
}

/** Decrypts the tokens and refreshes them when they expire within 2 minutes (like `accountCredentials`). */
export async function connectionCredentials(db: Db, conn: CalendarConnection): Promise<OAuthCreds> {
  const creds = await decryptJson<OAuthCreds>(conn.credentials);
  if (creds.expiresAt - Date.now() > 120_000) return creds;
  const kind = conn.provider as CalendarProvider;
  const client = await calendarClient(db, kind);
  if (!client) throw new Error(`${kind === 'google' ? 'Google' : 'Microsoft'} OAuth app is not configured`);
  try {
    const t = await tokenRequest(kind, client, {refresh_token: creds.refreshToken, grant_type: 'refresh_token'});
    const next: OAuthCreds = {
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? creds.refreshToken,
      expiresAt: Date.now() + t.expires_in * 1000,
      scope: t.scope ?? creds.scope,
    };
    await db.calendarConnection.update({where: {id: conn.id}, data: {credentials: await encryptJson(next), status: 'CONNECTED', lastError: null}});
    return next;
  } catch (e) {
    await db.calendarConnection.update({where: {id: conn.id}, data: {status: 'ERROR', lastError: `Reconnect needed: ${(e as Error).message}`.slice(0, 500)}});
    throw e;
  }
}
