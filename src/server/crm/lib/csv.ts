import Papa from 'papaparse';

/** Excel only reads a UTF-8 CSV as UTF-8 when it starts with a byte order mark. */
export const CSV_BOM = '﻿';

/** One CSV cell. Text starting with = + - @ would run as a formula in Excel / Sheets, so it gets a leading apostrophe. */
function csvCell(v: unknown) {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.join(', ') : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvLine = (values: unknown[]) => values.map(csvCell).join(',');

/** Rows → CSV text with `columns` as the header. Header cells (report labels, form questions) are escaped like body cells. */
export function csv(rows: Record<string, unknown>[], columns: string[]) {
  return [csvLine(columns), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\r\n');
}

/**
 * Parses an uploaded CSV: UTF-8 with or without a byte order mark, comma,
 * semicolon or tab separated (detected unless given), quoted cells with
 * newlines. Blank lines are skipped. Returns the header row and the data rows.
 */
export function parseCsv(bytes: Uint8Array, delimiter?: string) {
  const text = new TextDecoder('utf-8').decode(bytes); // drops a BOM
  const parsed = Papa.parse<string[]>(text, {delimiter: delimiter || '', skipEmptyLines: 'greedy'});
  const [head = [], ...rows] = parsed.data;
  return {headers: head.map((h) => String(h ?? '').trim()), rows, delimiter: parsed.meta.delimiter || ',', badEncoding: text.includes('�')};
}
