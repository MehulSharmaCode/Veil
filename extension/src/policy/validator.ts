// Local action validation and taint policy. The LLM is never the safety authority: every action
// passes these checks (V1–V4, T1–T4, risk class) before it can run. Pure functions.

import { PLACEHOLDER_TOKEN, type Action } from '../shared/actions';
import { CREDENTIAL_CATEGORIES } from '../shared/fieldCategory';
import type { RawElement, ValueCategory } from '../shared/ir';
import type { PiiCategory } from '../privacy/detectors';
import { digitsOnly } from '../privacy/normalize';
import { scanStrict } from '../privacy/sanitizer';
import type { Secrets } from '../egress/gate';
import type { VaultEntry } from '../privacy/vault';
import { isSubmitLike } from './submitLike';

export const POLICY_RULES = {
  V1_ACTION: 'unknown action or invalid parameters',
  V2_TARGET: 'target not in latest snapshot, gone, hidden or occluded',
  V3_FINGERPRINT: 'target changed since the snapshot (stale)',
  V4_SUITABILITY: 'action not suitable for this element',
  T1_CREDENTIAL: 'credential/card fields are filled by the user, never the agent',
  T2_CATEGORY: 'placeholder category does not match the field',
  T3_ORIGIN: 'value used on a different origin than it came from',
  T4_SMUGGLING: 'literal text contains a sensitive value',
  R1_SUBMIT_LIKE: 'submit-like control',
} as const;
export type PolicyRule = keyof typeof POLICY_RULES;

export interface Concern {
  rule: PolicyRule;
  reason: string;
}

export type Verdict =
  | { kind: 'reject'; rule: PolicyRule; reason: string }
  | { kind: 'handoff'; rule: 'T1_CREDENTIAL'; reason: string }
  | { kind: 'allow'; confirm: Concern[]; placeholder?: string };

export interface PolicyContext {
  /** Elements of the most recent snapshot, by id. */
  snapshot: Map<string, RawElement>;
  vault: { getEntry(id: string): VaultEntry | undefined };
  secrets: Secrets;
  taskOrigin: string;
  pageOrigin: string;
}

const COMPATIBLE: Record<PiiCategory, ValueCategory[]> = {
  EMAIL: ['email'],
  PHONE: ['tel'],
  ADDRESS: ['address'],
  PERSON: ['person_name'],
  PAN: ['pan'],
  AADHAAR: ['aadhaar'],
  CARD: [], // never typed (T1)
};

const reject = (rule: PolicyRule, reason: string): Verdict => ({ kind: 'reject', rule, reason });

function isEditable(el: RawElement): boolean {
  return !!el.state.editable && !el.state.disabled && !el.state.readonly;
}

/** Checks that need only the action, the latest snapshot and the vault. */
export function validateAction(action: Action, ctx: PolicyContext): Verdict {
  if (action.type === 'wait' || action.type === 'ask_user' || action.type === 'done') return { kind: 'allow', confirm: [] };
  if (action.type === 'scroll' && !('target' in action)) return { kind: 'allow', confirm: [] };

  const el = ctx.snapshot.get(action.target);
  if (!el) return reject('V2_TARGET', `target ${action.target} is not in the latest snapshot`);
  if (!el.visible) return reject('V2_TARGET', `target ${action.target} is not visible`);
  if (action.type === 'scroll') return { kind: 'allow', confirm: [] };
  if (el.state.disabled) return reject('V4_SUITABILITY', `target ${action.target} is disabled`);

  if (action.type === 'click') {
    if (el.kind !== 'interactive') return reject('V4_SUITABILITY', `target ${action.target} is not interactive`);
    const confirm: Concern[] = [];
    if (isSubmitLike(el)) confirm.push({ rule: 'R1_SUBMIT_LIKE', reason: 'This click may submit or change data.' });
    return { kind: 'allow', confirm };
  }

  if (action.type === 'select') {
    const isSelect = el.tag === 'select' || el.role === 'listbox' || el.role === 'combobox';
    if (!isSelect || el.state.disabled) return reject('V4_SUITABILITY', `target ${action.target} is not a select`);
    return { kind: 'allow', confirm: [] };
  }

  // type
  if (!isEditable(el)) return reject('V4_SUITABILITY', `target ${action.target} is not an editable field`);
  const fieldCat = el.state.value_category ?? 'free_text';
  if (CREDENTIAL_CATEGORIES.has(fieldCat)) {
    return { kind: 'handoff', rule: 'T1_CREDENTIAL', reason: `field is a ${fieldCat.replace('_', ' ')} field` };
  }

  const text = action.text;
  if (PLACEHOLDER_TOKEN.test(text)) {
    const entry = ctx.vault.getEntry(text);
    if (!entry) return reject('V1_ACTION', `unknown placeholder ${text}`);
    if (entry.sensitivity === 'high' || entry.category === 'CARD') {
      return { kind: 'handoff', rule: 'T1_CREDENTIAL', reason: 'card numbers are never typed by the agent' };
    }
    const confirm: Concern[] = [];
    if (!COMPATIBLE[entry.category].includes(fieldCat)) {
      confirm.push({ rule: 'T2_CATEGORY', reason: `${text} is ${entry.category} but the field looks like ${fieldCat}` });
    }
    const allowedOrigin = entry.source === 'page' ? entry.origin : ctx.taskOrigin;
    if (allowedOrigin !== ctx.pageOrigin) {
      confirm.push({ rule: 'T3_ORIGIN', reason: `${text} came from a different origin` });
    }
    return { kind: 'allow', confirm, placeholder: text };
  }

  // Literal text: must not embed placeholders, vault values or anything PII-shaped.
  if (/\[[A-Z]+_\d+\]|\[REDACTED_TEXT\]/.test(text)) return reject('V1_ACTION', 'type text must be exactly one placeholder or literal text');
  const lower = text.toLowerCase();
  const digits = digitsOnly(text);
  if (ctx.secrets.text.some((s) => lower.includes(s.toLowerCase())) || ctx.secrets.digits.some((d) => digits.includes(d))) {
    return reject('T4_SMUGGLING', 'literal text contains a vault value');
  }
  if (scanStrict(text).length) return reject('T4_SMUGGLING', 'literal text looks like personal data');
  return { kind: 'allow', confirm: [] };
}

/** Live state of the target as re-read by the content script just before execution. */
export interface LiveTarget {
  exists: boolean;
  visible: boolean;
  occluded: boolean;
  fingerprint: string;
}

/** V2 (still present, visible, not occluded) and V3 (fingerprint unchanged). */
export function validateLive(snapshotEl: RawElement, live: LiveTarget): Verdict | null {
  if (!live.exists) return reject('V2_TARGET', `target ${snapshotEl.id} no longer exists`);
  if (live.fingerprint !== snapshotEl.fingerprint) return reject('V3_FINGERPRINT', `target ${snapshotEl.id} changed since the snapshot`);
  if (!live.visible) return reject('V2_TARGET', `target ${snapshotEl.id} is not visible`);
  if (live.occluded) return reject('V2_TARGET', `target ${snapshotEl.id} is covered by another element`);
  return null;
}
