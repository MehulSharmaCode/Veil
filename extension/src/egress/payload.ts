// Payload builder. Accepts only sanitizer output (SanitizedText) for free text; structural
// fields (tags, roles, input types, autocomplete tokens) are passed through closed allowlists.

import { CONFIG } from '../shared/config';
import type { RawSnapshot, SanitizedElement, SanitizedPage, SanitizedRegion } from '../shared/ir';
import type { Detection, Sanitizer } from '../privacy/sanitizer';
import type { SanitizedText } from '../privacy/sanitized';
import type { VaultEntryMeta } from '../privacy/vault';
import { INPUT_TYPES, type HistoryEntry, type PlannerPayload } from './schema';

const AUTOCOMPLETE_TOKENS = new Set([
  'on', 'off', 'name', 'honorific-prefix', 'given-name', 'additional-name', 'family-name', 'honorific-suffix', 'nickname',
  'username', 'new-password', 'current-password', 'one-time-code', 'organization-title', 'organization', 'street-address',
  'address-line1', 'address-line2', 'address-line3', 'address-level1', 'address-level2', 'address-level3', 'address-level4',
  'country', 'country-name', 'postal-code', 'cc-name', 'cc-given-name', 'cc-additional-name', 'cc-family-name', 'cc-number',
  'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-csc', 'cc-type', 'transaction-currency', 'transaction-amount', 'language',
  'bday', 'bday-day', 'bday-month', 'bday-year', 'sex', 'url', 'photo', 'tel', 'tel-country-code', 'tel-national',
  'tel-area-code', 'tel-local', 'tel-extension', 'email', 'impp', 'shipping', 'billing', 'home', 'work', 'mobile', 'fax', 'pager',
]);

function cleanAutocomplete(ac?: string): string | undefined {
  if (!ac) return undefined;
  const toks = ac.toLowerCase().split(/\s+/).filter((t) => AUTOCOMPLETE_TOKENS.has(t));
  return toks.length ? toks.join(' ') : undefined;
}

function cleanTag(tag: string): string {
  return /^[a-z][a-z0-9]{0,15}$/.test(tag) ? tag : 'custom'; // custom-element names are page-controlled text
}

function cleanRole(role: string): string {
  return /^[a-z]{1,24}$/.test(role) ? role : 'generic';
}

export interface SanitizedSnapshot {
  page: SanitizedPage;
  elements: SanitizedElement[];
  regions: SanitizedRegion[];
  detections: Detection[];
}

/** Run every page string through the single sanitizer. Raw strings never survive this function. */
export function sanitizeSnapshot(raw: RawSnapshot, s: Sanitizer): SanitizedSnapshot {
  const origin = raw.page.origin;
  const detections: Detection[] = [];
  const san = (text: string, fingerprint?: string): SanitizedText => {
    const r = s.sanitizeWithReport(text, { source: 'page', origin, fingerprint });
    detections.push(...r.detections);
    return r.text;
  };

  const page: SanitizedPage = {
    origin: san(origin),
    path: san(raw.page.path.replace(/[?#].*$/, '')),
    title: san(raw.page.title.slice(0, 300)),
    viewport: raw.page.viewport,
    scroll: raw.page.scroll,
  };

  const elements = raw.elements.map((e): SanitizedElement => {
    const fp = e.fingerprint;
    const out: SanitizedElement = {
      id: e.id,
      kind: e.kind,
      role: cleanRole(e.role),
      tag: cleanTag(e.tag),
      name: san(e.name, fp),
      text: san(e.text, fp),
      state: { ...e.state },
      bbox: e.bbox,
      visible: e.visible,
      in_viewport: e.in_viewport,
      occluded: e.occluded,
      context: {},
    };
    const it = e.input_type?.toLowerCase();
    if (it && (INPUT_TYPES as readonly string[]).includes(it)) out.input_type = it;
    const ac = cleanAutocomplete(e.autocomplete);
    if (ac) out.autocomplete = ac;
    if (e.level) out.level = e.level;
    if (e.options) out.options = e.options.slice(0, CONFIG.MAX_SELECT_OPTIONS).map((o) => san(o.slice(0, 120), fp));
    if (e.link_path) out.link_path = san(e.link_path.replace(/[?#].*$/, '').slice(0, 240), fp);
    if (e.context.section) out.context.section = san(e.context.section.slice(0, 160));
    if (e.context.form) out.context.form = san(e.context.form.slice(0, 160));
    return out;
  });

  const regions = raw.regions.map(
    (r): SanitizedRegion => ({ id: r.id, kind: r.kind, bbox: r.bbox, label: san(r.label.slice(0, 160)), in_viewport: r.in_viewport, status: 'unperceived' }),
  );

  return { page, elements, regions, detections };
}

export interface BuildInput {
  sessionId: string;
  step: number;
  task: SanitizedText;
  snapshot: SanitizedSnapshot;
  placeholders: VaultEntryMeta[];
  history: HistoryEntry[];
}

function size(p: unknown): number {
  return new TextEncoder().encode(JSON.stringify(p)).length;
}

/**
 * Build the closed planner payload and prune it toward the size target: off-viewport text first,
 * then in-viewport text, then off-viewport interactive elements (farthest first). In-viewport
 * interactive elements are never dropped.
 */
/** Draft typed with SanitizedText so only sanitizer output can populate free-text fields. */
type PayloadDraft = Omit<PlannerPayload, 'task' | 'page' | 'elements' | 'regions'> & {
  task: SanitizedText;
  page: SanitizedPage;
  elements: SanitizedElement[];
  regions: SanitizedRegion[];
};

export function buildPlannerPayload(input: BuildInput): PlannerPayload {
  const payload: PayloadDraft = {
    schema_version: CONFIG.SCHEMA_VERSION,
    session_id: input.sessionId,
    step: input.step,
    task: input.task,
    page: input.snapshot.page,
    elements: input.snapshot.elements.map((e) => ({ ...e, state: { ...e.state }, context: { ...e.context } })),
    regions: input.snapshot.regions.slice(0, 60),
    placeholders: input.placeholders.map((p) => ({ id: p.id, category: p.category })),
    history: input.history.slice(-CONFIG.HISTORY_LENGTH),
  };

  const dropWhere = (pred: (e: SanitizedElement) => boolean, order?: (a: SanitizedElement, b: SanitizedElement) => number) => {
    const victims = payload.elements.filter(pred);
    if (order) victims.sort(order);
    for (const v of victims) {
      if (size(payload) <= CONFIG.PAYLOAD_TARGET_BYTES) return;
      payload.elements.splice(payload.elements.indexOf(v), 1);
    }
  };
  const distance = (e: SanitizedElement) => Math.abs(e.bbox.y - input.snapshot.page.scroll.y);

  if (size(payload) > CONFIG.PAYLOAD_TARGET_BYTES) {
    dropWhere((e) => e.kind !== 'interactive' && !e.in_viewport, (a, b) => distance(b) - distance(a));
    dropWhere((e) => e.kind === 'text' && e.in_viewport);
    dropWhere((e) => e.kind === 'interactive' && !e.in_viewport, (a, b) => distance(b) - distance(a));
  }
  // Structural enums (input_type etc.) were narrowed by allowlists above; the gate re-validates the schema.
  return payload as unknown as PlannerPayload;
}
