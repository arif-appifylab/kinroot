import {Hono} from 'hono';

import {CHANNEL_KEYS, MESSAGE_CHANNELS} from '@/lib/inbox';
import {OPEN_STATUSES} from '@/lib/tickets';
import {currentUser, type AppEnv} from '../kit/guards';
import {getInboxSettings, hasTeamAccess} from '../inbox/settings';
import {stampLastSeen} from './inbox';

/** Numbers are counted up to this, so a badge reads "99+" without counting a whole table. */
const CAP = 100;

export type Badges = {
  /** My overdue open tasks. */
  tasks: number;
  /** My task reminders that are due and not shown yet (the shell fetches them only when > 0). */
  reminders: number;
  /** Unread open conversations waiting on me or on the queue, as the inbox counts them. */
  inbox: number;
  /** Open tickets assigned to me. */
  tickets: number;
  /** My unread notifications, and the newest one (the bell toasts new arrivals). */
  notifications: number;
  latestNotificationId: string | null;
};

/**
 * GET /site-api/crm/badges: every number the app shell shows, polled by every open tab, in ONE
 * query (AUDIT P2-22). Each number is a subquery capped at CAP rows on an index. The full counts
 * (`/inbox/counts`, `/tickets/counts`) are read only by the inbox and tickets screens.
 *
 * The inbox number is the inbox's own rule (inbox/scope.ts `inboxScope().listable` and
 * `viewWhere('open')`, plus unread and "mine or unassigned") written once in SQL; the badges test
 * checks it gives the same number as `/inbox/counts` for an admin, a member and a member without
 * team-inbox access. Also keeps the agent "last seen" stamp the inbox counts used to keep.
 */
export const badges = new Hono<AppEnv>().get('/', async (c) => {
  const db = c.var.db;
  const me = currentUser(c);
  const now = new Date();
  const settings = await getInboxSettings(db); // Site Cache
  const team = hasTeamAccess(me, settings);
  const allTeamAccounts = settings.teamAccounts === 'all';
  const teamAccounts = allTeamAccounts ? [] : settings.teamAccounts;
  const channels = [...CHANNEL_KEYS];
  const messageChannels = ['form', ...MESSAGE_CHANNELS];
  const ticketStatuses = [...OPEN_STATUSES];

  const [[row]] = await Promise.all([
    db.$queryRaw<{tasks: number; reminders: number; inbox: number; tickets: number; notifications: number; latest: string | null}[]>`
      SELECT
        (SELECT COUNT(*)::int FROM (
          SELECT 1 FROM "Task" WHERE "assigneeId" = ${me.id} AND "done" = false AND "dueAt" < ${now} LIMIT ${CAP}
        ) x) AS tasks,
        (SELECT COUNT(*)::int FROM (
          SELECT 1 FROM "Task" WHERE "assigneeId" = ${me.id} AND "done" = false AND "reminderAt" <= ${now} AND "remindedAt" IS NULL LIMIT ${CAP}
        ) x) AS reminders,
        (SELECT COUNT(*)::int FROM (
          SELECT 1 FROM "Ticket" WHERE "assigneeId" = ${me.id} AND "status" = ANY(${ticketStatuses}::"TicketStatus"[]) LIMIT ${CAP}
        ) x) AS tickets,
        (SELECT COUNT(*)::int FROM (
          SELECT 1 FROM "Notification" WHERE "userId" = ${me.id} AND "readAt" IS NULL LIMIT ${CAP}
        ) x) AS notifications,
        (SELECT "id" FROM "Notification" WHERE "userId" = ${me.id} ORDER BY "createdAt" DESC LIMIT 1) AS latest,
        (SELECT COUNT(*)::int FROM (
          SELECT 1 FROM "EmailThread" t
          WHERE t."firstInboundAt" IS NOT NULL AND t."channel" = ANY(${channels}::text[])
            AND t."spamAt" IS NULL AND t."trashedAt" IS NULL AND t."snoozedUntil" IS NULL
            AND t."status" = 'OPEN' AND t."unread" = true
            AND (t."assigneeId" = ${me.id} OR t."assigneeId" IS NULL)
            AND (
              -- own: my personal mailboxes, and mail without a mailbox assigned to me
              (t."channel" = 'email' AND t."accountId" IN (SELECT a."id" FROM "EmailAccount" a WHERE a."userId" = ${me.id}))
              OR (t."channel" = 'email' AND t."accountId" IS NULL AND t."assigneeId" = ${me.id})
              -- the team inbox, for people with access ("mine or unassigned" already narrows it)
              OR (${team} AND (
                (t."channel" = 'email' AND t."accountId" IN (
                  SELECT a."id" FROM "EmailAccount" a WHERE a."userId" IS NULL AND (${allTeamAccounts} OR a."id" = ANY(${teamAccounts}::text[]))
                ))
                OR t."channel" = ANY(${messageChannels}::text[])
                OR (t."channel" = 'email' AND t."accountId" IS NULL AND t."assigneeId" IS NULL)
              ))
            )
          LIMIT ${CAP}
        ) x) AS inbox
    `,
    stampLastSeen(db, me),
  ]);

  return c.json({
    tasks: row?.tasks ?? 0,
    reminders: row?.reminders ?? 0,
    inbox: row?.inbox ?? 0,
    tickets: row?.tickets ?? 0,
    notifications: row?.notifications ?? 0,
    latestNotificationId: row?.latest ?? null,
  } satisfies Badges);
});
