// Branded type: only the sanitizer (and a few structural constants) may produce SanitizedText,
// so passing an unsanitized page/task string into a payload is a type error.

declare const brand: unique symbol;
export type SanitizedText = string & { readonly [brand]: 'SanitizedText' };

/** Used only by the sanitizer module. Do not import elsewhere. */
export function __brandSanitized(s: string): SanitizedText {
  return s as SanitizedText;
}

/** The fail-closed mask for a whole field. */
export const REDACTED: SanitizedText = '[REDACTED_TEXT]' as SanitizedText;

/**
 * Structural strings written by VEIL itself (e.g. empty string). Only accepts values matching
 * a strict allowlist pattern, so it cannot be used to launder page text.
 */
export function structural(s: '' | `[${string}]`): SanitizedText {
  if (s !== '' && !/^\[[A-Z]+(?:_[A-Z0-9]+)*\]$/.test(s)) throw new Error('structural(): not a structural token');
  return s as SanitizedText;
}
