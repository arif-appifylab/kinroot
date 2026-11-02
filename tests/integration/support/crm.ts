import {db, resetDatabase} from './harness';

/** Kinroot's tables (PascalCase; the template's are snake_case), emptied with the template's. */
export async function resetCrm() {
  await resetDatabase();
  const tables = await db.$queryRaw<{t: string}[]>`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' AND tablename ~ '^[A-Z]'`;
  // Names come from the catalogue just read, quoted; never from input.
  if (tables.length) await db.$executeRawUnsafe(`TRUNCATE ${tables.map(r => `"${r.t.replace(/"/g, '')}"`).join(', ')} CASCADE`);
}
