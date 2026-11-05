import {Hono, type Context, type ErrorHandler, type MiddlewareHandler} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {HTTPException} from 'hono/http-exception';

import {runsJobsLocally} from '../../platform/background';
import {getDb} from '../../platform/db';
import {problem} from '../../platform/guards';
import {CRM_API} from './kit/config';
import {loadUser, requireRole, requireWrite, type AppEnv} from './kit/guards';
import {auth} from './routes/auth';
import {bookingPublic} from './routes/booking-public';
import {calendar} from './routes/calendar';
import {companies} from './routes/companies';
import {contacts} from './routes/contacts';
import {dashboard} from './routes/dashboard';
import {deals} from './routes/deals';
import {email} from './routes/email';
import {inbox} from './routes/inbox';
import {inboxChat} from './routes/inbox-chat';
import {badges} from './routes/badges';
import {chatPublic} from './routes/chat-public';
import {website, websitePublic} from './routes/website';
import './inbox/reports'; // registers the Conversations report object
import {emailPublic} from './routes/email-public';
import {comments} from './routes/comments';
import {fields} from './routes/fields';
import {files, filesPublic} from './routes/files';
import {forms} from './routes/forms';
import {formsPublic} from './routes/forms-public';
import {exports} from './routes/exports';
import {imports} from './routes/imports';
import {interactions, meetingsPublic} from './routes/interactions';
import {lists} from './routes/lists';
import {broadcasts} from './routes/broadcasts';
import {notes} from './routes/notes';
import {notifications} from './routes/notifications';
import {pipelines} from './routes/pipelines';
import {publicApi} from './routes/public';
import {scheduling} from './routes/scheduling';
import './scheduling/reports'; // registers the Bookings report object
import {search} from './routes/search';
import {settings} from './routes/settings';
import {supportPublic} from './routes/support-public';
import {tags} from './routes/tags';
import {tasks} from './routes/tasks';
import {team} from './routes/team';
import {tickets} from './routes/tickets';
import './lib/ticket-reports'; // registers the Tickets report object
import {timeline} from './routes/timeline';
import {history} from './routes/history';
import {views} from './routes/views';
import {webhooks} from './routes/webhooks';
import {dataIn, dataInPublic} from './routes/data-in';
import {dashboards} from './routes/dashboards';
import {goals} from './routes/goals';
import {reports} from './routes/reports';
import {scoring} from './routes/scoring';
import './lib/scoring-report';
import {auditRoutes} from './routes/audit';
import {duplicates} from './routes/duplicates';
import {recycleBin} from './routes/recycle-bin';
import {automations} from './routes/automations';
import {reportSchedules, reportSchedulesPublic} from './routes/report-schedules';
import './lib/automation-reports'; // registers the Automation runs report object
// The job handlers, wherever this app runs: pages call it in-process too, and on your machine / in the
// Preview a job sent before they are registered would run nowhere and be dropped.
import '../background';
import {drainBacklog, withOutbox} from './lib/jobs';

/**
 * Kinroot's Site API, mounted at `/site-api/crm/*` by the site's Hono app (src/server/app.ts),
 * so it shares the template's guards (`sameOrigin`, `csrf`) and never collides with its routes. Its
 * request size limits are its own (`withBodyLimit` below; the site's 64 KB limit skips `/crm`). Two apps:
 *
 *   crmHooks  mounted BEFORE `csrf`: requests other services send (inbound email, the Data in
 *             webhook) and the tracking pixel / click links. They carry no CSRF token; each
 *             authenticates itself (a token or a signature), as before.
 *   crmApp    everything else, after the template's guards: public pages' calls (forms, booking,
 *             support, chat, unsubscribe) and the signed-in CRM.
 */

/** The request's Site Database client, as Kinroot's `c.var.db` (503 in words when the site has none yet). */
const withCrmDb: MiddlewareHandler<AppEnv> = async (c, next) => {
  const db = getDb();
  if (!db) return c.json(problem('site_database_disabled', 'This site has no Site Database yet. The owner can turn it on in the site’s Database tab.'), 503);
  c.set('db', db);
  c.set('user', null);
  await next();
};

/** Jobs queued while answering are sent once the answer is ready (src/server/crm/lib/jobs.ts). */
const withJobs: MiddlewareHandler<AppEnv> = async (c, next) => {
  await withOutbox(() => next());
  // On your machine jobs run as they are sent; ones planned for later wait in the backlog until due.
  if (runsJobsLocally()) await drainBacklog(c.var.db, 20).catch((e) => console.error('[jobs] backlog', String((e as Error)?.message ?? e).slice(0, 200)));
};

const onError: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof HTTPException) return err.res ? err.getResponse() : c.json({error: err.message}, err.status);
  // The message only: an error object can carry request details.
  console.error(`[crm] ${c.req.method} ${c.req.path}: ${err.message}`);
  return c.json({error: 'Something went wrong'}, 500);
};

/** The paths `crmHooks` answers; its middleware runs on these only (the rest of /crm is `crmApp`'s). */
const HOOK_PATHS = ['/inbound/*', '/t/*', '/public/brand-logo', '/public/data-in/*'];

export const crmHooks = new Hono<AppEnv>();
for (const path of HOOK_PATHS) {
  // Inbound mail with attachments is bigger than the Site API's 64 KB; still bounded.
  crmHooks.use(path, bodyLimit({maxSize: 5 * 1024 * 1024, onError: (c) => c.json({error: 'That request is too large.'}, 413)}), withCrmDb, withJobs);
}
crmHooks
  .route('/', emailPublic)
  .route('/public', dataInPublic)
  .onError(onError);

/**
 * Request size: 64 KB like the rest of the Site API, and 512 KB on the routes that save HTML or a
 * logo (Settings → Branding, email templates / sending / design / signatures, inbox replies,
 * broadcasts, ticket replies, forms): what worked in Kinroot before. Files never come through here.
 */
const LARGE_BODIES: [method: string, path: RegExp][] = [
  ['PATCH', /^\/settings\/?$/],
  ['*', /^\/email\/(?:send|design|templates(?:\/[^/]+)*|accounts(?:\/[^/]+)?)$/],
  ['POST', /^\/inbox\/conversations\/[^/]+\/reply$/],
  ['*', /^\/broadcasts(?:\/[^/]+)*$/],
  ['POST', /^\/tickets\/[^/]+\/messages$/],
  ['*', /^\/forms(?:\/[^/]+)?$/],
];
// The same words as the site's own limit (src/server/app.ts).
const onTooLarge = (c: Context) => c.json(problem('too_large', 'That request is too large.'), 413);
const smallBody = bodyLimit({maxSize: 64 * 1024, onError: onTooLarge});
const largeBody = bodyLimit({maxSize: 512 * 1024, onError: onTooLarge});
const withBodyLimit: MiddlewareHandler<AppEnv> = (c, next) => {
  const path = c.req.path.startsWith(CRM_API) ? c.req.path.slice(CRM_API.length) : c.req.path;
  const large = LARGE_BODIES.some(([method, re]) => (method === '*' || method === c.req.method) && re.test(path));
  return (large ? largeBody : smallBody)(c, next);
};

const app = new Hono<AppEnv>();

// The size limit first: before a body is read or a database client made.
app.use('*', withBodyLimit, withCrmDb, withJobs);
app.get('/health', (c) => c.json({ok: true}));

// Public: signed file links and the calls of public pages (unsubscribe, forms, support, booking, chat).
app.route('/', meetingsPublic);
app.route('/', filesPublic);
app.route('/public', publicApi);
app.route('/public', formsPublic);
app.route('/public', supportPublic);
app.route('/public', bookingPublic);
app.route('/public', chatPublic);
app.route('/public', websitePublic);
app.route('/public', reportSchedulesPublic);

app.use('*', loadUser);
// Who is here, the Owner's first-run setup, joining by invite: before the team check.
app.route('/auth', auth);
// Viewers may still read and dismiss their own notifications and follow records.
app.route('/notifications', notifications);
// Viewers may export what they can see.
app.route('/exports', exports);

// Everything below needs a signed-in team member; viewers can only read.
app.use('*', requireRole('VIEWER'), requireWrite);
app.route('/team', team);
app.route('/contacts', contacts);
app.route('/companies', companies);
app.route('/deals', deals);
app.route('/pipelines', pipelines);
app.route('/notes', notes);
app.route('/tasks', tasks);
app.route('/timeline', timeline);
app.route('/history', history);
app.route('/search', search);
app.route('/dashboard', dashboard);
app.route('/fields', fields);
app.route('/views', views);
app.route('/tags', tags);
app.route('/interactions', interactions);
app.route('/comments', comments);
app.route('/settings', settings);
app.route('/email', email);
app.route('/inbox', inbox);
app.route('/inbox', inboxChat);
app.route('/badges', badges);
app.route('/files', files);
app.route('/forms', forms);
app.route('/lists', lists);
app.route('/broadcasts', broadcasts);
app.route('/webhooks', webhooks);
app.route('/data-in', dataIn);
app.route('/reports', reports);
app.route('/dashboards', dashboards);
app.route('/goals', goals);
app.route('/tickets', tickets);
app.route('/scheduling', scheduling);
app.route('/calendar', calendar);
app.route('/scoring', scoring);
app.route('/audit', auditRoutes);
app.route('/recycle-bin', recycleBin);
app.route('/duplicates', duplicates);
app.route('/automations', automations);
app.route('/report-schedules', reportSchedules);
app.route('/website', website);
app.route('/imports', imports);

app.notFound((c) => c.json({error: 'Not found'}, 404));
app.onError(onError);

export {app as crmApp};
