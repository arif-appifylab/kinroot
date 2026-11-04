# Kinroot audit 2 (4 Nov, after template 0.10.16 and AUDIT.md)

Four fresh read-only reviews of the whole app — authorization and data exposure; input, injection,
secrets and outside calls; data integrity, performance, jobs and migrations; UI, accessibility, public
pages and platform rules. Each finding was traced in the code by its reviewer; the top ones (H-1, H-2,
M-1, M-2, M-5, M-7) were re-checked by hand. Duplicates merged. **Nothing critical.** Nothing below is
changed yet.

**Status (4 Nov):** all fixed except the parts noted on L-2 (timeline titles keep names written at the time) and L-13 (custom date triggers still read contacts each minute; company duplicate hint not indexed): 37 done, 2 partly done. Plus the owner's requests at the end.

Checked and fine (summary of the reviewers' "no finding" areas): managed files identical to the
template; every route guarded, viewers can't write, admin areas admin-only; owner scope in the `where`
for records, attachments, search, reports, exports (except where listed); no unsafe SQL, no array binds;
received-email HTML allow-list sanitized and framed; email header injection closed; CSV formula-safe;
redirects same-site; files private with short signed links; outgoing webhooks allow-listed, https, no
redirects; OAuth state signed, tokens encrypted; inbound mail / webhooks / Data in signed with replay
protection; secrets never sent or cached; every form `noValidate`; no `window.confirm`; one lockfile,
exact versions; jobs all have handlers, ticks within deadlines; migrations in step with the schema.

---

## High

| ✓ | ID | Area | Problem | Fix | Effort |
|---|---|---|---|---|---|
| [x] | H-1 | Automations | **Date and inactivity triggers silently skip records** when more than 500 rows fall in one window (`lib/automations.ts:366` LIMIT 500, cursor at `:512`): the query reads 500 rows from 2 days before the window, filters, and if the page holds only margin rows or a burst (an import gives hundreds the same timestamp), the cursor jumps to "now" and rows 501+ never fire. | Keyset paging from the cursor's value `(value, id) > (last)`, "more to come" from the raw row count, ties kept with the existing fire dedupe. Test with 1,200 same-time rows. | M |
| [x] | H-2 | Database | **No index on `WebhookDelivery.eventId`** (seq scan confirmed). Each webhook delivery scans the table, and the daily prune's event delete cascades into one full scan per event: with ~300k deliveries the 60 s job is killed, events are never pruned and **every later prune step never runs** (recycle bin, audit log, files, Data in…). | `@@index([eventId])` in its own migration. | S |

## Medium

| ✓ | ID | Area | Problem | Fix | Effort |
|---|---|---|---|---|---|
| [x] | M-1 | Team | **A deactivated pending invite still works, and accepting it re-activates the member** (`routes/auth.ts:39-45` no `active` check; `:105` sets `active: true`). "Deactivate" is the only way to cancel an invite, so a cancelled ADMIN invite can still be used for 14 days. | Require `active` in `inviteByToken` (and clear the token on deactivate); don't set `active` on accept. Add a real "Cancel invite". | S |
| [x] | M-2 | Forms | **Any Member can rewrite any form**, including notification emails, lead owner, redirect and inbox account (`routes/forms.ts:134` PATCH has no `canManage`): every future submission can be emailed outside, and new leads taken over. | Apply `canManage` (creator or admin) to PATCH. | S |
| [x] | M-3 | Forms | **Form responses and their CSV export ignore "members see only their own records"** (`forms.ts:206-224`, `:240-274`): any member or viewer gets every respondent's answers and email, and other members' contacts. | Same owner rule as the submissions report; hide unseen contact/deal links. | S |
| [x] | M-4 | Tickets | **Tickets can link any contact / company / deal** with no visibility check (`routes/tickets.ts:217-260`, `:280-315`; `contactForEmail` returns any contact): a member creates a ticket with someone's email and reads that contact's name, phone and title — an email lookup across all contacts. *(found by two reviewers)* | `assertVisible` on create and on link changes; only reuse a contact the member may see. | S |
| [x] | M-5 | Team | **A co-Owner can lock the site owner out of their own CRM** (`routes/team.ts:62-86` Owner may change another Owner; `kit/guards.ts:68-78` never restores a deactivated / demoted site-owner member). | Refuse role / active changes on the site owner's member row (and have `loadUser` restore it). | S |
| [x] | M-6 | Email | **Strangers can make the company's mailbox send their text to any address** (support form → portal-link email repeats the typed subject and name; booking and form autoresponder emails repeat the typed name; links become clickable): a phishing relay from the company's own domain, limited only per IP. | Never echo visitor free text in emails to unconfirmed addresses (fixed wording + request number); add an hourly cap per recipient and overall. | M |
| [x] | M-7 | Email | **Any Member can send as any address on the company's domain** using the owner's Resend / Postmark / SendGrid / Mailgun key (`routes/email.ts:31-52`, `:107-164`: a personal account's `fromEmail` is free). | Make API-provider accounts admin-only (shared), or force a member's `fromEmail` to their own address. | S |
| [x] | M-8 | Tickets | **A forged `From:` posts as the team or the customer on a ticket** (`lib/ticket-mail.ts:85-131` trusts the From header and the `[#1042]` subject; numbers are sequential). *Depends on the mail service's filtering.* | Trust team/contact identity only when SPF/DKIM/DMARC passed (the providers send it), or match only our own Message-IDs; never post inbound mail as a team reply. | M |
| [x] | M-9 | Database | **Missing indexes on large tables**: `Activity.refId` (note / interaction / file / chat edits and deletes scan the biggest table), `EmailMessage.contactId` (contact delete / bulk delete of 500 = 500 scans in one transaction), `EmailThread.companyId`, `FormSubmission.dealId`, and `Interaction.attendeeIds` (every contact page's activity list scans Interaction). | Five indexes in one migration (a GIN `jsonb_path_ops` for `attendeeIds`). | S |
| [x] | M-10 | Scoring | **Two scoring jobs on the same contact award a rule twice** (`lib/scoring.ts:247-278`; the unique key doesn't cover property awards, NULLs differ): a false band change with notifications, automations and webhooks, then a "fall" on the next pass. Happens on merges and imports. | Partial unique index `(ruleId, contactId) WHERE kind='property' AND revokedAt IS NULL` + `skipDuplicates`. | S–M |
| [x] | M-11 | Jobs | **The job backlog is first-in first-out**: a 10k-contact import puts ~500+ jobs ahead of booking confirmations, form emails, CSAT and SLA checks (about an hour at 10 jobs a minute). | Drain user-facing job types first; coalesce bulk event jobs. | M |
| [x] | M-12 | Duplicates | A full duplicate scan keeps every looked-at pair in memory: likely **out of memory at ~100k contacts**, failing every 6 hours. *(Not measurable on the dev data.)* | Keep only matches; cap pairs per scan. | S |
| [x] | M-13 | Broadcasts | The audience preview and broadcast create **load the whole list in the request** (100k contacts ≈ 120 sequential queries and 100k rows in memory). | Count in SQL; stop at the recipient limit + 1. | M |
| [x] | M-14 | Recycle bin | **Bulk delete of 500 records snapshots everything attached in one request** (100k rows / tens of MB near the 128 MB limit); collected outside the transaction. | Cap at ~100 or run as a job; collect inside the transaction. | M |
| [x] | M-15 | App | **The CRM has no not-found or error screen**: an unknown `/crm/…` address shows a bare "Not Found"; a failure on load shows a generic box whose "Show Error" reveals the raw message, no Retry. | Branded not-found (h1 + link home) and error (`LoadError` + Retry) screens on the router. | S |
| [x] | M-16 | Records | **Editing a property in place loses bad input** and says "Check the highlighted fields" with nothing highlighted (`components/properties.tsx:88-137`); clearing a required name is ignored silently. | Keep the editor open until the save answers, same rules as the server, error under the input; only say "highlighted" when fields were placed. | M |
| [x] | M-17 | App | The in-app **`prompt()` dialog has no validation or error** (Data in rate limit, saved-view name, new list name): bad input closes it, the value is lost, a vague toast shows. | Optional `rules` / `maxLength` and an error under the input; keep it open. | S–M |
| [x] | M-18 | Builders | **Deleting a form field or an automation step is one click, no confirmation, autosaved** (an If step takes both branches); on a live automation it takes effect at once. | `danger` + confirm (at least If steps and fields of published forms), or an Undo toast before autosave. | S |
| [x] | M-19 | Look | **Grey text too faint** (`text-slate-400` on white ≈ 2.6:1, ~236 uses for real text). | `text-muted-foreground` for text; slate-400 only for icons. | M |

## Low

| ✓ | ID | Area | Problem | Fix | Effort |
|---|---|---|---|---|---|
| [x] | L-1 | Exports | Deal CSV export includes linked contacts' emails, and the contact JSON export other members' deals, under owner-only visibility (`lib/exports.ts:97-111`, `routes/contacts.ts:378-381`). | Scope those includes like the detail views. | S |
| [~] | L-2 | Exposure | Linked records' names show where the detail view hides them: email thread list, inbox list, contact list's companies, dashboard "my tasks", timeline entries, report company picker; shared-mailbox threads outside the team inbox readable by all when an admin narrows team accounts. | Reuse the `shownTask` / `scopedDeal` pattern; scope the picker. **Left:** timeline titles written when the entry was made ("Deal created: <title>") still name the record; the linked contact/deal objects are hidden. | S |
| [x] | L-3 | Files | Ticket and chat files open for any member with the file id (`routes/files.ts:44-61`); `*_pending` files too. | Check the parent ticket / conversation; never serve pending files. | M |
| [x] | L-4 | Chat | A chat visitor can claim any email and get linked to that existing contact (replies and transcripts then go there). | Mark as unverified in the agent's view; link to an existing contact only after an emailed confirmation. **Left (UI):** the API sends `chat.visitor.emailVerified` (true once the visitor opened the link we mailed to that address, which also links their existing contact); the "unverified email" badge in the agent's sidebar is for the screens. | M |
| [x] | L-5 | Exposure | Small IDOR / writes: duplicate pair dismiss ignores scope; marking a deal won promotes other members' contacts to Customer; `loadTicket` checks visibility after loading. | Scope in the `where`. | S |
| [x] | L-6 | Email | Merge fields filled inside subjects written by outsiders (reply to an inbound "{{deal.value}}" subject sends internal values back). | Defuse `{{` in outside-written subjects. | S |
| [x] | L-7 | Email | System emails can fall back to a member's personal mailbox. | Shared accounts only, else the platform. | S |
| [x] | L-8 | Abuse | Open / click tracking and form view counters write a row per hit, unlimited. | Cap per message / per IP per minute. | S |
| [x] | L-9 | Input | Chat `page` / `referrer` stored as any string and shown as links (CSP blocks `javascript:` today). | Keep http(s) only. | S |
| [x] | L-10 | Privacy | Report-unsubscribe link carries the recipient's email (signed, not hidden) in the URL. | Sign an opaque recipient id. | S |
| [x] | L-11 | Webhooks | HMAC incoming webhooks without a timestamp can be replayed after 10 minutes. | Require a timestamp for HMAC hooks or remember body hashes longer. | S |
| [x] | L-12 | Data | Open / click tracking read-then-write: two near-simultaneous opens log and emit twice. Workspace settings saves can lose a concurrent update. A retried export can email twice. | Conditional claim updates; atomic `jsonb ||` settings write; mark "emailed" before sending. Export part done too: `emailed` is claimed with a conditional update before the link is sent (lib/exports.ts). | S |
| [~] | L-13 | Performance | Duplicate hint in create dialogs scans all contacts per keystroke pause; one contact's JSON export unbounded; date triggers on a custom date field scan Contact each minute. | Indexed candidate lookups; caps; accept or expression index. **Left:** a date trigger on a custom date field still reads Contact each minute (accepted: one expression index per field key would be needed); the company hint is unchanged (small table). | M |
| [x] | L-14 | Pages | A database outage makes a valid chat link say "expired" (410) (`pages/chat/c/[token].astro`). | 503 "not available right now" on a failed read. | S |
| [x] | L-15 | SEO | Sitemap lists `/support/` when the portal is off; `Crm.astro` hard-codes `lang="en"`; no `og:image` from the brand logo; home page without a headline has no description. | Small fixes in sitemap / layouts. | S |
| [x] | L-16 | Forms | Invalid notification addresses dropped silently on blur; the public form's last name and address parts use placeholders as labels and the address has no error wiring. | Error under the field; visible sub-labels. | S |
| [x] | L-17 | A11y | Colour pickers read hex codes; sortable headers have no `aria-sort` / `type`; bulk Delete shows no visible spinner; Settings → Security may flash password sections for the site owner while loading. | Colour names, `aria-sort`, spinner, wait for the account before rendering. | S |
| [x] | L-18 | Copy | Developer copy shown to users ("the AI builds in this codebase", a file path, an import snippet); "Kinroot" hard-coded where the company's brand name belongs (4 places); "Back to the website" loops when the website is off; portal sign-out has no pending state and fails silently; 7 hard-coded avatar colours. | Reword / remove; use the brand name; hide the link; pending + error; tokens. | S |

## Suggested order
1. **H-1, H-2, M-1 to M-5, M-7, M-9, M-10** — data that's lost or skipped, and who can see or change what. One round, with tests.
2. **M-6, M-8, M-11 to M-14** — email abuse and large-data limits.
3. **M-15 to M-19** and the Lows.

## Owner requests (4 Nov)

| ✓ | ID | Area | Request | Done | Effort |
|---|---|---|---|---|---|
| [x] | OR-DATAIN-URL | Data in | **Data in that Pabbly / Zapier / Make can call without code** (like EzyCourse's "Data in webhook integration"). | Settings → Webhooks → Incoming leads with the Data in webhook: Access token and Signature token (masked, "Show tokens" audited), Regenerate URL (both tokens, confirm), Disable / Enable webhook (confirm). One card per catalogue action: `POST https://<site>/site-api/crm/public/data-in/<action path>/<access token>` with Copy, a parameters table (type, required, max, example), a sample body and the `X-Signature-Token` header. Both tokens required (SHA-256 compared in constant time; stored hashed + encrypted in the `data-in` setting); acts as the admin who enabled / regenerated it; rate limit, size limit, log (tokens never logged), Idempotency-Key as with a key; unknown / regenerated / off → 404 counted against the connection. Empty values skipped, numbers / booleans / lists accepted as text. The API key + HMAC mode is unchanged, collapsed under "Advanced: signed requests". Tests: `tests/integration/crm-data-in-url.test.ts`. | M |
| [x] | OR-PABBLY-OUT | Webhooks | **Pabbly Connect as an outgoing webhook destination.** | `connect.pabbly.com`, paths `/workflow/sendwebhookdata/<id>` and `/webhook-listener/webhook/<id>` only, in `src/crm/lib/webhook-targets.ts` (the one list the editor, the webhook routes, the delivery job and automation steps all check). Tests: `tests/crm-webhook-targets.test.ts` (look-alike hosts and other paths refused). | S |
| [x] | OR-TEAM | Settings | **One "Team" screen** instead of Settings → Team and Settings → Accounts. | `settings.team.tsx`: tab **Team** (members and pending invites; each row's ⋯ menu has the team role, deactivate / reactivate, copy invite link and **Cancel invite** (`DELETE /site-api/crm/team/:id`, confirmed), plus, with the `manageUsers` site permission, that member's sign-in account actions: site roles, sign out everywhere, two-step reset, block / unblock, read when the menu opens) and tab **Customers** (site accounts that are not team members, same account actions; only with `manageUsers`). The site owner's row: "Account owner", no actions. `/settings/accounts` redirects to `/settings/team?tab=customers`; "Accounts" left the nav; Roles stays its own screen. The team list now carries each member's `accountId`. | M |
| [x] | OR-ACCOUNT | Settings | **One "Your account" screen** instead of Settings → Profile and Settings → Security. | `/settings/profile`: picture / name / colour, email, password and two-step sign-in (`#security`), signed-in devices, delete account; the site owner sees the "You're the site owner" note instead of email / password / two-step / delete, devices stay, and nothing flashes while the account loads. `/settings/security` redirects to `/settings/profile#security`; one "Your account" nav item (and in the user menu). | S |
