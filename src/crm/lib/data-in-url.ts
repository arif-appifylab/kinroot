/**
 * The Data in URL: the same Data in actions (src/crm/lib/data-in.ts) for tools that can't sign a
 * request, like Pabbly Connect, Zapier or Make. The tool POSTs JSON to
 *
 *   https://<site>/site-api/crm/public/data-in/<action path>/<access token>
 *
 * with the header `X-Signature-Token: <signature token>`. Both tokens are made, shown and
 * regenerated in Settings → Webhooks → Incoming; both are needed. Shared by the server
 * (src/server/crm/lib/data-in.ts `handleDataInUrl`) and the settings screen.
 */
import {DATA_IN_MAX_BYTES, FIELD_TYPE_LABEL, IDEMPOTENCY_HOURS, type DataInAction, type DataInField} from './data-in';

export const DATA_IN_URL_PATH = '/site-api/crm/public/data-in';
export const DATA_IN_URL_TOKEN_PREFIX = 'crm_url_';
export const SIGNATURE_TOKEN_PREFIX = 'crm_st_';
export const SIGNATURE_TOKEN_HEADER = 'X-Signature-Token';
/** 30 random bytes as base64url: 40 characters after the prefix. */
export const ACCESS_TOKEN_PATTERN = /^crm_url_[A-Za-z0-9_-]{40}$/;
/** Shown in the request log and on records' "source" instead of an API key's name. */
export const DATA_IN_URL_NAME = 'Data in URL';

/** The Data in URL as the admin screen sees it: never a token, only masks. */
export type DataInUrlState = {enabled: boolean; ready: boolean; rotatedAt: string | null; createdBy: {id: string; name: string; active: boolean} | null; accessMasked: string | null; signatureMasked: string | null};
/** GET /site-api/crm/data-in/url */
export type DataInUrlOverview = DataInUrlState & {origin: string; rateLimit: number};
export type DataInUrlTokens = {accessToken: string; signatureToken: string};

/** The action's full URL; `{list}`-style path parameters stay for the person to fill in. */
export const dataInUrlFor = (origin: string, action: DataInAction, token: string) => `${origin.replace(/\/$/, '')}${DATA_IN_URL_PATH}${action.path}/${token}`;

/** One row of an action's "Parameters" table. */
export type DataInUrlParam = {name: string; type: string; required: boolean; inPath: boolean; max: string | null; example: string; description: string};

function example(f: DataInField, sample: unknown): string {
  if (sample !== undefined) return typeof sample === 'string' ? sample : JSON.stringify(sample);
  switch (f.type) {
    case 'email':
      return 'maya.patel@northwind.example';
    case 'email[]':
      return '["maya.patel@northwind.example"]';
    case 'boolean':
      return 'true';
    case 'number':
    case 'integer':
      return String(f.min ?? 10);
    case 'datetime':
      return '2026-12-31T14:00:00Z';
    case 'enum':
      return f.values?.[0] ?? '';
    case 'string[]':
      return '["vip"]';
    case 'object':
      return '{"plan": "Pro"}';
    case 'id':
      return 'cm…';
    default:
      return '';
  }
}

const maxOf = (f: DataInField) => {
  if (f.max === undefined) return null;
  return f.type === 'string[]' || f.type === 'email[]' ? `${f.max} items` : f.type === 'number' || f.type === 'integer' ? String(f.max) : `${f.max} characters`;
};

export function dataInUrlParams(action: DataInAction): DataInUrlParam[] {
  const sample = action.sample as Record<string, unknown>;
  const row = (f: DataInField, inPath: boolean): DataInUrlParam => ({
    name: f.name,
    type: FIELD_TYPE_LABEL[f.type],
    required: !!f.required,
    inPath,
    max: maxOf(f),
    example: example(f, inPath ? undefined : sample[f.name]),
    description: [f.description, f.values ? `One of: ${f.values.join(', ')}.` : '', f.nullable ? 'null clears it.' : ''].filter(Boolean).join(' '),
  });
  return [...(action.params ?? []).map((f) => row(f, true)), ...action.fields.map((f) => row(f, false))];
}

/** What every Data in URL request may send besides the body. */
export const DATA_IN_URL_HEADERS = [
  {name: SIGNATURE_TOKEN_HEADER, required: true, value: 'your signature token', description: 'The signature token from this screen. Requests without it, or with an old one, are refused.'},
  {name: 'Content-Type', required: true, value: 'application/json', description: 'Send the body as JSON (in Zapier: Payload Type "json"; in Pabbly: Payload Type "JSON").'},
  {name: 'Idempotency-Key', required: false, value: 'a unique id per record, e.g. the order id', description: `Optional: a retry with the same value within ${IDEMPOTENCY_HOURS} hours is not applied twice.`},
] as const;

export const DATA_IN_URL_LIMITS = `${DATA_IN_MAX_BYTES / 1024} KB per request`;
