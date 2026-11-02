import {IO_FILE_DAYS} from '@/lib/import-export';
import type {Db} from '../kit/db';
import {purgeFiles} from '../kit/storage';

const DAY = 86_400_000;

/**
 * From pruneJobs(): import and export files (uploads, error rows, exports) go
 * after 7 days, the Import / Export rows (the drawers' history) after 90, and
 * imports that were uploaded but never started after a day. The audit log
 * keeps its own entries; its download links simply disappear with the files.
 */
export async function pruneImportExport(db: Db) {
  const fileCutoff = new Date(Date.now() - IO_FILE_DAYS * DAY);
  await purgeFiles(db, {purpose: {in: ['import', 'import_errors', 'export']}, createdAt: {lt: fileCutoff}});
  const stale = await db.import.findMany({where: {status: {in: ['draft', 'ready']}, updatedAt: {lt: new Date(Date.now() - DAY)}}, select: {id: true, fileId: true}});
  if (stale.length) {
    await purgeFiles(db, {id: {in: stale.flatMap((s) => (s.fileId ? [s.fileId] : []))}});
    await db.import.deleteMany({where: {id: {in: stale.map((s) => s.id)}}});
  }
  const rowCutoff = new Date(Date.now() - 90 * DAY);
  await db.import.deleteMany({where: {createdAt: {lt: rowCutoff}}});
  await db.export.deleteMany({where: {createdAt: {lt: rowCutoff}}});
}
