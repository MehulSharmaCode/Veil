// PII detectors. Pure functions over *normalized* text. Recall-biased by design.
//
// Known limitations (documented, v0.1): no NER; names are only found via context cues
// ("my name is", "signed in as", "Name:", greetings); addresses only via cues ("my address",
// "address:", "residing at") or a 6-digit PIN next to address words (then grown to the surrounding
// address tokens, so a cue-less address is masked whole); numbers are classified by
// length/prefix/checksum, so an unusual phone format may be masked as [REDACTED_TEXT] instead
// of [PHONE_n]; obfuscated emails ("name at domain dot com") are not detected.

import { isAadhaar, isCard, isPan } from './checksums';
import { digitsOnly } from './normalize';

export const PII_CATEGORIES = ['EMAIL', 'PHONE', 'ADDRESS', 'PERSON', 'PAN', 'AADHAAR', 'CARD'] as const;
export type PiiCategory = (typeof PII_CATEGORIES)[number];
/** REDACTED = masked without a vault entry (unsure / unclassifiable). */
export type DetectionCategory = PiiCategory | 'REDACTED';

export interface Span {
  start: number;
  end: number;
  category: DetectionCategory;
  detector: string;
}

/** Placeholder tokens produced by VEIL; detectors must never treat them as PII. */
export const PLACEHOLDER_RE = /\[(?:EMAIL|PHONE|ADDRESS|PERSON|PAN|AADHAAR|CARD)_\d+\]|\[REDACTED_TEXT\]/g;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const PAN_RE = /(?<![A-Za-z0-9])[A-Za-z]{5}\d{4}[A-Za-z](?![A-Za-z0-9])/g;
// Digit runs with common separators, optional leading '+'. Not preceded/followed by letters or digits.
const NUMBER_RUN_RE = /(?<![A-Za-z0-9_])\+?\(?\d(?:[ \-.()/]{0,2}\d)+\)?(?![A-Za-z0-9_])/g;

export function detectEmails(t: string): Span[] {
  return [...t.matchAll(EMAIL_RE)].map((m) => ({
    start: m.index!,
    end: m.index! + m[0].replace(/[.-]+$/, '').length,
    category: 'EMAIL' as const,
    detector: 'regex:email',
  }));
}

export function detectPan(t: string): Span[] {
  return [...t.matchAll(PAN_RE)]
    .filter((m) => isPan(m[0]))
    .map((m) => ({ start: m.index!, end: m.index! + m[0].length, category: 'PAN' as const, detector: 'regex:pan' }));
}

/** Classify a digit string. Returns null when it is not (confidently) PII. */
export function classifyDigits(digits: string, hasPlus: boolean): DetectionCategory | null {
  const n = digits.length;
  if (hasPlus && digits.startsWith('91') && /^91[6-9]\d{9}$/.test(digits)) return 'PHONE';
  if (isCard(digits)) return 'CARD';
  if (isAadhaar(digits)) return 'AADHAAR';
  if (/^(?:91|0)?[6-9]\d{9}$/.test(digits)) return 'PHONE'; // Indian mobile
  if (/^0\d{9,10}$/.test(digits)) return 'PHONE'; // Indian landline with STD code
  if (hasPlus && n >= 8 && n <= 15) return 'PHONE'; // generic international
  if (n >= 9) return 'REDACTED'; // unknown long number: fail closed
  return null;
}

interface Piece {
  start: number;
  end: number;
  digits: string;
  plus: boolean;
}

export function detectNumbers(t: string): Span[] {
  const out: Span[] = [];
  for (const m of t.matchAll(NUMBER_RUN_RE)) {
    const raw = m[0];
    const base = m.index!;
    const whole = classifyDigits(digitsOnly(raw), raw.startsWith('+'));
    if (whole && whole !== 'REDACTED') {
      out.push({ start: base, end: base + raw.length, category: whole, detector: `number:${whole.toLowerCase()}` });
      continue;
    }
    // The run may join unrelated numbers separated by spaces ("Road 411005 9876543210").
    // Try the longest classifiable combination of space-separated groups from each position.
    const pieces: Piece[] = [];
    for (const g of raw.matchAll(/\S+/g)) {
      pieces.push({ start: base + g.index!, end: base + g.index! + g[0].length, digits: digitsOnly(g[0]), plus: g[0].startsWith('+') });
    }
    if (pieces.length < 2) {
      if (whole) out.push({ start: base, end: base + raw.length, category: whole, detector: 'number:long' });
      continue;
    }
    let i = 0;
    while (i < pieces.length) {
      let matched = false;
      for (let j = pieces.length - 1; j > i; j--) {
        const digits = pieces.slice(i, j + 1).map((p) => p.digits).join('');
        const cat = classifyDigits(digits, pieces[i]!.plus);
        if (cat && cat !== 'REDACTED') {
          out.push({ start: pieces[i]!.start, end: pieces[j]!.end, category: cat, detector: `number:${cat.toLowerCase()}` });
          i = j + 1;
          matched = true;
          break;
        }
      }
      if (!matched) {
        const cat = classifyDigits(pieces[i]!.digits, pieces[i]!.plus);
        if (cat) out.push({ start: pieces[i]!.start, end: pieces[i]!.end, category: cat, detector: `number:${cat.toLowerCase()}` });
        i++;
      }
    }
    // Fail closed: if the whole run has ≥9 digits and nothing classified, mask it.
    if (!out.some((s) => s.start >= base && s.end <= base + raw.length) && digitsOnly(raw).length >= 9) {
      out.push({ start: base, end: base + raw.length, category: 'REDACTED', detector: 'number:long' });
    }
  }
  return out;
}

// ---- context cues ---------------------------------------------------------------------------

const ABBREVIATIONS = new Set(['no', 'st', 'rd', 'dr', 'opp', 'nr', 'near', 'flat', 'bldg', 'apt', 'sec', 'ph', 'mr', 'mrs', 'ms', 'smt', 'shri']);

/**
 * End of an address/name value: sentence end (". X" where the token before the dot is not an
 * abbreviation or a single letter), ";", "!", "?", newline, or a conjunction that starts a new clause.
 */
export function valueEnd(t: string, from: number): number {
  const clause = /\s+(?:and|but|then|also|plus|&)\s+(?:my|the|please|do|don't|dont|fill|also|then|set|enter|type|click|put|leave|i)\b/gi;
  clause.lastIndex = from;
  const c = clause.exec(t);
  let end = c ? c.index : t.length;
  for (let i = from; i < end; i++) {
    const ch = t[i]!;
    if (ch === ';' || ch === '!' || ch === '?' || ch === '\n') return i;
    if (ch === '.' && (i + 1 >= t.length || /\s/.test(t[i + 1]!))) {
      const before = /([A-Za-z0-9]+)$/.exec(t.slice(from, i));
      const tok = before?.[1] ?? '';
      const isAbbrev = (/^[A-Za-z]$/.test(tok) || ABBREVIATIONS.has(tok.toLowerCase())) && i + 1 < t.length;
      const nextIsDigit = /^\s*\d/.test(t.slice(i + 1));
      if (!isAbbrev && !nextIsDigit) return i;
    }
  }
  return end;
}

function trimSpan(t: string, start: number, end: number): [number, number] {
  while (start < end && /[\s:,(\-"']/.test(t[start]!)) start++;
  while (end > start && /[\s,:)\-"']/.test(t[end - 1]!)) end--;
  return [start, end];
}

function startsWithPlaceholder(t: string, at: number): boolean {
  return /^\s*:?\s*\[[A-Z_0-9]+\]/.test(t.slice(at));
}

const ADDRESS_CUE_RE = /\b(?:my\s+(?:home\s+|postal\s+|current\s+|permanent\s+)?address(?:\s+is)?|address\s*(?:is|:)|residing\s+at|(?:i\s+)?live\s+at|lives\s+at)\s*:?\s*/gi;

export function detectAddressCues(t: string): Span[] {
  const out: Span[] = [];
  for (const m of t.matchAll(ADDRESS_CUE_RE)) {
    const from = m.index! + m[0].length;
    if (startsWithPlaceholder(t, from)) continue;
    const [s, e] = trimSpan(t, from, valueEnd(t, from));
    if (e - s >= 3) out.push({ start: s, end: e, category: 'ADDRESS', detector: 'cue:address' });
  }
  return out;
}

const PIN_WORDS = /\b(?:pin|pincode|pin\s*code|postal|zip|address|road|rd|street|st|lane|marg|nagar|colony|sector|block|flat|house|floor|district|dist|city|state|village|taluka|tehsil|near|opp|apartment|society)\b/i;

export function detectPinCodes(t: string): Span[] {
  const out: Span[] = [];
  for (const m of t.matchAll(/(?<![A-Za-z0-9])[1-9]\d{2}\s?\d{3}(?![A-Za-z0-9])/g)) {
    const window = t.slice(Math.max(0, m.index! - 48), m.index!);
    if (!PIN_WORDS.test(window)) continue;
    const [start, end] = addressExtent(t, m.index!, m.index! + m[0].length);
    out.push({ start, end, category: 'ADDRESS', detector: 'cue:pincode' });
  }
  return out;
}

/**
 * Words that end an address when growing it outward from a PIN code: instruction/function words and
 * field labels. Everything else between boundaries is treated as part of the address (fail closed:
 * a cue-less address such as an ask_user answer "12 X Road, Y, City 411005" is masked whole, not
 * just its PIN).
 */
const ADDRESS_STOP = new Set([
  'and', 'but', 'then', 'also', 'plus', 'or', 'my', 'the', 'please', 'do', 'dont', "don't", 'not', 'fill', 'enter',
  'type', 'put', 'set', 'use', 'with', 'to', 'into', 'for', 'is', 'are', 'it', 'this', 'that', 'of', 'me', 'your',
  'our', 'here', 'as', 'at', 'from', 'submit', 'save', 'click', 'address', 'email', 'e-mail', 'phone', 'mobile',
  'tel', 'fax', 'name', 'pan', 'aadhaar', 'dob', 'id',
]);

/** A token that cannot be part of an address, or ends it (label colon, sentence end, other PII). */
function addressStops(tok: string): boolean {
  const core = tok.replace(/^[("'[]+/, '').replace(/[,)"'\]]+$/, '');
  if (!core) return false; // punctuation-only token (e.g. "-") stays inside the address
  if (/^[;!?:]/.test(core) || core.includes('@') || /^\[[A-Z_0-9]+\]$/.test(core)) return true;
  if (digitsOnly(core).length >= 7) return true; // phone / id-like numbers are detected separately
  return ADDRESS_STOP.has(core.replace(/[.:;!?]+$/, '').toLowerCase());
}

/** True if the token ends a sentence/clause: ";", "!", "?", ":" or "." after a non-abbreviation. */
function endsClause(tok: string): boolean {
  const core = tok.replace(/[,)"'\]]+$/, '');
  if (/[;!?:]$/.test(core)) return true;
  if (!core.endsWith('.')) return false;
  const word = /([A-Za-z0-9]+)\.$/.exec(core)?.[1] ?? '';
  return !(/^[A-Za-z]$/.test(word) || ABBREVIATIONS.has(word.toLowerCase()));
}

/** Grow an address span from its PIN code to the surrounding address tokens on the same line/clause. */
function addressExtent(t: string, pinStart: number, pinEnd: number): [number, number] {
  let start = pinStart;
  const before = [...t.slice(0, pinStart).matchAll(/\S+/g)];
  for (let i = before.length - 1; i >= 0; i--) {
    const m = before[i]!;
    const tokEnd = m.index! + m[0].length;
    if (t.slice(tokEnd, start).includes('\n') || endsClause(m[0]) || addressStops(m[0])) break;
    start = m.index!;
  }
  let end = pinEnd;
  const re = /\S+/g;
  re.lastIndex = pinEnd;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    const tok = m[0];
    if (t.slice(end, m.index).includes('\n') || /^[.;!?:]/.test(tok) || addressStops(tok)) break;
    if (endsClause(tok)) {
      end = m.index + tok.replace(/[,)"'\]]+$/, '').length - 1; // drop the terminating punctuation
      break;
    }
    end = m.index + tok.length;
  }
  return trimSpan(t, start, end);
}

const NAME_TOKEN = /^[A-Za-z][A-Za-z'.-]*$/;
const NAME_STOP = new Set([
  'and', 'but', 'then', 'also', 'my', 'the', 'please', 'do', 'from', 'with', 'to', 'at', 'in', 'on', 'for', 'is', 'of',
  // label words that often follow a name in page text ("Name: A B Email: …")
  'email', 'e-mail', 'phone', 'mobile', 'address', 'dob', 'pan', 'aadhaar', 'date', 'city', 'state', 'id', 'application',
]);

/** Take up to 4 name-like tokens after `from`. Capitalized-only unless `anyCase`. */
function takeName(t: string, from: number, anyCase: boolean): [number, number] | null {
  const re = /\S+/g;
  re.lastIndex = from;
  let start = -1;
  let end = -1;
  let count = 0;
  for (let m = re.exec(t); m && count < 4; m = re.exec(t)) {
    if (t.slice(end === -1 ? from : end, m.index).trim() !== '') break; // only whitespace between tokens
    const tok = m[0].replace(/[,;:.)!?(]+$/, '');
    if (!tok || !NAME_TOKEN.test(tok) || NAME_STOP.has(tok.toLowerCase())) break;
    if (!anyCase && !/^[A-Z]/.test(tok)) break;
    if (start === -1) start = m.index;
    end = m.index + tok.length;
    count++;
    if (tok.length !== m[0].length) break; // trailing punctuation ends the name
  }
  return start === -1 ? null : [start, end];
}

const NAME_CUES: { re: RegExp; anyCase: boolean }[] = [
  { re: /\bmy\s+(?:full\s+)?name\s+is\s+/gi, anyCase: true },
  { re: /\b(?:signed|logged)\s+in\s+as\s+/gi, anyCase: false },
  { re: /\b(?:full\s+name|name|applicant|account\s+holder|holder\s+name)\s*:\s*/gi, anyCase: false },
  { re: /\b(?:welcome(?:\s+back)?|hello|hi|dear)\s*,?\s+/gi, anyCase: false },
];

export function detectNameCues(t: string): Span[] {
  const out: Span[] = [];
  for (const cue of NAME_CUES) {
    for (const m of t.matchAll(cue.re)) {
      const from = m.index! + m[0].length;
      if (startsWithPlaceholder(t, from)) continue;
      const r = takeName(t, from, cue.anyCase);
      if (r) out.push({ start: r[0], end: r[1], category: 'PERSON', detector: 'cue:name' });
    }
  }
  return out;
}

const PHONE_CUE_RE = /\b(?:phone|mobile|mob|contact|tel|telephone|whatsapp|cell)(?:\s+(?:number|no\.?|num))?(?:\s+is)?\s*:?\s*(\+?\(?\d[\d \-()]{4,}\d)/gi;

export function detectPhoneCues(t: string): Span[] {
  const out: Span[] = [];
  for (const m of t.matchAll(PHONE_CUE_RE)) {
    const num = m[1]!;
    const start = m.index! + m[0].length - num.length;
    if (digitsOnly(num).length >= 6) out.push({ start, end: start + num.length, category: 'PHONE', detector: 'cue:phone' });
  }
  return out;
}

const DOB_CUE_RE = /\b(?:dob|d\.o\.b\.?|date\s+of\s+birth|born\s+on|birth\s*date)\s*:?\s*(\d{1,4}[\/\-. ]\d{1,2}[\/\-. ]\d{1,4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4})/gi;

export function detectDobCues(t: string): Span[] {
  return [...t.matchAll(DOB_CUE_RE)].map((m) => {
    const start = m.index! + m[0].length - m[1]!.length;
    return { start, end: start + m[1]!.length, category: 'REDACTED' as const, detector: 'cue:dob' };
  });
}

/** All detectors, unmerged. */
export function detectAll(t: string): Span[] {
  const spans = [
    ...detectEmails(t),
    ...detectPan(t),
    ...detectNumbers(t),
    ...detectAddressCues(t),
    ...detectPinCodes(t),
    ...detectNameCues(t),
    ...detectPhoneCues(t),
    ...detectDobCues(t),
  ];
  // Never re-detect inside VEIL placeholders.
  const ph = [...t.matchAll(PLACEHOLDER_RE)].map((m) => [m.index!, m.index! + m[0].length] as const);
  return spans.filter((s) => !ph.some(([a, b]) => s.start >= a && s.end <= b));
}

const PRIORITY: Record<DetectionCategory, number> = {
  CARD: 7,
  AADHAAR: 6,
  PAN: 5,
  EMAIL: 4,
  PHONE: 3,
  ADDRESS: 2,
  PERSON: 1,
  REDACTED: 0,
};

/**
 * Merge overlapping spans (fail closed: overlapping spans become their union so no tail leaks).
 * The merged span keeps the category of its longest member (ties → higher priority).
 */
export function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const groups: Span[][] = [];
  let curEnd = -1;
  for (const s of sorted) {
    if (groups.length && s.start < curEnd) {
      groups[groups.length - 1]!.push(s);
      curEnd = Math.max(curEnd, s.end);
    } else {
      groups.push([s]);
      curEnd = s.end;
    }
  }
  return groups.map((g) => {
    const start = Math.min(...g.map((s) => s.start));
    const end = Math.max(...g.map((s) => s.end));
    const best = [...g].sort((a, b) => b.end - b.start - (a.end - a.start) || PRIORITY[b.category] - PRIORITY[a.category])[0]!;
    return { start, end, category: best.category, detector: g.length > 1 ? `merged:${best.detector}` : best.detector };
  });
}

export function detect(t: string): Span[] {
  return mergeSpans(detectAll(t));
}
