// Infer the value category of an editable field from its type, autocomplete token and
// label/name/id tokens. Pure and site-agnostic. Order matters: credentials win.

import type { ValueCategory } from './ir';

export interface FieldSignals {
  tag: string;
  input_type?: string;
  autocomplete?: string;
  /** Free text hints: accessible name, placeholder, name attr, id attr, aria-label. */
  hints: string[];
}

/** Split "altEmail_address-2" → ["alt","email","address","2"]. */
export function tokenize(s: string): string[] {
  return s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

type Rule = [ValueCategory, RegExp];

// Applied to the space-joined token string of all hints, e.g. "alternate email alt email".
const TOKEN_RULES: Rule[] = [
  ['password', /\b(password|passwd|pwd|passcode|pin number|mpin|upi pin)\b/],
  ['otp', /\b(otp|one time (password|code)|verification code|auth(entication)? code|2fa|totp)\b/],
  ['card_cvc', /\b(cvv|cvc|cvv2|csc|security code|card verification)\b/],
  ['card_number', /\b(card number|card no|credit card|debit card|cc number|ccnum|cardnumber|card)\b/],
  ['aadhaar', /\b(aadhaar|aadhar|adhaar|uidai|uid)\b/],
  ['pan', /\b(pan|pan number|pan no|pan card|permanent account number)\b/],
  ['email', /\b(email|e mail|mail)\b/],
  ['tel', /\b(phone|mobile|mob|tel|telephone|contact number|contact no|whatsapp|cell)\b/],
  ['dob', /\b(dob|date of birth|birth ?date|birthday)\b/],
  ['postal_code', /\b(pin ?code|pincode|zip|zip code|postal ?code|postcode)\b/],
  ['address', /\b(address|addr|street|locality|landmark|city|town|district|state|area|house|flat|building)\b/],
  ['person_name', /\b(name|full name|first name|last name|surname|given name|family name|middle name|fname|lname)\b/],
];

const AUTOCOMPLETE: Record<string, ValueCategory> = {
  'current-password': 'password',
  'new-password': 'password',
  'one-time-code': 'otp',
  'cc-csc': 'card_cvc',
  'cc-number': 'card_number',
  email: 'email',
  tel: 'tel',
  'tel-national': 'tel',
  'tel-local': 'tel',
  name: 'person_name',
  'given-name': 'person_name',
  'family-name': 'person_name',
  'additional-name': 'person_name',
  'street-address': 'address',
  'address-line1': 'address',
  'address-line2': 'address',
  'address-line3': 'address',
  'address-level1': 'address',
  'address-level2': 'address',
  'address-level3': 'address',
  'postal-code': 'postal_code',
  bday: 'dob',
};

/** Hint words that must not be read as "name" (e.g. "username", "company name"). */
const NOT_PERSON = /\b(user ?name|login|company|organi[sz]ation|business|file|display|nick ?name|screen|project|school|college|institute|bank|branch|account name)\b/;

export function classifyField(sig: FieldSignals): ValueCategory {
  const type = (sig.input_type ?? '').toLowerCase();
  if (type === 'password') return 'password';
  if (type === 'email') return 'email';
  if (type === 'tel') return 'tel';

  const acTokens = (sig.autocomplete ?? '').toLowerCase().split(/\s+/);
  for (const t of acTokens) {
    const c = AUTOCOMPLETE[t] ?? (t.startsWith('cc-') ? 'card_number' : t.startsWith('tel') ? 'tel' : t.startsWith('bday') ? 'dob' : undefined);
    if (c) return c;
  }

  const joined = sig.hints.flatMap(tokenize).join(' ');
  for (const [cat, re] of TOKEN_RULES) {
    if (!re.test(joined)) continue;
    if (cat === 'person_name' && NOT_PERSON.test(joined)) continue;
    return cat;
  }
  if (['number', 'date', 'datetime-local', 'month', 'week', 'time', 'range', 'color', 'url', 'search'].includes(type)) return 'other';
  return 'free_text';
}

/** Credential-like categories the agent never types (T1). */
export const CREDENTIAL_CATEGORIES: ReadonlySet<ValueCategory> = new Set(['password', 'otp', 'card_cvc', 'card_number']);
