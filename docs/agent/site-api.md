---
title: Site API: the site's own backend (Hono)
read-when: before writing server routes or any backend code
---
One Hono app at `/site-api/*` (`src/server/app.ts`), mounted by ONE catch-all route
(`src/pages/site-api/[...path].ts`, `prerender = false`). It is the ONLY backend: pages call it
in-process (`backend(Astro.request)`), the portal and page scripts call it from the browser.

## Shape
- `new Hono().basePath('/site-api')`, routes CHAINED (the typed `hc` client needs it).
- App-wide middleware (keep): `sameOrigin`, `csrf`, `bodyLimit(64 KB)`, JSON `notFound`/`onError`.
- Errors: `c.json({error: 'snake_code', message: 'Words for people.'}, status)`; field problems
  `422 {error: 'invalid_input', message, fields: {name: '…'}}` (forms show them in place).
- Lists: `{items, nextBefore}` keyset pages, never totals.
- Shapes in `src/lib/types.ts`, built field by field (never return a Prisma row as is).

## Recipe: a feature route
```ts
// src/server/routes/notes.ts
import {Hono} from 'hono';
import {validator} from 'hono/validator';
import {problem, requireAuth, requirePermission, withDb, withViewer} from '../../platform/guards';
import {PERMISSIONS} from '../permissions';

const PAGE = 20;
const select = {id: true, body: true, createdAt: true} as const;

const noteBody = validator('json', (value, c) => {
  const body = typeof (value as {body?: unknown})?.body === 'string' ? (value as {body: string}).body.trim() : '';
  if (!body || body.length > 2000) {
    return c.json({...problem('invalid_input', 'A note needs 1 to 2000 characters.'), fields: {body: 'A note needs 1 to 2000 characters.'}}, 422);
  }
  return {body};
});

export const noteRoutes = new Hono()
  .get('/', validator('query', v => ({before: typeof v.before === 'string' ? v.before : ''})),
    withViewer, requireAuth, withDb, async c => {
      const before = Number(c.req.valid('query').before) || undefined;
      const rows = await c.var.db.note.findMany({
        select, where: {ownerId: c.var.viewer.id!, ...(before ? {id: {lt: before}} : {})},
        orderBy: {id: 'desc'}, take: PAGE + 1,
      });
      const notes = rows.slice(0, PAGE).map(n => ({...n, createdAt: n.createdAt.toISOString()}));
      return c.json({notes, nextBefore: rows.length > PAGE ? notes.at(-1)!.id : null});
    })
  .post('/', noteBody, withViewer, requireAuth, requirePermission(PERMISSIONS.NOTE_CREATE), withDb, async c => {
    const row = await c.var.db.note.create({data: {...c.req.valid('json'), ownerId: c.var.viewer.id!}, select});
    return c.json({note: {...row, createdAt: row.createdAt.toISOString()}}, 201);
  })
  .delete('/:id', withViewer, requireAuth, withDb, async c => {
    const id = Number(c.req.param('id'));
    const {count} = await c.var.db.note.deleteMany({where: {id, ownerId: c.var.viewer.id!}});
    return count ? c.json({ok: true}) : c.json(problem('not_found', 'No such note.'), 404);
  });
```
It needs a `notes` table (`database.md`: model, migration, `npx prisma generate`) and the
`site:note:create` codename (`roles-and-permissions.md`: ONE entry in `CATALOGUE`, no
migration; the app syncs the table itself, `src/platform/permission-sync.ts`). Then in `app.ts`: `.route('/notes', noteRoutes)` (chained, before `.notFound`). A query param in
a validator becomes REQUIRED in the typed client: pass `''` for "none", as the portal does.

## Calling it
- Page (SSR): `const {api} = await pageContext(Astro.request, Astro.response);`
  `const data = await read<T>(api.notes.$get({query: {before: ''}}));` (`null` on error: render a fallback).
- Portal: `read<T>(api.notes.$get({query: {before: ''}}))` through TanStack Query.
- Page script: `siteFetch('/site-api/notes', {method: 'POST', …})`.
- Never `fetch()` this site's own hostname from server code.

## Server-to-platform
| Call | Credential | Helper |
| --- | --- | --- |
| `{{PUBLIC_SITE_API_PREFIX}}/initial-data` (brand) | none | `publicGet()` |
| `{{EMAIL_ENDPOINT}}` (account emails) | `Bearer {{SITE_KEY_ENV}}` | `sendSiteEmail()` |
| `{{SITE_API_PREFIX}}/jobs` (background jobs) | `Bearer {{SITE_KEY_ENV}}` | `sendJob()`, `cancelJob()` (`background-jobs.md`) |
| `{{SITE_API_PREFIX}}/files` (file storage) | `Bearer {{SITE_KEY_ENV}}` | `createUpload()`, `completeUpload()`, `fileUrl()`… (`files.md`) |
| `{{SITE_API_PREFIX}}/payments` (prices, checkout, memberships) | `Bearer {{SITE_KEY_ENV}}` | `listPrices()`, `createCheckout()`, `getCheckout()`… (`payments.md`) |
Only through `src/platform/api.ts` (fixed origin, timeout, `User-Agent`). Other services (any
public API) are called with `fetch` and a key from `config.ownerSecret` (`security.md` › Calling
other services); the platform's internal network is never reachable. A webhook INTO the site
from another service is its own route, mounted before `csrf`, that verifies the sender's
signature with the owner's signing secret before it reads the body. Payment events come
from the platform instead, signed, at `/site-api/_platform/payments` (`payments.md`); like job
deliveries they are answered before the Site API. `/site-api/checkout` is mounted before `csrf`
with `formCsrf` so the Buy button works without JavaScript: keep it there, add nothing beside it. Work that must
happen later goes through background jobs (`background-jobs.md`).

## Paths
Never put a page or route under `{{API_PREFIX}}` (the platform's) or `/site-api` (this app's). Account pages
live under `/account/*`; don't add `/login`, `/register`, `/forgot`, `/reset` at the root.
