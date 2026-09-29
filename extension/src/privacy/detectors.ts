// PII detectors. Pure functions over *normalized* text. Recall-biased by design.
//
// Known limitations (documented, v0.1): no NER; names are only found via context cues
// ("my name is", "signed in as", "Name:", greetings) or as the answer to a name question; addresses
// via cues ("my address is", "address X", "X as my address"), house-number/street shapes
// ("Flat 3B", "12 MG Road"), a 6-digit PIN next to address words, or as the answer to an address
// question, each grown to the surrounding address tokens; an address with none of these (e.g.
// "Shivajinagar Pune" in page text) is not detected; numbers are classified by
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

function trimSpan(t: string, start: number, end: number): [number, number] {
  // Dashes and quotes that frame a value ("address — X —", "“X”") are punctuation, not part of it.
  while (start < end && /[\s:,(\-"'–—‒―“”‘’]/.test(t[start]!)) start++;
  while (end > start && /[\s,:)\-"'–—‒―“”‘’]/.test(t[end - 1]!)) end--;
  return [start, end];
}

function startsWithPlaceholder(t: string, at: number): boolean {
  return /^\s*:?\s*\[[A-Z_0-9]+\]/.test(t.slice(at));
}

// ---- addresses --------------------------------------------------------------------------------
//
// One boundary engine for every address detector. An address span is grown token by token from an
// anchor (a cue such as "my address is", a "… as my address" suffix, a house-number/street shape or
// a PIN code) and ends at the first token that cannot be part of an address: a sentence/clause end,
// an instruction or label word, another PII value, or a connector ("and", "in", "to", …) that starts
// a new clause. Fail closed: between those boundaries every token is treated as part of the address.

/** Words that are never part of an address: instructions, pronouns/copulas, field labels, status words. */
const ADDRESS_STOP = new Set([
  'then', 'but', 'also', 'plus', 'please', 'pls', 'kindly', 'do', 'dont', "don't", 'not', 'never', 'fill', 'enter', 'type',
  'put', 'set', 'use', 'write', 'add', 'insert', 'paste', 'copy', 'update', 'change', 'save', 'submit', 'click', 'press',
  'tap', 'stop', 'leave', 'skip', 'select', 'choose', 'send', 'want', 'need', 'would', 'should', 'will', 'must', 'can',
  'my', 'your', 'our', 'his', 'her', 'their', 'me', 'us', 'we', 'you', 'they', 'it', 'this', 'that', 'these', 'those',
  'is', 'are', 'was', 'be', 'as', 'into', 'here', 'there',
  'address', 'addresses', 'email', 'e-mail', 'mail', 'phone', 'mobile', 'tel', 'telephone', 'contact', 'name', 'pan',
  'aadhaar', 'dob', 'id', 'field', 'fields', 'box', 'input', 'form', 'section', 'column', 'line',
  'required', 'optional', 'invalid', 'missing', 'mandatory', 'below', 'above', 'same', 'needed', 'empty', 'incorrect',
  'updated', 'saved', 'changed', 'verified', 'details', 'unknown',
]);
/** Connectors end an address only when a new clause follows them ("and my email", "in the address field"). */
const ADDRESS_CONNECTORS = new Set(['and', '&', 'or', 'in', 'to', 'for', 'with', 'from', 'at', 'on']);
const DETERMINERS = new Set(['the', 'a', 'an']);
/** Words that are evidence of an address when a cue alone is weak ("address …" without "my"/":"). */
const ADDRESS_WORDS =
  /\b(?:road|rd|street|st|lane|marg|avenue|ave|nagar|colony|layout|cross|main|sector|block|phase|flat|house|plot|door|floor|apartments?|apt|society|residency|towers?|enclave|vihar|chowk|gali|mohalla|near|opp|behind|village|taluka|tehsil|district|dist|city|state|pin|pincode|highway|circle|park|bagh|puram|pet|peth|wadi|halli)\b/i;

interface Tok {
  start: number;
  end: number;
  raw: string;
}

/** Token without surrounding quotes/brackets/trailing punctuation, lowercased. */
function word(raw: string): string {
  return raw.replace(/^[("'[]+/, '').replace(/[,)"'\].:;!?]+$/, '').toLowerCase();
}

/** A token that cannot be part of an address. */
function addressStops(raw: string): boolean {
  const core = raw.replace(/^[("'[]+/, '').replace(/[,)"'\]]+$/, '');
  if (!core) return false; // punctuation-only token (e.g. "-") stays inside the address
  if (/^[;!?:]/.test(core) || core.includes('@') || /^\[[A-Z_0-9]+\]$/.test(core) || /^\(?[A-Z]+_\d+\)?$/.test(core)) return true;
  if (digitsOnly(core).length >= 7) return true; // phone / id-like numbers are detected separately
  return ADDRESS_STOP.has(core.replace(/[.:;!?]+$/, '').toLowerCase());
}

/** True if the token ends a sentence/clause: ";", "!", "?", ":" or "." after a non-abbreviation. */
function endsClause(tok: string): boolean {
  const core = tok.replace(/[,)"'\]]+$/, '');
  if (/[;!?:]$/.test(core)) return true;
  if (!core.endsWith('.')) return false;
  const w = /([A-Za-z0-9]+)\.$/.exec(core)?.[1] ?? '';
  return !(/^[A-Za-z]$/.test(w) || ABBREVIATIONS.has(w.toLowerCase()));
}

/**
 * A connector at `i` that starts a new clause rather than continuing the address: followed by a
 * determiner or a stop word (within two words), or by words with no address evidence up to the next
 * boundary ("… 700016 for help", "… and alternate email").
 */
function clauseConnector(toks: Tok[], i: number): boolean {
  if (!ADDRESS_CONNECTORS.has(word(toks[i]!.raw))) return false;
  const a = toks[i + 1];
  const b = toks[i + 2];
  if (!a || DETERMINERS.has(word(a.raw)) || addressStops(a.raw) || (b && !endsClause(a.raw) && addressStops(b.raw))) return true;
  const run: string[] = [];
  for (let j = i + 1; j < toks.length && !addressStops(toks[j]!.raw) && !ADDRESS_CONNECTORS.has(word(toks[j]!.raw)); j++) {
    run.push(toks[j]!.raw);
    if (endsClause(toks[j]!.raw)) break;
  }
  return !addressEvidence(run.join(' '), true);
}

/** Tokens of `t` from offset `pos` (a token cut at `pos` yields its remainder only). */
function tokensFrom(t: string, pos: number): Tok[] {
  return [...t.slice(pos).matchAll(/\S+/g)].map((m) => ({ start: pos + m.index!, end: pos + m.index! + m[0].length, raw: m[0] }));
}

/** The whitespace-delimited token of `t` that contains offset `pos` strictly inside it, if any. */
function tokenAround(t: string, pos: number): Tok | null {
  if (pos <= 0 || pos >= t.length || /\s/.test(t[pos]!) || /\s/.test(t[pos - 1]!)) return null;
  let s = pos;
  while (s > 0 && !/\s/.test(t[s - 1]!)) s--;
  let e = pos;
  while (e < t.length && !/\s/.test(t[e]!)) e++;
  return { start: s, end: e, raw: t.slice(s, e) };
}

/** End offset of an address that continues after offset `pos` (an anchor or cue end). */
function growForward(t: string, pos: number): number {
  let end = pos;
  let from = pos;
  // An anchor that ends inside a token ("411005." / "Rd.,"): its remainder is a terminator or kept.
  const cut = tokenAround(t, pos);
  if (cut) {
    const rest = t.slice(pos, cut.end);
    if (/^[;!?:]/.test(rest) || (rest.startsWith('.') && endsClause(cut.raw))) return pos;
    end = from = cut.end;
  }
  const toks = tokensFrom(t, from);
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i]!;
    if (/^[.;!?:]/.test(tok.raw) || addressStops(tok.raw) || clauseConnector(toks, i)) break;
    if (endsClause(tok.raw)) return tok.start + tok.raw.replace(/[,)"'\]]+$/, '').length - 1; // drop the terminator
    end = tok.end;
  }
  return end;
}

/** Start offset of an address that continues before offset `pos` (an anchor or suffix-cue start). */
function growBackward(t: string, pos: number): number {
  let start = pos;
  const toks = [...t.slice(0, pos).matchAll(/\S+/g)].map((m) => ({ start: m.index!, end: m.index! + m[0].length, raw: m[0] }));
  for (let i = toks.length - 1; i >= 0; i--) {
    const tok = toks[i]!;
    if (endsClause(tok.raw) || addressStops(tok.raw) || ADDRESS_CONNECTORS.has(word(tok.raw))) break;
    start = tok.start;
  }
  return start;
}

/**
 * Whether a candidate value carries address evidence: a digit, an address word or a comma. With
 * `lenient` (text the user typed), a run of capitalized words ("Andheri West, Mumbai") also counts.
 */
function addressEvidence(value: string, lenient: boolean): boolean {
  if (/\d/.test(value) || /,/.test(value) || ADDRESS_WORDS.test(value)) return true;
  if (!lenient) return false;
  const ws = value.split(/\s+/).filter(Boolean);
  return ws.length > 0 && ws.every((w) => /^[("']?[A-Z0-9]/.test(w));
}

export interface DetectOptions {
  /**
   * The text was typed by the user (task text, ask_user answers). Weak address cues ("fill address X")
   * then need no further evidence: in a user's instruction the words after "address" are the value.
   */
  userText?: boolean;
}

const ADDRESS_QUALIFIERS = '(?:(?:home|postal|current|permanent|residential|mailing|shipping|billing|delivery|office|new|full|correct)\\s+)?';
const NOT_ADDRESS_PREFIX = '(?<!\\b(?:e-?mail|ip|web|website|mac|url|server|wallet|reply)[\\s-])';
/**
 * Forward cues: "my address is X", "address: X", "address X", "the address field with X", "set the
 * address to X", "residing at X". Group 1 = "my …" (strong), group 2 = the connector tail.
 */
const ADDRESS_CUE_RE = new RegExp(
  `\\b(?:(my\\s+${ADDRESS_QUALIFIERS})|${ADDRESS_QUALIFIERS})${NOT_ADDRESS_PREFIX}address(?:es)?\\b` +
    `(?:\\s+(?:field|box|input|column|line(?:\\s*\\d)?))?` +
    `((?:\\s*(?:[:=–—-]+|(?:is|as|with|to|be|will|should|would|shall|here|below)\\b))*)\\s*` +
    `|\\b(?:residing|resides|reside|living|lives|live|located|situated|staying|stays)\\s+at\\b\\s*:?\\s*`,
  'gi',
);
/** Backward cues: "Use X as my address", "Enter X in the address field". The value precedes the cue. */
const ADDRESS_SUFFIX_RE = new RegExp(
  `\\b(?:as|in|into|to|for|under)\\s+(?:(?:the|my|your|this)\\s+)?${ADDRESS_QUALIFIERS}address(?:es)?\\b(?:\\s+(?:field|box|input|column|line(?:\\s*\\d)?))?`,
  'gi',
);

export function detectAddressCues(t: string, opts: DetectOptions = {}): Span[] {
  const out: Span[] = [];
  for (const m of t.matchAll(ADDRESS_CUE_RE)) {
    const from = m.index! + m[0].length;
    if (startsWithPlaceholder(t, from)) continue;
    const strong = m[1] !== undefined || m[2] === undefined || /[:=]|\bis\b/i.test(m[2]);
    const [s, e] = trimSpan(t, from, growForward(t, from));
    if (e - s < 3) continue;
    if (!strong && !opts.userText && !addressEvidence(t.slice(s, e), false)) continue;
    out.push({ start: s, end: e, category: 'ADDRESS', detector: 'cue:address' });
  }
  for (const m of t.matchAll(ADDRESS_SUFFIX_RE)) {
    const [s, e] = trimSpan(t, growBackward(t, m.index!), m.index!);
    if (e - s < 3 || !addressEvidence(t.slice(s, e), !!opts.userText)) continue;
    out.push({ start: s, end: e, category: 'ADDRESS', detector: 'cue:address-suffix' });
  }
  return out;
}

/** Grow an anchor [start, end) to the surrounding address tokens. */
function addressExtent(t: string, start: number, end: number): [number, number] {
  return trimSpan(t, growBackward(t, start), growForward(t, end));
}

// Cue-less address shapes: a house/flat number ("Flat 3B", "House No. 5") or a number followed within a
// few words by a street word ("12 MG Road", "221B Baker Street").
const HOUSE_RE = /\b(?:flat|house|plot|door|bungalow|villa|apt|apartment|shop|h\.?\s?no|d\.?\s?no)\.?\s*(?:no\.?|number|#)?\s*[-#:]?\s*\d{1,5}[A-Za-z]?(?:[/-]\d{1,5}[A-Za-z]?)?(?![\d%])/gi;
const STREET_RE =
  /(?<![\w.])\d{1,5}[A-Za-z]?(?:[/-]\d{1,5}[A-Za-z]?)?,?\s+(?:[A-Za-z][\w.'-]*\s+){0,3}(?:road|rd|street|lane|marg|avenue|nagar|colony|layout|cross|enclave|vihar|society|apartments|residency|chowk|gali|mohalla|highway|boulevard)\b\.?/gi;

export function detectAddressShapes(t: string): Span[] {
  const out: Span[] = [];
  for (const re of [HOUSE_RE, STREET_RE]) {
    for (const m of t.matchAll(re)) {
      const [start, end] = addressExtent(t, m.index!, m.index! + m[0].replace(/\.$/, '').length);
      if (end > start) out.push({ start, end, category: 'ADDRESS', detector: 'shape:address' });
    }
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
 * The category an ask_user answer is expected to hold, from the (sanitized) question: "What is your
 * address?" → ADDRESS, "What is your full name?" → PERSON. Yes/no questions expect nothing.
 */
export function expectedAnswerCategory(question: string): 'ADDRESS' | 'PERSON' | null {
  const q = question.trim().toLowerCase();
  if (/^(?:do|does|did|should|shall|can|could|may|would|will|is|are|was|were|have|has|want)\b/.test(q)) return null;
  if (new RegExp(`${NOT_ADDRESS_PREFIX}\\baddress(?:es)?\\b`).test(q)) return 'ADDRESS';
  if (/\b(?:full\s+|first\s+|last\s+|your\s+)?name\b/.test(q) && !/\b(?:user|file|company|field|display)\s*name\b/.test(q)) return 'PERSON';
  return null;
}

const CONTROL_ANSWER = /^(?:yes|no|y|n|ok|okay|sure|skip|stop|cancel|continue|proceed|done|none|nothing|same|n\/a|na)\b/i;

/**
 * A whole answer that no detector flagged, when the question asked for an address or a name: mask it
 * as that category if it has the shape (fail closed for cue-less, PIN-less answers such as
 * "Shivajinagar, Pune" or "priya nair").
 */
export function detectExpectedAnswer(t: string, expect: 'ADDRESS' | 'PERSON'): Span[] {
  const [s, e] = trimSpan(t, 0, t.replace(/[.!?]+$/, '').length);
  const v = t.slice(s, e);
  if (e - s < 3 || CONTROL_ANSWER.test(v) || /[@[\]]/.test(v)) return [];
  const ws = v.split(/\s+/);
  const plainWords = ws.length >= 2 && ws.every((w) => /^[A-Za-z][A-Za-z.'-]*,?$/.test(w) && !addressStops(w));
  if (expect === 'ADDRESS' && (addressEvidence(v, true) || plainWords)) return [{ start: s, end: e, category: 'ADDRESS', detector: 'expected:address' }];
  if (expect === 'PERSON' && /^[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,3}$/.test(v)) {
    return [{ start: s, end: e, category: 'PERSON', detector: 'expected:name' }];
  }
  return [];
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
export function detectAll(t: string, opts: DetectOptions = {}): Span[] {
  const spans = [
    ...detectEmails(t),
    ...detectPan(t),
    ...detectNumbers(t),
    ...detectAddressCues(t, opts),
    ...detectAddressShapes(t),
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

export function detect(t: string, opts: DetectOptions = {}): Span[] {
  return mergeSpans(detectAll(t, opts));
}
