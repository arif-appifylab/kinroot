-- Wrapped in one transaction: if any statement fails, none of them apply
-- and the live site keeps its old schema (docs/agent/database.md).
BEGIN;

-- Seed data the auth core needs, IDEMPOTENT and matched by slug / codename
-- (never by id), so it is safe on any database at any time.

-- The permission catalogue (core codenames; see src/platform/auth/codenames.ts).
INSERT INTO "permissions" ("codename", "title", "description", "group_name") VALUES
  ('*',                'Everything',            'Every permission, now and in the future. Owners only.', 'Site'),
  ('site:user:*',      'Manage users',          'Every user permission.',                               'Users'),
  ('site:user:read',   'See users',             'List users with their email, status and roles.',       'Users'),
  ('site:user:update', 'Change users',          'Suspend or reactivate users, end their sessions, change their roles.', 'Users'),
  ('site:role:*',      'Manage roles',          'Every role permission.',                               'Roles'),
  ('site:role:read',   'See roles',             'See roles and what each one allows.',                  'Roles'),
  ('site:role:update', 'Change roles',          'Create, edit and delete custom roles.',                'Roles'),
  ('site:audit:read',  'See the activity log',  'Sign-ins, password changes, role changes.',            'Security'),
  ('site:job:manage',  'Manage jobs',           'Post, edit, close and delete jobs on the job board.',  'Jobs')
ON CONFLICT ("codename") DO NOTHING;

-- The system roles.
INSERT INTO "roles" ("slug", "name", "description", "is_system", "updated_at") VALUES
  ('owner',  'Owner',  'Full control of the site. Cannot be edited.',          true, CURRENT_TIMESTAMP),
  ('admin',  'Admin',  'Manages users, jobs and reads the activity log.',      true, CURRENT_TIMESTAMP),
  ('member', 'Member', 'A signed-in user. Every new account gets this role.',  true, CURRENT_TIMESTAMP)
ON CONFLICT ("slug") DO NOTHING;

-- What each system role grants.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM (VALUES
  ('owner', '*'),
  ('admin', 'site:user:*'),
  ('admin', 'site:role:read'),
  ('admin', 'site:audit:read'),
  ('admin', 'site:job:manage')
) AS g(slug, codename)
JOIN "roles" r ON r."slug" = g.slug
JOIN "permissions" p ON p."codename" = g.codename
ON CONFLICT DO NOTHING;

-- The single auth_state row (who claimed the owner role first).
INSERT INTO "auth_state" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;

COMMIT;
