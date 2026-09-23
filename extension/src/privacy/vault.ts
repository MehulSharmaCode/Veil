// In-memory vault of real sensitive values, keyed by placeholder id. Lives only in the side panel's
// JS heap: cleared on task end / Stop, and destroyed when the panel closes.

import { digitsOnly, normalizeValue } from './normalize';
import type { PiiCategory } from './detectors';
import { CONFIG } from '../shared/config';

export type ValueSource = 'task' | 'page' | 'user_answer';
export type Sensitivity = 'normal' | 'high';

export interface VaultEntry {
  id: string; // "[EMAIL_1]"
  category: PiiCategory;
  value: string;
  normalized: string;
  source: ValueSource;
  origin: string;
  source_fingerprint?: string;
  sensitivity: Sensitivity;
  created_at: number;
}

/** Metadata view: everything except the value. Safe for UI and telemetry. */
export interface VaultEntryMeta {
  id: string;
  category: PiiCategory;
  source: ValueSource;
  sensitivity: Sensitivity;
  stored: 'locally';
}

const HIGH: ReadonlySet<PiiCategory> = new Set(['CARD']);

export class Vault {
  private entries = new Map<string, VaultEntry>();
  private byKey = new Map<string, string>();
  private counters = new Map<PiiCategory, number>();

  /**
   * Returns the placeholder for a value, creating an entry if needed. The same normalized value
   * always maps to the same placeholder within a session. Numbers come from a per-session counter.
   */
  assign(
    category: PiiCategory,
    value: string,
    meta: { source: ValueSource; origin: string; fingerprint?: string },
  ): string {
    const normalized = normalizeValue(category, value);
    const key = `${category}\u0000${normalized}`;
    const existing = this.byKey.get(key);
    if (existing) {
      const e = this.entries.get(existing)!;
      // A value the user typed in the task is user-provided, whatever was seen first.
      if (meta.source !== 'page' && e.source === 'page') e.source = meta.source;
      return existing;
    }
    const n = (this.counters.get(category) ?? 0) + 1;
    this.counters.set(category, n);
    const id = `[${category}_${n}]`;
    this.entries.set(id, {
      id,
      category,
      value: value.trim(),
      normalized,
      source: meta.source,
      origin: meta.origin,
      source_fingerprint: meta.source === 'page' ? meta.fingerprint : undefined,
      sensitivity: HIGH.has(category) ? 'high' : 'normal',
      created_at: Date.now(),
    });
    this.byKey.set(key, id);
    return id;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Full entry including the real value. Only for local resolution/validation — never serialize. */
  getEntry(id: string): VaultEntry | undefined {
    return this.entries.get(id);
  }

  metadata(): VaultEntryMeta[] {
    return [...this.entries.values()].map((e) => ({
      id: e.id,
      category: e.category,
      source: e.source,
      sensitivity: e.sensitivity,
      stored: 'locally' as const,
    }));
  }

  /**
   * Known non-numeric values as lowercase needles (longest first), so the sanitizer can replace later
   * occurrences of an already-vaulted value that no detector would catch (e.g. a name in a heading).
   */
  knownNeedles(): { id: string; category: PiiCategory; needle: string }[] {
    return [...this.entries.values()]
      .filter((e) => !['PHONE', 'AADHAAR', 'CARD'].includes(e.category) && e.normalized.length >= CONFIG.TRIPWIRE_MIN_TEXT_LEN)
      .map((e) => ({ id: e.id, category: e.category, needle: e.normalized.toLowerCase() }))
      .sort((a, b) => b.needle.length - a.needle.length);
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Forms of every stored value for the egress tripwire: normalized, lowercase and digits-only.
   * Local use only (the gate). Short forms are skipped to avoid matching common words.
   */
  secretForms(): { text: string[]; digits: string[] } {
    const text = new Set<string>();
    const digits = new Set<string>();
    for (const e of this.entries.values()) {
      for (const f of [e.normalized, e.value.toLowerCase(), e.normalized.toLowerCase()]) {
        if (f.length >= CONFIG.TRIPWIRE_MIN_TEXT_LEN) text.add(f);
      }
      const d = digitsOnly(e.value);
      // Digits-only form is meaningful for mostly-numeric values (phone, aadhaar, card, …).
      if (d.length >= CONFIG.TRIPWIRE_MIN_DIGITS_LEN && d.length >= e.value.replace(/\s/g, '').length * 0.6) {
        digits.add(d);
        if (e.category === 'PHONE') digits.add(normalizeValue('PHONE', d));
      }
    }
    return { text: [...text], digits: [...digits] };
  }

  clear(): void {
    for (const e of this.entries.values()) {
      e.value = '';
      e.normalized = '';
    }
    this.entries.clear();
    this.byKey.clear();
    this.counters.clear();
  }
}
