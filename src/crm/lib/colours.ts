/**
 * Names for the colours the app's pickers offer (AUDIT-2 L-17): a screen reader says "Teal", not
 * "#0d9488". A colour not listed here (a custom one) is "Custom colour".
 */
const NAMES: Record<string, string> = {
  '#2563eb': 'Blue',
  '#3b82f6': 'Blue',
  '#0d9488': 'Teal',
  '#7c3aed': 'Violet',
  '#db2777': 'Pink',
  '#ea580c': 'Orange',
  '#16a34a': 'Green',
  '#0891b2': 'Cyan',
  '#475569': 'Slate',
  '#4f46e5': 'Indigo',
  '#e11d48': 'Rose',
  '#0f172a': 'Navy',
  '#94a3b8': 'Grey',
  '#38bdf8': 'Sky',
  '#0ea5e9': 'Light blue',
  '#f59e0b': 'Amber',
  '#d97706': 'Amber',
  '#64748b': 'Grey',
};

export const colourName = (hex: string | null | undefined): string => (hex ? (NAMES[hex.toLowerCase()] ?? 'Custom colour') : 'Brand colours');
