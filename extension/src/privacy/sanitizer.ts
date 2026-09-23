// The single sanitizer. Every string that could leave the extension goes through here:
// task text, ask_user answers, element names/text, labels, aria-*, placeholder, alt, title,
// page title and URL path — and later OCR lines (source tag 'ocr').

import { detectAll, mergeSpans, PLACEHOLDER_RE, type DetectionCategory, type Span } from './detectors';
import { normalizeText } from './normalize';
import { __brandSanitized, REDACTED, type SanitizedText } from './sanitized';
import type { Vault, ValueSource } from './vault';

export type SanitizeSource = ValueSource | 'ocr';

export interface SanitizeContext {
  source: SanitizeSource;
  origin: string;
  /** Fingerprint of the element the text came from (page-sourced text only). */
  fingerprint?: string;
  /**
   * Keep existing VEIL placeholders intact (VEIL/planner-generated text). Untrusted page/task
   * text must leave this unset so look-alike placeholders are defused.
   */
  keepPlaceholders?: boolean;
}

export interface Detection {
  category: DetectionCategory;
  placeholder: string; // "[EMAIL_1]" or "[REDACTED_TEXT]"
  detector: string;
}

export interface SanitizeResult {
  text: SanitizedText;
  detections: Detection[];
}

/** Neutralize placeholder look-alikes in untrusted input so pages cannot forge vault references. */
function defusePlaceholders(t: string): string {
  return t.replace(PLACEHOLDER_RE, (m) => `(${m.slice(1, -1)})`);
}

export class Sanitizer {
  constructor(private readonly vault: Vault) {}

  sanitizeWithReport(raw: string, ctx: SanitizeContext): SanitizeResult {
    if (typeof raw !== 'string' || raw === '') return { text: __brandSanitized(''), detections: [] };
    try {
      const t = ctx.keepPlaceholders ? normalizeText(raw) : defusePlaceholders(normalizeText(raw));
      const spans = mergeSpans([...detectAll(t), ...this.knownValueSpans(t)]);
      const detections: Detection[] = [];
      let out = '';
      let pos = 0;
      for (const s of spans) {
        out += t.slice(pos, s.start);
        const value = t.slice(s.start, s.end);
        const placeholder =
          s.category === 'REDACTED'
            ? REDACTED
            : this.vault.assign(s.category, value, {
                source: ctx.source === 'ocr' ? 'page' : ctx.source,
                origin: ctx.origin,
                fingerprint: ctx.fingerprint,
              });
        detections.push({ category: s.category, placeholder, detector: s.detector });
        out += placeholder;
        pos = s.end;
      }
      out += t.slice(pos);
      return { text: __brandSanitized(out), detections };
    } catch {
      // Fail closed: any detector error masks the whole field.
      return { text: REDACTED, detections: [{ category: 'REDACTED', placeholder: REDACTED, detector: 'error' }] };
    }
  }

  /** Occurrences of values already in the vault (case-insensitive), e.g. a known name without a cue. */
  private knownValueSpans(t: string): Span[] {
    const lower = t.toLowerCase();
    if (lower.length !== t.length) return [];
    const out: Span[] = [];
    for (const k of this.vault.knownNeedles()) {
      for (let i = lower.indexOf(k.needle); i !== -1; i = lower.indexOf(k.needle, i + k.needle.length)) {
        out.push({ start: i, end: i + k.needle.length, category: k.category, detector: 'vault:known' });
      }
    }
    return out;
  }

  sanitize(raw: string, ctx: SanitizeContext): SanitizedText {
    return this.sanitizeWithReport(raw, ctx).text;
  }

  /** Fail-closed mode: mask the whole field. */
  failClosed(): SanitizedText {
    return REDACTED;
  }
}

export interface StrictFinding {
  category: DetectionCategory;
  detector: string;
}

/**
 * Strict residual scan used by the egress gate on already-sanitized strings. Pure; never modifies.
 * Same detectors as the sanitizer plus looser email/long-digit rules.
 */
export function scanStrict(s: string): StrictFinding[] {
  const t = normalizeText(s);
  const findings: StrictFinding[] = detectAll(t).map((x) => ({ category: x.category, detector: x.detector }));
  const noPlaceholders = t.replace(PLACEHOLDER_RE, ' ');
  if (/[^\s@[\]]+@[^\s@[\]]+\.[^\s@[\]]+/.test(noPlaceholders) && !findings.some((f) => f.category === 'EMAIL')) {
    findings.push({ category: 'EMAIL', detector: 'strict:email' });
  }
  if (/\d{9,}/.test(noPlaceholders.replace(/(\d)[\s\-.()/]{1,2}(?=\d)/g, '$1')) && !findings.length) {
    findings.push({ category: 'REDACTED', detector: 'strict:digits' });
  }
  return findings;
}
