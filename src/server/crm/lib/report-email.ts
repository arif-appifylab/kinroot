import {buttonHtml, escapeHtml} from '@/lib/email-html';
import {EMAIL_TOP_ROWS} from '@/lib/report-schedules';
import type {ReportResult, ReportRow} from '@/lib/reports';

/**
 * A report as email HTML: a stat tile (total + change vs the previous
 * period), then the grouped results as a table with inline bars. Mail
 * clients run no JS and many block images, so the bars are table cells with
 * percentage widths and a background colour. Follows the dataviz rules as
 * far as email allows: categorical colours in fixed order (the light
 * `--chart-1…8` steps from styles.css, emails are light only), "Other" in
 * grey, a legend for 2+ series, text in ink colours (never the series
 * colour), 2px white gaps between stacked segments, rounded data ends.
 */

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const INK = '#0f172a';
const BODY = '#1e293b';
const SECONDARY = '#475569';
const MUTED = '#64748b';
const LINE = '#e2e8f0';
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const OTHER = '#94a3b8';

export type EmailSection = {
  name: string;
  result: ReportResult;
  /** Total of the same range + the period before it (for the change line). */
  kpi: Pick<ReportResult, 'total' | 'previous'>;
};

export function formatValue(v: number, format: ReportResult['format'], currency: string) {
  if (format === 'currency') return new Intl.NumberFormat('en-US', {style: 'currency', currency, maximumFractionDigits: Math.abs(v) < 100 && !Number.isInteger(v) ? 2 : 0}).format(v);
  return new Intl.NumberFormat('en-US', {maximumFractionDigits: Number.isInteger(v) ? 0 : 2}).format(v);
}

/** "Oct 13 – 19, 2026" for [from, to) in the zone; "All time" without bounds. */
export function rangeText(from: string | Date | null, to: string | Date | null, tz: string, fallback = 'All time') {
  if (!from && !to) return fallback;
  const f = (d: Date, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', {timeZone: tz, ...o}).format(d);
  const a = from ? new Date(from) : null;
  const b = to ? new Date(new Date(to).getTime() - 1) : null; // `to` is exclusive
  const full: Intl.DateTimeFormatOptions = {month: 'short', day: 'numeric', year: 'numeric'};
  if (!a) return `Until ${f(b!, full)}`;
  if (!b) return `Since ${f(a, full)}`;
  if (f(a, full) === f(b, full)) return f(a, full);
  const sameYear = f(a, {year: 'numeric'}) === f(b, {year: 'numeric'});
  return `${f(a, sameYear ? {month: 'short', day: 'numeric'} : full)} – ${f(b, full)}`;
}

/** "▲ 12% vs Oct 6 – 12, 2026". Neutral ink: whether up is good depends on the report. */
function change(kpi: EmailSection['kpi'], format: ReportResult['format'], currency: string, tz: string) {
  const prev = kpi.previous;
  if (!prev) return '';
  const cur = kpi.total.value;
  const period = rangeText(prev.from, prev.to, tz);
  let head: string;
  if (prev.value === cur) head = 'No change';
  else if (prev.value === 0) head = '▲ New';
  else {
    const pct = ((cur - prev.value) / Math.abs(prev.value)) * 100;
    const shown = Math.abs(pct) >= 10 ? Math.round(Math.abs(pct)) : Math.round(Math.abs(pct) * 10) / 10;
    head = `${pct > 0 ? '▲' : '▼'} ${shown}%`;
  }
  return (
    `<p style="margin:6px 0 0;font-family:${FONT};font-size:13px;line-height:1.5;color:${SECONDARY}">` +
    `<strong style="color:${BODY}">${head}</strong> vs ${escapeHtml(period)} (${escapeHtml(formatValue(prev.value, format, currency))})</p>`
  );
}

const swatch = (color: string) =>
  `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${color};vertical-align:middle;margin-right:6px"></span>`;

const colorOf = (key: string, i: number) => (key === '__other__' ? OTHER : SERIES[i % SERIES.length]!);

/** One horizontal bar (or a stack of segments) as nested tables, `pct` of the cell wide. */
function bar(row: ReportRow, series: ReportResult['series'], max: number) {
  const parts = series.map((s, i) => ({value: Math.max(0, row.values[s.key] ?? 0), color: colorOf(s.key, i)})).filter((p) => p.value > 0);
  const sum = parts.reduce((t, p) => t + p.value, 0);
  if (!sum || max <= 0) return '&nbsp;';
  const pct = Math.max(1, Math.min(100, Math.round((sum / max) * 1000) / 10));
  const cells = parts
    .map((p, i) => {
      const last = i === parts.length - 1;
      const w = Math.round((p.value / sum) * 1000) / 10;
      return `<td width="${w}%" style="width:${w}%;height:10px;line-height:10px;font-size:0;background:${p.color};${last ? 'border-radius:0 4px 4px 0' : 'border-right:2px solid #ffffff'}">&nbsp;</td>`;
    })
    .join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${pct}%" style="width:${pct}%;border-collapse:separate"><tr>${cells}</tr></table>`;
}

function rowsTable(section: EmailSection, currency: string, link: string) {
  const r = section.result;
  if (!r.groupLabel || !r.rows.length) return '';
  // Time series keep their order and show the latest buckets; other groups are already sorted.
  const all = r.rows;
  const shown = r.bucket ? all.slice(-EMAIL_TOP_ROWS) : all.slice(0, EMAIL_TOP_ROWS);
  const hidden = all.length - shown.length;
  const max = Math.max(0, ...shown.map((row) => r.series.reduce((t, s) => t + Math.max(0, row.values[s.key] ?? 0), 0)));
  const multi = r.series.length > 1;
  const legend = multi
    ? `<p style="margin:14px 0 0;font-family:${FONT};font-size:12px;line-height:1.9;color:${BODY}">` +
      r.series.map((s, i) => `<span style="white-space:nowrap;margin-right:14px">${swatch(colorOf(s.key, i))}${escapeHtml(s.label)}</span>`).join(' ') +
      `</p>`
    : '';
  const th = (label: string, alignTo: 'left' | 'right') =>
    `<th align="${alignTo}" style="padding:8px 0;border-bottom:1px solid ${LINE};font-family:${FONT};font-size:12px;font-weight:600;color:${MUTED};text-align:${alignTo}">${escapeHtml(label)}</th>`;
  const body = shown
    .map(
      (row) =>
        `<tr>` +
        `<td style="padding:7px 12px 7px 0;border-bottom:1px solid #f1f5f9;font-family:${FONT};font-size:13px;line-height:1.4;color:${BODY};width:36%">${escapeHtml(row.label)}</td>` +
        `<td style="padding:7px 0;border-bottom:1px solid #f1f5f9;width:44%">${bar(row, r.series, max)}</td>` +
        `<td align="right" style="padding:7px 0 7px 12px;border-bottom:1px solid #f1f5f9;font-family:${FONT};font-size:13px;line-height:1.4;color:${INK};font-weight:600;white-space:nowrap;font-variant-numeric:tabular-nums;text-align:right">${escapeHtml(formatValue(row.total, r.format, currency))}</td>` +
        `</tr>`,
    )
    .join('');
  const more = hidden
    ? `<p style="margin:10px 0 0;font-family:${FONT};font-size:13px;line-height:1.5;color:${MUTED}">and ${hidden} more ${r.bucket ? `earlier ${hidden === 1 ? 'row' : 'rows'}` : hidden === 1 ? 'row' : 'rows'} in the CSV file · <a href="${escapeHtml(link)}" style="color:${MUTED};text-decoration:underline">see them all</a></p>`
    : '';
  return (
    legend +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:12px;border-collapse:collapse">` +
    `<tr>${th(r.groupLabel, 'left')}<th style="padding:8px 0;border-bottom:1px solid ${LINE}"></th>${th(multi ? 'Total' : r.measureLabel, 'right')}</tr>${body}</table>` +
    more
  );
}

/** One report's block in the email. */
function sectionHtml(section: EmailSection, opts: {currency: string; tz: string; link: string; heading: boolean; divider: boolean}) {
  const r = section.result;
  const range = rangeText(r.range.from, r.range.to, opts.tz, r.range.label);
  const tileLabel = r.additive ? `Total ${r.measureLabel.charAt(0).toLowerCase()}${r.measureLabel.slice(1)}` : r.measureLabel;
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px"><tr><td${opts.divider ? ` style="padding-top:24px;border-top:1px solid ${LINE}"` : ''}>` +
    (opts.heading ? `<h2 style="margin:0 0 2px;font-family:${FONT};font-size:17px;line-height:1.35;font-weight:800;color:${INK}">${escapeHtml(section.name)}</h2>` : '') +
    `<p style="margin:0 0 12px;font-family:${FONT};font-size:13px;line-height:1.5;color:${MUTED}">${escapeHtml(r.measureLabel)}${r.groupLabel ? ` by ${escapeHtml(r.groupLabel.toLowerCase())}` : ''} · ${escapeHtml(range)}</p>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;background:#f8fafc;border:1px solid ${LINE};border-radius:10px"><tr><td style="padding:14px 16px">` +
    `<p style="margin:0;font-family:${FONT};font-size:12px;line-height:1.4;color:${MUTED}">${escapeHtml(tileLabel)}</p>` +
    `<p style="margin:2px 0 0;font-family:${FONT};font-size:28px;line-height:1.2;font-weight:700;color:${INK}">${escapeHtml(formatValue(section.kpi.total.value, r.format, opts.currency))}</p>` +
    change(section.kpi, r.format, opts.currency, opts.tz) +
    `</td></tr></table>` +
    rowsTable(section, opts.currency, opts.link) +
    `</td></tr></table>`
  );
}

export type ReportEmailInput = {
  title: string;
  rangeLabel: string;
  note?: string | null;
  sections: EmailSection[];
  /** A dashboard: each report gets its own heading. */
  dashboard: boolean;
  /** Reports the creator can no longer see, or that failed to run. */
  skipped: string[];
  link: string;
  brandName: string;
  accent: string;
  currency: string;
  tz: string;
  attached: boolean;
};

/** The content that goes inside the branded layout (wrapEmail). */
export function reportEmailContent(i: ReportEmailInput) {
  const note = i.note?.trim()
    ? `<p style="margin:0 0 20px;font-family:${FONT};font-size:15px;line-height:1.6;color:${BODY}">${escapeHtml(i.note.trim()).replace(/\n/g, '<br>')}</p>`
    : '';
  const skipped = i.skipped.length
    ? `<p style="margin:0 0 20px;font-family:${FONT};font-size:13px;line-height:1.5;color:${MUTED}">Not included: ${i.skipped.map(escapeHtml).join(', ')}.</p>`
    : '';
  return (
    `<h1 style="margin:0 0 4px;font-family:${FONT};font-size:24px;line-height:1.25;font-weight:800;letter-spacing:-0.01em;color:${INK}">${escapeHtml(i.title)}</h1>` +
    `<p style="margin:0 0 20px;font-family:${FONT};font-size:14px;line-height:1.5;color:${MUTED}">${escapeHtml(i.rangeLabel)}</p>` +
    note +
    (i.sections.length ? i.sections.map((s, n) => sectionHtml(s, {currency: i.currency, tz: i.tz, link: i.link, heading: i.dashboard, divider: n > 0})).join('') : `<p style="margin:0 0 20px;color:${MUTED}">No reports to show.</p>`) +
    skipped +
    buttonHtml(escapeHtml(`Open in ${i.brandName}`), i.link, {accent: i.accent}) +
    `<p style="margin:0;font-family:${FONT};font-size:12px;line-height:1.6;color:${MUTED}">${i.attached ? 'The full data is attached as CSV. ' : ''}Numbers show what the person who set up this email can see.</p>`
  );
}
