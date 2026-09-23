// Closed schemas for everything that may leave the extension. Mirrored in server/app/schemas.py.

import { z } from '../shared/zod';
import { VALUE_CATEGORIES } from '../shared/ir';
import { PII_CATEGORIES } from '../privacy/detectors';
import { PLACEHOLDER_TOKEN } from '../shared/actions';
import { CONFIG } from '../shared/config';

const str = (max: number) => z.string().max(max);
const int = z.number().int();
const bbox = z.strictObject({ x: int, y: int, w: int, h: int });

export const INPUT_TYPES = [
  'text', 'email', 'tel', 'password', 'number', 'search', 'url', 'date', 'datetime-local', 'month', 'week', 'time',
  'checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'file', 'range', 'color',
] as const;

export const ElementSchema = z.strictObject({
  id: z.string().regex(/^e\d{1,5}$/),
  kind: z.enum(['interactive', 'heading', 'text']),
  role: z.string().regex(/^[a-z]{1,24}$/),
  tag: z.string().regex(/^[a-z][a-z0-9-]{0,24}$/),
  input_type: z.enum(INPUT_TYPES).optional(),
  autocomplete: z.string().regex(/^[a-z0-9 -]{1,80}$/).optional(),
  name: str(CONFIG.TEXT_CAP + 40),
  text: str(CONFIG.TEXT_CAP + 40),
  level: int.min(1).max(6).optional(),
  options: z.array(str(120)).max(CONFIG.MAX_SELECT_OPTIONS).optional(),
  link_path: str(240).optional(),
  state: z.strictObject({
    disabled: z.boolean().optional(),
    required: z.boolean().optional(),
    checked: z.boolean().optional(),
    selected: z.boolean().optional(),
    readonly: z.boolean().optional(),
    expanded: z.boolean().optional(),
    editable: z.boolean().optional(),
    submitter: z.boolean().optional(),
    has_value: z.boolean().optional(),
    value_category: z.enum(VALUE_CATEGORIES).optional(),
  }),
  bbox,
  visible: z.boolean(),
  in_viewport: z.boolean(),
  occluded: z.boolean(),
  context: z.strictObject({ section: str(160).optional(), form: str(160).optional() }),
});

export const RegionSchema = z.strictObject({
  id: z.string().regex(/^e\d{1,5}$/),
  kind: z.enum(['img', 'canvas', 'video', 'svg']),
  bbox,
  label: str(160),
  in_viewport: z.boolean(),
  status: z.literal('unperceived'),
  /** Seam for the visual pipeline: sanitized structured OCR. Unused in v0.1. */
  ocr: z.array(z.strictObject({ text: str(200), bbox, confidence: z.number().min(0).max(1) })).max(50).optional(),
});

export const HISTORY_RESULTS = [
  'ok', 'verify_failed', 'rejected', 'stale_target', 'exec_error', 'user_denied', 'handed_to_user', 'answered',
] as const;

export const HistoryEntrySchema = z.strictObject({
  step: int.min(0),
  action: z.strictObject({
    type: z.enum(['click', 'type', 'select', 'scroll', 'wait', 'ask_user', 'done']),
    target: z.string().regex(/^e\d{1,5}$/).optional(),
    text: str(300).optional(),
    option: str(200).optional(),
    direction: z.enum(['up', 'down']).optional(),
    amount_px: int.optional(),
    ms: int.optional(),
  }),
  result: z.enum(HISTORY_RESULTS),
  rule: z.string().regex(/^[A-Z0-9_]{1,40}$/).optional(),
  user_answer: str(300).optional(),
});

export const PlannerPayloadSchema = z.strictObject({
  schema_version: z.literal(CONFIG.SCHEMA_VERSION),
  session_id: z.string().regex(/^[a-z]{16}$/),
  step: int.min(0).max(100),
  task: str(1000),
  page: z.strictObject({
    origin: str(200),
    path: str(300),
    title: str(300),
    viewport: z.strictObject({ w: int, h: int }),
    scroll: z.strictObject({ x: int, y: int, max_y: int }),
  }),
  elements: z.array(ElementSchema).max(CONFIG.IR_MAX_ELEMENTS),
  regions: z.array(RegionSchema).max(60),
  placeholders: z.array(z.strictObject({ id: z.string().regex(PLACEHOLDER_TOKEN), category: z.enum(PII_CATEGORIES) })).max(100),
  history: z.array(HistoryEntrySchema).max(CONFIG.HISTORY_LENGTH),
});
export type PlannerPayload = z.infer<typeof PlannerPayloadSchema>;
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

/** Telemetry envelope. `data` is free-form JSON but still passes every other gate rule. */
export const TelemetryEventSchema = z.strictObject({
  event_id: z.string().regex(/^[a-z0-9]{8,32}$/),
  ts: int,
  session_id: z.string().regex(/^[a-z]{16}$/),
  step: int.min(0),
  type: z.string().regex(/^[A-Z][A-Z0-9_]{2,40}$/),
  stage: z.string().regex(/^[a-z_]{1,32}$/),
  data: z.record(z.string().max(64), z.unknown()),
});
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;
