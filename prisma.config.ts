import {existsSync} from 'node:fs';

import {defineConfig} from 'prisma/config';

// On your own machine the URLs live in `.env` (git-ignored, copied from
// `.env.example`), which the Prisma CLI does not read by itself. A variable
// that is already set (the editor, the Build) always wins over the file.
if (existsSync('.env')) process.loadEnvFile('.env');

/**
 * The Prisma CLI's config (`prisma generate`, `migrate dev`, `studio`, seed).
 *
 * Every URL comes from the environment — never write one here or in `.env`
 * files that could be committed:
 *   - DATABASE_URL         the Site Database. In the editor it is the PREVIEW
 *                          Database; the deployed site gets the live one.
 *                          Empty until the owner enables the Site Database.
 *   - SHADOW_DATABASE_URL  the throwaway database `prisma migrate dev` needs
 *                          (the editor provides one).
 *
 * The Build runs `prisma generate` with neither set: generating the client
 * needs no database. Deploy-time migrations are run by the platform with its
 * own config; this file is only for your machine and the editor.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'prisma db execute --file prisma/seed.sql',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
