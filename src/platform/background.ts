import {PLATFORM_HEADERS, platformOrigin} from './api';
import {config} from './config';
import {getDb} from './db';
import manifest from '../../background.json';

/**
 * BACKGROUND JOBS: do something later, or on a schedule, with retries. MANAGED: never edit.
 * Guide: docs/agent/background-jobs.md.
 *
 *   Your handlers      src/server/background.ts   defineBackground({'<list>': async (data, job) => {...}})
 *   Your schedules     background.json            {"lists": {...}, "schedules": {...}}
 *   Send a job         sendJob(request.url, '<list>', data, {delay | at, key, label})
 *   Cancel one         cancelJob(request.url, {list, key})
 *
 * WHERE A JOB RUNS
 *   Live site          the platform keeps the job, calls this site back at POST /site-api/_platform/jobs
 *                      (signed with SITE_JOBS_SECRET), retries 1 min, 2 min, 10 min, 1 h, and
 *                      shows every run in the owner's Jobs tab.
 *   Editor Preview,    LOCAL: the handler runs right away, in this process, once, and the log says
 *   your own machine   what the live site would do (when, how many tries). Nothing is sent to
 *                      The platform, no key or secret is needed.
 *
 * A handler gets the job's data and returns when done. Throw to try again later; throw
 * `DontRetry` when trying again cannot help (bad data, a rule): it fails at once, with your message.
 * A handler may run more than once (at-least-once): make it safe to repeat (use `job.id`).
 * Each run has 60 seconds: split big work into more jobs. A job sent with no delay starts within
 * about a second or two. Calls to other services: `docs/agent/security.md`.
 */

export interface JobInfo {
  /** `job_…` (live) or `local_…`: the same id on every try of one job. */
  id: string;
  list: string;
  attempt: number;
  maxAttempts: number;
  /** When it was meant to run (ISO). */
  scheduledFor: string;
  /** Ordered lists: the group this job ran in (`null` when none). */
  group: string | null;
  /** True in the Preview / on your machine. */
  local: boolean;
}

export type JobHandler = (data: any, job: JobInfo) => unknown | Promise<unknown>;

export interface Background {
  handlers: Readonly<Record<string, JobHandler>>;
}

export interface SendOptions {
  /** Seconds from now. */
  delay?: number;
  /** When to run (a Date or an ISO string). In the past = now. */
  at?: Date | string;
  /** Dedupe key: a second send with the same key (within 24 h) returns the first job. Also what `cancelJob` finds it by. */
  key?: string;
  /** What the owner reads in the Jobs tab ("Reminder for Ana · Fri 10:00"). Never secrets or tokens. */
  label?: string;
  /**
   * Ordered lists only (`"ordered": true` in background.json): jobs with the same group run one at a
   * time, in the order they were sent (e.g. `customer-${id}`). Different groups run side by side.
   */
  group?: string;
}

export interface SentJob {
  id: string;
  list: string;
  runAt: string;
  deduplicated: boolean;
  local: boolean;
}

/** Throw this from a handler when trying again cannot help: the job fails now, with your message. */
export class DontRetry extends Error {}

/** The platform refused a send (`code` is stable: E_JOBS_BAD_LIST, E_JOBS_PAYLOAD_TOO_LARGE, …). */
export class JobRejected extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number
  ) {
    super(message);
  }
}

export const DELIVERY_PATH = '/site-api/_platform/jobs';
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_DATA_BYTES = 32 * 1024;
const MAX_BODY_BYTES = 64 * 1024;
export const SIGNATURE_TOLERANCE_SECONDS = 300;
const TIMEOUT_MS = 8000;
const DEFAULT_TRIES = 5;

/** A list's handler, only when the site defined one (never something on Object's prototype). */
const handlerOf = (handlers: Readonly<Record<string, JobHandler>> | undefined, list: string): JobHandler | undefined =>
  handlers && Object.hasOwn(handlers, list) ? handlers[list] : undefined;

/** Tries a list gets (background.json `retries` + 1), as the live site would. */
function triesOf(list: string): number {
  const lists = (manifest as {lists?: Record<string, {retries?: unknown}>}).lists ?? {};
  const retries = Object.hasOwn(lists, list) ? lists[list]?.retries : undefined;
  return Number.isInteger(retries) ? Number(retries) + 1 : DEFAULT_TRIES;
}

/** The request body as text, refusing (null) past `max` bytes even without a content-length. Also used by `./payments`. */
export async function readCapped(request: Request, max: number): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

let registered: Background | null = null;

/** Your handlers, keyed by list name (`src/server/background.ts`). Call it once. */
export function defineBackground(handlers: Record<string, JobHandler>): Background {
  for (const name of Object.keys(handlers)) {
    if (!NAME.test(name)) throw new Error(`Background list "${name}": use lower-case letters, digits and dashes.`);
  }
  registered = {handlers: Object.freeze({...handlers})};
  return registered;
}

/** True when this process runs jobs itself (the Preview, your machine): no Site Key or not production. */
export function runsJobsLocally(): boolean {
  return !config.production || !config.siteKey;
}

function check(list: string, data: unknown, options: SendOptions): {body: Record<string, unknown>; bytes: number} {
  if (!NAME.test(list)) throw new JobRejected(`"${list}" is not a list name (lower-case letters, digits, dashes).`, 'E_JOBS_BAD_LIST', 422);
  const json = JSON.stringify(data === undefined ? null : data);
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > MAX_DATA_BYTES) {
    throw new JobRejected(`Job data is ${Math.ceil(bytes / 1024)} KB; the limit is 32 KB. Send an id, not the record.`, 'E_JOBS_PAYLOAD_TOO_LARGE', 413);
  }
  const body: Record<string, unknown> = {list, data: data === undefined ? null : data};
  if (options.delay !== undefined) body.delay = options.delay;
  if (options.at !== undefined) body.at = options.at instanceof Date ? options.at.toISOString() : options.at;
  if (options.key !== undefined) body.key = options.key;
  if (options.label !== undefined) body.label = options.label;
  if (options.group !== undefined) body.group = options.group;
  return {body, bytes};
}

function runAtOf(options: SendOptions): Date {
  const now = Date.now();
  if (options.at !== undefined) return new Date(Math.max(new Date(options.at).getTime() || now, now));
  return new Date(now + Math.max(0, (options.delay ?? 0) * 1000));
}

let localSeq = 0;

/** LOCAL: run the handler now, once, and say what the live site would do. */
async function runLocally(list: string, data: unknown, options: SendOptions): Promise<SentJob> {
  const id = `local_${Date.now().toString(36)}${(localSeq++).toString(36)}`;
  const runAt = runAtOf(options);
  const when = runAt.getTime() - Date.now() > 1000 ? ` (live: at ${runAt.toISOString()})` : '';
  const handler = handlerOf(registered?.handlers, list);
  if (!handler) {
    console.warn(`[jobs] ${list}: no handler. Add '${list}' to defineBackground in src/server/background.ts.`);
    return {id, list, runAt: runAt.toISOString(), deduplicated: false, local: true};
  }
  const job: JobInfo = {
    id,
    list,
    attempt: 1,
    maxAttempts: triesOf(list),
    scheduledFor: runAt.toISOString(),
    group: options.group ?? null,
    local: true,
  };
  const started = Date.now();
  try {
    await handler(JSON.parse(JSON.stringify(data ?? null)), job);
    console.info(`[jobs] ${list} ${id} done in ${Date.now() - started} ms, run locally now${when}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retry = error instanceof DontRetry ? 'it fails at once (DontRetry)' : `it would try ${triesOf(list) - 1} more times`;
    console.error(`[jobs] ${list} ${id} failed: ${message}. On the live site ${retry}.`);
  }
  return {id, list, runAt: runAt.toISOString(), deduplicated: false, local: true};
}

async function platformCall(requestUrl: string | URL, path: string, body: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${platformOrigin(requestUrl)}/api/site/v1/jobs${path}`, {
      method: 'POST',
      headers: {...PLATFORM_HEADERS, 'content-type': 'application/json', authorization: `Bearer ${config.siteKey}`},
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new JobRejected('The platform did not answer. Nothing was sent; try again.', 'E_JOBS_UNREACHABLE', 0);
  }
  const answer = (await res.json().catch(() => null)) as any;
  if (!res.ok) {
    const error = answer?.errors?.[0];
    throw new JobRejected(error?.message ?? `The platform answered ${res.status}.`, error?.code ?? 'E_JOBS_REJECTED', res.status);
  }
  return answer?.data;
}

/**
 * Send one job to a list. Server code only. `requestUrl` is the current request's URL (it
 * finds the platform's address). Throws `JobRejected` when the job was not accepted.
 */
export async function sendJob(requestUrl: string | URL, list: string, data?: unknown, options: SendOptions = {}): Promise<SentJob> {
  const {body} = check(list, data, options);
  if (runsJobsLocally()) return runLocally(list, data, options);
  const sent = await platformCall(requestUrl, '', body);
  return {...sent, local: false};
}

/** Send up to 100 jobs at once (all or none are accepted). */
export async function sendJobs(
  requestUrl: string | URL,
  jobs: Array<{list: string; data?: unknown} & SendOptions>
): Promise<SentJob[]> {
  const bodies = jobs.map(job => check(job.list, job.data, job).body);
  if (runsJobsLocally()) {
    const out: SentJob[] = [];
    for (const job of jobs) out.push(await runLocally(job.list, job.data, job));
    return out;
  }
  const sent = await platformCall(requestUrl, '', {jobs: bodies});
  return (sent?.jobs ?? []).map((job: SentJob) => ({...job, local: false}));
}

/** Cancel a waiting job by its id, or by the list + key it was sent with. True when it is cancelled. */
export async function cancelJob(requestUrl: string | URL, target: {id: string} | {list: string; key: string}): Promise<boolean> {
  if (runsJobsLocally()) {
    console.info(`[jobs] cancel ${JSON.stringify(target)}: nothing waits locally (jobs ran when sent).`);
    return true;
  }
  const answer = await platformCall(requestUrl, '/cancel', target);
  return Boolean(answer?.cancelled);
}

/* ------------------------------- delivery ------------------------------- */

/** A JSON answer that no cache keeps. */
export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json', 'cache-control': 'no-store'}});

export function isJobDelivery(url: string | URL): boolean {
  return new URL(url).pathname === DELIVERY_PATH;
}

const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');

/** Constant-time compare of two hex strings. */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** A platform delivery's `x-site-signature` (`t=…,v1=…`) checks out for `body`. Also used by `./payments`. */
export async function signatureOk(secret: string, body: string, header: string | null): Promise<boolean> {
  if (!header || header.length > 1024) return false;
  let t = NaN;
  const given: string[] = [];
  for (const part of header.split(',')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === 't') t = Number(rest.join('='));
    // One `v1` per secret the platform signs with (two while a replaced secret waits for a publish).
    else if (k === 'v1' && given.length < 4) given.push(rest.join('='));
  }
  if (!Number.isInteger(t) || !given.length || Math.abs(Date.now() / 1000 - t) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const mac = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`)));
  return given.some(value => sameHex(mac, value));
}

/**
 * Deliveries already taken (job id + try): a copy of a signed delivery replayed within its
 * 5-minute signature window runs nothing (the platform never sends one try twice).
 *
 * With a Site Database the nonce is a row in the managed `job_deliveries` table (one insert, the
 * primary key decides), so it holds across every Worker instance. Rows older than a day are swept
 * on the way (the window is 5 minutes). Without a Site Database (or before the migration ran) it is
 * this instance's memory only. Either way a handler must stay idempotent: a job MAY run twice.
 *
 * Raw SQL on purpose, never `db.jobDelivery`: this file is replaced on upgrade but
 * `prisma/schema.prisma` is the site's own, so a site's generated client may have no
 * `JobDelivery` model even when the migration created the table.
 */
const DELIVERY_ROWS_KEPT_MS = 24 * 60 * 60 * 1000;

/** The `job_deliveries` table is not there (a database from before this template version). */
export function tableMissing(error: unknown): boolean {
  const e = error as {code?: string; message?: string; meta?: {driverAdapterError?: {cause?: {kind?: string; originalCode?: string}}}};
  const cause = e?.meta?.driverAdapterError?.cause;
  return (
    e?.code === 'P2021' ||
    cause?.kind === 'TableDoesNotExist' ||
    cause?.originalCode === '42P01' ||
    (e?.code === 'P2010' && /\b42P01\b/.test(String(e?.message ?? '')))
  );
}

async function firstDelivery(id: string, attempt: number): Promise<boolean> {
  const db = getDb();
  if (db) {
    try {
      const taken = await db.$executeRaw`INSERT INTO "job_deliveries" ("job_id", "attempt") VALUES (${id}, ${attempt}) ON CONFLICT DO NOTHING`;
      if (Math.random() < 0.02) {
        await db.$executeRaw`DELETE FROM "job_deliveries" WHERE "seen_at" < ${new Date(Date.now() - DELIVERY_ROWS_KEPT_MS)}`;
      }
      return taken === 1;
    } catch (error) {
      if (!tableMissing(error)) throw error;
    }
  }
  return firstSight(id, attempt);
}

const seenDeliveries = new Map<string, number>();
function firstSight(id: string, attempt: number, now = Date.now()): boolean {
  const key = `${id}:${attempt}`;
  if (seenDeliveries.has(key)) return false;
  if (seenDeliveries.size >= 5000) {
    for (const [k, at] of seenDeliveries) if (now - at > SIGNATURE_TOLERANCE_SECONDS * 1000) seenDeliveries.delete(k);
    if (seenDeliveries.size >= 5000) seenDeliveries.clear();
  }
  seenDeliveries.set(key, now);
  return true;
}

/**
 * `POST /site-api/_platform/jobs`: The platform delivering one job. Mounted by
 * `src/pages/site-api/[...path].ts` BEFORE the Site API (it has its own authentication: the
 * signature). Answers: 200 done · 404 `no_handler` · 422 a `DontRetry` (fails now) · 500 try again.
 */
export async function handleJobDelivery(request: Request, background: Background | null = registered): Promise<Response> {
  if (request.method !== 'POST') return json(405, {error: 'POST only.'});
  const secret = config.jobsSecret;
  if (!secret) return json(503, {error: 'This site has no jobs secret yet. Publish it again.', code: 'no_secret'});
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > MAX_BODY_BYTES) return json(413, {error: 'Too large.'});
  const body = await readCapped(request, MAX_BODY_BYTES);
  if (body === null) return json(413, {error: 'Too large.'});
  if (!(await signatureOk(secret, body, request.headers.get('x-site-signature')))) {
    return json(401, {error: 'Bad signature.', code: 'bad_signature'});
  }
  let job: {id: string; list: string; attempt: number; maxAttempts: number; scheduledFor: string; group?: string | null; data: unknown};
  try {
    job = JSON.parse(body);
  } catch {
    return json(400, {error: 'Bad delivery.'});
  }
  // Signed is not the same as well-formed: `null`, an array or a job without its
  // id and list is a 400, never an exception (a 500 would be retried).
  if (
    !job ||
    typeof job !== 'object' ||
    Array.isArray(job) ||
    typeof job.list !== 'string' ||
    (typeof job.id !== 'string' && typeof job.id !== 'number') ||
    !Number.isInteger(Number(job.attempt))
  ) {
    return json(400, {error: 'Bad delivery.'});
  }
  const handler = handlerOf(background?.handlers, job.list);
  if (!handler) return json(404, {error: `No handler for "${job.list}".`, code: 'no_handler'});
  // A replayed copy: say done (the first copy answers for this try) and run nothing.
  let first: boolean;
  try {
    first = await firstDelivery(String(job.id), Number(job.attempt));
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    console.error(`[jobs] ${job.list} ${job.id} try ${job.attempt}: replay check failed: ${why}`.slice(0, 500));
    return json(500, {error: 'The Site Database did not answer. Try again.'});
  }
  if (!first) return json(200, {ok: true, duplicate: true});
  try {
    await handler(job.data, {
      id: job.id,
      list: job.list,
      attempt: job.attempt,
      maxAttempts: job.maxAttempts,
      scheduledFor: job.scheduledFor,
      group: job.group ?? null,
      local: false,
    });
    return json(200, {ok: true});
  } catch (error) {
    // Your message reaches the owner's Jobs tab: never put secrets or personal data in it.
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    console.error(`[jobs] ${job.list} ${job.id} try ${job.attempt}: ${message}`);
    return json(error instanceof DontRetry ? 422 : 500, {error: message});
  }
}
