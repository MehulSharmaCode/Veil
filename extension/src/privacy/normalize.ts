// Text normalization applied before detection and before anything is sent.

const ZERO_WIDTH = /[​-‏‪-‮⁠-⁤﻿­]/g;

// Zero code points of decimal-digit blocks that NFKC does not fold to ASCII.
const DIGIT_ZEROS = [0x0660, 0x06f0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0xff10];

function foldDigits(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const zero = DIGIT_ZEROS.find((z) => cp >= z && cp <= z + 9);
    out += zero === undefined ? ch : String(cp - zero);
  }
  return out;
}

/** NFKC, strip zero-width/bidi controls, fold non-ASCII digits, collapse whitespace. */
export function normalizeText(s: string): string {
  return foldDigits(s.normalize('NFKC').replace(ZERO_WIDTH, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

export function digitsOnly(s: string): string {
  return s.replace(/\D+/g, '');
}

/** Normalized comparison key for a detected value of a given category. */
export function normalizeValue(category: string, value: string): string {
  const v = normalizeText(value);
  switch (category) {
    case 'EMAIL':
      return v.toLowerCase();
    case 'PHONE': {
      const d = digitsOnly(v);
      // Indian numbers: +91 / 0 prefixes refer to the same 10-digit mobile.
      if (d.length === 12 && d.startsWith('91')) return d.slice(2);
      if (d.length === 11 && d.startsWith('0')) return d.slice(1);
      return d;
    }
    case 'AADHAAR':
    case 'CARD':
      return digitsOnly(v);
    case 'PAN':
      return v.toUpperCase().replace(/\s+/g, '');
    default:
      return v.toLowerCase().replace(/[\s,.;:]+$/g, '').replace(/\s*,\s*/g, ', ');
  }
}
