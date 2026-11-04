import {queryOptions} from '@tanstack/react-query';

import {siteFetch} from '../../platform/browser';
import type {Viewer} from '../../platform/types';

/**
 * The person's own account, for Settings → Your account. Every call is the
 * site's auth core (`/site-api/auth/*`, src/platform/auth): through `siteFetch` (CSRF header,
 * one shared session refresh), never Kinroot's `api` (that one targets `/site-api/crm`).
 */

/** An error carrying the server's message and its field errors (`422 {fields}`). */
export class AccountError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly fields: Record<string, string> = {},
  ) {
    super(message);
  }
}

/** True when the error belongs to fields of the form (shown there, not in its status line). */
export const onFields = (error: unknown) => error instanceof AccountError && Object.keys(error.fields).length > 0;

async function call<T>(path: string, init: {method?: string; body?: unknown} = {}): Promise<T> {
  let res: Response;
  try {
    res = await siteFetch(`/site-api/auth${path}`, {
      method: init.method ?? 'GET',
      headers: init.body === undefined ? {accept: 'application/json'} : {accept: 'application/json', 'content-type': 'application/json'},
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new AccountError('Could not reach the server. Check your connection and try again.', 0);
  }
  const body = (await res.json().catch(() => null)) as (T & {message?: string; fields?: Record<string, string>}) | null;
  if (!res.ok) throw new AccountError(body?.message ?? `Something went wrong (${res.status}). Try again.`, res.status, body?.fields ?? {});
  return body as T;
}

export type TwoFactorStatus = {enabled: boolean; recoveryCodesLeft: number; hasPassword: boolean};
export type TwoFactorSetup = {secret: string; uri: string; qr: string};
/** A device signed in to this account (this one marked `current`). */
export type DeviceSession = {id: string; device: string; lastActiveAt: string; current: boolean};

/** Query keys of this file: their own namespace, apart from Kinroot's `keys`. */
export const accountKeys = {
  viewer: ['site-account', 'viewer'] as const,
  twoFactor: ['site-account', 'two-factor'] as const,
  sessions: ['site-account', 'sessions'] as const,
};

/** The signed-in account: its name, its own email and whether that email is confirmed. */
export const viewerQuery = queryOptions({
  queryKey: accountKeys.viewer,
  queryFn: () => call<{user: Viewer}>('/me').then((d) => d.user),
});

/** Two-step sign-in, and whether the account has a password at all (`hasPassword`). */
export const twoFactorQuery = queryOptions({
  queryKey: accountKeys.twoFactor,
  queryFn: () => call<TwoFactorStatus>('/two-factor'),
});

export const sessionsQuery = queryOptions({
  queryKey: accountKeys.sessions,
  queryFn: () => call<{sessions: DeviceSession[]}>('/sessions').then((d) => d.sessions),
});

type Message = {ok: true; message: string};

export const accountApi = {
  saveName: (name: string) => call<{user: Viewer}>('/me', {method: 'PATCH', body: {name}}),
  requestEmailChange: (body: {email: string; password: string}) => call<Message>('/email', {method: 'POST', body}),
  resendVerification: (email: string) => call<Message>('/resend-verification', {method: 'POST', body: {email}}),
  changePassword: (body: {currentPassword: string; newPassword: string}) => call<Message>('/change-password', {method: 'POST', body}),
  /** For an account without a password: the reset link lets them choose one. */
  sendPasswordLink: (email: string) => call<Message>('/forgot-password', {method: 'POST', body: {email}}),
  startTwoFactor: (password: string) => call<TwoFactorSetup>('/two-factor/setup', {method: 'POST', body: {password}}),
  enableTwoFactor: (code: string) => call<{recoveryCodes: string[]}>('/two-factor/enable', {method: 'POST', body: {code}}),
  disableTwoFactor: (password: string) => call<{ok: true}>('/two-factor/disable', {method: 'POST', body: {password}}),
  renewRecoveryCodes: (password: string) => call<{recoveryCodes: string[]}>('/two-factor/recovery-codes', {method: 'POST', body: {password}}),
  signOutDevice: (id: string) => call<{ok: true}>(`/sessions/${encodeURIComponent(id)}`, {method: 'DELETE'}),
  signOutEverywhere: () => call<{ok: true}>('/logout-all', {method: 'POST'}),
  deleteAccount: (body: {password: string; confirm: string}) => call<Message>('/delete-account', {method: 'POST', body}),
};

/** Where a signed-out person lands: the sign-in page, back to Kinroot after. */
export const SIGN_IN_AGAIN = '/account/login/?next=%2Fcrm%2F';
