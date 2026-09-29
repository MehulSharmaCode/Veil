// Dashboard state model: a pure reducer over real telemetry events (browser and Node, no DOM).
// Rule: a stage or check is shown as passed/blocked/failed only if an event says so. Anything the
// stream does not prove stays "pending", "skipped" (the step ended before it), "n/a" (the current
// step's action has no such stage, e.g. DONE has nothing to execute) or "not observed".
// Scope rule: pipeline cards describe the CURRENT loop step; task-wide history is kept per step and
// summarized separately (taskSummary, stageHistory), so "not in this step" never reads as "never".
// Order rule: events are applied in the order they happened (their `ts`), not the order they arrived.

import { FORBIDDEN_KEYS, LABELS, PIPELINE, STAGE_OF, SUMMARIES } from './registry.js';

const STEP_STAGES = PIPELINE.filter((s) => s.scope !== 'task').map((s) => s.id);
const OUTCOME_STATUS = { done: 'passed', stopped: 'stopped', panel_closed: 'stopped', blocked: 'blocked', error: 'failed', max_steps: 'failed' };
export const OUTCOME_LABEL = { done: 'DONE', stopped: 'STOPPED', panel_closed: 'PANEL CLOSED', blocked: 'BLOCKED', error: 'FAILED', max_steps: 'STEP LIMIT' };

export function createState() {
  return {
    session: null,
    seen: new Set(),
    events: [],
    task: null,
    taskTs: null,
    origin: null,
    planner: undefined, // undefined: no TASK_STARTED yet; null: started but planner identity not reported
    limits: null,
    steps: new Map(),
    outcome: null,
    egress: { passed: 0, remediated: 0, failed: 0, blocked: 0, bytes: 0, rules: [] },
    payloads: [],
    categories: {},
    detections: [],
    vault: { entries: [], known: new Map(), count: 0, peak: 0, cleared: false, clearedTs: null },
    ir: null,
    snapshot: null,
    errors: [],
    lastEvent: null,
    reorders: 0, // how often a late event had to be slotted in by time (the timeline re-renders)
  };
}

function stepRec(s, n) {
  if (!s.steps.has(n)) {
    s.steps.set(n, { n, stages: {}, t0: null, proposal: null, validation: null, rejection: null, confirmation: null, answer: null, resolution: null, execution: null, verification: null });
  }
  return s.steps.get(n);
}

function set(rec, id, status, ev, detail, ms) {
  rec.stages[id] = { status, ts: ev.ts, detail: detail ?? '', ms: ms ?? null };
}

const byTs = (a, b) => (a.ts ?? 0) - (b.ts ?? 0);

/**
 * Apply one event. Returns the same state object (mutated), or a fresh one on a new session or when
 * an event arrives out of order (telemetry is delivered asynchronously; a panel-close event is sent
 * immediately and can overtake queued ones). Out-of-order events are slotted in by `ts` and the state
 * is rebuilt, so every view reflects the order in which things happened.
 */
export function reduce(s, ev) {
  if (!ev || typeof ev !== 'object' || !ev.session_id || !ev.type) return s;
  if (ev.session_id !== s.session) {
    s = createState();
    s.session = ev.session_id;
  }
  if (s.seen.has(ev.event_id)) return s;
  const last = s.events[s.events.length - 1];
  if (last && byTs(ev, last) < 0) {
    const events = [...s.events, ev].sort(byTs); // stable: same-ms events keep their emit order
    let fresh = createState();
    fresh.session = s.session;
    for (const e of events) fresh = apply(fresh, e);
    fresh.reorders = s.reorders + 1;
    return fresh;
  }
  return apply(s, ev);
}

function apply(s, ev) {
  s.seen.add(ev.event_id);
  s.events.push(ev);
  s.lastEvent = ev;
  const d = ev.data || {};
  const step = Number.isInteger(ev.step) ? ev.step : 0;
  const rec = stepRec(s, step);
  if (rec.t0 === null) rec.t0 = ev.ts;

  switch (ev.type) {
    case 'TASK_STARTED':
      s.task = d.task ?? null;
      s.taskTs = ev.ts;
      s.origin = d.origin ?? null;
      s.planner = d.planner ?? null;
      s.limits = d.limits ?? null;
      set(rec, 'task', 'passed', ev, 'sanitized locally before anything else');
      break;
    case 'PII_DETECTED':
      for (const [k, v] of Object.entries(d.counts || {})) s.categories[k] = (s.categories[k] || 0) + v;
      s.detections.push({ step, ts: ev.ts, source: d.source, counts: d.counts || {}, placeholders: d.placeholders || [] });
      break;
    case 'VAULT_UPDATED':
      if (d.cleared) {
        s.vault.cleared = true;
        s.vault.clearedTs = ev.ts;
        s.vault.count = 0;
        s.vault.entries = [];
      } else {
        s.vault.entries = d.entries || [];
        s.vault.count = d.count ?? s.vault.entries.length;
        s.vault.peak = Math.max(s.vault.peak, s.vault.count);
        for (const e of s.vault.entries) if (!s.vault.known.has(e.id)) s.vault.known.set(e.id, { ...e, firstStep: step });
        if (step > 0) set(rec, 'vault', 'passed', ev, `${s.vault.count} placeholders held locally`);
      }
      break;
    case 'DOM_SNAPSHOT_CREATED':
      s.snapshot = { ...d, step };
      set(rec, 'snapshot', 'passed', ev, `${d.elements} elements · ${d.interactive} interactive · ${d.regions} regions`, d.duration_ms);
      break;
    case 'IR_CREATED':
      s.ir = { ...d, step, ts: ev.ts };
      set(rec, 'ir', 'passed', ev, Object.entries(d.by_kind || {}).map(([k, v]) => `${v} ${k}`).join(' · '));
      break;
    case 'SANITIZATION_COMPLETE':
      set(rec, 'sanitize', 'passed', ev, `${d.detections} detections · ${d.redacted} redacted`, d.duration_ms);
      break;
    case 'EGRESS_CHECK_PASSED':
      if (d.attempt === 2) s.egress.remediated++;
      else s.egress.passed++;
      s.egress.bytes += d.bytes || 0;
      if (d.rules_checked) s.egress.rules = d.rules_checked;
      set(rec, 'egress', 'passed', ev, `${d.bytes} bytes approved${d.attempt === 2 ? ' after masking' : ''}`);
      set(rec, 'plan', 'running', ev, 'sanitized request dispatched');
      break;
    case 'EGRESS_CHECK_FAILED':
      s.egress.failed++;
      set(rec, 'egress', 'warn', ev, `failed ${(d.failures || []).map((f) => f.rule).join(', ')}: masking and re-checking once`);
      break;
    case 'EGRESS_BLOCKED':
      s.egress.blocked++;
      set(rec, 'egress', 'blocked', ev, `blocked: ${(d.failures || []).map((f) => f.rule).join(', ')}. Nothing sent`);
      break;
    case 'REQUEST_SENT':
      s.payloads.push({ step, ts: ev.ts, request_id: d.request_id ?? null, bytes: d.bytes, http_status: d.http_status ?? null, response_ms: d.response_ms ?? null, payload: d.payload ?? null });
      if (d.http_status >= 400) set(rec, 'plan', 'failed', ev, `planner returned HTTP ${d.http_status}`);
      else set(rec, 'plan', 'running', ev, `response received after ${d.response_ms ?? '?'} ms; validating`);
      break;
    case 'LLM_ACTION_RECEIVED':
      rec.proposal = { ...d, ts: ev.ts };
      set(rec, 'plan', 'passed', ev, (d.actions || []).map((a) => String(a.type).toUpperCase()).join(', ') || d.status, d.latency_ms);
      break;
    case 'ACTION_VALIDATED': {
      const needs = d.confirm?.length > 0;
      rec.validation = { ...d, ts: ev.ts };
      set(rec, 'validate', needs ? 'warn' : 'passed', ev, needs ? `allowed only with confirmation (${d.confirm.join(', ')})` : 'allowed');
      if (d.action?.type === 'ask_user') set(rec, 'ask', 'running', ev, 'waiting for the user');
      break;
    }
    case 'ACTION_REJECTED':
      rec.rejection = { ...d, ts: ev.ts };
      if (d.handoff) set(rec, 'validate', 'warn', ev, `handed to the user (${d.rule})`);
      else if (!d.action) set(rec, 'plan', 'failed', ev, d.reason || 'response rejected by the local schema');
      else set(rec, 'validate', 'blocked', ev, `${d.rule ?? d.result}: ${d.reason ?? ''}`);
      break;
    case 'CONFIRMATION_REQUESTED':
      rec.confirmation = { rules: d.rules || [], action: d.action, approved: null, ts: ev.ts };
      set(rec, 'confirm', 'running', ev, `waiting for the user (${(d.rules || []).join(', ')})`);
      break;
    case 'CONFIRMATION_RESOLVED':
      rec.confirmation = { ...(rec.confirmation || { rules: [] }), action: d.action, approved: !!d.approved, result: d.result ?? null, ts: ev.ts };
      set(rec, 'confirm', d.approved ? 'passed' : 'blocked', ev, d.approved ? 'approved by the user' : 'denied by the user: not executed');
      break;
    case 'USER_ANSWERED':
      rec.answer = { ...d, ts: ev.ts };
      set(rec, 'ask', 'passed', ev, `answer sanitized to ${d.answer}`);
      break;
    case 'PLACEHOLDER_RESOLVED':
      rec.resolution = { ...d, ts: ev.ts };
      set(rec, 'resolve', 'passed', ev, `${d.placeholder} → real value, locally`);
      break;
    case 'ACTION_EXECUTED':
      rec.execution = { ...d, ts: ev.ts };
      set(rec, 'execute', d.ok ? 'passed' : 'failed', ev,
        d.ok
          ? `${String(d.action?.type ?? '').toUpperCase()} ran in the page · ${d.mutations ?? 0} mutations${d.after_stop ? ' · finished after Stop (was already dispatched; cannot be recalled)' : ''}`
          : `error: ${d.error}`,
        d.settle_ms);
      break;
    case 'VERIFICATION_COMPLETE':
      rec.verification = { ...d, ts: ev.ts };
      set(rec, 'verify', d.passed ? 'passed' : 'failed', ev, `${d.check}: ${d.passed ? 'confirmed' : 'NOT confirmed'}`);
      break;
    case 'ERROR':
      s.errors.push({ step, ts: ev.ts, code: d.code, reason: d.reason ?? null });
      if (String(d.code).startsWith('PLANNER')) set(rec, 'plan', 'failed', ev, d.reason || d.code);
      else if (d.code === 'EXEC_FAILED') set(rec, 'execute', 'failed', ev, d.reason || d.code);
      break;
    case 'TASK_COMPLETED': {
      s.outcome = { ...d, ts: ev.ts, step };
      // Anything still running in this step did not complete: say so instead of leaving it animated.
      for (const st of Object.values(rec.stages)) if (st.status === 'running') st.status = 'interrupted';
      const task = stepRec(s, 0);
      // DONE is the planner's declaration, accepted by local code; it is not a local proof that the goal was met.
      const why = d.outcome === 'done' ? 'planner declared the task complete (accepted locally)' : d.message ?? '';
      set(task, 'done', OUTCOME_STATUS[d.outcome] ?? 'failed', ev, `${OUTCOME_LABEL[d.outcome] ?? d.outcome}: ${why}${d.outcome === 'done' && d.message ? ` · “${d.message}”` : ''}`);
      break;
    }
    default: {
      // Unknown/future event types: record that the stage was observed, without claiming success.
      const id = STAGE_OF[ev.stage];
      if (id && id !== 'task' && id !== 'done') set(rec, id, 'observed', ev, summarize(ev));
    }
  }
  return s;
}

export function reduceAll(events, s = createState()) {
  for (const ev of events) s = reduce(s, ev);
  return s;
}

// ---- derived views ----------------------------------------------------------------------------

export function summarize(ev) {
  const f = SUMMARIES[ev.type];
  if (f) {
    try {
      return f(ev.data || {});
    } catch {
      /* fall through */
    }
  }
  return Object.entries(ev.data || {})
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join('  ')
    .slice(0, 300);
}

export function label(ev) {
  return LABELS[ev.type] ?? ev.type;
}

/** Timeline status of a single event. */
export function eventStatus(ev) {
  const d = ev.data || {};
  switch (ev.type) {
    case 'EGRESS_BLOCKED': return 'blocked';
    case 'EGRESS_CHECK_FAILED': return 'warn';
    case 'ACTION_REJECTED': return d.handoff ? 'warn' : 'blocked';
    case 'CONFIRMATION_REQUESTED': return 'warn';
    case 'CONFIRMATION_RESOLVED': return d.approved ? 'passed' : 'blocked';
    case 'ACTION_VALIDATED': return d.confirm?.length ? 'warn' : 'passed';
    case 'ACTION_EXECUTED': return !d.ok ? 'failed' : d.after_stop ? 'warn' : 'passed';
    case 'VERIFICATION_COMPLETE': return d.passed ? 'passed' : 'failed';
    case 'REQUEST_SENT': return d.http_status >= 400 ? 'failed' : 'passed';
    case 'TASK_COMPLETED': return OUTCOME_STATUS[d.outcome] ?? 'failed';
    case 'ERROR': return 'failed';
    default: return LABELS[ev.type] ? 'passed' : 'observed';
  }
}

export function latestStep(s) {
  let n = 0;
  for (const k of s.steps.keys()) if (k > n) n = k;
  return n;
}

export function overall(s) {
  if (!s.session) return { status: 'IDLE', tone: 'muted' };
  if (s.outcome) return { status: OUTCOME_LABEL[s.outcome.outcome] ?? String(s.outcome.outcome).toUpperCase(), tone: OUTCOME_STATUS[s.outcome.outcome] ?? 'failed' };
  return { status: 'RUNNING', tone: 'running' };
}

const BROWSER_ACTIONS = new Set(['click', 'type', 'select', 'scroll']);

/**
 * A browser action that was dispatched to the page but whose result was never reported, because the
 * task ended (Stop / panel close) while it ran. In the agent, dispatch follows ACTION_VALIDATED (or an
 * approved CONFIRMATION_RESOLVED) synchronously, so such a step proves dispatch but not the result.
 */
export function inFlight(s, rec) {
  if (!rec || !s.outcome || rec.execution || rec.rejection) return false;
  if (!['stopped', 'panel_closed'].includes(s.outcome.outcome) || s.outcome.step !== rec.n) return false;
  const v = rec.validation;
  if (!v || !BROWSER_ACTIONS.has(v.action?.type)) return false;
  if (v.confirm?.length && rec.confirmation?.approved !== true) return false;
  return !s.errors.some((e) => e.step === rec.n);
}

/** Status of one loop-step stage in one step record, after the task ended (running → interrupted). */
function stageIn(s, rec, id) {
  const st = rec?.stages[id];
  if (!st) return null;
  return s.outcome && st.status === 'running' ? { ...st, status: 'interrupted' } : st;
}

/** Task-wide history of one loop stage: which steps passed / failed / were blocked there. */
export function stageHistory(s, id) {
  const out = {};
  for (const [n, rec] of s.steps) {
    if (n === 0) continue;
    const st = stageIn(s, rec, id);
    if (st) (out[st.status] ||= []).push(n);
  }
  return out;
}

/** Pipeline cards: task-level stages plus the stages of the latest (current) loop step. */
export function pipeline(s) {
  const n = latestStep(s);
  const rec = s.steps.get(n);
  const taskRec = s.steps.get(0);
  const closed = !!s.outcome;
  const actionType = rec?.validation?.action?.type ?? rec?.proposal?.actions?.[0]?.type ?? null;
  const noBrowserAction = actionType && !BROWSER_ACTIONS.has(actionType) && rec?.validation;
  const denied = rec?.confirmation && rec.confirmation.approved === false;
  const rejected = rec?.rejection && !rec.rejection.handoff && rec.rejection.action;
  const flying = inFlight(s, rec);
  const last = latestBrowserAction(s);
  const lastNote = last && last.n !== n ? ` · most recent browser action: step ${last.n}` : '';
  return PIPELINE.filter((p) => {
    if (!p.optional) return true;
    return n > 0 && rec?.stages[p.id];
  }).map((p) => {
    const scope = p.scope === 'task' ? 'task' : 'step';
    const history = scope === 'step' ? stageHistory(s, p.id) : null;
    const base = { ...p, scope, step: scope === 'task' ? null : n, history };
    const st = scope === 'task' ? taskRec?.stages[p.id] : n > 0 ? stageIn(s, rec, p.id) : null;
    if (st) return { ...base, ...st };
    let detail = '';
    let status = 'pending';
    if (scope === 'step' && n > 0 && flying && p.id === 'execute') {
      return { ...base, status: 'interrupted', detail: `dispatched to the page when the task ended: it may have run; result not observed`, ts: null, ms: null };
    }
    const stepDone = closed || (rec && (rec.execution || rec.verification || denied || rejected || noBrowserAction));
    if (scope === 'step' && n > 0 && noBrowserAction && ['resolve', 'execute', 'verify'].includes(p.id)) {
      status = 'na';
      detail = `no browser action in step ${n} (${String(actionType).toUpperCase()})${lastNote}`;
    } else if (scope === 'step' && n > 0 && p.id === 'resolve' && rec?.execution) {
      status = 'na';
      detail = 'no placeholder in this action';
    } else if (scope === 'step' && n > 0 && stepDone) {
      status = 'skipped';
      if (denied) detail = 'blocked before this stage';
      else if (rejected) detail = 'rejected before this stage';
      else if (p.id === 'verify' && rec?.execution?.after_stop) detail = 'not verified: the task was stopped';
      else if (p.id === 'verify' && flying) detail = 'not verified: the task ended first';
      else detail = closed ? 'not reached before the task ended' : 'not needed in this step';
    }
    return { ...base, status, detail, ts: null, ms: null };
  });
}

/** The latest step that performed, or dispatched, a browser action (not DONE / ASK_USER / WAIT). */
export function latestBrowserAction(s) {
  const ns = [...s.steps.keys()].sort((a, b) => b - a);
  for (const n of ns) {
    const rec = s.steps.get(n);
    if ((rec.execution && BROWSER_ACTIONS.has(rec.execution.action?.type)) || rec.resolution || inFlight(s, rec)) return rec;
  }
  return null;
}

/** Task-wide facts for the whole run, so a DONE step is never read as "nothing happened". */
export function taskSummary(s) {
  const out = { steps: 0, browserActions: 0, executedOk: 0, verified: 0, notVerified: 0, denied: 0, rejected: 0, answered: 0, inFlight: 0, lastBrowser: null };
  for (const [n, rec] of s.steps) {
    if (n === 0) continue;
    out.steps++;
    const x = rec.execution;
    if (x && BROWSER_ACTIONS.has(x.action?.type)) {
      out.browserActions++;
      if (x.ok) out.executedOk++;
    }
    if (rec.verification) rec.verification.passed ? out.verified++ : out.notVerified++;
    if (rec.confirmation?.approved === false) out.denied++;
    if (rec.rejection && !rec.rejection.handoff) out.rejected++;
    if (rec.answer) out.answered++;
    if (inFlight(s, rec)) out.inFlight++;
  }
  const lb = latestBrowserAction(s);
  if (lb) {
    const a = lb.execution?.action ?? lb.validation?.action ?? null;
    let result = 'in progress';
    if (lb.verification) result = lb.verification.passed ? 'verified' : 'NOT verified';
    else if (lb.execution && !lb.execution.ok) result = 'execution failed';
    else if (lb.execution?.after_stop) result = 'ran after Stop, not verified';
    else if (inFlight(s, lb)) result = 'in flight when the task ended; result not observed';
    else if (lb.execution) result = 'executed, verifying';
    out.lastBrowser = { n: lb.n, action: a, result };
  }
  return out;
}

/** One row per loop step. */
export function stepHistory(s) {
  const out = [];
  for (const [n, rec] of [...s.steps.entries()].sort((a, b) => a[0] - b[0])) {
    if (n === 0) continue;
    const stages = STEP_STAGES.filter((id) => rec.stages[id]).map((id) => ({ id, label: PIPELINE.find((p) => p.id === id).label, status: stageIn(s, rec, id).status }));
    const proposal = rec.proposal?.actions?.[0] ?? null;
    let result = { text: 'in progress', tone: 'running' };
    if (rec.verification) result = rec.verification.passed ? { text: 'verified', tone: 'passed' } : { text: 'NOT verified', tone: 'failed' };
    else if (rec.execution && !rec.execution.ok) result = { text: 'execution failed', tone: 'failed' };
    else if (rec.execution?.after_stop) result = { text: 'ran after Stop (already dispatched), not verified', tone: 'stopped' };
    else if (inFlight(s, rec)) result = { text: 'in flight when the task ended; result not observed', tone: 'interrupted' };
    else if (rec.confirmation?.approved === false) result = { text: 'blocked (user denied)', tone: 'blocked' };
    else if (rec.rejection) result = rec.rejection.handoff ? { text: 'handed to user', tone: 'warn' } : { text: `rejected (${rec.rejection.rule ?? rec.rejection.result})`, tone: 'blocked' };
    else if (rec.answer) result = { text: 'user answered (sanitized)', tone: 'passed' };
    else if (proposal?.type === 'done') result = { text: 'done', tone: 'passed' };
    else if (rec.stages.plan?.status === 'failed') result = { text: 'planner failed', tone: 'failed' };
    else if (rec.stages.egress?.status === 'blocked') result = { text: 'egress blocked', tone: 'blocked' };
    if (result.tone === 'running' && s.outcome && s.outcome.step === n) result = { text: `ended: ${OUTCOME_LABEL[s.outcome.outcome] ?? s.outcome.outcome}`, tone: OUTCOME_STATUS[s.outcome.outcome] ?? 'failed' };
    out.push({ n, stages, proposal, result, ts: rec.t0 });
  }
  return out;
}

/** Latest step that has an LLM proposal (the decision view shows this one). */
export function latestDecision(s) {
  const ns = [...s.steps.keys()].sort((a, b) => b - a);
  for (const n of ns) {
    const rec = s.steps.get(n);
    if (rec.proposal || rec.rejection) return rec;
  }
  return null;
}

/** Latest step that performed (or tried to perform) an action in the page, including WAIT. */
export function latestExecution(s) {
  const ns = [...s.steps.keys()].sort((a, b) => b - a);
  for (const n of ns) {
    const rec = s.steps.get(n);
    if (rec.execution || rec.resolution || inFlight(s, rec)) return rec;
  }
  return null;
}

/**
 * The dashboard's own re-check of an outbound payload (independent of the extension's gate): forbidden
 * key names anywhere, HTML markup in any string, and whether any element carries more than has_value +
 * value_category about its value.
 */
export function recheckPayload(payload) {
  const forbidden = new Set(FORBIDDEN_KEYS);
  const html = /<\/?[a-zA-Z][\w:-]*(?:\s[^<>]*)?\/?>|<!--|<!doctype/i;
  const found = { forbiddenKeys: [], htmlStrings: 0, strings: 0, keys: new Set() };
  const walk = (v, path) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (path === '') found.keys.add(k);
        if (forbidden.has(k.toLowerCase())) found.forbiddenKeys.push(`${path}.${k}`);
        walk(x, `${path}.${k}`);
      }
      return;
    }
    if (typeof v === 'string') {
      found.strings++;
      if (html.test(v)) found.htmlStrings++;
    }
  };
  walk(payload, '');
  const elements = Array.isArray(payload?.elements) ? payload.elements : [];
  const withValueInfo = elements.filter((e) => e?.state && ('has_value' in e.state || 'value_category' in e.state)).length;
  const placeholders = new Set();
  JSON.stringify(payload ?? null).replace(/\[[A-Z]+_\d+\]/g, (m) => placeholders.add(m));
  return {
    topLevelKeys: [...found.keys],
    forbiddenKeys: found.forbiddenKeys,
    htmlStrings: found.htmlStrings,
    strings: found.strings,
    elements: elements.length,
    elementsWithValueMetadataOnly: withValueInfo,
    placeholders: [...placeholders],
  };
}

export function elapsedMs(s, now = Date.now()) {
  if (!s.taskTs) return null;
  return (s.outcome?.ts ?? now) - s.taskTs;
}
