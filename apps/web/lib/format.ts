// Display formatting only. Amounts arrive as canonical decimal strings from the server evaluator.

export function money(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const negative = value.startsWith('-');
  const [integer = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  // Cents are shown when present; sub-cent digits (never produced by fee-free fixtures) are truncated for display.
  const cents = fraction ? `.${fraction.padEnd(2, '0').slice(0, 2)}` : '';
  return `${negative ? '−' : ''}$${grouped}${cents}`;
}

export function shares(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
