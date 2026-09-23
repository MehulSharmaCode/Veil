// Dashboard configuration. Stages and event presentation are data, not code: new event types
// (e.g. future VISUAL_REGION_DETECTED, LOCAL_OCR_COMPLETE, REDACTION_APPLIED, PIXELS_WITHHELD) show up
// in the timeline automatically, and a new stage only needs an entry here.

window.VEIL_DASHBOARD_CONFIG = {
  relayUrl: 'http://localhost:8000',

  // Pipeline stage tracker, in order. `stages` lists the envelope `stage` values that light it up.
  stages: [
    { id: 'task', label: 'Task', stages: ['task'] },
    { id: 'snapshot', label: 'DOM snapshot', stages: ['snapshot'] },
    { id: 'ir', label: 'IR', stages: ['ir'] },
    { id: 'sanitize', label: 'Sanitize', stages: ['sanitize'] },
    { id: 'vault', label: 'Local vault', stages: ['vault'] },
    // Reserved for the visual pipeline (hidden until an event with one of these stages arrives).
    { id: 'perception', label: 'Local perception', stages: ['perception', 'ocr', 'redaction'], optional: true },
    { id: 'egress', label: 'Egress gate', stages: ['egress'] },
    { id: 'plan', label: 'LLM planner', stages: ['plan'] },
    { id: 'validate', label: 'Local validation', stages: ['validate'] },
    { id: 'confirm', label: 'Confirmation', stages: ['confirm'] },
    { id: 'execute', label: 'Execute', stages: ['execute'] },
    { id: 'verify', label: 'Verify', stages: ['verify'] },
    { id: 'done', label: 'Done', stages: ['done'] },
  ],

  // Tone per event type for the timeline; anything not listed renders as 'info'.
  tones: {
    EGRESS_CHECK_PASSED: 'ok',
    EGRESS_CHECK_FAILED: 'warn',
    EGRESS_BLOCKED: 'error',
    ACTION_REJECTED: 'warn',
    CONFIRMATION_REQUESTED: 'warn',
    VERIFICATION_COMPLETE: (e) => (e.data.passed ? 'ok' : 'warn'),
    TASK_COMPLETED: (e) => (e.data.outcome === 'done' ? 'ok' : 'warn'),
    ERROR: 'error',
    PIXELS_WITHHELD: 'ok',
  },

  // One-line summaries per event type; unknown types get a generic key=value summary.
  summaries: {
    TASK_STARTED: (d) => `task: ${d.task}`,
    DOM_SNAPSHOT_CREATED: (d) => `${d.elements} elements (${d.interactive} interactive), ${d.regions} regions, ${d.duration_ms} ms`,
    IR_CREATED: (d) => `${d.page?.title ?? ''} ${d.page?.path ?? ''}`,
    PII_DETECTED: (d) => `${d.source}: ${Object.entries(d.counts || {}).map(([k, v]) => `${k}×${v}`).join(', ')}`,
    SANITIZATION_COMPLETE: (d) => `${d.detections} detections, ${d.redacted} redacted, ${d.duration_ms} ms`,
    VAULT_UPDATED: (d) => (d.cleared ? 'vault cleared' : `${d.count} placeholders stored locally`),
    EGRESS_CHECK_PASSED: (d) => `attempt ${d.attempt}, ${d.bytes} bytes`,
    EGRESS_CHECK_FAILED: (d) => (d.failures || []).map((f) => `${f.rule}@${f.path}`).join(', '),
    EGRESS_BLOCKED: (d) => (d.failures || []).map((f) => `${f.rule}@${f.path}`).join(', '),
    REQUEST_SENT: (d) => `${d.bytes} bytes sanitized payload`,
    LLM_ACTION_RECEIVED: (d) => `${d.status}: ${(d.actions || []).map(actionText).join('; ')} (${d.latency_ms} ms)`,
    ACTION_VALIDATED: (d) => `${actionText(d.action)}${d.confirm?.length ? ` → needs confirmation (${d.confirm.join(', ')})` : ''}`,
    ACTION_REJECTED: (d) => `${actionText(d.action)} → ${d.rule ?? d.result}: ${d.reason ?? ''}`,
    CONFIRMATION_REQUESTED: (d) => `${actionText(d.action)} (${(d.rules || []).join(', ')})`,
    CONFIRMATION_RESOLVED: (d) => `${actionText(d.action)} → ${d.approved ? 'approved' : 'denied'} by user`,
    ACTION_EXECUTED: (d) => `${actionText(d.action)} → ${d.ok ? 'ok' : d.error}, ${d.mutations ?? 0} mutations, settled ${d.settle_ms ?? 0} ms`,
    VERIFICATION_COMPLETE: (d) => `${actionText(d.action)} → ${d.passed ? 'verified' : 'NOT verified'} (${d.check})`,
    TASK_COMPLETED: (d) => `${d.outcome}: ${d.message ?? ''}`,
    ERROR: (d) => `${d.code ?? ''} ${d.reason ?? ''}`,
  },
};

function actionText(a) {
  if (!a) return '';
  const bits = [a.type];
  if (a.target) bits.push(a.target);
  if (a.text) bits.push(JSON.stringify(a.text));
  if (a.option) bits.push(JSON.stringify(a.option));
  if (a.direction) bits.push(`${a.direction} ${a.amount_px}px`);
  if (a.ms !== undefined) bits.push(`${a.ms}ms`);
  if (a.question) bits.push(JSON.stringify(a.question));
  if (a.summary) bits.push(JSON.stringify(a.summary));
  return bits.join(' ');
}
window.actionText = actionText;
