/** Small presentation helpers. No data access here. */

/** "9 September 2026". Locale-fixed so the server and every visitor agree. */
export function formatDate(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}




/** "$19.99" from minor units (1999, "USD"); a currency without cents (JPY) is not divided. */
export function formatMoney(amountCents: number, currency: string, locale = 'en-US'): string {
  try {
    const format = new Intl.NumberFormat(locale, {style: 'currency', currency});
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(amountCents / 10 ** digits);
  } catch {
    return `${(amountCents / 100).toFixed(2)} ${currency}`;
  }
}

/** Initials for the logo-less brand mark and the avatar-less author chip. */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(word => word[0]?.toUpperCase() ?? '')
    .join('');
}
