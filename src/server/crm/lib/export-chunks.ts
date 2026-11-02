import type {Db} from '../kit/db';

/**
 * An export's CSV while it is being written: background jobs append 1,000 rows per chunk
 * (`seq` is the key, so a retried job never doubles one), then `chunkStream` feeds them, in
 * order, into ONE upload to platform storage (src/server/crm/kit/storage.ts `storeStream`).
 * The chunks go with the export (cascade) or once it is stored.
 */
export async function writeChunk(db: Db, exportId: string, seq: number, text: string) {
  await db.exportChunk.createMany({data: [{exportId, seq, text}], skipDuplicates: true});
  return new TextEncoder().encode(text).byteLength;
}

/** Bytes written so far (UTF-8). */
export async function chunkedSize(db: Db, exportId: string) {
  const rows = await db.$queryRaw<{size: bigint | null}[]>`SELECT sum(octet_length(text)) AS size FROM "ExportChunk" WHERE "exportId" = ${exportId}`;
  return Number(rows[0]?.size ?? 0);
}

/** The whole CSV as a stream, read from the database 20 chunks at a time (memory stays small). */
export function chunkStream(db: Db, exportId: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let after = -1;
  let queue: string[] = [];
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!queue.length) {
        const rows = await db.exportChunk.findMany({where: {exportId, seq: {gt: after}}, orderBy: {seq: 'asc'}, take: 20, select: {seq: true, text: true}});
        if (!rows.length) return controller.close();
        after = rows.at(-1)!.seq;
        queue = rows.map((r) => r.text);
      }
      controller.enqueue(encoder.encode(queue.shift()!));
    },
  });
}
