// Intermediate representation produced by the content script (raw, extension-internal)
// and its sanitized counterpart (the only form that may be put into outbound payloads).

import type { SanitizedText } from '../privacy/sanitized';

/** Category of the *value* a field holds, inferred from type/autocomplete/label tokens. Never the value itself. */
export const VALUE_CATEGORIES = [
  'email',
  'tel',
  'person_name',
  'address',
  'postal_code',
  'pan',
  'aadhaar',
  'dob',
  'card_number',
  'card_cvc',
  'password',
  'otp',
  'free_text',
  'other',
] as const;
export type ValueCategory = (typeof VALUE_CATEGORIES)[number];

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ElementState {
  disabled?: boolean;
  required?: boolean;
  checked?: boolean;
  selected?: boolean;
  readonly?: boolean;
  expanded?: boolean;
  editable?: boolean;
  /** True when the control is a form submitter (type=submit, default button in a form, input[type=image]). */
  submitter?: boolean;
  has_value?: boolean;
  value_category?: ValueCategory;
}

export type ElementKind = 'interactive' | 'heading' | 'text';

interface ElementBase<S> {
  id: string;
  kind: ElementKind;
  role: string;
  tag: string;
  input_type?: string;
  autocomplete?: string;
  name: S;
  text: S;
  level?: number;
  options?: S[];
  link_path?: S;
  state: ElementState;
  bbox: BBox;
  visible: boolean;
  in_viewport: boolean;
  occluded: boolean;
  context: { section?: S; form?: S };
}

/** Raw element from the content script. Strings are unsanitized page text: never send these. */
export interface RawElement extends ElementBase<string> {
  fingerprint: string;
}

export type RegionKind = 'img' | 'canvas' | 'video' | 'svg';

interface RegionBase<S> {
  id: string;
  kind: RegionKind;
  bbox: BBox;
  label: S;
  in_viewport: boolean;
  /** Visual pipeline seam. v0.1 never perceives pixels. */
  status: 'unperceived';
}
export type RawRegion = RegionBase<string>;

interface PageBase<S> {
  origin: S;
  /** Path only: query and fragment are removed in the content script. */
  path: S;
  title: S;
  viewport: { w: number; h: number };
  scroll: { x: number; y: number; max_y: number };
}

export interface RawSnapshot {
  page: PageBase<string>;
  elements: RawElement[];
  regions: RawRegion[];
  stats: { candidates: number; pruned: number; duration_ms: number };
}

export type SanitizedElement = ElementBase<SanitizedText>;
export type SanitizedRegion = RegionBase<SanitizedText>;
export type SanitizedPage = PageBase<SanitizedText>;
