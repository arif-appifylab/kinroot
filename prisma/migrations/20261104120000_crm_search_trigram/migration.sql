-- Audit P3-20: trigram indexes for search. ⌘K (routes/search.ts) and the lists' `q` filter
-- (contacts, companies, deals, tickets) match with `contains, mode: 'insensitive'`, which Prisma
-- sends as ILIKE '%term%': a b-tree can't serve it, a pg_trgm GIN index can. Only the columns the
-- search really matches: Contact first / last name, email, phone (plain LIKE), job title; Company
-- name, domain, industry; Deal title; Note body; Ticket subject. Related-record matches (a contact's
-- company name, a deal's company) are resolved to ids first, so every OR branch is index-served.
-- pg_trgm is a supported Prisma Postgres extension; IF NOT EXISTS keeps this safe to re-run.
-- The schema declares the indexes (`@@index([col(ops: raw("gin_trgm_ops"))], type: Gin, map: …)`),
-- so `migrate dev` sees no drift. The tables are small (thousands of rows): a normal CREATE INDEX
-- inside the transaction (docs/agent/database.md › Big live tables).
BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateIndex
CREATE INDEX "Contact_firstName_trgm_idx" ON "Contact" USING GIN ("firstName" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Contact_lastName_trgm_idx" ON "Contact" USING GIN ("lastName" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Contact_email_trgm_idx" ON "Contact" USING GIN ("email" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Contact_phone_trgm_idx" ON "Contact" USING GIN ("phone" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Contact_title_trgm_idx" ON "Contact" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Company_name_trgm_idx" ON "Company" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Company_domain_trgm_idx" ON "Company" USING GIN ("domain" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Company_industry_trgm_idx" ON "Company" USING GIN ("industry" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Deal_title_trgm_idx" ON "Deal" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Note_body_trgm_idx" ON "Note" USING GIN ("body" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Ticket_subject_trgm_idx" ON "Ticket" USING GIN ("subject" gin_trgm_ops);

COMMIT;
