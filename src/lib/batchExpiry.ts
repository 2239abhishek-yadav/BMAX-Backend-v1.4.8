/** Canonical batch expiry: month + year. Legacy expiryDate is read only for migration/backward compatibility. */
export function normalizeExpiryMonth(value: unknown): number | null {
  const n = Number(String(value ?? '').replace(/\D/g, ''));
  if (!Number.isInteger(n) || n < 1 || n > 12) return null;
  return n;
}

export function normalizeExpiryYear(value: unknown): number | null {
  const raw = String(value ?? '').replace(/\D/g, '');
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isInteger(n)) return null;
  if (raw.length <= 2) return 2000 + n;
  if (raw.length === 4 && n >= 2000 && n <= 2099) return n;
  return null;
}

export function expiryFromLegacyDate(value: unknown): { month: number | null; year: number | null } {
  const s = String(value ?? '').trim();
  const m = /^(\d{4})-(\d{1,2})-(?:\d{1,2})$/.exec(s);
  if (!m) return { month: null, year: null };
  return { month: normalizeExpiryMonth(m[2]), year: normalizeExpiryYear(m[1]) };
}

/** Accept the user-facing MM/YYYY format (and safe legacy YYYY-MM[-DD] values) and return canonical month/year. */
export function parseExpiryInput(value: unknown): { month: number | null; year: number | null } {
  const s = String(value ?? '').trim();
  if (!s) return { month: null, year: null };
  let m = /^(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (m) return { month: normalizeExpiryMonth(m[1]), year: normalizeExpiryYear(m[2]) };
  m = /^(\d{4})-(\d{1,2})(?:-(?:\d{1,2}))?$/.exec(s);
  if (m) return { month: normalizeExpiryMonth(m[2]), year: normalizeExpiryYear(m[1]) };
  return { month: null, year: null };
}

export function expiryDisplay(month: unknown, year: unknown): string | null {
  const m = normalizeExpiryMonth(month);
  const y = normalizeExpiryYear(year);
  return m && y ? `${String(m).padStart(2, '0')}/${y}` : null;
}

export function expiryKey(month: unknown, year: unknown): string | null {
  const m = normalizeExpiryMonth(month);
  const y = normalizeExpiryYear(year);
  return m && y ? `${y}-${String(m).padStart(2, '0')}` : null;
}

export function expiryLegacyDate(month: unknown, year: unknown): string | null {
  const key = expiryKey(month, year);
  return key ? `${key}-01` : null;
}



