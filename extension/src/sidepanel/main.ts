// Side panel UI. Binds DOM controls to the Agent. Shows placeholders/categories only.
// All text is rendered with textContent (page-derived strings are untrusted).

import { CONFIG } from '../shared/config';
import type { SnapshotResponse } from '../shared/messages';
import { ensureContentScript, getActiveTab, sendToTab } from '../platform/chrome';
import { Vault } from '../privacy/vault';
import { Sanitizer } from '../privacy/sanitizer';
import { sanitizeSnapshot, type SanitizedSnapshot } from '../egress/payload';
import { EgressClient } from '../egress/client';
import { Agent, type AgentUI, type Outcome, type PlannerInfo } from './agent';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  health: $('health'),
  task: $<HTMLTextAreaElement>('task'),
  start: $<HTMLButtonElement>('start'),
  stop: $<HTMLButtonElement>('stop'),
  sanitizedTask: $('sanitizedTask'),
  stage: $('stage'),
  stageDetail: $('stageDetail'),
  vaultCount: $('vaultCount'),
  vaultList: $('vaultList'),
  prompt: $('prompt'),
  promptTitle: $('promptTitle'),
  promptReasons: $('promptReasons'),
  promptInput: $<HTMLTextAreaElement>('promptInput'),
  promptYes: $<HTMLButtonElement>('promptYes'),
  promptNo: $<HTMLButtonElement>('promptNo'),
  log: $('log'),
  debug: $('debug'),
  snapNow: $<HTMLButtonElement>('snapNow'),
};

let agent: Agent | null = null;
/** Last planner identity reported by /health (metadata only; forwarded to telemetry for the dashboard). */
let planner: PlannerInfo | null = null;
let cancelPrompt: (() => void) | null = null;

function log(line: string, kind: 'info' | 'ok' | 'warn' | 'error' = 'info') {
  const li = document.createElement('li');
  li.className = kind;
  li.textContent = line;
  els.log.append(li);
  els.log.scrollTop = els.log.scrollHeight;
}

function renderDebug(s: SanitizedSnapshot) {
  const lines = [
    `page: ${s.page.origin}${s.page.path}  "${s.page.title}"`,
    `elements: ${s.elements.length}  regions: ${s.regions.length}  detections: ${s.detections.length}`,
    '',
    ...s.elements.map((e) => {
      const st = e.state;
      const flags = [st.editable && 'editable', st.has_value && 'has_value', st.value_category, st.submitter && 'submitter', st.disabled && 'disabled', e.occluded && 'occluded', !e.in_viewport && 'offscreen']
        .filter(Boolean)
        .join(',');
      return `${e.id.padEnd(5)} ${e.kind.slice(0, 4)} ${e.role.padEnd(9)} ${JSON.stringify(e.name || e.text).slice(0, 80)}${flags ? `  [${flags}]` : ''}`;
    }),
    ...s.regions.map((r) => `${r.id.padEnd(5)} REGION ${r.kind} ${JSON.stringify(r.label)} (${r.status})`),
  ];
  els.debug.textContent = lines.join('\n');
}

type PromptMode = { kind: 'confirm' } | { kind: 'ask' } | { kind: 'handoff' };

function showPrompt(mode: PromptMode, title: string, reasons: string[]): Promise<string | boolean | null> {
  cancelPrompt?.();
  els.prompt.classList.remove('hidden');
  els.promptTitle.textContent = title;
  els.promptReasons.replaceChildren(...reasons.map((r) => Object.assign(document.createElement('li'), { textContent: r })));
  els.promptInput.value = '';
  els.promptInput.classList.toggle('hidden', mode.kind !== 'ask');
  els.promptYes.textContent = mode.kind === 'confirm' ? 'Allow' : mode.kind === 'ask' ? 'Send answer' : "I've done it";
  els.promptNo.textContent = mode.kind === 'confirm' ? 'Deny' : mode.kind === 'ask' ? 'Stop task' : 'Skip';
  if (mode.kind === 'ask') els.promptInput.focus();
  return new Promise((resolve) => {
    const done = (v: string | boolean | null) => {
      els.prompt.classList.add('hidden');
      els.promptYes.onclick = els.promptNo.onclick = null;
      cancelPrompt = null;
      resolve(v);
    };
    cancelPrompt = () => done(mode.kind === 'ask' ? null : false);
    els.promptYes.onclick = () => done(mode.kind === 'ask' ? els.promptInput.value : true);
    els.promptNo.onclick = () => done(mode.kind === 'ask' ? null : false);
  });
}

const ui: AgentUI = {
  stage(stage, detail) {
    els.stage.textContent = stage;
    els.stageDetail.textContent = detail ?? '';
  },
  log,
  async confirm(title, reasons) {
    return (await showPrompt({ kind: 'confirm' }, title, reasons)) === true;
  },
  async ask(question) {
    const r = await showPrompt({ kind: 'ask' }, `Agent asks: ${question}`, []);
    return typeof r === 'string' ? r : null;
  },
  async handoff(message) {
    return (await showPrompt({ kind: 'handoff' }, 'Your turn', [message])) === true;
  },
  debug: renderDebug,
  vault(entries) {
    els.vaultCount.textContent = String(entries.length);
    els.vaultList.replaceChildren(
      ...entries.map((e) => Object.assign(document.createElement('li'), { textContent: `${e.id} → ${e.category} → stored ${e.stored} (${e.source})` })),
    );
  },
  task(sanitized) {
    els.sanitizedTask.classList.remove('hidden');
    els.sanitizedTask.textContent = `sent as: ${sanitized}`;
  },
  finished(outcome: Outcome, message: string) {
    ui.stage(outcome === 'done' ? 'done' : outcome, message);
    els.stage.className = `pill ${outcome === 'done' ? 'pill-ok' : outcome === 'stopped' ? 'pill-muted' : 'pill-err'}`;
    log(`task ${outcome}: ${message}`, outcome === 'done' ? 'ok' : outcome === 'stopped' ? 'info' : 'error');
    cancelPrompt?.();
    els.start.disabled = false;
    els.stop.disabled = true;
  },
};

els.start.onclick = async () => {
  const task = els.task.value.trim();
  if (!task || agent?.running) return;
  els.log.replaceChildren();
  els.stage.className = 'pill';
  els.start.disabled = true;
  els.stop.disabled = false;
  agent = new Agent(ui, { planner });
  // The raw task stays in this textarea (local UI) only; the agent sanitizes it before anything else.
  await agent.run(task);
};

els.stop.onclick = () => agent?.stop('stopped');

// Kill switch: closing the panel stops the agent; the vault dies with this JS context.
window.addEventListener('pagehide', () => agent?.stop('panel_closed'));

// Debug snapshot (local only; sanitized with a throwaway vault).
els.snapNow.onclick = async () => {
  const tab = await getActiveTab();
  if (!tab || !(await ensureContentScript(tab.id))) {
    els.debug.textContent = 'No accessible tab (v0.1 runs on localhost pages).';
    return;
  }
  const res = await sendToTab<SnapshotResponse>(tab.id, { type: 'snapshot' });
  renderDebug(sanitizeSnapshot(res.snapshot, new Sanitizer(new Vault())));
};

async function checkHealth() {
  const probe = new EgressClient({ secrets: () => ({ text: [], digits: [] }), failClosed: () => new Sanitizer(new Vault()).failClosed() });
  try {
    const r = await probe.get(`${CONFIG.PLANNER_URL}/health`);
    const body = (await r.json()) as { status?: string; planner_configured?: boolean; provider?: string; model?: string; effort?: string };
    planner = body.planner_configured && body.provider && body.model ? { provider: body.provider, model: body.model, effort: body.effort ?? null } : null;
    els.health.textContent = body.planner_configured ? `backend: ok · ${body.model ?? ''}` : 'backend: ok · no LLM key';
    els.health.className = `pill ${body.planner_configured ? 'pill-ok' : 'pill-muted'}`;
  } catch {
    planner = null;
    els.health.textContent = 'backend: offline';
    els.health.className = 'pill pill-err';
  }
}
void checkHealth();
setInterval(checkHealth, 15_000);
