-- Kinroot phase 10 clean-up (owner approved): the template's job board is gone (pages, API, dashboard
-- screen). Its permission is deleted with its grants (the permission sync never deletes a codename),
-- the Admin role's description stops mentioning jobs, and the table is dropped. Idempotent.
BEGIN;

DELETE FROM "role_permissions"
WHERE "permission_id" IN (SELECT "id" FROM "permissions" WHERE "codename" = 'site:job:manage');

DELETE FROM "permissions" WHERE "codename" = 'site:job:manage';

UPDATE "roles"
SET "description" = 'Manages users and roles, and reads the activity log.', "updated_at" = CURRENT_TIMESTAMP
WHERE "slug" = 'admin' AND "description" = 'Manages users, jobs and reads the activity log.';

DROP TABLE IF EXISTS "jobs";

COMMIT;
