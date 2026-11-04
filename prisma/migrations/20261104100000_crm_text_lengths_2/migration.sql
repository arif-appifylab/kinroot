-- Audit P3-14 (part 3): lengths on main record fields whose EVERY writer is capped at or below n
-- (docs/agent/database.md › Column types; checked across src/server/crm, the seed and the tests):
--   Ticket.subject 300   routes (tickets, support portal) .max(300); lib/tickets.ts createTicket slices 300
--                        (email, forms, webhooks, automations, Data in all create through it);
--                        automations can't write it.
--   Task.title 300       routes/tasks.ts .max(300); the "create task" automation step slices 300; the
--                        follow-up task of an interaction slices 300; repeats copy the title.
--   Member.name 80       team invite and profile .max(80); a new owner's name is users.name (varchar 80).
--   BookingLink.name 120 routes/scheduling.ts .max(120); the website's "Product demo" link.
--   Contact.linkedin, Company.website, Company.linkedin 2000: lib/http.ts httpUrl .max(2000) (routes,
--                        imports, incoming webhooks), Data in 300, forms 300, automation field updates 2000.
-- Not changed (a writer is not capped at the API's max, or the API max is the generic 5000 of optStr):
-- Contact.firstName / lastName / email / phone / title / source…, Company.name / domain / phone /
-- industry…, Deal.title (automation field updates write up to 2000; bookings, forms and the "(copy)"
-- duplicates write past the route's max), Form.name / slug and BookingLink.slug (slugs are made from
-- names longer than the slug's max; a form copy adds " (copy)").
-- text -> varchar(n) re-checks every row (fails if one is longer; none are: checked on the dev and
-- test databases) and the Publish asks the owner to approve the type change.
BEGIN;

-- AlterTable
ALTER TABLE "Ticket" ALTER COLUMN "subject" SET DATA TYPE VARCHAR(300);

-- AlterTable
ALTER TABLE "Task" ALTER COLUMN "title" SET DATA TYPE VARCHAR(300);

-- AlterTable
ALTER TABLE "Member" ALTER COLUMN "name" SET DATA TYPE VARCHAR(80);

-- AlterTable
ALTER TABLE "BookingLink" ALTER COLUMN "name" SET DATA TYPE VARCHAR(120);

-- AlterTable
ALTER TABLE "Contact" ALTER COLUMN "linkedin" SET DATA TYPE VARCHAR(2000);

-- AlterTable
ALTER TABLE "Company" ALTER COLUMN "website" SET DATA TYPE VARCHAR(2000),
ALTER COLUMN "linkedin" SET DATA TYPE VARCHAR(2000);

COMMIT;
