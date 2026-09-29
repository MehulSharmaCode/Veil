// The orchestrator. Runs in the side panel and owns all agent state, including the vault.
// Closing the panel destroys this context: the loop stops and the vault is gone.

import { CONFIG } from '../shared/config';
import { PlanResponseSchema, type Action, type PlanResponse } from '../shared/actions';
import type { RawElement, RawSnapshot, SanitizedElement } from '../shared/ir';
import type { ExecCommand, ExecResponse, InspectResponse, SnapshotResponse } from '../shared/messages';
import { ensureContentScript, getActiveTab, sendToTab } from '../platform/chrome';
import { Vault } from '../privacy/vault';
import { Sanitizer, type Detection } from '../privacy/sanitizer';
import { expectedAnswerCategory } from '../privacy/detectors';
import type { SanitizedText } from '../privacy/sanitized';
import { EgressClient, type GateReport } from '../egress/client';
import { GATE_RULES } from '../egress/gate';
import { buildPlannerPayload, sanitizeSnapshot, type SanitizedSnapshot } from '../egress/payload';
import type { HistoryEntry, PlannerPayload } from '../egress/schema';
import { validateAction, validateLive, POLICY_RULES, type Concern, type PolicyRule } from '../policy/validator';
import { newSessionId, Telemetry } from '../telemetry/telemetry';

export type Outcome = 'done' | 'stopped' | 'max_steps' | 'blocked' | 'error' | 'panel_closed';

/** Planner identity as reported by the backend's /health (metadata only; shown on the dashboard). */
export interface PlannerInfo {
  provider: string;
  model: string;
  effort: string | null;
}

const META_RE = /^[\w.\/:-]{1,80}$/;
/** Keep only plain identifier-like strings (never free text) for planner metadata telemetry. */
function plannerMeta(p: PlannerInfo | null | undefined): Record<string, string | null> | null {
  if (!p || !META_RE.test(p.provider) || !META_RE.test(p.model)) return null;
  return { provider: p.provider, model: p.model, effort: p.effort && META_RE.test(p.effort) ? p.effort : null };
}

/** Everything the UI shows comes through here and is placeholder-only. */
export interface AgentUI {
  stage(stage: string, detail?: string): void;
  log(line: string, kind?: 'info' | 'ok' | 'warn' | 'error'): void;
  confirm(title: string, reasons: string[]): Promise<boolean>;
  ask(question: string): Promise<string | null>;
  handoff(message: string): Promise<boolean>;
  debug(snapshot: SanitizedSnapshot): void;
  vault(entries: ReturnType<Vault['metadata']>): void;
  task(sanitized: string): void;
  finished(outcome: Outcome, message: string): void;
}

class Stopped extends Error {}

function countBy<T>(xs: T[], key: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return out;
}

/** Placeholder-only description of an action, for UI/telemetry/history. */
function describe(a: Action, el?: SanitizedElement): string {
  const tgt = el ? `${el.id} "${el.name || el.text || el.tag}"` : 'target' in a ? a.target : '';
  switch (a.type) {
    case 'type': return `type ${a.text} into ${tgt}`;
    case 'click': return `click ${tgt}`;
    case 'select': return `select "${a.option}" in ${tgt}`;
    case 'scroll': return 'target' in a ? `scroll to ${tgt}` : `scroll ${a.direction} ${a.amount_px}px`;
    case 'wait': return `wait ${a.ms}ms`;
    case 'ask_user': return `ask: ${a.question}`;
    case 'done': return `done: ${a.summary}`;
  }
}

function historyAction(a: Action): HistoryEntry['action'] {
  const h: HistoryEntry['action'] = { type: a.type };
  if ('target' in a) h.target = a.target;
  if (a.type === 'type') h.text = a.text;
  if (a.type === 'select') h.option = a.option;
  if (a.type === 'scroll' && 'direction' in a) {
    h.direction = a.direction;
    h.amount_px = a.amount_px;
  }
  if (a.type === 'wait') h.ms = a.ms;
  if (a.type === 'ask_user') h.text = a.question;
  return h;
}

export class Agent {
  readonly sessionId = newSessionId();
  private readonly vault = new Vault();
  private readonly sanitizer = new Sanitizer(this.vault);
  private readonly egress: EgressClient;
  private readonly telemetry: Telemetry;
  private readonly abort = new AbortController();
  private stopped = false;
  private finished = false;
  private step = 0;
  private history: HistoryEntry[] = [];
  private failures = 0;
  private tabId = -1;
  private taskOrigin = '';
  private task = '' as SanitizedText;

  constructor(
    private readonly ui: AgentUI,
    private readonly opts: { planner?: PlannerInfo | null } = {},
  ) {
    this.egress = new EgressClient({
      secrets: () => this.vault.secretForms(),
      failClosed: () => this.sanitizer.failClosed(),
      onGate: (r) => this.onGate(r),
    });
    this.telemetry = new Telemetry(this.egress, this.sessionId, () => this.step, () => this.vault.secretForms(), (type, rules) => {
      this.ui.log(`telemetry event ${type} blocked by egress gate (${rules.join(', ')})`, 'warn');
    });
  }

  get running(): boolean {
    return !this.finished;
  }

  // ---- lifecycle --------------------------------------------------------------------------------

  async run(rawTask: string): Promise<void> {
    try {
      const tab = await getActiveTab();
      if (!tab) throw new AgentError('NO_TAB', 'VEIL cannot access this tab. v0.1 runs on localhost pages only.');
      const origin = new URL(tab.url).origin;
      this.tabId = tab.id;
      this.taskOrigin = origin;
      if (!(await ensureContentScript(tab.id))) throw new AgentError('NO_CONTENT_SCRIPT', 'Content script unavailable on this page (reload the tab).');

      this.ui.stage('sanitize', 'task');
      const r = this.sanitizer.sanitizeWithReport(rawTask, { source: 'task', origin });
      this.task = r.text;
      this.ui.task(r.text);
      this.telemetry.emit('TASK_STARTED', 'task', {
        task: r.text,
        origin: this.sanitizer.sanitize(origin, { source: 'page', origin }),
        planner: plannerMeta(this.opts.planner),
        limits: { max_steps: CONFIG.MAX_STEPS, max_actions_per_step: CONFIG.MAX_ACTIONS_PER_STEP, max_consecutive_failures: CONFIG.MAX_CONSECUTIVE_FAILURES },
      });
      this.reportDetections('task', r.detections);

      await this.loop();
    } catch (e) {
      if (e instanceof Stopped) return; // stop() already finalized
      const code = e instanceof AgentError ? e.code : 'UNEXPECTED';
      const msg = e instanceof AgentError ? e.message : 'Unexpected error (see side panel console).';
      if (!(e instanceof AgentError)) console.error('VEIL agent error', e instanceof Error ? e.name : 'error');
      this.telemetry.emit('ERROR', 'error', { code, reason: this.sanitizeOwn(msg) });
      this.finish('error', msg);
    }
  }

  /** Stop button / panel close: halt the loop and clear the vault. */
  stop(outcome: 'stopped' | 'panel_closed' = 'stopped'): void {
    if (this.finished) return;
    this.stopped = true;
    this.abort.abort();
    this.finish(outcome, outcome === 'stopped' ? 'Stopped by user. Vault cleared.' : 'Panel closed.', outcome === 'panel_closed');
  }

  private finish(outcome: Outcome, message: string, immediate = false): void {
    if (this.finished) return;
    this.finished = true;
    const safeMessage = this.sanitizeOwn(message);
    this.vault.clear();
    this.telemetry.emit('VAULT_UPDATED', 'vault', { entries: [], count: 0, cleared: true }, { immediate });
    this.telemetry.emit('TASK_COMPLETED', 'done', { outcome, message: safeMessage, steps: this.step }, { immediate });
    this.ui.vault([]);
    this.ui.finished(outcome, message);
  }

  private check(): void {
    if (this.stopped) throw new Stopped();
  }

  // ---- main loop --------------------------------------------------------------------------------

  private async loop(): Promise<void> {
    while (this.step < CONFIG.MAX_STEPS) {
      this.check();
      this.step++;

      const { raw, san } = await this.observe();
      this.check();

      const plan = await this.plan(san);
      this.check();
      // An invalid response is already recorded as a failure; it still counts toward the limit below.
      const action = plan?.actions[0];
      if (plan && plan.actions.length > CONFIG.MAX_ACTIONS_PER_STEP) this.ui.log(`planner proposed ${plan.actions.length} actions; v0.1 executes only the first`, 'warn');
      if (plan && !action) {
        if (plan.status === 'done') {
          this.telemetry.emit('ACTION_VALIDATED', 'validate', { action: { type: 'done', summary: plan.message.slice(0, 300) }, confirm: [], checks: ['V1_ACTION'] });
          return this.finish('done', plan.message || 'Task complete.');
        }
        this.recordFailure(null, 'rejected', 'V1_ACTION', 'planner returned no action');
      }
      if (action) await this.handle(action, raw, san);
      if (this.finished) return;

      if (this.failures >= CONFIG.MAX_CONSECUTIVE_FAILURES) {
        this.failures = 0;
        await this.askUser('I could not complete the last actions. How should I proceed?');
      }
    }
    this.finish('max_steps', `Stopped after ${CONFIG.MAX_STEPS} steps without finishing.`);
  }

  private async observe(): Promise<{ raw: RawSnapshot; san: SanitizedSnapshot }> {
    this.ui.stage('snapshot');
    const res = await this.content<SnapshotResponse>({ type: 'snapshot' });
    const raw = res.snapshot;
    this.telemetry.emit('DOM_SNAPSHOT_CREATED', 'snapshot', {
      elements: raw.elements.length,
      interactive: raw.elements.filter((e) => e.kind === 'interactive').length,
      regions: raw.regions.length,
      candidates: raw.stats.candidates,
      pruned: raw.stats.pruned,
      duration_ms: raw.stats.duration_ms,
    });

    this.ui.stage('sanitize', 'page');
    const t0 = performance.now();
    const san = sanitizeSnapshot(raw, this.sanitizer);
    this.telemetry.emit('IR_CREATED', 'ir', {
      page: { origin: san.page.origin, path: san.page.path, title: san.page.title },
      by_kind: countBy(san.elements, (e) => e.kind),
      regions: san.regions.map((r) => ({ id: r.id, kind: r.kind, label: r.label, status: r.status })),
      interactive: san.elements
        .filter((e) => e.kind === 'interactive')
        .slice(0, 40)
        .map((e) => ({
          id: e.id,
          role: e.role,
          tag: e.tag,
          input_type: e.input_type ?? null,
          name: e.name,
          value_category: e.state.value_category ?? null,
          has_value: e.state.has_value ?? null,
          // Structural flags only (never values). Fingerprints stay local (V3) and are not sent.
          flags: {
            editable: !!e.state.editable, disabled: !!e.state.disabled, required: !!e.state.required, submitter: !!e.state.submitter,
            in_viewport: e.in_viewport, occluded: e.occluded,
          },
        })),
    });
    this.reportDetections('page', san.detections);
    this.telemetry.emit('SANITIZATION_COMPLETE', 'sanitize', {
      detections: san.detections.length,
      redacted: san.detections.filter((d) => d.category === 'REDACTED').length,
      duration_ms: Math.round(performance.now() - t0),
    });
    this.ui.debug(san);
    return { raw, san };
  }

  private reportDetections(source: 'task' | 'page' | 'user_answer', detections: Detection[]): void {
    if (detections.length) {
      this.telemetry.emit('PII_DETECTED', 'sanitize', {
        source,
        counts: countBy(detections, (d) => d.category),
        placeholders: [...new Set(detections.map((d) => d.placeholder))],
      });
    }
    const meta = this.vault.metadata();
    this.ui.vault(meta);
    this.telemetry.emit('VAULT_UPDATED', 'vault', { entries: meta, count: meta.length });
  }

  private onGate(r: GateReport): void {
    if (r.kind !== 'plan') return; // telemetry gate results are reported via onBlocked only (no recursion)
    // checkEgress evaluates every rule on every message, so the full rule list is what was checked.
    const data = { attempt: r.attempt, bytes: r.bytes, failures: r.failures, rules_checked: Object.keys(GATE_RULES) };
    if (r.phase === 'passed') this.telemetry.emit('EGRESS_CHECK_PASSED', 'egress', data);
    else if (r.phase === 'failed') this.telemetry.emit('EGRESS_CHECK_FAILED', 'egress', data);
    else this.telemetry.emit('EGRESS_BLOCKED', 'egress', data);
  }

  private async plan(san: SanitizedSnapshot): Promise<PlanResponse | null> {
    this.ui.stage('egress');
    const payload: PlannerPayload = buildPlannerPayload({
      sessionId: this.sessionId,
      step: this.step,
      task: this.task,
      snapshot: san,
      placeholders: this.vault.metadata(),
      history: this.history,
    });

    this.ui.stage('plan', `step ${this.step}`);
    const planAbort = new AbortController();
    const timeout = setTimeout(() => planAbort.abort(), CONFIG.PLAN_TIMEOUT_MS);
    this.abort.signal.addEventListener('abort', () => planAbort.abort(), { once: true });
    const t0 = performance.now();
    let res;
    try {
      res = await this.egress.send('plan', `${CONFIG.PLANNER_URL}/plan`, payload, { signal: planAbort.signal });
    } catch {
      this.check();
      throw new AgentError('PLANNER_UNREACHABLE', 'Planner backend unreachable or timed out.');
    } finally {
      clearTimeout(timeout);
    }
    if (!res.sent) {
      this.stopped = true;
      const rules = res.blocked.failures.map((f) => `${f.rule} at ${f.path}`);
      this.ui.log(`Egress BLOCKED: ${rules.join('; ')}`, 'error');
      this.finish('blocked', 'Outbound payload blocked by the egress gate. Task paused; nothing was sent.');
      throw new Stopped();
    }
    // Emitted once the response headers are back (the gate result above marks the dispatch moment).
    this.telemetry.emit('REQUEST_SENT', 'egress', {
      request_id: `${this.sessionId}-${this.step}`,
      bytes: res.gate.bytes,
      http_status: res.response.status,
      response_ms: Math.round(performance.now() - t0),
      payload: res.message,
    });

    let body: unknown;
    try {
      body = await res.response.json();
    } catch {
      body = null;
    }
    const latency = Math.round(performance.now() - t0);
    if (!res.response.ok) {
      const detail = typeof (body as { detail?: unknown })?.detail === 'string' ? (body as { detail: string }).detail : `HTTP ${res.response.status}`;
      throw new AgentError('PLANNER_ERROR', `Planner error: ${detail.slice(0, 200)}`);
    }
    const parsed = PlanResponseSchema.safeParse(body);
    if (!parsed.success) {
      this.recordFailure(null, 'rejected', 'V1_ACTION', 'planner response failed local schema validation');
      return null;
    }
    const plan = parsed.data;
    // Emitted only after the response passed the local zod schema (V1).
    this.telemetry.emit('LLM_ACTION_RECEIVED', 'plan', { status: plan.status, actions: plan.actions, message: plan.message, latency_ms: latency, schema: 'valid' });
    this.ui.log(`planner (${latency} ms): ${plan.message || plan.status}`);
    return plan;
  }

  // ---- one action -------------------------------------------------------------------------------

  private async handle(action: Action, raw: RawSnapshot, san: SanitizedSnapshot): Promise<void> {
    const sanById = new Map(san.elements.map((e) => [e.id, e]));
    const label = describe(action, 'target' in action ? sanById.get(action.target) : undefined);

    if (action.type === 'done') {
      this.telemetry.emit('ACTION_VALIDATED', 'validate', { action, confirm: [], checks: ['V1_ACTION'] });
      return this.finish('done', action.summary || 'Task complete.');
    }
    if (action.type === 'ask_user') {
      this.telemetry.emit('ACTION_VALIDATED', 'validate', { action, confirm: [], checks: ['V1_ACTION'] });
      await this.askUser(action.question, action);
      return;
    }
    if (action.type === 'wait') {
      this.telemetry.emit('ACTION_VALIDATED', 'validate', { action, confirm: [], checks: ['V1_ACTION'] });
      this.ui.stage('execute', label);
      await this.sleep(action.ms);
      this.check(); // a Stop during the wait ends the task; the wait did not complete
      this.telemetry.emit('ACTION_EXECUTED', 'execute', { action, ok: true });
      this.pushHistory(action, 'ok');
      return;
    }

    // Static checks (V1 done by schema; V2 snapshot membership, V4, T1–T4, risk class).
    this.ui.stage('validate', label);
    const snapshotById = new Map(raw.elements.map((e) => [e.id, e]));
    const verdict = validateAction(action, {
      snapshot: snapshotById,
      vault: this.vault,
      secrets: this.vault.secretForms(),
      taskOrigin: this.taskOrigin,
      pageOrigin: raw.page.origin,
    });
    if (verdict.kind === 'reject') return this.recordFailure(action, verdict.rule === 'V3_FINGERPRINT' ? 'stale_target' : 'rejected', verdict.rule, verdict.reason);
    if (verdict.kind === 'handoff') {
      this.telemetry.emit('ACTION_REJECTED', 'validate', { action, rule: verdict.rule, reason: POLICY_RULES.T1_CREDENTIAL, handoff: true });
      this.ui.log(`${label}: handed to you (${verdict.rule})`, 'warn');
      await this.handoffToUser(action, `This ${verdict.reason}. VEIL never fills credentials or card data. Please fill it yourself, then press "I've done it".`);
      return;
    }

    // Live checks (V2 still present/visible/unoccluded, V3 fingerprint) right before acting.
    const snapEl = 'target' in action ? snapshotById.get(action.target) : undefined;
    if (snapEl) {
      const live = await this.content<InspectResponse>({ type: 'inspect', id: snapEl.id, scrollIntoView: true });
      const liveVerdict = validateLive(snapEl, {
        exists: live.exists,
        visible: live.element?.visible ?? false,
        occluded: live.element?.occluded ?? false,
        fingerprint: live.element?.fingerprint ?? '',
      });
      if (liveVerdict && liveVerdict.kind === 'reject') {
        return this.recordFailure(action, liveVerdict.rule === 'V3_FINGERPRINT' ? 'stale_target' : 'rejected', liveVerdict.rule, liveVerdict.reason);
      }
    }
    const taint = verdict.placeholder
      ? { placeholder: verdict.placeholder, placeholder_category: this.vault.getEntry(verdict.placeholder)?.category ?? null, field_category: snapEl?.state.value_category ?? 'free_text' }
      : null;
    this.telemetry.emit('ACTION_VALIDATED', 'validate', {
      action,
      confirm: verdict.confirm.map((c) => c.rule),
      checks: verdict.checked,
      live_checks: snapEl ? ['V2_TARGET', 'V3_FINGERPRINT'] : [],
      taint,
    });

    if (verdict.confirm.length) {
      const ok = await this.confirm(action, label, verdict.confirm);
      if (!ok) {
        this.ui.log(`${label}: denied by you`, 'warn');
        this.pushHistory(action, 'user_denied', verdict.confirm[0]!.rule);
        return;
      }
    }

    // Resolve locally and execute. The real value exists only inside this call.
    this.ui.stage('execute', label);
    const cmd = this.toCommand(action, verdict.placeholder);
    if (taint) {
      // The real value now exists only in `cmd`, which goes to the content script for this one action.
      this.telemetry.emit('PLACEHOLDER_RESOLVED', 'resolve', { placeholder: taint.placeholder, category: taint.placeholder_category, target: 'target' in action ? action.target : null });
    }
    let exec: ExecResponse;
    try {
      // Dispatched here: from now on the action cannot be recalled by Stop or panel close.
      exec = await this.content<ExecResponse>({ type: 'execute', command: cmd, expectedFingerprint: snapEl?.fingerprint }, { afterStop: 'return' });
    } catch (e) {
      if (e instanceof Stopped) throw e;
      if (action.type !== 'click') throw e;
      // A click that navigates tears down the content script; treat as a state change.
      exec = { ok: true, mutations: 0, settle_ms: 0, settled: false, changed: true };
      await this.sleep(800);
      if (!this.stopped) await ensureContentScript(this.tabId);
    }
    // Reported even if Stop came while it ran (then flagged): the page changed, and the record must say so.
    const afterStop = this.stopped;
    this.telemetry.emit('ACTION_EXECUTED', 'execute', { action, ok: exec.ok, error: exec.error ?? null, mutations: exec.mutations, settle_ms: exec.settle_ms, settled: exec.settled, ...(afterStop ? { after_stop: true } : {}) });
    this.check(); // nothing after this one action once stopped: no verification, no next step
    if (!exec.ok) {
      return this.recordFailure(action, exec.error === 'stale' ? 'stale_target' : 'exec_error', exec.error === 'stale' ? 'V3_FINGERPRINT' : undefined, `execution failed: ${exec.error}`);
    }

    // Verify.
    this.ui.stage('verify', label);
    let passed: boolean;
    let check: string;
    if (action.type === 'type' || action.type === 'select') {
      passed = exec.value_matches === true;
      check = 'value_matches_after_settle';
    } else if (action.type === 'click') {
      passed = exec.changed;
      check = 'dom_or_state_changed';
    } else {
      passed = true;
      check = exec.scroll_changed ? 'scrolled' : 'scroll_at_limit';
    }
    this.telemetry.emit('VERIFICATION_COMPLETE', 'verify', { action, passed, check, mutations: exec.mutations });
    if (!passed) {
      const why = action.type === 'type' ? 'value did not stick after settle (synthetic events may be ignored by this page)' : 'no observable change';
      return this.recordFailure(action, 'verify_failed', undefined, why);
    }
    this.failures = 0;
    this.ui.log(`${label}: ✓ verified`, 'ok');
    this.pushHistory(action, 'ok');
  }

  private toCommand(action: Action, placeholder?: string): ExecCommand {
    switch (action.type) {
      case 'click':
        return { kind: 'click', id: action.target };
      case 'select':
        return { kind: 'select', id: action.target, option: action.option };
      case 'scroll':
        return 'target' in action ? { kind: 'scroll_to', id: action.target } : { kind: 'scroll_by', dy: action.direction === 'down' ? action.amount_px : -action.amount_px };
      case 'type': {
        const entry = placeholder ? this.vault.getEntry(placeholder) : undefined;
        if (placeholder && !entry) throw new AgentError('VAULT_MISS', 'Placeholder no longer in vault.');
        return { kind: 'type', id: action.target, text: entry ? entry.value : action.text };
      }
      default:
        throw new AgentError('BAD_COMMAND', 'Not an executable action.');
    }
  }

  // ---- user interaction ---------------------------------------------------------------------------

  private async confirm(action: Action, label: string, concerns: Concern[]): Promise<boolean> {
    this.ui.stage('confirm', label);
    this.telemetry.emit('CONFIRMATION_REQUESTED', 'confirm', { action, rules: concerns.map((c) => c.rule) });
    const ok = await this.ui.confirm(`Allow: ${label}?`, concerns.map((c) => `${c.rule}: ${c.reason}`));
    this.check();
    // A denial returns to the loop without executing (see handle()).
    this.telemetry.emit('CONFIRMATION_RESOLVED', 'confirm', { action, approved: ok, result: ok ? 'proceed' : 'blocked_not_executed' });
    return ok;
  }

  private async askUser(question: string, action?: Action): Promise<void> {
    this.ui.stage('confirm', 'waiting for your answer');
    const answer = await this.ui.ask(question);
    this.check();
    if (answer === null) return this.stop();
    // The question tells the sanitizer what a cue-less answer holds ("What is your address?" → ADDRESS).
    const r = this.sanitizer.sanitizeWithReport(answer, { source: 'user_answer', origin: this.taskOrigin, expect: expectedAnswerCategory(question) });
    // The sanitized answer is exactly what the planner receives in history.user_answer.
    this.telemetry.emit('USER_ANSWERED', 'ask', { answer: r.text.slice(0, 300), placeholders: [...new Set(r.detections.map((d) => d.placeholder))] });
    this.reportDetections('user_answer', r.detections);
    this.pushHistory(action ?? { type: 'ask_user', question: question.slice(0, 300) }, 'answered', undefined, r.text);
  }

  private async handoffToUser(action: Action, message: string): Promise<void> {
    this.ui.stage('confirm', 'handed to you');
    const done = await this.ui.handoff(message);
    this.check();
    this.pushHistory(action, 'handed_to_user', 'T1_CREDENTIAL', this.sanitizeOwn(done ? 'user says they filled it' : 'user skipped it'));
  }

  // ---- helpers --------------------------------------------------------------------------------------

  /** VEIL- or planner-generated text (may contain legitimate placeholders) → sanitized for display/egress. */
  private sanitizeOwn(text: string): SanitizedText {
    return this.sanitizer.sanitize(text, { source: 'page', origin: this.taskOrigin, keepPlaceholders: true });
  }

  /**
   * `action: null` = the planner response itself was unusable (no valid action). Telemetry then carries
   * no action (the planner proposed none); the planner's history gets a neutral `wait 0` placeholder
   * entry, because a history entry needs an action type, so it learns its last response was rejected.
   */
  private recordFailure(action: Action | null, result: HistoryEntry['result'], rule: PolicyRule | 'V1_ACTION' | undefined, reason: string): void {
    this.failures++;
    const safeReason = this.sanitizeOwn(reason);
    // verify failures are already reported by VERIFICATION_COMPLETE(passed=false)
    if (result === 'exec_error') this.telemetry.emit('ERROR', 'execute', { code: 'EXEC_FAILED', action, reason: safeReason });
    else if (result !== 'verify_failed') this.telemetry.emit('ACTION_REJECTED', 'validate', { ...(action ? { action } : {}), rule: rule ?? null, result, reason: safeReason });
    this.ui.log(`${action ? describe(action) : 'planner response'}: ${result}${rule ? ` [${rule}]` : ''} — ${reason}`, 'warn');
    this.pushHistory(action ?? { type: 'wait', ms: 0 }, result, rule);
  }

  private pushHistory(action: Action, result: HistoryEntry['result'], rule?: string, userAnswer?: SanitizedText): void {
    const e: HistoryEntry = { step: this.step, action: historyAction(action), result };
    if (rule) e.rule = rule;
    if (userAnswer !== undefined) e.user_answer = userAnswer.slice(0, 300);
    this.history = [...this.history, e].slice(-CONFIG.HISTORY_LENGTH);
  }

  /**
   * One content-script request. The stop flag is checked synchronously right before dispatch, so
   * nothing new reaches the page after Stop. `afterStop: 'return'` hands back the result of a request
   * that was already dispatched when Stop came (an execute), so the caller can report it honestly.
   */
  private async content<R>(msg: Parameters<typeof sendToTab>[1], opts: { afterStop?: 'throw' | 'return' } = {}): Promise<R> {
    this.check();
    let res: { ok: boolean; error?: string } & R;
    try {
      res = await sendToTab<typeof res>(this.tabId, msg);
    } catch (e) {
      this.check();
      if (msg.type === 'execute') throw e; // never re-send an action: it may already have happened
      if (!(await ensureContentScript(this.tabId))) throw new AgentError('NO_CONTENT_SCRIPT', 'Lost the page (navigated or closed).');
      res = await sendToTab<typeof res>(this.tabId, msg);
    }
    if (opts.afterStop !== 'return') this.check();
    if (!res || (res.ok === false && msg.type !== 'execute')) throw new AgentError('CONTENT_ERROR', `Content script error: ${res?.error ?? 'no response'}`);
    return res;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.abort.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }
}

export class AgentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export type { RawElement };
