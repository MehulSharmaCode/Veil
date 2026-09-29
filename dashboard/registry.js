// Dashboard configuration: data, not logic. Stages, event labels and one-line summaries live here, so
// new event types (e.g. future VISUAL_REGION_DETECTED, LOCAL_OCR_COMPLETE, REDACTION_APPLIED,
// PIXELS_WITHHELD) render in the timeline automatically and a new stage only needs an entry below.
// Nothing here can mark anything as passed: statuses come only from events (see model.js).

export const RELAY_URL = 'http://localhost:8000';

/** Pipeline, in order. `scope: 'task'` stages happen once per task; the rest repeat every loop step. */
export const PIPELINE = [
  { id: 'task', label: 'Task', short: 'Task', scope: 'task', explain: 'Typed in the side panel and sanitized locally before anything else.' },
  { id: 'snapshot', label: 'DOM snapshot', short: 'Snap', explain: 'The content script reads the live page. Field values are never read.' },
  { id: 'ir', label: 'IR', short: 'IR', explain: 'Structured page model: ids, roles, accessible names, field categories.' },
  { id: 'sanitize', label: 'Sanitize', short: 'Sanit', explain: 'Sensitive text is replaced with typed placeholders.' },
  { id: 'vault', label: 'Local vault', short: 'Vault', explain: 'Real values stay in side-panel memory only.' },
  // Reserved for the visual pipeline: shown only once an event with one of these stages arrives.
  { id: 'perception', label: 'Local perception', short: 'Percep', optional: true, explain: 'On-device visual perception (not built in v0.1).' },
  { id: 'egress', label: 'Egress gate', short: 'Gate', explain: 'Rules G0–G7 run before anything leaves the extension.' },
  { id: 'plan', label: 'LLM planner', short: 'Plan', explain: 'The hosted model proposes one action from sanitized data.' },
  { id: 'validate', label: 'Local validation', short: 'Check', explain: 'Local code checks the proposal (V1–V4, T1–T4, R1).' },
  { id: 'confirm', label: 'Confirmation', short: 'Confirm', optional: true, explain: 'A risky action waits for the user to allow or deny it.' },
  { id: 'ask', label: 'Ask user', short: 'Ask', optional: true, explain: 'The planner asked for information; the answer is sanitized locally.' },
  { id: 'resolve', label: 'Resolve locally', short: 'Resolve', explain: 'Placeholder → real value, inside the extension, for this action only.' },
  { id: 'execute', label: 'Execute', short: 'Exec', explain: 'The action is performed in the page.' },
  { id: 'verify', label: 'Verify', short: 'Verify', explain: 'The result is checked after the page settles.' },
  { id: 'done', label: 'Outcome', short: 'End', scope: 'task', explain: 'Done, stopped or failed. The vault is cleared either way.' },
];

/**
 * Presentation only: the pipeline stages grouped into the story a viewer reads left to right. `lane: 'remote'`
 * is the one phase that runs off the device (the hosted planner); everything else runs in this browser.
 * A stage missing from the model's pipeline (an optional stage with no event) is simply not drawn.
 */
export const PHASES = [
  { id: 'asked', label: 'Asked', stages: ['task'] },
  { id: 'saw', label: 'Seen locally', stages: ['snapshot', 'ir', 'perception'] },
  { id: 'kept', label: 'Kept local', stages: ['sanitize', 'vault'] },
  { id: 'gate', label: 'Boundary', stages: ['egress'] },
  { id: 'proposed', label: 'Proposed remotely', stages: ['plan'], lane: 'remote' },
  { id: 'decided', label: 'Decided locally', stages: ['validate', 'confirm', 'ask'] },
  { id: 'acted', label: 'Acted in the page', stages: ['resolve', 'execute'] },
  { id: 'checked', label: 'Checked', stages: ['verify'] },
  { id: 'outcome', label: 'Outcome', stages: ['done'] },
];

/** Envelope `stage` → pipeline stage id. */
export const STAGE_OF = {
  task: 'task', snapshot: 'snapshot', ir: 'ir', sanitize: 'sanitize', vault: 'vault',
  perception: 'perception', ocr: 'perception', redaction: 'perception',
  egress: 'egress', plan: 'plan', validate: 'validate', confirm: 'confirm', ask: 'ask', resolve: 'resolve',
  execute: 'execute', verify: 'verify', done: 'done',
};

/** Human-readable event names for the timeline. Unknown types fall back to the raw type. */
export const LABELS = {
  TASK_STARTED: 'Task started',
  DOM_SNAPSHOT_CREATED: 'DOM snapshot',
  IR_CREATED: 'IR built',
  PII_DETECTED: 'PII detected',
  SANITIZATION_COMPLETE: 'Sanitization',
  VAULT_UPDATED: 'Local vault',
  EGRESS_CHECK_PASSED: 'Egress gate passed',
  EGRESS_CHECK_FAILED: 'Egress gate failed (masking once)',
  EGRESS_BLOCKED: 'Egress BLOCKED',
  REQUEST_SENT: 'Sanitized request sent',
  LLM_ACTION_RECEIVED: 'LLM proposal',
  ACTION_VALIDATED: 'Local validation',
  ACTION_REJECTED: 'Rejected locally',
  CONFIRMATION_REQUESTED: 'Confirmation requested',
  CONFIRMATION_RESOLVED: 'User decision',
  USER_ANSWERED: 'User answered',
  PLACEHOLDER_RESOLVED: 'Resolved locally',
  ACTION_EXECUTED: 'Executed in page',
  VERIFICATION_COMPLETE: 'Verification',
  TASK_COMPLETED: 'Task finished',
  ERROR: 'Error',
};

/** Mirror of the extension gate's G2 forbidden key names, for the dashboard's own re-check of payloads. */
export const FORBIDDEN_KEYS = [
  'value', 'values', 'raw', 'raw_value', 'password', 'passwd', 'pwd', 'secret', 'token', 'html', 'outerhtml', 'innerhtml',
  'dom', 'cookie', 'cookies', 'query', 'querystring', 'search_params', 'href', 'url', 'screenshot', 'pixels', 'image_data',
  'vault', 'normalized', 'otp', 'cvv', 'cvc',
];

export function actionText(a) {
  if (!a) return '';
  const bits = [String(a.type ?? '').toUpperCase()];
  if (a.target) bits.push(`→ ${a.target}`);
  if (a.text !== undefined) bits.push(JSON.stringify(a.text));
  if (a.option !== undefined) bits.push(JSON.stringify(a.option));
  if (a.direction) bits.push(`${a.direction} ${a.amount_px}px`);
  if (a.ms !== undefined) bits.push(`${a.ms} ms`);
  if (a.question) bits.push(JSON.stringify(a.question));
  if (a.summary) bits.push(JSON.stringify(a.summary));
  return bits.join(' ');
}

const counts = (c) => Object.entries(c || {}).map(([k, v]) => `${k} ×${v}`).join(', ');
const fails = (f) => (f || []).map((x) => `${x.rule} at ${x.path || '(message)'}`).join(', ');

/** One-line summaries per event type; unknown types get a generic key=value summary. */
export const SUMMARIES = {
  TASK_STARTED: (d) => `sent as: ${d.task}`,
  DOM_SNAPSHOT_CREATED: (d) => `${d.elements} elements (${d.interactive} interactive), ${d.regions} regions, ${d.duration_ms} ms`,
  IR_CREATED: (d) => `${Object.entries(d.by_kind || {}).map(([k, v]) => `${v} ${k}`).join(', ')} · ${d.page?.path ?? ''}`,
  PII_DETECTED: (d) => `${d.source}: ${counts(d.counts)} → ${(d.placeholders || []).join(' ')}`,
  SANITIZATION_COMPLETE: (d) => `${d.detections} detections, ${d.redacted} redacted, ${d.duration_ms} ms`,
  VAULT_UPDATED: (d) => (d.cleared ? 'vault cleared (0 entries)' : `${d.count} placeholders held locally`),
  EGRESS_CHECK_PASSED: (d) => `attempt ${d.attempt}, ${d.bytes} bytes${d.attempt === 2 ? ' (after masking)' : ''}`,
  EGRESS_CHECK_FAILED: (d) => fails(d.failures),
  EGRESS_BLOCKED: (d) => `nothing sent: ${fails(d.failures)}`,
  REQUEST_SENT: (d) => `${d.request_id ?? ''} · ${d.bytes} bytes · HTTP ${d.http_status ?? '?'} after ${d.response_ms ?? '?'} ms`,
  LLM_ACTION_RECEIVED: (d) => `${d.status}: ${(d.actions || []).map(actionText).join('; ') || '(no action)'} · ${d.latency_ms} ms`,
  ACTION_VALIDATED: (d) => `${actionText(d.action)}${d.confirm?.length ? ` → needs confirmation (${d.confirm.join(', ')})` : ' → allowed'}`,
  ACTION_REJECTED: (d) => `${d.action ? actionText(d.action) : 'planner response'} → ${d.handoff ? 'handed to user' : d.rule ?? d.result}: ${d.reason ?? ''}`,
  CONFIRMATION_REQUESTED: (d) => `${actionText(d.action)} (${(d.rules || []).join(', ')})`,
  CONFIRMATION_RESOLVED: (d) => `${actionText(d.action)} → ${d.approved ? 'approved' : 'DENIED, not executed'}`,
  USER_ANSWERED: (d) => `answer sanitized to: ${d.answer}`,
  PLACEHOLDER_RESOLVED: (d) => `${d.placeholder} (${d.category}) → real value handed to the page for ${d.target}`,
  ACTION_EXECUTED: (d) => `${actionText(d.action)} → ${d.ok ? 'ok' : d.error}${d.settle_ms !== undefined ? `, settled in ${d.settle_ms} ms` : ''}`,
  VERIFICATION_COMPLETE: (d) => `${actionText(d.action)} → ${d.passed ? 'verified' : 'NOT verified'} (${d.check})`,
  TASK_COMPLETED: (d) => `${d.outcome}: ${d.message ?? ''}`,
  ERROR: (d) => `${d.code ?? ''}${d.reason ? `: ${d.reason}` : ''}`,
};
