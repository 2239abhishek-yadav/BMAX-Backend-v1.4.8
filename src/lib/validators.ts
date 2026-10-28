// Shared validation helpers — GSTIN and Indian mobile numbers.
// Used by both parties.routes.ts and firms.routes.ts so validation can never
// be bypassed by hitting the API directly (frontend validation alone is not enough).

// Standard 15-character GSTIN pattern:
// 2 digits state code, 10-char PAN, 1 entity code digit, 'Z' by default, 1 checksum alphanumeric.
const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

export interface ValidationResult {
  valid: boolean;
  value?: string;
  error?: string;
}

/**
 * Validates + normalizes a GSTIN: trims whitespace, uppercases, then checks
 * exact 15-char length and the standard alphanumeric GSTIN format.
 * Returns { valid: true, value } with the normalized value, or { valid: false, error }.
 * Empty/undefined GSTIN is treated as valid (GSTIN is optional on most forms) —
 * callers that require it should check presence separately.
 */
export function validateGSTIN(raw: unknown): ValidationResult {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { valid: true, value: '' };
  }
  const value = String(raw).trim().toUpperCase();
  if (value.length !== 15) {
    return { valid: false, error: `GSTIN must be exactly 15 characters (got ${value.length})` };
  }
  if (!GSTIN_REGEX.test(value)) {
    return { valid: false, error: 'GSTIN format is invalid. Expected format: 22AAAAA0000A1Z5' };
  }
  return { valid: true, value };
}

/**
 * Validates + normalizes an Indian mobile number.
 * Accepts exactly 10 numeric digits. Non-numeric characters are removed before
 * validation, and the stored/returned normalized form is the 10-digit number.
 * Empty/undefined phone is treated as valid because phone is optional on these forms.
 */
export function validateMobile(raw: unknown): ValidationResult {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { valid: true, value: '' };
  }
  const input = String(raw).trim();
  const digits = input.replace(/\D/g, '');
  let national = digits;
  let countryCode = '';

  // B-MAX stores international numbers as +<country code><10-digit national number>.
  // The country code is excluded from the 10-digit limit. For legacy Indian data,
  // a plain 10-digit number remains valid and is normalized to +91.
  if (input.startsWith('+') || digits.length > 10) {
    if (digits.length < 11 || digits.length > 13) {
      return { valid: false, error: 'Phone number must contain exactly 10 digits after the country code' };
    }
    countryCode = digits.slice(0, digits.length - 10);
    national = digits.slice(-10);
    if (!/^[1-9][0-9]{0,2}$/.test(countryCode)) {
      return { valid: false, error: 'Invalid country calling code' };
    }
  } else {
    countryCode = '91';
  }

  if (!/^\d{10}$/.test(national)) {
    return { valid: false, error: 'Phone number must contain exactly 10 digits after the country code' };
  }
  return { valid: true, value: `+${countryCode}${national}` };
}

