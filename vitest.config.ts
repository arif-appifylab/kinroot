import {fileURLToPath} from 'node:url';

import {defineConfig} from 'vitest/config';

/**
 * Unit tests (`tests/*.test.ts`): the auth core's pure modules, no database.
 * Integration tests (`tests/integration/*.test.ts`): the real Hono app against
 * a real Postgres, ONLY when `TEST_DATABASE_URL` is set (skipped otherwise):
 *
 *   TEST_DATABASE_URL=postgresql://…/site_tpl_test npm test
 *
 * Use a throwaway database: the integration tests empty its tables.
 */
// Unit tests run without any of this; `npm test` runs `prisma generate` first.
export default defineConfig({
  resolve: {
    alias: [
      // Kinroot's own code (src/crm), as in astro.config.mjs.
      {find: /^@\//, replacement: fileURLToPath(new URL('./src/crm/', import.meta.url))},
      {
        find: 'cloudflare:workers',
        replacement: fileURLToPath(new URL('./tests/integration/support/cloudflare-workers.ts', import.meta.url)),
      },
      // The site's client is built for workerd (it imports wasm as a module);
      // tests use the Node build of the same schema (`generator nodeClient`).
      {
        find: /^(?:\.\.\/)+generated\/prisma\/client$/,
        replacement: fileURLToPath(new URL('./src/generated/prisma-node/client.ts', import.meta.url)),
      },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The integration files share one database: run files one after another.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
