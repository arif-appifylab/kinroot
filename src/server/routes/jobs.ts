import {Hono} from 'hono';
import {validator} from 'hono/validator';

import {JOB_TYPES, type Job, type JobsPage} from '../../lib/types';
import {problem, requireAuth, requirePermission, withDb, withViewer} from '../../platform/guards';
import {PERMISSIONS} from '../permissions';

/**
 * The job board, stored in the Site Database (table `jobs`).
 *
 * Public (the `/jobs` pages render these on the server):
 *   GET /site-api/jobs?search=&type=&remote=&before=   open jobs, newest first
 *   GET /site-api/jobs/:slug                           one open job
 *   GET /site-api/jobs/sitemap                         slugs of the newest open jobs (/sitemap.xml)
 *
 * Holders of `site:job:manage`, from the dashboard (`/dashboard/jobs`):
 *   GET    /site-api/jobs/manage?before=   every job, any status
 *   GET    /site-api/jobs/manage/:id       one job, any status (for editing)
 *   POST   /site-api/jobs                  create
 *   PATCH  /site-api/jobs/:id              edit (incl. `status: 'closed'`)
 *   DELETE /site-api/jobs/:id              delete
 *
 * Lists are keyset-paged (`?before=<id>`, 20 a page, no count). Search is a
 * case-insensitive match on the title: fine for a small job board (a few
 * hundred rows). For thousands, add a trigram or full-text index first.
 */

/** Who may post and edit jobs (the seeded `owner` and `admin` roles hold it). */
export const MANAGE_JOBS = PERMISSIONS.JOB_MANAGE;

const PAGE_SIZE = 20;
/** The sitemap lists at most this many open jobs (newest first); the list pages link the rest. */
const SITEMAP_LIMIT = 1000;
const RESERVED_SLUGS = new Set(['manage', 'sitemap']);

const summarySelect = {
  id: true,
  slug: true,
  title: true,
  company: true,
  location: true,
  type: true,
  remote: true,
  status: true,
  createdAt: true,
} as const;
const jobSelect = {...summarySelect, description: true, applyUrl: true} as const;

const cursorOf = (value: unknown) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
};

const listQuery = validator('query', value => ({
  search: typeof value.search === 'string' ? value.search.trim().slice(0, 80) : '',
  type: typeof value.type === 'string' && (JOB_TYPES as string[]).includes(value.type) ? value.type : '',
  remote: value.remote === '1' || value.remote === 'true',
  before: typeof value.before === 'string' ? value.before : undefined,
}));

const manageQuery = validator('query', value => ({
  before: typeof value.before === 'string' ? value.before : undefined,
}));

/** `Senior Dev (Remote)!` → `senior-dev-remote` */
function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_-]+/g, '-')
      .slice(0, 100) || 'job'
  );
}

/** An https URL or a mailto: link; anything else (javascript:, http:) is refused. */
function safeApplyUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'mailto:' ? url.toString() : null;
  } catch {
    return null;
  }
}

type JobInput = {
  title?: string;
  company?: string;
  location?: string;
  type?: string;
  remote?: boolean;
  description?: string;
  applyUrl?: string;
  status?: string;
};

/** Validates a create (`partial = false`) or an edit (`partial = true`). */
function jobBody(partial: boolean) {
  return validator('json', (value, c) => {
    const v = (value ?? {}) as Record<string, unknown>;
    const out: JobInput = {};
    const text = (key: string, max: number, min = 1) => {
      if (v[key] === undefined && partial) return true;
      const s = typeof v[key] === 'string' ? (v[key] as string).trim() : '';
      if (s.length < min || s.length > max) return false;
      (out as Record<string, unknown>)[key] = s;
      return true;
    };
    if (!text('title', 120)) return c.json(problem('invalid_job', 'A title needs 1 to 120 characters.'), 422);
    if (!text('company', 80)) return c.json(problem('invalid_job', 'A company needs 1 to 80 characters.'), 422);
    if (!text('location', 80)) return c.json(problem('invalid_job', 'A location needs 1 to 80 characters.'), 422);
    if (!text('description', 10000, 20)) {
      return c.json(problem('invalid_job', 'A description needs 20 to 10000 characters.'), 422);
    }
    if (v.type !== undefined || !partial) {
      const type = String(v.type ?? 'full-time');
      if (!(JOB_TYPES as string[]).includes(type)) return c.json(problem('invalid_job', 'Unknown job type.'), 422);
      out.type = type;
    }
    if (v.remote !== undefined || !partial) out.remote = v.remote === true;
    if (v.applyUrl !== undefined || !partial) {
      const url = safeApplyUrl(String(v.applyUrl ?? '').trim());
      if (!url) return c.json(problem('invalid_job', 'Apply link must be an https:// or mailto: link.'), 422);
      out.applyUrl = url;
    }
    if (v.status !== undefined) {
      if (v.status !== 'open' && v.status !== 'closed') return c.json(problem('invalid_job', 'Status is open or closed.'), 422);
      out.status = v.status;
    }
    return out;
  });
}

export const jobRoutes = new Hono()
  // ---- public ---------------------------------------------------------------
  .get('/', listQuery, withDb, async c => {
    const {search, type, remote, before} = c.req.valid('query');
    const cursor = cursorOf(before);
    const rows = await c.var.db.job.findMany({
      select: summarySelect,
      where: {
        status: 'open',
        ...(cursor ? {id: {lt: cursor}} : {}),
        ...(search ? {title: {contains: search, mode: 'insensitive' as const}} : {}),
        ...(type ? {type} : {}),
        ...(remote ? {remote: true} : {}),
      },
      orderBy: {id: 'desc'},
      take: PAGE_SIZE + 1,
    });
    const jobs = rows.slice(0, PAGE_SIZE);
    const page: JobsPage = {
      jobs: jobs.map(job => ({...job, createdAt: job.createdAt.toISOString()})),
      nextBefore: rows.length > PAGE_SIZE ? jobs.at(-1)!.id : null,
    };
    return c.json(page);
  })

  // Registered before `/:slug` so `sitemap` is not a slug. Index: jobs(status, id).
  .get('/sitemap', withDb, async c => {
    const rows = await c.var.db.job.findMany({
      select: {slug: true, updatedAt: true},
      where: {status: 'open'},
      orderBy: {id: 'desc'},
      take: SITEMAP_LIMIT,
    });
    c.header('Cache-Control', 'public, max-age=3600');
    return c.json({jobs: rows.map(row => ({slug: row.slug, updatedAt: row.updatedAt.toISOString()}))});
  })

  // ---- site admins (registered before `/:slug` so `manage` is not a slug) ----
  .get('/manage', manageQuery, withViewer, requireAuth, requirePermission(MANAGE_JOBS), withDb, async c => {
    const cursor = cursorOf(c.req.valid('query').before);
    const rows = await c.var.db.job.findMany({
      select: summarySelect,
      where: cursor ? {id: {lt: cursor}} : undefined,
      orderBy: {id: 'desc'},
      take: PAGE_SIZE + 1,
    });
    const jobs = rows.slice(0, PAGE_SIZE);
    const page: JobsPage = {
      jobs: jobs.map(job => ({...job, createdAt: job.createdAt.toISOString()})),
      nextBefore: rows.length > PAGE_SIZE ? jobs.at(-1)!.id : null,
    };
    return c.json(page);
  })

  .get('/manage/:id', withViewer, requireAuth, requirePermission(MANAGE_JOBS), withDb, async c => {
    const id = cursorOf(c.req.param('id'));
    const row = id ? await c.var.db.job.findUnique({where: {id}, select: jobSelect}) : null;
    if (!row) return c.json(problem('not_found', 'No such job.'), 404);
    return c.json({job: {...row, createdAt: row.createdAt.toISOString()} satisfies Job});
  })

  .get('/:slug', withDb, async c => {
    const row = await c.var.db.job.findFirst({
      select: jobSelect,
      where: {slug: c.req.param('slug'), status: 'open'},
    });
    if (!row) return c.json(problem('not_found', 'No such job.'), 404);
    const job: Job = {...row, createdAt: row.createdAt.toISOString()};
    return c.json({job});
  })

  .post('/', jobBody(false), withViewer, requireAuth, requirePermission(MANAGE_JOBS), withDb, async c => {
    const input = c.req.valid('json') as Required<Omit<JobInput, 'status'>> & {status?: string};
    // `manage` and `sitemap` are routes of their own (above): never a job's slug.
    const slugged = slugify(input.title);
    const base = RESERVED_SLUGS.has(slugged) ? `${slugged}-job` : slugged;
    // A unique slug: `title`, then `title-2`, `title-3`…
    const taken = await c.var.db.job.findMany({
      select: {slug: true},
      where: {OR: [{slug: base}, {slug: {startsWith: `${base}-`}}]},
      take: 50,
    });
    const used = new Set(taken.map(row => row.slug));
    let slug = base;
    for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
    const data = {...input, status: input.status ?? 'open', createdBy: c.var.viewer.id!};
    let row;
    try {
      row = await c.var.db.job.create({data: {...data, slug}, select: jobSelect});
    } catch (error) {
      // P2002 = unique violation: the slug was taken meanwhile (or hid among 50+ look-alikes).
      if ((error as {code?: unknown} | null)?.code !== 'P2002') throw error;
      slug = `${base}-${crypto.randomUUID().slice(0, 8)}`;
      row = await c.var.db.job.create({data: {...data, slug}, select: jobSelect});
    }
    return c.json({job: {...row, createdAt: row.createdAt.toISOString()}}, 201);
  })

  .patch('/:id', jobBody(true), withViewer, requireAuth, requirePermission(MANAGE_JOBS), withDb, async c => {
    const id = cursorOf(c.req.param('id'));
    const found = id ? await c.var.db.job.findUnique({where: {id}, select: {id: true}}) : null;
    if (!found) return c.json(problem('not_found', 'No such job.'), 404);
    const row = await c.var.db.job.update({where: {id: found.id}, data: c.req.valid('json'), select: jobSelect});
    return c.json({job: {...row, createdAt: row.createdAt.toISOString()}});
  })

  .delete('/:id', withViewer, requireAuth, requirePermission(MANAGE_JOBS), withDb, async c => {
    const id = cursorOf(c.req.param('id'));
    const deleted = id ? await c.var.db.job.deleteMany({where: {id}}) : {count: 0};
    return deleted.count ? c.json({ok: true}) : c.json(problem('not_found', 'No such job.'), 404);
  });
