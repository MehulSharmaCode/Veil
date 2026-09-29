// VEIL dashboard: a read-only consumer of telemetry. It only issues GET /telemetry/state and
// subscribes to GET /telemetry/stream. It never sends anything to the extension or the backend.
// All strings are rendered with textContent (event strings may originate from web pages).

import { RELAY_URL, PIPELINE, PHASES, STAGE_OF, actionText } from './registry.js';
import {
  createState, reduce, pipeline, stepHistory, latestDecision, latestExecution, recheckPayload, overall, elapsedMs,
  latestStep, summarize, label, eventStatus, taskSummary, inFlight, OUTCOME_LABEL,
} from './model.js';

const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}
function h(tag, cls, ...kids) {
  const n = el(tag, cls);
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.append(typeof k === 'string' || typeof k === 'number' ? document.createTextNode(String(k)) : k);
  return n;
}
const ICON = { passed: '✓', running: '●', warn: '!', blocked: '⊘', failed: '✗', stopped: '■', interrupted: '◐', skipped: '–', na: '∅', pending: '○', observed: '•' };
const WORD = { passed: 'PASSED', running: 'RUNNING', warn: 'NEEDS USER', blocked: 'BLOCKED', failed: 'FAILED', stopped: 'STOPPED', interrupted: 'INTERRUPTED', skipped: 'SKIPPED', na: 'N/A THIS STEP', pending: 'PENDING', observed: 'OBSERVED' };
const time = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour12: false }) : '');
/** With milliseconds: the timeline is the place to judge order. */
const timeMs = (ts) => (ts ? `${time(ts)}.${String(new Date(ts).getMilliseconds()).padStart(3, '0')}` : '');
const ms = (v) => (v === null || v === undefined ? '' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const badge = (status, text) => el('span', `badge s-${status}`, text ?? `${ICON[status] ?? ''} ${WORD[status] ?? status}`);
const glyph = (status) => el('span', `glyph s-${status}`, ICON[status] ?? '');
const tag = (status, text) => el('span', `tag s-${status}`, text ?? WORD[status] ?? status);
function kv(pairs, cls = '') {
  const dl = el('dl', `kv ${cls}`);
  for (const [k, v] of pairs) {
    if (v === undefined) continue;
    dl.append(el('dt', '', k), v instanceof Node ? h('dd', '', v) : el('dd', '', v));
  }
  return dl;
}

/** Text with placeholders ([EMAIL_1], [REDACTED_TEXT]) set as tokens, so what stood in for a value is visible at a glance. */
const TOKEN = /\[[A-Z][A-Z_]*_\d+\]|\[REDACTED_TEXT\]/g;
function tokenized(text, cls = '') {
  const s = String(text ?? '');
  const span = el('span', cls);
  let last = 0;
  for (const m of s.matchAll(TOKEN)) {
    if (m.index > last) span.append(document.createTextNode(s.slice(last, m.index)));
    span.append(el('span', 'tok', m[0]));
    last = m.index + m[0].length;
  }
  if (last < s.length) span.append(document.createTextNode(s.slice(last)));
  return span;
}
/** A fixed-size bar standing in for a real value that exists only on this device. It carries no content. */
const redaction = () => {
  const r = el('span', 'redact');
  r.setAttribute('role', 'img');
  r.setAttribute('aria-label', 'real value withheld');
  return r;
};

let S = createState();
let payloadStep = null; // local view choice only (which payload to show); never sent anywhere
let frame = 0;

// Coalesce bursts of events into one render. A timer (not requestAnimationFrame) so that a dashboard in a
// background tab stays current too.
function schedule() {
  if (frame) return;
  frame = setTimeout(() => {
    frame = 0;
    render();
  }, 40);
}

// ---- story: task + outcome ----------------------------------------------------------------------
/** What the overall state means, in one sentence. Definitions only: the facts come from the events. */
const OUTCOME_WHY = {
  done: 'The planner declared the task complete, and local code accepted that. A declaration is not a check: verified actions are counted below.',
  stopped: 'The task was stopped before it finished.',
  panel_closed: 'The side panel was closed, which ends the task and discards the in-memory vault with it.',
  blocked: 'Local safety blocked the task.',
  error: 'The task ended with an error.',
  max_steps: 'The task reached the step limit before the planner declared it complete.',
};

function currentStageLabel() {
  const cur = S.lastEvent ? PIPELINE.find((p) => p.id === STAGE_OF[S.lastEvent.stage]) : null;
  return cur?.label ?? (S.lastEvent ? S.lastEvent.stage : null);
}

function renderHeader() {
  const o = overall(S);
  const st = $('overall');
  st.textContent = o.status;
  st.className = `state s-${o.tone}`;
  const n = latestStep(S);
  const max = S.limits?.max_steps;
  $('hStep').textContent = S.session ? `${n}${max ? ` / ${max}` : ''}` : '–';
  $('hStage').textContent = S.outcome ? (OUTCOME_LABEL[S.outcome.outcome] ?? S.outcome.outcome) : currentStageLabel() ?? '–';
  $('hPlanner').textContent =
    S.planner === undefined ? '–' : S.planner === null ? 'not reported' : `${S.planner.provider} · ${S.planner.model}${S.planner.effort ? ` · effort ${S.planner.effort}` : ''}`;
  const e = elapsedMs(S);
  $('hElapsed').textContent = e === null ? '–' : ms(e);
  $('hSession').textContent = S.session ?? '–';
  const task = $('task');
  if (S.task) task.replaceChildren(tokenized(S.task));
  else task.textContent = S.session ? 'Task text not reported yet.' : 'No task yet. Start one from the VEIL side panel.';
  task.classList.toggle('is-empty', !S.task);

  let why;
  let msg = null;
  if (!S.session) why = 'Waiting for a task. The console fills in as real events arrive.';
  else if (!S.outcome) {
    const rec = S.steps.get(n);
    if (rec?.confirmation && rec.confirmation.approved === null) why = `Step ${n} is paused: local safety requires your confirmation (${(rec.confirmation.rules || []).join(', ')}).`;
    else if (rec?.stages.ask?.status === 'running') why = `Step ${n} is paused: the planner asked you a question.`;
    else why = n > 0 ? `Working on step ${n}: ${currentStageLabel() ?? 'starting'}.` : 'Setting up the task.';
  }
  else {
    why = OUTCOME_WHY[S.outcome.outcome] ?? `The task ended: ${S.outcome.outcome}.`;
    if (S.outcome.message) msg = S.outcome.outcome === 'done' ? `Planner's summary: “${S.outcome.message}”` : S.outcome.message;
  }
  $('overallWhy').replaceChildren(...[el('span', '', why), msg ? h('span', 'verdict-msg', tokenized(msg)) : null].filter(Boolean)); // null would print as text
}

// ---- pipeline (current step) --------------------------------------------------------------------
/** "Earlier: ✓ step 1, 2": only shown where the current step lacks a stage that earlier steps had. */
function earlierText(hist, n) {
  const order = ['passed', 'warn', 'blocked', 'failed', 'interrupted', 'observed'];
  const parts = order
    .map((k) => [k, (hist?.[k] || []).filter((x) => x !== n)])
    .filter(([, xs]) => xs.length)
    .map(([k, xs]) => `${ICON[k]} ${xs.length === 1 ? 'step' : 'steps'} ${xs.join(', ')}`);
  return parts.length ? `Earlier in this task: ${parts.join(' · ')}` : null;
}

/** The outcome card names the outcome itself: a planner-declared DONE is not the same fact as a verified action. */
function outcomeWord(c) {
  if (c.id !== 'done' || !S.outcome || c.status === 'pending') return undefined;
  const o = S.outcome.outcome;
  return o === 'done' ? 'DONE · DECLARED' : OUTCOME_LABEL[o] ?? String(o).toUpperCase();
}

function stageItem(c, n, isNow) {
  const earlier = c.scope === 'step' && n > 0 && !['passed', 'running', 'warn', 'failed', 'blocked'].includes(c.status) ? earlierText(c.history, n) : null;
  // Durations stay visible; the clock time is in the tooltip (the timeline has every event to the ms).
  const meta = c.ms !== null && c.ms !== undefined ? ms(c.ms) : null;
  const li = h(
    'li',
    `stage s-${c.status}${isNow ? ' is-now' : ''}`,
    h('div', 'st-head', glyph(c.status), el('span', 'st-name', c.label)),
    h('p', 'st-detail', tokenized(c.detail || c.explain)),
    h('p', 'st-foot', tag(c.status, outcomeWord(c)), meta ? el('span', 'st-meta', meta) : null),
    earlier ? el('p', 'st-earlier', earlier) : null,
  );
  li.title = c.ts ? `${c.explain}\n${time(c.ts)}` : c.explain;
  return li;
}

function renderPipeline() {
  const cards = pipeline(S);
  const byId = new Map(cards.map((c) => [c.id, c]));
  const n = latestStep(S);
  const max = S.limits?.max_steps;
  $('pipeStep').textContent = S.session ? (n > 0 ? `current step ${n}${max ? ` of ${max}` : ''}` : 'task set-up') : '';
  $('pipeScope').textContent = !S.session
    ? 'Each stage lights up only when a real event proves it. Nothing is shown as passed on assumption.'
    : n > 0
      ? `The stages below describe step ${n} only. “N/A this step” means step ${n}'s action has no such stage, not that VEIL never did it; the whole task is summarised underneath.`
      : 'The task is being set up; loop stages start with step 1.';

  // The stage that is "now": the running one, else the latest event of this step, else the outcome.
  let now = null;
  if (S.session) {
    if (S.outcome) now = 'done';
    else {
      const running = cards.find((c) => c.status === 'running');
      const latest = cards.filter((c) => c.ts).sort((a, b) => b.ts - a.ts)[0];
      now = running?.id ?? latest?.id ?? null;
    }
  }

  const phases = PHASES.map((ph) => {
    const items = ph.stages.map((id) => byId.get(id)).filter(Boolean);
    const remote = ph.lane === 'remote';
    return h(
      'div',
      `phase phase-${ph.id}${remote ? ' is-remote' : ''}`,
      h('div', 'phase-h', el('span', 'phase-label', ph.label)),
      h('ol', 'phase-stages', items.map((c) => stageItem(c, n, c.id === now))),
    );
  });
  const i = PHASES.findIndex((p) => p.lane === 'remote');
  const planner = S.planner ? `${S.planner.provider} · ${S.planner.model}` : 'hosted LLM';
  $('pipeline').replaceChildren(
    ...phases.slice(0, i),
    h('div', 'lane-note note-in',
      h('p', 'lane-key', h('span', '', el('span', 'lane-dot local'), 'This browser'), h('span', '', el('span', 'lane-dot remote'), `Remote (hatched): ${planner}`)),
      el('p', '', 'Only the sanitized, gate-checked request crosses down to the planner.')),
    phases[i],
    h('div', 'lane-note note-out', el('p', '', 'Only a proposal comes back up. The planner never touches the page, the vault or the final decision.')),
    ...phases.slice(i + 1),
    h('div', 'crossing', el('span', 'x-down', 'request ↓'), el('span', 'x-line'), el('span', 'x-up', '↑ proposal')),
  );
  renderTaskSummary();
}

/** Task-wide record, next to the current-step pipeline. */
function renderTaskSummary() {
  const box = $('taskSummary');
  if (!S.session || latestStep(S) === 0) {
    box.replaceChildren(el('span', 'muted', S.session ? 'No loop step yet.' : 'Nothing yet.'));
    return;
  }
  const t = taskSummary(S);
  const lb = t.lastBrowser;
  const stat = (n, text, tone = '') => h('span', `stat ${tone}`, el('b', '', n), ` ${text}`);
  box.replaceChildren(...[
    stat(t.steps, t.steps === 1 ? 'step' : 'steps'),
    stat(t.browserActions, t.browserActions === 1 ? 'browser action run' : 'browser actions run'),
    stat(t.verified, 'verified', t.verified ? 's-passed' : ''),
    t.notVerified ? stat(t.notVerified, 'NOT verified', 's-failed') : null,
    t.denied ? stat(t.denied, 'denied by you', 's-blocked') : null,
    t.rejected ? stat(t.rejected, 'rejected locally', 's-blocked') : null,
    t.answered ? stat(t.answered, t.answered === 1 ? 'answer (sanitized)' : 'answers (sanitized)') : null,
    t.inFlight ? stat(t.inFlight, 'in flight at the end', 's-interrupted') : null,
    h('span', 'ts-last', lb ? h('span', '', `Most recent browser action: step ${lb.n} · `, tokenized(actionText(lb.action)), ` → ${lb.result}`) : 'No browser action yet.'),
  ].filter(Boolean)); // replaceChildren would print null as text
}

// ---- agent loop: step × stage matrix (whole task) -----------------------------------------------
function renderSteps() {
  const rows = stepHistory(S);
  if (!rows.length) {
    $('steps').replaceChildren();
    return;
  }
  const cols = PIPELINE.filter((p) => p.scope !== 'task' && (!p.optional || rows.some((r) => r.stages.some((s) => s.id === p.id))));
  const cur = latestStep(S);
  const head = h('tr', '', el('th', 'c-step', 'Step'), el('th', 'c-act', 'Planner proposed'), cols.map((c) => {
    const th = el('th', 'c-st', c.short ?? c.label);
    th.title = c.label;
    return th;
  }), el('th', 'c-res', 'Step result'));
  const body = rows.map((r) => {
    const byId = new Map(r.stages.map((s) => [s.id, s]));
    return h(
      'tr',
      r.n === cur ? 'is-current' : '',
      h('td', 'c-step', el('span', 'step-n', r.n), r.n === cur ? el('span', 'cur-mark', 'current') : null),
      h('td', 'c-act', r.proposal ? tokenized(actionText(r.proposal), 'mono') : el('span', 'muted', '–')),
      cols.map((c) => {
        const s = byId.get(c.id);
        const td = h('td', 'c-st', s ? glyph(s.status) : el('span', 'none', '·'));
        td.title = s ? `${c.label}: ${WORD[s.status] ?? s.status}` : `${c.label}: no event in this step`;
        return td;
      }),
      h('td', 'c-res', badge(r.result.tone, r.result.text)),
    );
  });
  const legend = h('p', 'legend', ['passed', 'warn', 'blocked', 'failed', 'interrupted', 'running'].map((k) => h('span', '', glyph(k), ` ${WORD[k].toLowerCase()}`)), h('span', '', el('span', 'none', '·'), ' no event for that stage in that step'));
  $('steps').replaceChildren(
    h('div', 'tbl-wrap', h('table', 'tbl matrix', h('caption', 'sr', 'Agent loop: every step of the task and the stages it went through'), h('thead', '', head), h('tbody', '', body))),
    legend,
  );
}

// ---- privacy proof (what was sent) --------------------------------------------------------------
function renderPrivacy() {
  const e = S.egress;
  const sent = S.payloads;
  const rechecks = sent.map((p) => recheckPayload(p.payload));
  const forbidden = rechecks.reduce((a, r) => a + r.forbiddenKeys.length, 0);
  const html = rechecks.reduce((a, r) => a + r.htmlStrings, 0);
  const placeholders = [...new Set(rechecks.flatMap((r) => r.placeholders))];
  const any = S.session !== null;
  const rows = [];
  const row = (title, status, text, note) => rows.push(h('li', `proof s-${status}`, glyph(status), h('div', 'proof-b', el('div', 'proof-title', title), h('div', 'proof-text', text instanceof Node ? text : tokenized(text)), note ? el('div', 'proof-note', note) : null)));

  row('Egress gate, rules G0–G7', !any || e.passed + e.remediated + e.blocked === 0 ? 'pending' : e.blocked ? 'blocked' : e.remediated ? 'warn' : 'passed',
    any ? `${e.passed} passed · ${e.remediated} passed after masking · ${e.blocked} blocked` : 'No planner request yet.',
    e.rules.length ? `Rules checked on every request: ${e.rules.map((r) => r.split('_')[0]).join(' ')}` : null);
  // REQUEST_SENT arrives with the response; a gate pass without one is a request whose response was never observed.
  const sentBytes = sent.reduce((a, p) => a + (p.bytes || 0), 0);
  const unanswered = Math.max(0, e.passed + e.remediated - sent.length);
  row('Requests sent to the planner', sent.length ? 'passed' : unanswered ? 'running' : 'pending',
    sent.length ? `${plural(sent.length, 'sanitized request')} with a response, ${sentBytes.toLocaleString()} bytes, each sent only after the gate passed` : unanswered ? 'Dispatched; no response observed yet.' : 'None sent yet.',
    unanswered && sent.length ? `${plural(unanswered, 'more request')} passed the gate, but ${unanswered === 1 ? 'its response was' : 'their responses were'} not observed${S.outcome ? ' before the task ended' : ' yet'}.` : null);
  row('Network privacy check', !sent.length ? 'pending' : forbidden || html ? 'failed' : 'passed',
    sent.length ? `${forbidden} forbidden keys detected · ${html} strings with HTML markup` : 'Waiting for a payload.',
    'Re-checked in this page, independently of the extension, over the exact payloads received. Forbidden keys include value, html, url and password.');
  row('What stood in for values', placeholders.length ? 'passed' : sent.length ? 'observed' : 'pending',
    placeholders.length ? h('span', 'toks', placeholders.map((p) => el('span', 'tok', p))) : sent.length ? 'No placeholders were needed in the payloads.' : '–',
    placeholders.length ? 'These placeholders are all the planner ever saw of your data.' : null);
  const v = S.vault;
  row('Local vault', !any ? 'pending' : v.cleared ? 'passed' : v.peak ? 'running' : 'pending',
    !any ? '–' : v.cleared ? `Held up to ${plural(v.peak, 'value')} on this device · cleared at ${time(v.clearedTs)}` : `${plural(v.count, 'value')} held in side-panel memory only`,
    'Values are never shown here, only ids, categories and counts.');
  row('Leak check (canary scan)', 'pending', 'Not observed in this stream.', 'An offline tool: run `make leaks` after a run.');

  const byDesign = [
    'Raw DOM/HTML is never serialized: closed payload schema (G1), forbidden keys (G2) and a markup check (G3).',
    'Input values are never read into the IR: only has_value and a value category.',
    'A real value leaves the vault only inside the single type action that needs it, and only to the content script.',
    'This console only receives events that already passed the same egress gate.',
  ];
  $('privacy').replaceChildren(
    el('h4', 'sub', 'Observed this session'),
    h('ul', 'proofs', rows),
    h('details', 'design', el('summary', '', 'Enforced by design (in code, not observable here)'), h('ul', '', byDesign.map((t) => el('li', '', t)))),
  );
}

// ---- sanitization (what stayed local) -----------------------------------------------------------
function renderSanitize() {
  const bySource = {};
  for (const d of S.detections) {
    const b = (bySource[d.source] ||= {});
    for (const [k, v] of Object.entries(d.counts)) b[k] = (b[k] || 0) + v;
  }
  const step = (title, ...body) => h('li', 'sflow-step', el('span', 'sflow-h', title), h('span', 'sflow-b', ...body));
  const sources = Object.keys(bySource);
  const cats = Object.entries(S.categories);
  const flow = h(
    'ol',
    'sflow',
    step('Read locally', sources.length ? sources.map((s) => s.replace('_', ' ')).join(', ') : '–'),
    step('Detected', cats.length ? cats.map(([k, n]) => `${k} ×${n}`).join(', ') : '–'),
    step('Replaced by', S.vault.known.size ? h('span', 'toks', [...S.vault.known.keys()].map((id) => el('span', 'tok', id))) : '–'),
    step('Vault', S.vault.cleared ? 'cleared' : `${S.vault.count} held locally`),
  );
  const current = new Set(S.vault.entries.map((e) => e.id));
  const known = [...S.vault.known.values()];
  const tbody = h(
    'tbody',
    '',
    known.map((e) =>
      h('tr', '', h('td', '', el('span', 'tok', e.id)), el('td', '', e.category), el('td', '', e.source), el('td', '', e.firstStep ? `step ${e.firstStep}` : 'task'),
        h('td', 'c-real', redaction(), el('span', 'muted', 'never shown')),
        el('td', current.has(e.id) ? 's-running' : S.vault.cleared ? 's-passed' : 'muted', current.has(e.id) ? 'held locally' : S.vault.cleared ? 'cleared' : '–')),
    ),
  );
  $('sanitize').replaceChildren(
    flow,
    known.length
      ? h('div', 'tbl-wrap', h('table', 'tbl vault-tbl', h('thead', '', h('tr', '', ['Placeholder', 'Category', 'Source', 'First seen', 'Real value', 'Vault'].map((t) => el('th', '', t)))), tbody))
      : el('p', 'muted empty', S.session ? 'Nothing sensitive detected yet.' : 'No task yet.'),
  );
}

// ---- DOM / IR inspector -------------------------------------------------------------------------
function renderIR() {
  const ir = S.ir;
  const sn = S.snapshot;
  $('irSum').textContent = ir ? `${sn ? `${sn.elements} elements, ${sn.interactive} interactive` : Object.entries(ir.by_kind || {}).map(([k, v]) => `${v} ${k}`).join(', ')} · step ${ir.step} · values never read` : 'no snapshot yet';
  if (!ir) {
    $('ir').replaceChildren(el('div', 'muted', 'No snapshot yet.'));
    return;
  }
  const target = latestDecision(S)?.proposal?.actions?.[0]?.target;
  const rows = (ir.interactive || []).map((e) => {
    const f = e.flags || {};
    const flags = [f.editable && 'editable', f.submitter && 'submitter', f.required && 'required', f.disabled && 'disabled', f.occluded && 'occluded', f.in_viewport === false && 'off-screen'].filter(Boolean).join(' · ');
    return h('tr', e.id === target ? 'hl' : '', el('td', 'mono', e.id), el('td', '', `${e.role}${e.tag ? ` · ${e.tag}` : ''}${e.input_type ? `[${e.input_type}]` : ''}`), h('td', '', tokenized(e.name || '–')),
      el('td', '', e.value_category ?? '–'), el('td', '', e.has_value === null ? '–' : e.has_value ? 'HAS_VALUE' : 'empty'), el('td', 'muted', flags));
  });
  $('ir').replaceChildren(
    kv([
      ['page', `${ir.page?.origin ?? ''}${ir.page?.path ?? ''}`],
      ['title', ir.page?.title ?? ''],
      ['snapshot', sn ? `${sn.elements} elements (${sn.interactive} interactive) of ${sn.candidates} candidates · ${sn.duration_ms} ms · step ${sn.step}` : '–'],
      ['by kind', Object.entries(ir.by_kind || {}).map(([k, v]) => `${v} ${k}`).join(' · ')],
      ['regions', (ir.regions || []).map((r) => `${r.id} ${r.kind} "${r.label}" → ${r.status}`).join(' · ') || 'none'],
    ]),
    el('p', 'note', 'Field values are never read: only HAS_VALUE and a category. Fingerprints are computed for the V3 stale check but stay local.'),
    h('details', 'ir-details', el('summary', '', `Interactive elements (${rows.length}) · highlighted: current action target`),
      h('div', 'tbl-wrap', h('table', 'tbl', h('thead', '', h('tr', '', ['ID', 'Role', 'Name (sanitized)', 'Field category', 'Value', 'Flags'].map((t) => el('th', '', t)))), h('tbody', '', rows)))),
  );
  $('ir').querySelector('details').open = irOpen;
}
let irOpen = true;

// ---- AI proposal vs local safety authority ------------------------------------------------------
function renderDecision() {
  const rec = latestDecision(S);
  $('decStep').textContent = rec ? `step ${rec.n}${rec.n !== latestStep(S) ? ' · latest decision' : ''}` : '';
  if (!rec) {
    $('decision').replaceChildren(el('p', 'muted empty', 'No planner decision yet.'));
    return;
  }
  const p = rec.proposal;
  const a = p?.actions?.[0] ?? rec.rejection?.action ?? null;
  const name = a?.target ? (S.ir?.interactive || []).find((e) => e.id === a.target)?.name : null;
  const block = (cls, who, verb, ...body) => h('article', `link ${cls}`, h('header', 'link-h', el('span', 'link-who', who), el('span', 'link-verb', verb)), ...body);
  // The header's weight is on the verb: the planner proposes, VEIL decides.

  const ai = block(
    'remote',
    'Remote planner · untrusted',
    'Proposes',
    p
      ? [
          h('p', 'act', el('span', 'act-verb', a ? String(a.type).toUpperCase() : p.status), a?.target ? h('span', 'act-target', `${a.target}${name ? ` “${name}”` : ''}`) : null),
          kv([
            ['input', a?.text !== undefined ? tokenized(a.text) : a?.option !== undefined ? tokenized(a.option) : undefined],
            ['question', a?.question !== undefined ? tokenized(a.question) : undefined],
            ['summary', a?.summary !== undefined ? tokenized(a.summary) : undefined],
            ['message', p.message ? tokenized(`“${p.message}”`) : undefined],
            ['planner', S.planner ? `${S.planner.provider} · ${S.planner.model}` : 'not reported'],
            ['step', rec.n],
            ['latency', ms(p.latency_ms)],
            ['schema', badge(p.schema === 'valid' ? 'passed' : 'observed', p.schema === 'valid' ? '✓ VALID (local zod V1)' : 'not reported')],
          ]),
        ]
      : kv([['response', badge('failed', '✗ rejected by the local schema')], ['reason', rec.rejection?.reason ?? '']]),
  );

  const v = rec.validation;
  const rj = rec.rejection;
  const c = rec.confirmation;
  let verdict;
  let result;
  if (rj && rj.action && !rj.handoff) {
    verdict = badge('blocked', `⊘ REJECTED · ${rj.rule ?? rj.result}`);
    result = badge('blocked', 'ACTION BLOCKED · not executed');
  } else if (rj?.handoff) {
    verdict = badge('warn', `! HANDED TO USER · ${rj.rule}`);
    result = badge('warn', 'agent does not fill this field');
  } else if (v) {
    verdict = v.confirm?.length ? badge('warn', `! CONFIRMATION REQUIRED · ${v.confirm.join(', ')}`) : badge('passed', '✓ ALLOWED');
    if (c && c.approved === false) result = badge('blocked', 'ACTION BLOCKED · user denied, not executed');
    else if (c && c.approved === null) result = badge('running', '● waiting for the user');
    else if (a?.type === 'done') result = badge('passed', '✓ planner declared done · accepted locally');
    else if (a?.type === 'ask_user') result = rec.answer ? badge('passed', '✓ user answered (sanitized)') : badge('running', '● waiting for the user');
    else if (rec.verification) result = rec.verification.passed ? badge('passed', '✓ executed and verified') : badge('failed', '✗ executed, NOT verified');
    else if (rec.execution) result = rec.execution.ok ? badge('running', '● executed, verifying') : badge('failed', `✗ execution failed`);
    else result = badge('running', '● in progress');
  } else {
    verdict = badge('pending');
    result = badge('pending');
  }
  // A task that ended while this step was still waiting: say how it ended, not "waiting".
  const endedHere = S.outcome && S.outcome.step === rec.n;
  if (endedHere && result.classList.contains('s-running')) {
    const tone = { done: 'passed', stopped: 'stopped', panel_closed: 'stopped', blocked: 'blocked' }[S.outcome.outcome] ?? 'failed';
    result = badge(tone, `task ended: ${OUTCOME_LABEL[S.outcome.outcome] ?? S.outcome.outcome}`);
  }
  let userDecision = 'not required';
  let userTone = 'na';
  if (c) {
    userDecision = c.approved === null ? (endedHere ? 'no decision (task ended)' : 'waiting…') : c.approved ? 'APPROVED' : 'DENIED';
    userTone = c.approved === null ? (endedHere ? 'interrupted' : 'running') : c.approved ? 'passed' : 'blocked';
  } else if (v?.confirm?.length) {
    // Validation said a confirmation is needed; the request itself has not been reported (yet).
    userDecision = endedHere ? 'no decision (task ended)' : 'confirmation required';
    userTone = endedHere ? 'interrupted' : 'warn';
  } else if (rec.answer) {
    userDecision = tokenized(`answered → ${rec.answer.answer}`);
    userTone = 'passed';
  } else if (a?.type === 'ask_user') {
    userDecision = endedHere ? 'no answer (task ended)' : 'waiting…';
    userTone = endedHere ? 'interrupted' : 'running';
  }
  const taint = v?.taint;
  const local = block(
    'local',
    'VEIL, on this device',
    'Decides',
    kv([
      ['checks run', v?.checks ? h('span', 'rules', [...v.checks.map((r) => el('span', 'rule ok', r.split('_')[0])), ...(v.live_checks || []).map((r) => el('span', 'rule ok', `${r.split('_')[0]} live`))]) : rj ? h('span', 'rules', el('span', 'rule bad', rj.rule ?? rj.result)) : '–'],
      ['taint', taint ? tokenized(`${taint.placeholder} is ${taint.placeholder_category} → field category ${taint.field_category}${v.confirm?.includes('T2_CATEGORY') ? ' (mismatch)' : ' (match)'}`) : a?.type === 'type' ? 'literal text (no placeholder)' : 'not applicable'],
      ['risk policy', v ? (v.confirm?.length ? v.confirm.join(', ') : 'no confirmation needed') : '–'],
      ['reason', rj?.reason],
    ]),
    h('div', 'link-foot', el('span', 'foot-k', 'Verdict'), verdict),
  );
  const rules = c?.rules?.length ? c.rules : v?.confirm ?? [];
  let userNote = 'Local validation did not ask for a confirmation for this action.';
  if (c || v?.confirm?.length) userNote = `Required by ${rules.join(', ') || 'a local rule'}: the action waits for you and never runs on a denial.`;
  else if (a?.type === 'ask_user' || rec.answer) userNote = 'The answer is sanitized on this device before the planner sees it.';
  else if (rj && !rj.handoff) userNote = 'Local code rejected the proposal, so there was nothing to confirm.';
  else if (!v) userNote = 'Not reached yet.';
  const user = block(`user s-${userTone}`, 'You', 'Confirm or answer', h('p', `user-d s-${userTone}`, userDecision), el('p', 'link-note', userNote));
  const res = block('result', 'Result', 'What happened', h('div', 'link-res', result));
  const arrow = () => el('div', 'chain-arrow', '→');
  $('decision').replaceChildren(h('div', 'chain', ai, arrow(), local, arrow(), user, arrow(), res));
}

// ---- execution + verification -------------------------------------------------------------------
function renderExecution() {
  const rec = latestExecution(S);
  const cur = latestStep(S);
  $('exStep').textContent = rec ? `step ${rec.n}${rec.n !== cur ? ` · the current step ${cur} has none` : ' · current step'}` : '';
  if (!rec) {
    $('execution').replaceChildren(el('p', 'muted empty', 'No browser action yet.'));
    return;
  }
  const r = rec.resolution;
  const x = rec.execution;
  const v = rec.verification;
  const ended = !!S.outcome;
  const flying = inFlight(S, rec);
  const a = x?.action ?? rec.validation?.action;
  const target = a?.target ? (S.ir?.interactive || []).find((e) => e.id === a.target)?.name : null;
  const cell = (status, title, text) => h('li', `xcell s-${status}`, h('div', 'xcell-h', glyph(status), el('span', 'xcell-t', title)), h('p', 'xcell-b', text instanceof Node ? text : tokenized(text)));
  let exec;
  if (x) exec = cell(x.ok ? (x.after_stop ? 'warn' : 'passed') : 'failed', 'Execution', `${actionText(x.action)} → ${x.ok ? 'ran in the page' : `error: ${x.error}`}${x.after_stop ? ' (finished after Stop: it was already dispatched and cannot be recalled)' : ''}`);
  else if (flying) exec = cell('interrupted', 'Execution', `${actionText(a)} was dispatched when the task ended: it may have run; its result was not observed`);
  else exec = cell(ended ? 'skipped' : 'running', 'Execution', ended ? 'not reached before the task ended' : 'waiting…');
  let verify;
  if (v) verify = cell(v.passed ? 'passed' : 'failed', 'Verification', `${v.check}: ${v.passed ? 'expected state confirmed' : 'expected state NOT confirmed'}`);
  else if (x || flying) verify = cell(x && !x.ok ? 'skipped' : ended ? 'skipped' : 'running', 'Verification', x && !x.ok ? 'not run' : ended ? 'not verified: the task ended first' : 'waiting…');
  else verify = cell(ended ? 'skipped' : 'pending', 'Verification', ended ? 'not reached before the task ended' : 'after execution');
  const items = [
    h('li', 'xcell xcell-act', h('div', 'xcell-h', el('span', 'xcell-t', 'Action')), h('p', 'act', el('span', 'act-verb', String(a?.type ?? '–').toUpperCase()), a?.target ? el('span', 'act-target', `${a.target}${target ? ` “${target}”` : ''}`) : null)),
    cell(r ? 'passed' : 'na', 'Resolved locally', r ? `${r.placeholder} (${r.category}) was filled in from the vault and handed to the page for ${r.target}. The value never went to the backend.` : 'Not needed: no placeholder in this action.'),
    exec,
    x && x.settled !== undefined ? cell(x.settled ? 'passed' : 'warn', 'Settle', `${x.settled ? 'Page stabilized' : 'Did not fully settle'} in ${ms(x.settle_ms)} · ${x.mutations ?? 0} DOM mutations`) : cell(ended && !x ? 'skipped' : 'pending', 'Settle', x ? 'not reported' : ended ? 'not reached' : 'after execution'),
    verify,
  ];
  $('execution').replaceChildren(h('ol', 'xchain', items));
}

// ---- outbound payload ---------------------------------------------------------------------------
function renderPayload() {
  const list = S.payloads;
  if (!list.length) {
    $('payloadTabs').replaceChildren();
    $('payloadSum').textContent = 'nothing has left the browser yet';
    $('payload').replaceChildren(el('div', 'muted', 'No request has left the browser yet.'));
    return;
  }
  const all = list.map((p) => recheckPayload(p.payload || {}));
  const fk = all.reduce((n, r) => n + r.forbiddenKeys.length, 0);
  const hs = all.reduce((n, r) => n + r.htmlStrings, 0);
  $('payloadSum').textContent = `${plural(list.length, 'request')} · ${list.reduce((n, p) => n + (p.bytes || 0), 0).toLocaleString()} bytes · ${fk} forbidden keys · ${hs} HTML strings`;
  const sel = list.find((p) => p.step === payloadStep) ?? list[list.length - 1];
  $('payloadTabs').replaceChildren(
    ...list.map((p) => {
      const b = el('button', p === sel ? 'tab on' : 'tab', `step ${p.step}`);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(p === sel));
      b.onclick = () => {
        payloadStep = p === list[list.length - 1] ? null : p.step;
        schedule();
      };
      return b;
    }),
  );
  const pl = sel.payload || {};
  const rc = recheckPayload(pl);
  const summary = kv([
    ['request', sel.request_id ?? '–'],
    ['step', sel.step],
    ['to', 'VEIL backend (/plan) → planner provider'],
    ['planner', S.planner ? `${S.planner.provider} · ${S.planner.model}` : 'not reported'],
    ['size', `${sel.bytes} bytes`],
    ['response', sel.http_status ? `HTTP ${sel.http_status} after ${ms(sel.response_ms)}` : '–'],
    ['task', tokenized(pl.task ?? '–')],
    ['page', pl.page ? `${pl.page.origin}${pl.page.path} · "${pl.page.title}"` : '–'],
    ['IR', `${rc.elements} elements (value info: has_value/category only) · ${(pl.regions || []).length} regions`],
    ['placeholders', (pl.placeholders || []).length ? h('span', 'toks', (pl.placeholders || []).map((p) => h('span', 'tok-pair', el('span', 'tok', p.id), ` ${p.category}`))) : 'none'],
    ['history', (pl.history || []).length ? h('ol', 'hist', (pl.history || []).map((x) => h('li', '', tokenized(`step ${x.step}: ${actionText(x.action)} → ${x.result}${x.rule ? ` (${x.rule})` : ''}${x.user_answer ? ` · answer: ${x.user_answer}` : ''}`)))) : 'none'],
    ['top-level fields', rc.topLevelKeys.join(', ')],
    ['re-check', h('span', 'rules', el('span', `rule ${rc.forbiddenKeys.length ? 'bad' : 'ok'}`, `${rc.forbiddenKeys.length} forbidden keys`), el('span', `rule ${rc.htmlStrings ? 'bad' : 'ok'}`, `${rc.htmlStrings} HTML strings`))],
  ]);
  const json = el('pre', 'json', JSON.stringify(pl, null, 2));
  $('payload').replaceChildren(h('div', 'payload-grid', h('div', '', summary), h('div', 'json-col', el('div', 'json-h', 'Exact JSON that crossed the egress boundary'), json)));
}

// ---- timeline -----------------------------------------------------------------------------------
let rendered = 0;
let renderedReorders = 0;
function renderTimeline() {
  const box = $('timeline');
  if (rendered > S.events.length || S.reorders !== renderedReorders) {
    // A late event was slotted in by time: rebuild so the list stays in the order things happened.
    box.replaceChildren();
    rendered = 0;
    renderedReorders = S.reorders;
  }
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  let lastStep = rendered ? S.events[rendered - 1].step : null;
  for (const ev of S.events.slice(rendered)) {
    if (ev.step !== lastStep) {
      box.append(el('li', 'tl-step', ev.step === 0 ? 'Task set-up' : `Step ${ev.step}`));
      lastStep = ev.step;
    }
    const st = eventStatus(ev);
    const data = { ...(ev.data || {}) };
    if (ev.type === 'REQUEST_SENT') data.payload = '(see Outbound payload)';
    const li = h(
      'li',
      `tl s-${st} fresh`,
      el('span', 'tl-time', timeMs(ev.ts)),
      glyph(st),
      el('span', 'tl-type', label(ev)),
      h('details', 'tl-body', h('summary', '', tokenized(summarize(ev))), el('pre', 'json small', JSON.stringify(data, null, 2))),
    );
    box.append(li);
    setTimeout(() => li.classList.remove('fresh'), 1200);
  }
  rendered = S.events.length;
  if (nearBottom) box.scrollTop = box.scrollHeight;
  $('tlCount').textContent = S.events.length ? `${S.events.length} events` : 'no events yet';
}

function render() {
  renderHeader();
  renderPipeline();
  renderSteps();
  renderSanitize();
  renderPrivacy();
  renderDecision();
  renderExecution();
  renderPayload();
  renderIR();
  renderTimeline();
}

/** Delivery delay of the latest live event (emit time in the side panel → arrival here, same machine). */
let lastLagMs = null;

function onEvent(ev, live = false) {
  const before = S.session;
  if (live && Number.isFinite(ev?.ts)) lastLagMs = Math.max(0, Date.now() - ev.ts);
  S = reduce(S, ev);
  if (S.session !== before) {
    payloadStep = null;
    rendered = 0;
    $('timeline').replaceChildren();
  }
  schedule();
}

// ---- transport (read-only) ----------------------------------------------------------------------
async function loadState() {
  try {
    const r = await fetch(`${RELAY_URL}/telemetry/state`);
    const st = await r.json();
    for (const ev of st.events || []) onEvent(ev);
  } catch {
    /* relay offline; the stream will retry */
  }
}

function connect() {
  const es = new EventSource(`${RELAY_URL}/telemetry/stream`);
  es.onopen = () => {
    $('conn').textContent = '● live';
    $('conn').className = 'conn s-passed';
  };
  // Telemetry is delivered after the fact, one event at a time; show by how much, so a page change
  // that appears before its proposal/validation cards update is not mistaken for a reordering.
  setInterval(() => {
    if ($('conn').classList.contains('s-passed') && lastLagMs !== null) $('conn').textContent = `● live · events arrive ${ms(lastLagMs)} after they happen`;
  }, 1000);
  es.onerror = () => {
    $('conn').textContent = 'relay offline, retrying…';
    $('conn').className = 'conn s-failed';
  };
  es.addEventListener('veil', (m) => {
    try {
      onEvent(JSON.parse(m.data), true);
    } catch {
      /* ignore malformed */
    }
  });
}

document.addEventListener('toggle', (e) => {
  if (e.target.classList?.contains('ir-details')) irOpen = e.target.open;
}, true);
setInterval(() => {
  if (S.session && !S.outcome) renderHeader();
}, 500);
render();
// Subscribe first, then load the stored state: nothing emitted in between is missed (the reducer drops
// duplicates by event_id and orders by ts).
connect();
void loadState();
