// Unit tests for the dashboard reducer (node --test; no dependencies). The event sequences below are
// test fixtures shaped like real VEIL telemetry; they never reach the running dashboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createState, reduceAll as reduceAllRaw, reduce, pipeline, stepHistory, overall, recheckPayload, latestDecision, latestBrowserAction,
  taskSummary, stageHistory, eventStatus,
} from '../model.js';

let n = 0;
const E = (step, type, stage, data = {}, session = 'abcdefghijklmnop') => ({ event_id: `ev${String(++n).padStart(6, '0')}`, ts: 1000 + n * 10, session_id: session, step, type, stage, data });
// Fixtures are listed in the order the agent emits them; stamp `ts` in that order (the reducer orders by
// ts, like real telemetry, which is stamped at emit time).
let clock = 1_000_000;
const stamp = (evs) => evs.map((e) => ({ ...e, ts: (clock += 10) }));
const reduceAll = (evs, s) => reduceAllRaw(stamp(evs), s);
const stage = (s, id) => pipeline(s).find((c) => c.id === id);
const TYPE = { type: 'type', target: 'e12', text: '[EMAIL_1]' };
const SAVE = { type: 'click', target: 'e14' };

function stepEvents(step, extra) {
  return [
    E(step, 'DOM_SNAPSHOT_CREATED', 'snapshot', { elements: 26, interactive: 12, regions: 1, candidates: 26, pruned: 0, duration_ms: 2 }),
    E(step, 'IR_CREATED', 'ir', { page: { origin: 'http://localhost:8080', path: '/', title: 'Edit profile' }, by_kind: { interactive: 12 }, regions: [], interactive: [{ id: 'e12', role: 'textbox', name: 'Alternate email' }] }),
    E(step, 'PII_DETECTED', 'sanitize', { source: 'page', counts: { EMAIL: 1 }, placeholders: ['[EMAIL_1]'] }),
    E(step, 'VAULT_UPDATED', 'vault', { entries: [{ id: '[EMAIL_1]', category: 'EMAIL', source: 'page', sensitivity: 'normal', stored: 'locally' }], count: 1 }),
    E(step, 'SANITIZATION_COMPLETE', 'sanitize', { detections: 1, redacted: 0, duration_ms: 1 }),
    E(step, 'EGRESS_CHECK_PASSED', 'egress', { attempt: 1, bytes: 7500, failures: [], rules_checked: ['G0_GATE_ERROR', 'G7_SIZE'] }),
    ...extra,
  ];
}
const started = () => [E(0, 'TASK_STARTED', 'task', { task: 'Fill my alternate email with my email.', planner: { provider: 'groq', model: 'openai/gpt-oss-20b', effort: 'medium' }, limits: { max_steps: 15 } })];
const sent = (step) => E(step, 'REQUEST_SENT', 'egress', { request_id: `abcdefghijklmnop-${step}`, bytes: 7500, http_status: 200, response_ms: 800, payload: { task: 'x', elements: [], placeholders: [{ id: '[EMAIL_1]', category: 'EMAIL' }] } });

test('success path: every stage is lit only by its own event, then DONE with the vault cleared', () => {
  const s = reduceAll([
    ...started(),
    ...stepEvents(1, [
      sent(1),
      E(1, 'LLM_ACTION_RECEIVED', 'plan', { status: 'continue', actions: [TYPE], message: 'fill', latency_ms: 800, schema: 'valid' }),
      E(1, 'ACTION_VALIDATED', 'validate', { action: TYPE, confirm: [], checks: ['V1_ACTION'], live_checks: ['V2_TARGET', 'V3_FINGERPRINT'], taint: { placeholder: '[EMAIL_1]', placeholder_category: 'EMAIL', field_category: 'email' } }),
      E(1, 'PLACEHOLDER_RESOLVED', 'resolve', { placeholder: '[EMAIL_1]', category: 'EMAIL', target: 'e12' }),
      E(1, 'ACTION_EXECUTED', 'execute', { action: TYPE, ok: true, mutations: 0, settle_ms: 307, settled: true }),
      E(1, 'VERIFICATION_COMPLETE', 'verify', { action: TYPE, passed: true, check: 'value_matches_after_settle' }),
    ]),
    ...stepEvents(2, [
      sent(2),
      E(2, 'LLM_ACTION_RECEIVED', 'plan', { status: 'done', actions: [{ type: 'done', summary: 'ok' }], latency_ms: 900, schema: 'valid' }),
      E(2, 'ACTION_VALIDATED', 'validate', { action: { type: 'done', summary: 'ok' }, confirm: [], checks: ['V1_ACTION'] }),
      E(2, 'VAULT_UPDATED', 'vault', { entries: [], count: 0, cleared: true }),
      E(2, 'TASK_COMPLETED', 'done', { outcome: 'done', message: 'ok', steps: 2 }),
    ]),
  ]);
  assert.equal(overall(s).status, 'DONE');
  assert.equal(stage(s, 'done').status, 'passed');
  // Latest step is 2 (DONE): it has no browser action, so resolve/execute/verify are "n/a in this step",
  // never passed and never "skipped" (which would read as "the task never did it"). The task-wide record
  // on the same cards says they passed in step 1.
  for (const id of ['resolve', 'execute', 'verify']) {
    assert.equal(stage(s, id).status, 'na', id);
    assert.equal(stage(s, id).scope, 'step');
    assert.match(stage(s, id).detail, /no browser action in step 2 \(DONE\) · most recent browser action: step 1/);
    assert.deepEqual(stage(s, id).history, { passed: [1] }, id);
  }
  const t = taskSummary(s);
  assert.equal(t.browserActions, 1);
  assert.equal(t.verified, 1);
  assert.equal(t.lastBrowser.n, 1);
  assert.equal(t.lastBrowser.result, 'verified');
  assert.equal(latestBrowserAction(s).n, 1);
  assert.match(stage(s, 'done').detail, /planner declared the task complete \(accepted locally\)/);
  assert.equal(stage(s, 'plan').status, 'passed');
  const hist = stepHistory(s);
  assert.deepEqual(hist.map((h) => h.result.text), ['verified', 'done']);
  assert.ok(hist[0].stages.some((x) => x.id === 'resolve' && x.status === 'passed'));
  assert.equal(s.vault.cleared, true);
  assert.equal(s.vault.peak, 1);
  assert.equal(s.payloads.length, 2);
  assert.deepEqual(s.planner, { provider: 'groq', model: 'openai/gpt-oss-20b', effort: 'medium' });
});

test('denied Save: confirmation is BLOCKED and nothing after it is claimed', () => {
  const s = reduceAll([
    ...started(),
    ...stepEvents(1, [
      sent(1),
      E(1, 'LLM_ACTION_RECEIVED', 'plan', { status: 'continue', actions: [SAVE], latency_ms: 800, schema: 'valid' }),
      E(1, 'ACTION_VALIDATED', 'validate', { action: SAVE, confirm: ['R1_SUBMIT_LIKE'], checks: ['V1_ACTION', 'R1_SUBMIT_LIKE'], live_checks: ['V2_TARGET', 'V3_FINGERPRINT'], taint: null }),
      E(1, 'CONFIRMATION_REQUESTED', 'confirm', { action: SAVE, rules: ['R1_SUBMIT_LIKE'] }),
      E(1, 'CONFIRMATION_RESOLVED', 'confirm', { action: SAVE, approved: false, result: 'blocked_not_executed' }),
    ]),
  ]);
  assert.equal(stage(s, 'validate').status, 'warn');
  assert.equal(stage(s, 'confirm').status, 'blocked');
  for (const id of ['resolve', 'execute', 'verify']) {
    assert.equal(stage(s, id).status, 'skipped', id);
    assert.equal(stage(s, id).detail, 'blocked before this stage');
  }
  assert.equal(stepHistory(s)[0].result.text, 'blocked (user denied)');
  assert.equal(latestDecision(s).confirmation.approved, false);
  assert.equal(overall(s).status, 'RUNNING');
});

test('Stop while the planner is running: the running stage becomes INTERRUPTED, not passed', () => {
  const s = reduceAll([...started(), ...stepEvents(1, []), E(1, 'VAULT_UPDATED', 'vault', { entries: [], count: 0, cleared: true }), E(1, 'TASK_COMPLETED', 'done', { outcome: 'stopped', message: 'Stopped by user. Vault cleared.', steps: 1 })]);
  assert.equal(stage(s, 'plan').status, 'interrupted');
  assert.equal(stage(s, 'done').status, 'stopped');
  assert.equal(overall(s).status, 'STOPPED');
  assert.equal(stage(s, 'execute').status, 'skipped');
});

test('panel close and egress block are reported as such', () => {
  const closed = reduceAll([...started(), E(1, 'TASK_COMPLETED', 'done', { outcome: 'panel_closed', message: 'Panel closed.', steps: 1 })]);
  assert.equal(overall(closed).status, 'PANEL CLOSED');
  const blocked = reduceAll([
    ...started(),
    E(1, 'EGRESS_CHECK_FAILED', 'egress', { attempt: 1, bytes: 10, failures: [{ rule: 'G6_TRIPWIRE', path: 'task' }] }),
    E(1, 'EGRESS_BLOCKED', 'egress', { attempt: 2, bytes: 10, failures: [{ rule: 'G1_SCHEMA', path: '' }] }),
    E(1, 'TASK_COMPLETED', 'done', { outcome: 'blocked', message: 'blocked', steps: 1 }),
  ]);
  assert.equal(stage(blocked, 'egress').status, 'blocked');
  assert.equal(blocked.egress.blocked, 1);
  assert.equal(overall(blocked).status, 'BLOCKED');
  assert.equal(stage(blocked, 'plan').status, 'skipped');
});

test('planner failure and local schema rejection are shown as failed', () => {
  const s = reduceAll([...started(), ...stepEvents(1, [E(1, 'REQUEST_SENT', 'egress', { request_id: 'r', bytes: 1, http_status: 502, response_ms: 5, payload: {} }), E(1, 'ERROR', 'error', { code: 'PLANNER_ERROR', reason: 'Planner error: HTTP 502' }), E(1, 'TASK_COMPLETED', 'done', { outcome: 'error', message: 'x', steps: 1 })])]);
  assert.equal(stage(s, 'plan').status, 'failed');
  assert.equal(overall(s).status, 'FAILED');
  const bad = reduceAll([...started(), ...stepEvents(1, [sent(1), E(1, 'ACTION_REJECTED', 'validate', { rule: 'V1_ACTION', reason: 'planner response failed local schema validation' })])]);
  assert.equal(stage(bad, 'plan').status, 'failed');
});

test('no fabricated progress: an early session shows pending stages and "not reported" planner', () => {
  const s = reduceAll([E(0, 'TASK_STARTED', 'task', { task: 't' }), E(1, 'DOM_SNAPSHOT_CREATED', 'snapshot', { elements: 1, interactive: 0, regions: 0, duration_ms: 1 })]);
  assert.equal(s.planner, null);
  assert.equal(stage(s, 'snapshot').status, 'passed');
  for (const id of ['ir', 'sanitize', 'egress', 'plan', 'validate', 'execute', 'verify']) assert.equal(stage(s, id).status, 'pending', id);
  assert.equal(stage(s, 'done').status, 'pending');
  assert.equal(overall(createState()).status, 'IDLE');
});

test('unknown future events are "observed", never "passed"; duplicates are ignored; a new session resets', () => {
  let s = reduceAll([...started(), E(1, 'LOCAL_OCR_COMPLETE', 'ocr', { lines: 3 })]);
  assert.equal(stage(s, 'perception').status, 'observed');
  const dup = E(1, 'DOM_SNAPSHOT_CREATED', 'snapshot', { elements: 1, interactive: 0, regions: 0, duration_ms: 1 });
  s = reduce(reduce(s, dup), dup);
  assert.equal(s.events.filter((e) => e.event_id === dup.event_id).length, 1);
  s = reduce(s, E(0, 'TASK_STARTED', 'task', { task: 'new' }, 'zyxwvutsrqponmlk'));
  assert.equal(s.session, 'zyxwvutsrqponmlk');
  assert.equal(s.events.length, 1);
});

test('payload re-check flags forbidden keys and HTML, and lists placeholders', () => {
  const clean = recheckPayload({ task: 'Fill [EMAIL_1]', elements: [{ id: 'e1', state: { has_value: true, value_category: 'email' } }] });
  assert.deepEqual(clean.forbiddenKeys, []);
  assert.equal(clean.htmlStrings, 0);
  assert.deepEqual(clean.placeholders, ['[EMAIL_1]']);
  assert.equal(clean.elementsWithValueMetadataOnly, 1);
  const dirty = recheckPayload({ task: '<b>x</b>', elements: [{ state: { value: 'secret' } }] });
  assert.deepEqual(dirty.forbiddenKeys, ['.elements[0].state.value']);
  assert.equal(dirty.htmlStrings, 1);
});

// ---- hardening pass (2026-09-28): scope, ordering and in-flight truthfulness ----------------------

const typed = (step, tgt = 'e12', ph = '[EMAIL_1]') => {
  const a = { type: 'type', target: tgt, text: ph };
  return [
    sent(step),
    E(step, 'LLM_ACTION_RECEIVED', 'plan', { status: 'continue', actions: [a], latency_ms: 800, schema: 'valid' }),
    E(step, 'ACTION_VALIDATED', 'validate', { action: a, confirm: [], checks: ['V1_ACTION'], live_checks: ['V2_TARGET', 'V3_FINGERPRINT'], taint: { placeholder: ph, placeholder_category: 'EMAIL', field_category: 'email' } }),
    E(step, 'PLACEHOLDER_RESOLVED', 'resolve', { placeholder: ph, category: 'EMAIL', target: tgt }),
  ];
};
const executed = (step, extra = {}) => E(step, 'ACTION_EXECUTED', 'execute', { action: TYPE, ok: true, mutations: 0, settle_ms: 307, settled: true, ...extra });
const verified = (step, passed = true) => E(step, 'VERIFICATION_COMPLETE', 'verify', { action: TYPE, passed, check: 'value_matches_after_settle' });

test('events are applied in the order they happened, even when a late one arrives after the outcome', () => {
  // Panel close sends VAULT_UPDATED + TASK_COMPLETED immediately; a queued event with an earlier ts
  // can arrive after them. The reducer slots it in by time and rebuilds.
  const evs = stamp([...started(), ...stepEvents(1, [])]);
  const egress = evs.pop(); // EGRESS_CHECK_PASSED, delivered late
  const closed = stamp([E(1, 'VAULT_UPDATED', 'vault', { entries: [], count: 0, cleared: true }), E(1, 'TASK_COMPLETED', 'done', { outcome: 'panel_closed', message: 'Panel closed.', steps: 1 })]);
  let s = reduceAllRaw([...evs, ...closed]);
  s = reduce(s, egress);
  assert.equal(s.reorders, 1);
  assert.deepEqual(s.events.map((e) => e.ts), [...s.events.map((e) => e.ts)].sort((a, b) => a - b));
  assert.equal(s.events.at(-1).type, 'TASK_COMPLETED');
  // The planner request was dispatched but never answered: interrupted, not "running" and not passed.
  assert.equal(stage(s, 'plan').status, 'interrupted');
  assert.equal(overall(s).status, 'PANEL CLOSED');
});

test('panel close with a validated action in flight: execute is INTERRUPTED ("may have run"), never passed or "not reached"', () => {
  const s = reduceAll([
    ...started(),
    ...stepEvents(1, [...typed(1), E(1, 'VAULT_UPDATED', 'vault', { entries: [], count: 0, cleared: true }), E(1, 'TASK_COMPLETED', 'done', { outcome: 'panel_closed', message: 'Panel closed.', steps: 1 })]),
  ]);
  assert.equal(stage(s, 'resolve').status, 'passed');
  assert.equal(stage(s, 'execute').status, 'interrupted');
  assert.match(stage(s, 'execute').detail, /may have run; result not observed/);
  assert.equal(stage(s, 'verify').status, 'skipped');
  assert.equal(stage(s, 'verify').detail, 'not verified: the task ended first');
  assert.match(stepHistory(s)[0].result.text, /in flight/);
  assert.equal(taskSummary(s).inFlight, 1);
  assert.equal(taskSummary(s).executedOk, 0);
});

test('Stop while a confirmation is pending: nothing was dispatched, so execute is "not reached", not in flight', () => {
  const s = reduceAll([
    ...started(),
    ...stepEvents(1, [
      sent(1),
      E(1, 'LLM_ACTION_RECEIVED', 'plan', { status: 'continue', actions: [SAVE], latency_ms: 800, schema: 'valid' }),
      E(1, 'ACTION_VALIDATED', 'validate', { action: SAVE, confirm: ['R1_SUBMIT_LIKE'], checks: ['V1_ACTION', 'R1_SUBMIT_LIKE'], live_checks: [], taint: null }),
      E(1, 'CONFIRMATION_REQUESTED', 'confirm', { action: SAVE, rules: ['R1_SUBMIT_LIKE'] }),
      E(1, 'TASK_COMPLETED', 'done', { outcome: 'stopped', message: 'Stopped by user. Vault cleared.', steps: 1 }),
    ]),
  ]);
  assert.equal(stage(s, 'confirm').status, 'interrupted');
  assert.equal(stage(s, 'execute').status, 'skipped');
  assert.equal(stage(s, 'execute').detail, 'not reached before the task ended');
  assert.equal(taskSummary(s).inFlight, 0);
  assert.equal(latestBrowserAction(s), null);
});

test('an action that finishes after Stop is reported as run (flagged), and is not verified', () => {
  const s = reduceAll([
    ...started(),
    ...stepEvents(1, [...typed(1), E(1, 'TASK_COMPLETED', 'done', { outcome: 'stopped', message: 'Stopped by user. Vault cleared.', steps: 1 }), executed(1, { after_stop: true })]),
  ]);
  assert.equal(stage(s, 'execute').status, 'passed');
  assert.match(stage(s, 'execute').detail, /finished after Stop/);
  assert.equal(stage(s, 'verify').status, 'skipped');
  assert.equal(stage(s, 'verify').detail, 'not verified: the task was stopped');
  assert.equal(eventStatus(s.events.at(-1)), 'warn');
  assert.match(stepHistory(s)[0].result.text, /ran after Stop/);
  assert.equal(overall(s).status, 'STOPPED');
});

test('current step ASK_USER after browser actions: loop stages are n/a in this step, task-wide history is kept', () => {
  const ask = { type: 'ask_user', question: 'What is your address?' };
  const s = reduceAll([
    ...started(),
    ...stepEvents(1, [...typed(1), executed(1), verified(1, false)]),
    ...stepEvents(2, [...typed(2), executed(2), verified(2, true)]),
    ...stepEvents(3, [sent(3), E(3, 'LLM_ACTION_RECEIVED', 'plan', { status: 'need_user', actions: [ask], latency_ms: 700, schema: 'valid' }), E(3, 'ACTION_VALIDATED', 'validate', { action: ask, confirm: [], checks: ['V1_ACTION'] })]),
  ]);
  for (const id of ['resolve', 'execute', 'verify']) {
    assert.equal(stage(s, id).status, 'na', id);
    assert.match(stage(s, id).detail, /no browser action in step 3 \(ASK_USER\) · most recent browser action: step 2/);
  }
  assert.deepEqual(stage(s, 'verify').history, { failed: [1], passed: [2] });
  assert.deepEqual(stageHistory(s, 'execute'), { passed: [1, 2] });
  assert.equal(stage(s, 'ask').status, 'running');
  const t = taskSummary(s);
  assert.equal(t.steps, 3);
  assert.equal(t.browserActions, 2);
  assert.equal(t.verified, 1);
  assert.equal(t.notVerified, 1);
  assert.equal(t.lastBrowser.n, 2);
});

test('missing events never become PASSED: a proposal followed by an error shows no validation, execution or verification', () => {
  const s = reduceAll([
    ...started(),
    ...stepEvents(1, [
      sent(1),
      E(1, 'LLM_ACTION_RECEIVED', 'plan', { status: 'continue', actions: [TYPE], latency_ms: 800, schema: 'valid' }),
      E(1, 'ERROR', 'error', { code: 'CONTENT_ERROR', reason: 'Content script error: no response' }),
      E(1, 'TASK_COMPLETED', 'done', { outcome: 'error', message: 'x', steps: 1 }),
    ]),
  ]);
  for (const id of ['validate', 'resolve', 'execute', 'verify']) {
    assert.notEqual(stage(s, id).status, 'passed', id);
    assert.equal(stage(s, id).status, 'skipped', id);
  }
  assert.equal(taskSummary(s).browserActions, 0);
  assert.equal(taskSummary(s).lastBrowser, null);
  assert.equal(overall(s).status, 'FAILED');
});
