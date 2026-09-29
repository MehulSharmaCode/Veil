// Orchestration tests for the agent loop (side panel). The Chrome platform seam is mocked with a fake
// page and `fetch` is stubbed with a test-only scripted planner, so the real Agent, sanitizer, vault,
// egress gate/client, validator and telemetry run unchanged. One ordered log records planner calls,
// content-script requests and telemetry emits, which is what the causal-order assertions read.
// Synthetic values only; nothing here is reachable from the extension at runtime.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawElement, RawSnapshot } from '../src/shared/ir';
import type { ContentRequest } from '../src/shared/messages';

const ORIGIN = 'http://localhost:8080';
const EMAIL = 'mehul.test@example.com';
const ADDRESS = '12 MG Road, Shivajinagar, Pune';

// ---- fake page (content script) ------------------------------------------------------------------

function field(id: string, name: string, category: RawElement['state']['value_category'], over: Partial<RawElement> = {}): RawElement {
  return {
    id, kind: 'interactive', role: 'textbox', tag: 'input', input_type: 'text', name, text: '',
    state: { editable: true, has_value: false, value_category: category }, bbox: { x: 0, y: 0, w: 100, h: 20 },
    visible: true, in_viewport: true, occluded: false, context: {}, fingerprint: `f-${id}`, ...over,
  };
}
const SAVE: RawElement = {
  ...field('e3', 'Save changes', undefined),
  role: 'button', tag: 'button', input_type: undefined, text: 'Save changes', state: { submitter: true },
};
function snapshot(): RawSnapshot {
  return {
    page: { origin: ORIGIN, path: '/', title: 'Edit profile', viewport: { w: 1200, h: 800 }, scroll: { x: 0, y: 0, max_y: 0 } },
    elements: [field('e1', 'Email', 'email'), field('e2', 'Address', 'address', { tag: 'textarea', input_type: undefined }), SAVE],
    regions: [],
    stats: { candidates: 3, pruned: 0, duration_ms: 1 },
  };
}

type Log = string[];
let log: Log;
let typed: { id: string; text: string }[];
let content: (msg: ContentRequest) => Promise<unknown>;
const defaultContent = async (msg: ContentRequest): Promise<unknown> => {
  switch (msg.type) {
    case 'ping':
      return { ok: true, version: 'test' };
    case 'snapshot':
      return { ok: true, snapshot: snapshot() };
    case 'inspect': {
      const el = snapshot().elements.find((e) => e.id === msg.id);
      return { ok: true, exists: !!el, element: el };
    }
    case 'execute':
      if (msg.command.kind === 'type') typed.push({ id: msg.command.id, text: msg.command.text });
      return { ok: true, mutations: 1, settle_ms: 300, settled: true, changed: true, value_matches: true };
  }
};

vi.mock('../src/platform/chrome', () => ({
  getActiveTab: async () => ({ id: 7, url: `${ORIGIN}/`, windowId: 1 }),
  ensureContentScript: async () => true,
  sendToTab: async (_tab: number, msg: ContentRequest) => {
    log.push(msg.type === 'execute' ? `content:execute:${msg.command.kind}` : `content:${msg.type}`);
    return content(msg);
  },
}));

// ---- test-only scripted planner + telemetry sink ----------------------------------------------------

type Plan = { status: 'continue' | 'done' | 'need_user'; actions: unknown[]; message: string } | { __malformed: true } | (() => Promise<unknown>);
let plans: Plan[];
let planBodies: string[];
let telemetryBodies: string[];

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  log = [];
  typed = [];
  plans = [];
  planBodies = [];
  telemetryBodies = [];
  content = defaultContent;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/telemetry/events')) {
      telemetryBodies.push(String(init.body));
      return new Response(null, { status: 204 });
    }
    if (url.endsWith('/plan')) {
      log.push('planner:request');
      planBodies.push(String(init.body));
      const next = plans.shift() ?? { status: 'done', actions: [{ type: 'done', summary: 'script exhausted' }], message: '' };
      if (typeof next === 'function') {
        return new Promise<Response>((resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          void next().then((b) => resolve(respond(b)));
        });
      }
      return respond('__malformed' in next ? { status: 'continue', actions: [{ type: 'eval', code: 'x' }], message: '' } : next);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  // Telemetry sends are queued and can outlive a test: keep fetch stubbed with a closed network so a
  // late send can never reach a real relay on this machine (Telemetry swallows the error).
  vi.stubGlobal('fetch', async () => {
    throw new Error('network closed in tests');
  });
});

async function makeAgent(ui: Partial<import('../src/sidepanel/agent').AgentUI> = {}) {
  const { Agent } = await import('../src/sidepanel/agent');
  const { Telemetry } = await import('../src/telemetry/telemetry');
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const orig = Telemetry.prototype.emit;
  vi.spyOn(Telemetry.prototype, 'emit').mockImplementation(function (this: InstanceType<typeof Telemetry>, type, stage, data = {}, opts = {}) {
    log.push(`event:${type}`);
    events.push({ type, data });
    return orig.call(this, type, stage, data, opts);
  });
  const calls = { ask: [] as string[], confirm: [] as string[] };
  const agent = new Agent({
    stage: () => {}, log: () => {}, debug: () => {}, vault: () => {}, task: () => {}, finished: () => {},
    confirm: async (t) => (calls.confirm.push(t), false),
    ask: async (q) => (calls.ask.push(q), null),
    handoff: async () => false,
    ...ui,
  });
  return { agent, events, calls };
}

const at = (entry: string, from = 0) => log.indexOf(entry, from);
const type = (target: string, text: string) => ({ type: 'type', target, text });
const plan = (...actions: unknown[]) => ({ status: 'continue' as const, actions, message: 'next' });
const done = { status: 'done' as const, actions: [{ type: 'done', summary: 'filled' }], message: 'done' };
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---- tests -----------------------------------------------------------------------------------------

describe('agent loop: causal order of a browser-changing action', () => {
  it('planner → schema (V1) → live V2/V3 → validation/taint → local resolution → execute → verify, every step', async () => {
    plans = [plan(type('e1', '[EMAIL_1]')), plan(type('e2', '[ADDRESS_1]')), done];
    const { agent, events } = await makeAgent();
    await agent.run(`Fill my email ${EMAIL} and my address ${ADDRESS}. Do not submit.`);

    for (let from = 0, k = 0; k < 2; k++) {
      const req = at('planner:request', from);
      const received = at('event:LLM_ACTION_RECEIVED', req);
      const inspect = at('content:inspect', received);
      const validated = at('event:ACTION_VALIDATED', inspect);
      const resolved = at('event:PLACEHOLDER_RESOLVED', validated);
      const exec = at('content:execute:type', resolved);
      const executed = at('event:ACTION_EXECUTED', exec);
      const verified = at('event:VERIFICATION_COMPLETE', executed);
      expect([req, received, inspect, validated, resolved, exec, executed, verified].every((i) => i >= 0)).toBe(true);
      expect(req < received && received < inspect && inspect < validated && validated < resolved && resolved < exec && exec < executed && executed < verified).toBe(true);
      from = verified;
    }
    // Only the content script ever saw the real values, exactly once each.
    expect(typed).toEqual([{ id: 'e1', text: EMAIL }, { id: 'e2', text: ADDRESS }]);
    // Nothing that crossed the network holds them (planner bodies + telemetry bodies).
    for (const b of [...planBodies, ...telemetryBodies]) {
      expect(b).not.toContain(EMAIL);
      expect(b.toLowerCase()).not.toContain('shivajinagar');
    }
    expect(JSON.parse(planBodies[0]!).task).toBe('Fill my email [EMAIL_1] and my address [ADDRESS_1]. Do not submit.');
    expect(events.at(-1)).toMatchObject({ type: 'TASK_COMPLETED', data: { outcome: 'done' } });
    // No execute ever happens without a planner request before it in the same step.
    expect(log.filter((l) => l.startsWith('content:execute')).length).toBe(2);
  });

  it('a denied submit-like click is never dispatched; the loop re-plans', async () => {
    plans = [plan({ type: 'click', target: 'e3' }), done];
    const { agent, events, calls } = await makeAgent();
    await agent.run('Fill my email and save');
    expect(calls.confirm).toHaveLength(1);
    expect(log.some((l) => l.startsWith('content:execute'))).toBe(false);
    expect(events.find((e) => e.type === 'CONFIRMATION_RESOLVED')?.data).toMatchObject({ approved: false, result: 'blocked_not_executed' });
    expect(at('event:CONFIRMATION_REQUESTED')).toBeLessThan(at('event:CONFIRMATION_RESOLVED'));
    expect(log.filter((l) => l === 'planner:request')).toHaveLength(2);
    expect(JSON.parse(planBodies[1]!).history[0]).toMatchObject({ result: 'user_denied', rule: 'R1_SUBMIT_LIKE' });
  });

  it('a stale target (fingerprint changed) is rejected before dispatch', async () => {
    plans = [plan(type('e1', '[EMAIL_1]')), done];
    content = async (msg) => {
      if (msg.type === 'inspect') return { ok: true, exists: true, element: { ...snapshot().elements[0]!, fingerprint: 'f-changed' } };
      return defaultContent(msg);
    };
    const { agent, events } = await makeAgent();
    await agent.run(`Fill my email ${EMAIL}`);
    expect(log.some((l) => l.startsWith('content:execute'))).toBe(false);
    expect(events.find((e) => e.type === 'ACTION_REJECTED')?.data).toMatchObject({ rule: 'V3_FINGERPRINT', result: 'stale_target' });
  });

  it('a raw address smuggled as literal type text is rejected (T4), never typed', async () => {
    plans = [plan(type('e2', '45 Park Street, Kolkata')), done]; // PIN-less: only the new shape detector sees it
    const { agent, events } = await makeAgent();
    await agent.run('Fill my address');
    expect(typed).toEqual([]);
    expect(events.find((e) => e.type === 'ACTION_REJECTED')?.data).toMatchObject({ rule: 'T4_SMUGGLING' });
  });

  it('an unknown placeholder look-alike is rejected (V1), never resolved', async () => {
    plans = [plan(type('e1', '[EMAIL_7]')), done];
    const { agent, events } = await makeAgent();
    await agent.run(`Fill my email ${EMAIL}`);
    expect(typed).toEqual([]);
    expect(events.some((e) => e.type === 'PLACEHOLDER_RESOLVED')).toBe(false);
    expect(events.find((e) => e.type === 'ACTION_REJECTED')?.data).toMatchObject({ rule: 'V1_ACTION' });
  });
});

describe('agent loop: failures', () => {
  it('two malformed planner responses in a row count as consecutive failures and hand over to the user', async () => {
    plans = [{ __malformed: true }, { __malformed: true }];
    const { agent, events, calls } = await makeAgent();
    await agent.run('Fill my email');
    expect(events.filter((e) => e.type === 'ACTION_REJECTED' && e.data.rule === 'V1_ACTION')).toHaveLength(2);
    expect(events.some((e) => e.type === 'LLM_ACTION_RECEIVED')).toBe(false);
    expect(calls.ask).toEqual(['I could not complete the last actions. How should I proceed?']);
    expect(log.some((l) => l.startsWith('content:execute'))).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'TASK_COMPLETED', data: { outcome: 'stopped' } });
  });
});

describe('agent loop: Stop and panel close', () => {
  it('Stop while the planner is thinking: no action is ever dispatched, the vault is cleared', async () => {
    let release!: () => void;
    plans = [() => new Promise((r) => (release = () => r(plan(type('e1', '[EMAIL_1]')))))];
    const { agent, events } = await makeAgent();
    const run = agent.run(`Fill my email ${EMAIL}`);
    while (!log.includes('planner:request')) await tick();
    agent.stop();
    release();
    await run;
    expect(log.some((l) => l.startsWith('content:execute'))).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'TASK_COMPLETED', data: { outcome: 'stopped' } });
    expect(events.find((e) => e.type === 'VAULT_UPDATED' && e.data.cleared)).toBeTruthy();
    expect(events.some((e) => e.type === 'LLM_ACTION_RECEIVED')).toBe(false);
  });

  it('Stop while an execute is in flight: its real result is reported (flagged after_stop), nothing follows it', async () => {
    plans = [plan(type('e1', '[EMAIL_1]')), plan(type('e2', '[ADDRESS_1]'))];
    let finishExec!: () => void;
    content = async (msg) => {
      if (msg.type === 'execute') {
        await new Promise<void>((r) => (finishExec = r));
      }
      return defaultContent(msg);
    };
    const { agent, events } = await makeAgent();
    const run = agent.run(`Fill my email ${EMAIL} and my address ${ADDRESS}`);
    while (!log.includes('content:execute:type')) await tick();
    agent.stop();
    finishExec();
    await run;
    const stopAt = log.findIndex((l) => l === 'event:TASK_COMPLETED');
    const exec = events.find((e) => e.type === 'ACTION_EXECUTED');
    expect(exec?.data).toMatchObject({ ok: true, after_stop: true });
    expect(at('event:ACTION_EXECUTED')).toBeGreaterThan(stopAt);
    expect(events.some((e) => e.type === 'VERIFICATION_COMPLETE')).toBe(false);
    // No new snapshot, planner call or action after the Stop.
    expect(log.slice(stopAt).filter((l) => l.startsWith('content:') || l === 'planner:request')).toEqual([]);
    expect(log.filter((l) => l.startsWith('content:execute'))).toHaveLength(1);
  });

  it('Stop during a WAIT action: no ACTION_EXECUTED is claimed for the interrupted wait', async () => {
    plans = [plan({ type: 'wait', ms: 3000 })];
    const { agent, events } = await makeAgent();
    const run = agent.run('Wait a bit');
    while (!events.some((e) => e.type === 'ACTION_VALIDATED')) await tick();
    agent.stop();
    await run;
    expect(events.some((e) => e.type === 'ACTION_EXECUTED')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'TASK_COMPLETED', data: { outcome: 'stopped' } });
  });

  it('panel close ends the task as panel_closed and clears the vault; no new request follows', async () => {
    let release!: () => void;
    plans = [() => new Promise((r) => (release = () => r(plan(type('e1', '[EMAIL_1]')))))];
    const { agent, events } = await makeAgent();
    const run = agent.run(`Fill my email ${EMAIL}`);
    while (!log.includes('planner:request')) await tick();
    agent.stop('panel_closed');
    release();
    await run;
    expect(events.at(-1)).toMatchObject({ type: 'TASK_COMPLETED', data: { outcome: 'panel_closed' } });
    expect(events.find((e) => e.type === 'VAULT_UPDATED' && e.data.cleared)).toBeTruthy();
    expect(log.some((l) => l.startsWith('content:execute'))).toBe(false);
  });
});

describe('agent loop: ask_user', () => {
  it('a cue-less address answer is sanitized locally (the question sets the category), then resolved and typed', async () => {
    plans = [
      { status: 'need_user', actions: [{ type: 'ask_user', question: 'What is your address?' }], message: '' },
      plan(type('e2', '[ADDRESS_1]')),
      done,
    ];
    const { agent, events } = await makeAgent({ ask: async () => 'Shivajinagar, Pune' });
    await agent.run('Fill my address. Do not submit.');
    expect(events.find((e) => e.type === 'USER_ANSWERED')?.data).toEqual({ answer: '[ADDRESS_1]', placeholders: ['[ADDRESS_1]'] });
    expect(JSON.parse(planBodies[1]!).history.at(-1)).toMatchObject({ result: 'answered', user_answer: '[ADDRESS_1]' });
    expect(typed).toEqual([{ id: 'e2', text: 'Shivajinagar, Pune' }]);
    for (const b of [...planBodies, ...telemetryBodies]) expect(b.toLowerCase()).not.toContain('shivajinagar');
  });
});
