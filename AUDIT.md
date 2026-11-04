# Kinroot full audit (2026-11-03)

**Status (4 Nov):** of 70 rows, 55 done, 12 partly done, 2 not done (P3-20 trigram search, P3-23 npm audit), 1 dropped (P3-24).

Six read-only reviews of the whole app after Phase 10 (authorization, input/secrets, performance, feature
parity with the original, UI and forms, platform rules and operations). Findings are merged and
de-duplicated here; each was verified in the code by its reviewer, and the top ones were re-checked.

**Boxes:** `[x]` done (checked in the code, and a test where there is one), `[~]` partly done (what is
left in bold at the end of the row), `[ ]` not done (why in bold), `[-]` dropped by the owner.
Marks: **inherited** = the original CRM had the same behaviour (fixing it changes how Kinroot behaves,
so it is your call); **new** = came with the migration.

Effort: S = under an hour, M = a few hours, L = a day or more.

---

## P1 · Fix before going live (lost work, security holes, broken features)

| ✓ | ID | Problem | Why it matters | Fix | Effort |
|---|---|---|---|---|---|
| [x] | P1-1 · new | Kinroot sends background jobs in batches of up to 100; the platform allows **10 new jobs a minute** and refuses an over-limit batch whole. Refused jobs wait in a backlog that is resent as one big batch (refused again) and **deleted after 7 days**. | Webhook deliveries, automation runs, scoring, form and booking emails can stop and be lost on the live site (tests can't see it: locally jobs run in-process). "Run automation on a list" makes 101 jobs at once. | Send at most the allowed rate per call (setting, default 10), stop at the first refusal and honour `Retry-After`; never delete unsent backlog rows silently; one webhook job per event (all hooks), list runs in steps of ≤10; show stuck jobs in Settings → Webhooks; advise raising the limit to 50. `lib/jobs.ts`, `lib/events.ts`, `lib/automations.ts` | M |
| [x] | P1-2 · new | The stuck-automation rescue re-queues healthy runs (any run "running" for 2+ minutes since it started, e.g. after a wait). Two jobs can then run the same step. | Duplicate emails / duplicate actions from automations. | One job key per run (`run-<id>`), rescue based on last progress not start time, optional per-run lock. `lib/automations.ts` | S–M |
| [x] | P1-3 · new | Contact and company **merge** loads both records without the owner-only check. | With "members see only their own records", a member can merge another owner's contact into theirs: they take its notes, emails, deals, files, and the other record is **deleted permanently** (no recycle bin). | Load both with the owner scope; 404 if not visible; test. `routes/contacts.ts:235`, `routes/companies.ts:184` | S |
| [x] | P1-4 · new | `POST /files/:id/link` makes a **public 30-day link for any file id**, including other people's import/export CSVs (whole tables with emails), skipping the uploader/admin check the download has. | Data leak by any member who has a file id. | Same check as the download (private purposes: uploader or admin), only attachments on visible records. `routes/files.ts:109` | S |
| [x] | P1-5 · new | The site's **64 KB request limit** also applies to the CRM. | Logos, email templates, broadcasts and long replies over 64 KB worked in the original and are now refused ("That request is too large"). | Give `/crm` its own limit (≈512 KB) on the routes that carry HTML; move the logo to file storage (see P2-27). `src/server/app.ts:46` | S |
| [x] | P1-6 · inherited | Received-email HTML: the cleaning regexes are **very slow on crafted mail** (an unclosed-tag email of 240 KB took 46 s), and they run on every inbox open. | Anyone can email the company and freeze the inbox or make the mail provider retry forever (CPU limit). | Linear patterns, cap stored HTML (~200 KB), clean once at arrival instead of on every read. `inbox/sanitize.ts:66`, `email/render.ts:82` | M |
| [x] | P1-7 · inherited | A received email can use `position:fixed` styles to **cover the whole CRM screen** with its own content and links (verified in the browser). | Phishing inside the CRM. | `contain: layout paint` on the email frame; drop `position:fixed/sticky` and CSS escapes in the style cleaner; fix the outdated "sandboxed iframe" comment. `inbox/sanitize.ts:37`, `components/email-frame.tsx` | S |
| [~] | P1-8 · new | Mailbox and calendar sync run all accounts one after another in one job with no time budget; a few busy mailboxes exceed the 60 s job limit, so **calendars never sync** and runs overlap. The manual "Sync now" does the same inside a request. **Left: calendar "Sync now" still syncs inside the request (one connection, 40 s budget).** | Email and calendar sync silently stop. | One job per mailbox / calendar (keyed per 5-minute slot), oldest first, time budget per message. `email/sync.ts:130`, `calendar/service.ts:228`, `lib/ticks.ts` | M |
| [x] | P1-9 · new | The every-minute tick runs 5 steps with no error handling and no overall time budget; one failure skips the rest; the schedules have no "no retry / one at a time" settings so retried minutes overlap. | Report emails, automations, inbox wake-ups skipped or doubled. | try/catch per step, shared deadline and per-step caps, `background.json`: `retries: 0, concurrency: 1` for the 3 schedules. `lib/ticks.ts`, `background.json` | S |
| [x] | P1-10 · inherited | Date/inactivity automations check their time budget only between automations; switching one on can take minutes, and a run killed midway **loses those records' runs forever** (the "fired" mark is written before the run). | Automations silently skip people. | Budget inside the loop, cap per tick, save progress as it goes, rely on the run's own dedupe key. `lib/automations.ts:423` | M |
| [x] | P1-11 · new | One malformed job in the backlog (too large, bad list…) blocks the whole backlog every minute until it is deleted 7 days later. | Same as P1-1, from one bad row. | Send one at a time on permanent errors, mark the row failed, cap attempts, show it. `lib/jobs.ts:158` | S |

## P2 · Should fix (permission gaps, hardening, speed at scale, form rules)

### Permissions and data exposure
| ✓ | ID | Problem | Fix | Effort |
|---|---|---|---|---|
| [x] | P2-1 · inherited | With owner-only visibility on, everything **attached** to a record leaks: notes, tasks (all-tasks list), interactions, files, email threads, comments, search over note bodies, ticket threads in the inbox; members can follow any record (and get its new notes), link others' contacts to their deals, send email into any thread, add notes/tasks/files to any record. | One `assertVisible` helper (404) on every route that takes a record id; owner scope in child queries; ticket scope in the inbox; tests. | M |
| [x] | P2-2 · inherited | Every member (viewers too) can read automations' "Send a webhook" URLs, which work like passwords (Slack, Zapier…). | Show `Zapier (hooks.zapier.com)` to non-admins. | S |
| [x] | P2-3 · inherited | An Admin can demote or deactivate other Admins; an Owner can never be changed by another Owner. | Only Owners change Admins; Owners can change other Owners but never the last one. | S |
| [x] | P2-4 · new | A Viewer can connect a personal Gmail/Outlook mailbox (calendar already refuses). | Same refusal as calendar. | S |
| [x] | P2-5 · new | "Run automation on a list" keeps running after the member who started it is deactivated. | Check `active` in the job. | S |
| [~] | P2-6 · inherited | Any member can add/remove contacts on anyone's static list, publish/close any form, hard-delete form responses, and start a full duplicate scan inside a request. **Left: the full duplicate scan (admins only now) still runs inside the request, not as a job.** | Apply the creator-or-admin rule; scan as an admin-only job. | S |
| [~] | P2-7 · inherited | Several "not yours" answers say 403 (confirms the record exists) instead of 404. **Left: still 403 for another member's email account, private email templates, booking links and booking cancel.** | Owner condition in the query, 404. | S |
| [x] | P2-8 · inherited | CSAT and booking-manage links never expire. | CSAT 30 days after close; booking until meeting end + 7 days. | S |

### Input, abuse and hardening
| ✓ | ID | Problem | Fix | Effort |
|---|---|---|---|---|
| [x] | P2-9 · new | Public booking slots: no rate limit, no cache, one live Google/Microsoft call per host per request, ~20 sequential DB trips for team links; dates not validated. | Rate limit, validate dates, one query for all hosts, cache busy times 1–5 min. | M |
| [x] | P2-10 · new | Data in API logs a row for every request without a key, unlimited. | Count and refuse before logging. | S |
| [x] | P2-11 · new | Rate-limit keys use an unkeyed hash of the IP (reversible for IPv4); count-then-insert lets bursts through. | Keyed hash as the audit log does; insert-then-count. | S |
| [x] | P2-12 · inherited | Replays: incoming-webhook HMAC has no timestamp; Svix/Mailgun ids not recorded. | Remember seen ids 10 min; optional timestamp or body-hash dedupe. | S–M |
| [~] | P2-13 · inherited | Website / LinkedIn / form redirect / meeting location URLs are not checked when saved (the CSP blocks `javascript:` today). **Left: imports, the Data in API and booking-link locations still save website / LinkedIn / location unchecked.** | Shared http(s) URL check on save, imports and APIs. | S |
| [x] | P2-14 · inherited | Microsoft tenant id pasted into the sign-in URL unchecked. | Format check + encode. | S |
| [x] | P2-15 · inherited | CSV headers (report labels, form field names) are not formula-protected. | Escape headers like cells. | S |
| [x] | P2-16 · inherited | Meeting `.ics` text keeps carriage returns (property injection). | Escape `\r`. | S |
| [~] | P2-17 · new | Raw error text (Prisma, provider) shown to users on restore and calendar errors. **Left: calendar sync errors (toast and "last error") still show the provider's raw text.** | Map to words. | S |
| [~] | P2-18 · inherited | Loose number parsing (`1.5`, `1e3` → 500 errors), unbounded `page`/`tzOffset`. **Left: `page` has no maximum and numbers are loosely parsed in inbox, automations, audit, recycle bin, tickets, email and broadcasts.** | Strict patterns and maximums. | S |
| [x] | P2-19 · new | `PATCH /email/threads/:id` links a deal/contact without checking it is visible (part of P2-1). | Scope the linked ids. | S |

### Speed (matters as data and the team grow)
| ✓ | ID | Problem | Fix | Effort |
|---|---|---|---|---|
| [x] | P2-20 · inherited | Open inbox conversation re-downloads the whole transcript every 3 s (13–15 sequential queries per poll). | Light "updates since" endpoint; full detail on open only. | M |
| [x] | P2-21 · inherited | Website chat poll: ~10 sequential queries and up to 4 writes per visitor every 3 s. | Cache online agents and settings, skip re-reads; 3–4 queries. | M |
| [x] | P2-22 · inherited | App badges poll ~25 counts a minute per open tab (14 unindexed counts for the inbox alone), also in background tabs. | One capped `/badges` call; full counts only on their screens. | M |
| [x] | P2-23 · inherited | Bulk delete / complete / tag act one record at a time (up to ~2000 sequential queries in one request). | Bulk SQL + `emitMany` / `auditMany`. | S–M |
| [x] | P2-24 · inherited | Missing indexes: lists sorted by created date, `lastActivityAt`, task and booking triggers; case-insensitive email lookups can't use the email index (support portal, broadcasts, forms, chat…). | Indexes migration + `lower(email)` index and lookups. | M |
| [x] | P2-25 · inherited | Contact create/edit runs a full-table duplicate check inside the request; the 6-hourly scan loads all contacts into memory. | Duplicate check as a job; group candidates in SQL. | M |
| [x] | P2-26 · inherited | Settings rows read uncached on most requests (twice on some). | Site Cache with clear-on-save. | S |
| [x] | P2-27 · new | Logos over ~256 KB can't be cached, so the brand is read on every page (logo is a data URL in the database; already an open item). | Logo to public file storage; cache its URL. | M |
| [x] | P2-28 · inherited | Dashboard loads whole deal sets into memory; deals list up to 1000 rows with deep includes; company page loads every contact; lists picker counts every segment. | SQL aggregates; 100-row pages; capped counts. | M |
| [x] | P2-29 · inherited | Import deal updates: a 200-row batch can exceed the job time limit. | Batch writes; smaller batches for deals. | M |

### Forms and screens (the site's own form rules)
| ✓ | ID | Problem | Fix | Effort |
|---|---|---|---|---|
| [x] | P2-30 · inherited | Mouse-only controls: editing record properties, opening tickets and tasks, ticket subject, filter cards, form builder fields (keyboard and screen-reader users can't use them). | Real buttons/links. | M |
| [x] | P2-31 · inherited | ~56 forms show browser validation popups (`required`, `type=email` without `noValidate`), incl. booking, support request and chat. | `noValidate` + the app's own errors. | M |
| [~] | P2-32 · inherited | CRM forms show errors only as toasts: no error under the field, no focus on the first wrong field; the server returns only the first error (no `422 fields`). **Left: email design, website and inbox settings still answer in toasts only; ~150 hand-written 400 / 409 checks have no `fields`.** | Field ids/aria in the kit, a small form helper (exists in Phase 10 code), 422 with fields. | L |
| [x] | P2-33 · inherited | ~95 buttons keep their label while working ("Save" not "Saving…"); ~33 action buttons can send twice on a double click. | `pending` on the kit Button; disable while running. | M |
| [x] | P2-34 · inherited | Deleting a **note** or **task** is permanent and has no confirmation; also comments, saved views, dashboard widgets, "remove from list", "clear" actions. | Confirm dialog (or recycle bin for notes/tasks). | S |
| [~] | P2-35 · inherited | ~30 screens have no error state (a failed load shows an empty page or endless skeletons). **Left: the tickets card on record pages shows "0" when its load fails.** | Error state with Retry in DataTable and screens. | M |

## P3 · Nice to have / housekeeping

| ✓ | ID | Problem | Fix | Effort |
|---|---|---|---|---|
| [x] | P3-1 · new | Duplicate scans run daily instead of every 6 hours (the screen says 6 hours). | Check from the every-minute tick. | S |
| [x] | P3-2 · new | Favicon no longer takes the brand colours (original tinted it). | Serve a tinted SVG. | S |
| [~] | P3-3 · new | Owner-by-email in Data in, imports and incoming webhooks no longer matches invited (not yet joined) teammates. **Left: incoming webhooks still match only active teammates' sign-in emails.** | Match invite email too. | S |
| [~] | P3-4 · inherited | ~181 form labels not linked to their inputs (screen readers). **Left: ~14 controls (automation step text fields, a few rich editors and group labels).** | Auto-id in the kit `Field` (comes with P2-32). | S |
| [x] | P3-5 · inherited | Hover-only buttons invisible to keyboard; saved-view delete unreachable. | Focus-visible styles. | S |
| [x] | P3-6 · inherited | Editor screens have no `<h1>`; card titles skip a level; focus not moved after navigation; mobile menu not a real dialog. | Headings, focus, Radix dialog. | S–M |
| [x] | P3-7 · inherited | Placeholders used as labels (chat name/email, CSAT comment, cancel reason, composer). | Visible or sr-only labels. | S |
| [x] | P3-8 · new | Stale words: Settings → Website says the app is at `/admin`; "The template ships as…"; "works with SMTP sending". | Reword. | S |
| [x] | P3-9 · new | `/support/` is indexable with no server-rendered heading; `/f/` and `/book/` neither noindex nor indexable. | Decide per page: noindex or real SEO. | S |
| [x] | P3-10 · inherited | Disabled buttons don't show `not-allowed`; one select has no focus style. | Kit styles. | S |
| [~] | P3-11 · new | Several CRM route files have no integration test (notifications, views, goals, calendar, tags, search, dashboard, website). **Left: no tests for the calendar routes and Settings → Website; tags / search have no 404 case.** | One test file per the "other user gets 404" rule. | M |
| [x] | P3-12 · new | A few ported tests poll with short fixed waits and fail on a busy machine (seen today under load). | Await the work / longer time-based waits. | S |
| [x] | P3-13 · new | Platform docs say keep RSS; it was removed with the blog (owner-approved). | Serve an empty valid feed, or accept. | S |
| [~] | P3-14 · inherited | Most text columns have no length limit in the database; ~30 status columns have no CHECK. **Left: the 56 CHECKs are in; lengths only on ~17 columns, not the main record fields.** | Later expand migration. | M |
| [x] | P3-15 · new | Jobs carry no label, so the dashboard's Jobs tab is hard to read. | Short labels per job type. | S |
| [x] | P3-16 · new | Dead code and stale comments: no-op `kickJobs()` (50 refs), ignored `maxAttempts`, unused exports, Turnstile leftovers, `/jobs/run` and `/dashboard/account` in comments, outdated `astro.config.mjs` comments, a few outdated PLAN.md lines. | Remove / reword. | S |
| [x] | P3-17 · new | `README.md` and `AGENTS.md` still describe the template's blog, jobs, portal and dashboard. | Kinroot README; a short "This site" section in AGENTS.md. | S |
| [x] | P3-18 · inherited | File purge deletes database rows even when deleting the stored file failed (orphaned storage). | Delete rows only for removed files. | S |
| [x] | P3-19 · inherited | Daily prune deletes in one unbatched statement. | Chunked deletes. | S |
| [ ] | P3-20 · inherited | ⌘K search: unindexed `ILIKE` scans. **Not done: the platform database's extensions (pg_trgm) aren't documented, and a refused migration blocks a Publish.** | Trigram indexes. | S |
| [x] | P3-21 · inherited | Small N+1s (scheduling links, meetings, mention checks, widget reorder). | `in` queries, `Promise.all`. | S |
| [x] | P3-22 · inherited | Remote images in received emails load automatically (tracking pixels). | Optional "Show images" toggle. | M |
| [ ] | P3-23 · — | `npm audit`: 1 high, 4 moderate, all in build/dev tools (nothing in the deployed Worker). **Not done: taken with the next template upgrade.** | Take with the next template upgrade. | S |
| [-] | P3-24 · known | Lists page with OFFSET and totals (already an open decision in PLAN.md); inbox conversations, tickets and recycle bin also do it. **Dropped by the owner: pages keep page numbers.** | Keyset paging + "25+". | L |

## Checked and fine (highlights)
- No unsafe SQL; every raw fragment is a code constant; values bound. Every route validates input.
- Secrets only from owner secrets; stored tokens encrypted; no secrets or raw IPs in logs; CSP with no unsafe-inline.
- Outgoing calls only to fixed hosts with timeouts; webhooks only to the service list; inbound mail, incoming webhooks and Data in verify the sender before reading.
- Team emails masked as decided; invites hashed and bound to the verified account; Phase 10 sign-in, account and admin screens meet every form rule.
- `src/platform/**` and `docs/agent/**` identical to the template; one lockfile; background lists match their handlers; migrations wrapped and ordered; schema matches migrations.
- Every original screen, API route (336), job type and setting is present or changed as approved.
