import type {EmailAccount} from '../../../generated/prisma/client';
import {decryptJson, encryptJson} from '../kit/crypto';
import type {Db} from '../kit/db';
import {config as site} from '../../../platform/config';
import {getSettings} from '../lib/settings';
import type {Credentials, OAuthCreds} from './providers';

export type OAuthKind = 'google' | 'microsoft';

const GOOGLE_SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'];
const MS_SCOPES = ['offline_access', 'openid', 'email', 'profile', 'User.Read', 'Mail.Send', 'Mail.Read'];

/**
 * OAuth app credentials. Each install registers its own Google Cloud / Azure app. The client ID
 * (a public identifier) can be saved in Settings → Email; the client SECRET only ever comes from
 * a secret the owner adds in the dashboard (`GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_SECRET`), read
 * through the site's config (docs/agent/security.md › Calling other services). An ID added as
 * `GOOGLE_CLIENT_ID` / `MICROSOFT_CLIENT_ID` wins over the saved one.
 */
export async function oauthClient(db: Db, kind: OAuthKind) {
  const s = await getSettings(db);
  if (kind === 'google') {
    const clientId = site.ownerSecret('GOOGLE_CLIENT_ID') || s.googleClientId;
    const clientSecret = site.ownerSecret('GOOGLE_CLIENT_SECRET');
    return clientId && clientSecret ? {clientId, clientSecret, tenant: ''} : null;
  }
  const clientId = site.ownerSecret('MICROSOFT_CLIENT_ID') || s.microsoftClientId;
  const clientSecret = site.ownerSecret('MICROSOFT_CLIENT_SECRET');
  return clientId && clientSecret ? {clientId, clientSecret, tenant: s.microsoftTenant || 'common'} : null;
}

export function authorizeUrl(kind: OAuthKind, client: {clientId: string; tenant: string}, redirectUri: string, state: string) {
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

const tokenUrl = (kind: OAuthKind, tenant: string) =>
  kind === 'google' ? 'https://oauth2.googleapis.com/token' : `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;

type TokenResponse = {access_token: string; refresh_token?: string; expires_in: number; scope?: string; error?: string; error_description?: string};

async function tokenRequest(kind: OAuthKind, client: {clientId: string; clientSecret: string; tenant: string}, params: Record<string, string>) {
  const res = await fetch(tokenUrl(kind, client.tenant), {
    method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({client_id: client.clientId, client_secret: client.clientSecret, ...params}),
  });
  const body = (await res.json()) as TokenResponse;
  if (!res.ok || body.error) throw new Error(body.error_description ?? body.error ?? `Token request failed (${res.status})`);
  return body;
}

export async function exchangeCode(kind: OAuthKind, client: {clientId: string; clientSecret: string; tenant: string}, code: string, redirectUri: string) {
  const t = await tokenRequest(kind, client, {code, redirect_uri: redirectUri, grant_type: 'authorization_code'});
  if (!t.refresh_token) throw new Error('No refresh token returned. Remove the app from your account permissions and connect again.');
  const creds: OAuthCreds = {accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000, scope: t.scope};

  const profileUrl = kind === 'google' ? 'https://openidconnect.googleapis.com/v1/userinfo' : 'https://graph.microsoft.com/v1.0/me';
  const profile = (await (await fetch(profileUrl, {headers: {authorization: `Bearer ${creds.accessToken}`}})).json()) as Record<string, string>;
  const email = (kind === 'google' ? profile.email : profile.mail || profile.userPrincipalName)?.toLowerCase();
  const name = kind === 'google' ? profile.name : profile.displayName;
  if (!email) throw new Error('Could not read the mailbox address');
  return {creds, email, name: name ?? email};
}

/** Decrypts credentials and refreshes OAuth tokens that expire within 2 minutes. */
export async function accountCredentials(db: Db, account: EmailAccount): Promise<Credentials> {
  const creds = await decryptJson<Credentials>(account.credentials);
  if (account.provider !== 'GMAIL' && account.provider !== 'OUTLOOK') return creds;

  const oauth = creds as OAuthCreds;
  if (oauth.expiresAt - Date.now() > 120_000) return oauth;
  const kind: OAuthKind = account.provider === 'GMAIL' ? 'google' : 'microsoft';
  const client = await oauthClient(db, kind);
  if (!client) throw new Error(`${kind === 'google' ? 'Google' : 'Microsoft'} OAuth app is not configured`);
  try {
    const t = await tokenRequest(kind, client, {refresh_token: oauth.refreshToken, grant_type: 'refresh_token'});
    const next: OAuthCreds = {
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? oauth.refreshToken, // Microsoft rotates, Google usually doesn't
      expiresAt: Date.now() + t.expires_in * 1000,
      scope: t.scope ?? oauth.scope,
    };
    await db.emailAccount.update({where: {id: account.id}, data: {credentials: await encryptJson(next), status: 'CONNECTED', lastError: null}});
    return next;
  } catch (e) {
    await db.emailAccount.update({where: {id: account.id}, data: {status: 'ERROR', lastError: `Reconnect needed: ${(e as Error).message}`}});
    throw e;
  }
}
