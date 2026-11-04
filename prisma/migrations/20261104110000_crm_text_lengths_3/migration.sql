-- Audit P3-14 (part 4): lengths on the main record fields left by crm_text_lengths_2. Each n is the
-- API's max (src/crm/lib/record-limits.ts: contactBody, companyBody, dealBody, the forms and
-- booking-link routes; Data in's catalogue stays at or below it), and every writer is capped at it:
-- what a person types is refused with a field error; what Kinroot makes is cut to it (`clip()` /
-- `cut()`): names split from a booking, a chat or a support email, form answers mapped to a contact
-- or company, automation "update field" values (up to 2000 before), " (copy)" names, slugs made
-- from names (room left for "-2"… within 60), companies named after a domain, imports, Data in and
-- incoming webhooks (record-writes.ts), and records restored from the recycle bin.
-- text -> varchar(n) re-checks every row (fails if one is longer; none are: checked on the dev and
-- test databases) and the Publish asks the owner to approve the type change. Indexes on these
-- columns (Contact email, lower(email), name; Company name, domain; Form slug) are rebuilt.
BEGIN;

-- AlterTable
ALTER TABLE "Contact" ALTER COLUMN "firstName" SET DATA TYPE VARCHAR(100),
ALTER COLUMN "lastName" SET DATA TYPE VARCHAR(100),
ALTER COLUMN "email" SET DATA TYPE VARCHAR(254),
ALTER COLUMN "phone" SET DATA TYPE VARCHAR(50),
ALTER COLUMN "title" SET DATA TYPE VARCHAR(200),
ALTER COLUMN "leadStatus" SET DATA TYPE VARCHAR(100),
ALTER COLUMN "buyingRole" SET DATA TYPE VARCHAR(100),
ALTER COLUMN "city" SET DATA TYPE VARCHAR(100),
ALTER COLUMN "country" SET DATA TYPE VARCHAR(100),
ALTER COLUMN "source" SET DATA TYPE VARCHAR(100);

-- AlterTable
ALTER TABLE "Company" ALTER COLUMN "name" SET DATA TYPE VARCHAR(200),
ALTER COLUMN "domain" SET DATA TYPE VARCHAR(253),
ALTER COLUMN "industry" SET DATA TYPE VARCHAR(100),
ALTER COLUMN "size" SET DATA TYPE VARCHAR(50),
ALTER COLUMN "type" SET DATA TYPE VARCHAR(100),
ALTER COLUMN "timezone" SET DATA TYPE VARCHAR(100),
ALTER COLUMN "phone" SET DATA TYPE VARCHAR(50),
ALTER COLUMN "address" SET DATA TYPE VARCHAR(300),
ALTER COLUMN "city" SET DATA TYPE VARCHAR(100),
ALTER COLUMN "state" SET DATA TYPE VARCHAR(100),
ALTER COLUMN "postalCode" SET DATA TYPE VARCHAR(30),
ALTER COLUMN "country" SET DATA TYPE VARCHAR(100);

-- AlterTable
ALTER TABLE "Deal" ALTER COLUMN "title" SET DATA TYPE VARCHAR(200),
ALTER COLUMN "lostReason" SET DATA TYPE VARCHAR(200),
ALTER COLUMN "type" SET DATA TYPE VARCHAR(100),
ALTER COLUMN "priority" SET DATA TYPE VARCHAR(50);

-- AlterTable
ALTER TABLE "Form" ALTER COLUMN "name" SET DATA TYPE VARCHAR(120),
ALTER COLUMN "slug" SET DATA TYPE VARCHAR(60);

-- AlterTable
ALTER TABLE "BookingLink" ALTER COLUMN "slug" SET DATA TYPE VARCHAR(60);

COMMIT;
