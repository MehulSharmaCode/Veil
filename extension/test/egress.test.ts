import { describe, expect, it, vi, afterEach } from 'vitest';
import { checkEgress } from '../src/egress/gate';
import { EgressClient, remediate } from '../src/egress/client';
import { buildPlannerPayload, sanitizeSnapshot } from '../src/egress/payload';
import type { PlannerPayload } from '../src/egress/schema';
import { Sanitizer } from '../src/privacy/sanitizer';
import { REDACTED } from '../src/privacy/sanitized';
import { Vault } from '../src/privacy/vault';
import type { RawElement, RawSnapshot } from '../src/shared/ir';

const ORIGIN = 'http://localhost:8080';

function rawEl(id: string, over: Partial<RawElement> = {}): RawElement {
  return {
    id,
    kind: 'interactive',
    role: 'textbox',
    tag: 'input',
    input_type: 'text',
    name: 'Field',
    text: '',
    state: { editable: true, has_value: false, value_category: 'free_text' },
    bbox: { x: 0, y: 10, w: 100, h: 20 },
    visible: true,
    in_viewport: true,
    occluded: false,
    context: { section: 'Profile', form: 'Edit profile' },
    fingerprint: `f${id}`,
    ...over,
  };
}

function rawSnap(elements: RawElement[]): RawSnapshot {
  return {
    page: { origin: ORIGIN, path: '/profile', title: 'Portal', viewport: { w: 1280, h: 800 }, scroll: { x: 0, y: 0, max_y: 0 } },
    elements,
    regions: [{ id: 'e99', kind: 'img', bbox: { x: 0, y: 0, w: 64, h: 64 }, label: 'Profile photo of Rahul Sharma', in_viewport: true, status: 'unperceived' }],
    stats: { candidates: elements.length, pruned: 0, duration_ms: 1 },
  };
}

function setup(elements: RawElement[] = [rawEl('e1')]) {
  const vault = new Vault();
  const s = new Sanitizer(vault);
  const task = s.sanitize('Fill my email mehul.test@example.com and my address 12 MG Road, Shivajinagar, Pune 411005. Do not submit.', { source: 'task', origin: ORIGIN });
  const snapshot = sanitizeSnapshot(rawSnap(elements), s);
  const payload = buildPlannerPayload({ sessionId: 'abcdefghijklmnop', step: 1, task, snapshot, placeholders: vault.metadata(), history: [] });
  return { vault, s, payload };
}

describe('payload builder', () => {
  it('builds a schema-valid, sanitized payload that passes the gate', () => {
    const { vault, payload } = setup([
      rawEl('e1', { kind: 'text', role: 'text', tag: 'p', name: '', text: 'Signed in as Rahul Sharma (rahul.sharma@example.test)', state: {} }),
      rawEl('e2', { name: 'Email', input_type: 'email', state: { editable: true, has_value: false, value_category: 'email' } }),
    ]);
    expect(payload.task).toBe('Fill my email [EMAIL_1] and my address [ADDRESS_1]. Do not submit.');
    expect(payload.elements[0]!.text).toBe('Signed in as [PERSON_1] ([EMAIL_2])');
    expect(payload.regions[0]!.label).toBe('Profile photo of [PERSON_1]'); // known-value reuse
    const r = checkEgress('plan', payload, vault.secretForms());
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    const json = JSON.stringify(payload);
    for (const raw of ['mehul.test', 'MG Road', 'Rahul', 'rahul.sharma', '411005']) expect(json).not.toContain(raw);
  });
  it('drops query strings from paths and non-allowlisted tags', () => {
    const vault = new Vault();
    const s = new Sanitizer(vault);
    const snap = rawSnap([rawEl('e1', { tag: 'x-rahul-widget', link_path: '/a/b?x=1#y' })]);
    snap.page.path = '/p?token=abc';
    const out = sanitizeSnapshot(snap, s);
    expect(out.page.path).toBe('/p');
    expect(out.elements[0]!.tag).toBe('custom');
    expect(out.elements[0]!.link_path).toBe('/a/b');
  });
  it('prunes off-viewport text first and never drops in-viewport interactive elements', () => {
    const els: RawElement[] = [];
    for (let i = 0; i < 280; i++) els.push(rawEl(`e${i}`, { kind: 'text', role: 'text', tag: 'p', text: 'x'.repeat(150), in_viewport: false, bbox: { x: 0, y: 5000 + i, w: 1, h: 1 }, state: {} }));
    for (let i = 280; i < 300; i++) els.push(rawEl(`e${i}`));
    const { payload } = setup(els);
    expect(new TextEncoder().encode(JSON.stringify(payload)).length).toBeLessThanOrEqual(30_000);
    expect(payload.elements.filter((e) => e.kind === 'interactive')).toHaveLength(20);
  });
});

describe('egress gate', () => {
  const secretsOf = (v: Vault) => v.secretForms();

  it('G1 rejects unexpected fields', () => {
    const { vault, payload } = setup();
    const bad = { ...payload, extra: 1 };
    expect(checkEgress('plan', bad, secretsOf(vault)).failures.map((f) => f.rule)).toContain('G1_SCHEMA');
  });
  it('G2 rejects disallowed field names anywhere', () => {
    const { vault } = setup();
    const ev = { event_id: 'abcdefgh', ts: 1, session_id: 'abcdefghijklmnop', step: 0, type: 'X_Y', stage: 'x', data: { nested: { value: 'x' } } };
    const r = checkEgress('telemetry', ev, secretsOf(vault));
    expect(r.failures).toContainEqual({ rule: 'G2_FORBIDDEN_KEY', path: ['data', 'nested', 'value'] });
  });
  it('G3 rejects HTML markup', () => {
    const { vault, payload } = setup();
    payload.elements[0]!.text = '<div onclick="x">hi</div>' as never;
    expect(checkEgress('plan', payload, secretsOf(vault)).failures).toContainEqual({ rule: 'G3_HTML', path: ['elements', 0, 'text'] });
  });
  it('G4 rejects URL query strings and fragments', () => {
    const { vault, payload } = setup();
    payload.elements[0]!.name = 'see https://x.test/a?id=5' as never;
    payload.page.path = '/a#frag' as never;
    const rules = checkEgress('plan', payload, secretsOf(vault)).failures;
    expect(rules).toContainEqual({ rule: 'G4_URL_QUERY', path: ['elements', 0, 'name'] });
    expect(rules).toContainEqual({ rule: 'G4_URL_QUERY', path: ['page', 'path'] });
  });
  it('G5 residual scan catches unsanitized PII', () => {
    const { payload } = setup();
    payload.elements[0]!.name = 'Contact priya@example.org' as never;
    expect(checkEgress('plan', payload, { text: [], digits: [] }).failures).toContainEqual({ rule: 'G5_RESIDUAL_PII', path: ['elements', 0, 'name'] });
  });
  it('G6 tripwire catches known vault values in any form', () => {
    const { vault, payload } = setup();
    // A value no detector would catch on its own (no cue), but which the vault knows.
    payload.elements[0]!.text = 'Deliver to 12 mg road, shivajinagar, pune 411005' as never;
    expect(checkEgress('plan', payload, secretsOf(vault)).failures.map((f) => f.rule)).toContain('G6_TRIPWIRE');
    const v2 = new Vault();
    v2.assign('PHONE', '+91 98765 43210', { source: 'task', origin: ORIGIN });
    const ev = { event_id: 'abcdefgh', ts: 1, session_id: 'abcdefghijklmnop', step: 0, type: 'X_Y', stage: 'x', data: { note: 'ref 98765-43210x' } };
    expect(checkEgress('telemetry', ev, v2.secretForms()).failures.map((f) => f.rule)).toContain('G6_TRIPWIRE');
  });
  it('G6 whole-message tripwire catches values split across non-string fields', () => {
    const v = new Vault();
    v.assign('PHONE', '9876543210', { source: 'task', origin: ORIGIN });
    const ev = { event_id: 'abcdefgh', ts: 1, session_id: 'abcdefghijklmnop', step: 0, type: 'X_Y', stage: 'x', data: { n: 9876543210 } };
    expect(checkEgress('telemetry', ev, v.secretForms()).failures).toContainEqual({ rule: 'G6_TRIPWIRE', path: [] });
  });
  it('G7 size limit', () => {
    const ev = { event_id: 'abcdefgh', ts: 1, session_id: 'abcdefghijklmnop', step: 0, type: 'X_Y', stage: 'x', data: { big: 'a '.repeat(40_000) } };
    expect(checkEgress('telemetry', ev, { text: [], digits: [] }).failures.map((f) => f.rule)).toContain('G7_SIZE');
  });
  it('G0: an exception inside the gate is a failure', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(checkEgress('telemetry', cyclic, { text: [], digits: [] }).failures).toEqual([{ rule: 'G0_GATE_ERROR', path: [] }]);
  });
});

describe('M8 dashboard telemetry shapes', () => {
  const ev = (type: string, stage: string, data: Record<string, unknown>) => ({
    event_id: 'abcdefgh12', ts: 1, session_id: 'abcdefghijklmnop', step: 1, type, stage, data,
  });
  function vaultWithTask() {
    const vault = new Vault();
    const s = new Sanitizer(vault);
    const task = s.sanitize('Fill my email mehul.test@example.com and my address 12 MG Road, Shivajinagar, Pune 411005.', { source: 'task', origin: ORIGIN });
    return { vault, task };
  }
  it('the new/extended event shapes pass the telemetry gate with placeholders only', () => {
    const { vault, task } = vaultWithTask();
    const secrets = vault.secretForms();
    const events = [
      ev('TASK_STARTED', 'task', { task, origin: ORIGIN, planner: { provider: 'groq', model: 'openai/gpt-oss-20b', effort: 'medium' }, limits: { max_steps: 15, max_actions_per_step: 1, max_consecutive_failures: 2 } }),
      ev('EGRESS_CHECK_PASSED', 'egress', { attempt: 1, bytes: 7000, failures: [], rules_checked: ['G0_GATE_ERROR', 'G1_SCHEMA', 'G7_SIZE'] }),
      ev('LLM_ACTION_RECEIVED', 'plan', { status: 'continue', actions: [{ type: 'type', target: 'e10', text: '[EMAIL_1]' }], message: 'Fill email', latency_ms: 800, schema: 'valid' }),
      ev('ACTION_VALIDATED', 'validate', { action: { type: 'type', target: 'e10', text: '[EMAIL_1]' }, confirm: [], checks: ['V1_ACTION', 'T2_CATEGORY'], live_checks: ['V2_TARGET', 'V3_FINGERPRINT'], taint: { placeholder: '[EMAIL_1]', placeholder_category: 'EMAIL', field_category: 'email' } }),
      ev('PLACEHOLDER_RESOLVED', 'resolve', { placeholder: '[EMAIL_1]', category: 'EMAIL', target: 'e10' }),
      ev('CONFIRMATION_RESOLVED', 'confirm', { action: { type: 'click', target: 'e14' }, approved: false, result: 'blocked_not_executed' }),
      ev('USER_ANSWERED', 'ask', { answer: '[ADDRESS_1]', placeholders: ['[ADDRESS_1]'] }),
      ev('ERROR', 'error', { code: 'PLANNER_ERROR', reason: 'Planner error: rate limit reached; retry in ~12 s' }),
    ];
    for (const e of events) expect(checkEgress('telemetry', e, secrets).failures, e.type).toEqual([]);
  });
  it('a resolution or answer event that carried a real value would be stopped by the gate', () => {
    const { vault } = vaultWithTask();
    const secrets = vault.secretForms();
    const leakyResolve = ev('PLACEHOLDER_RESOLVED', 'resolve', { placeholder: '[EMAIL_1]', category: 'EMAIL', target: 'mehul.test@example.com' });
    expect(checkEgress('telemetry', leakyResolve, secrets).failures.map((f) => f.rule)).toContain('G6_TRIPWIRE');
    const leakyAnswer = ev('USER_ANSWERED', 'ask', { answer: '12 MG Road, Shivajinagar, Pune 411005', placeholders: [] });
    expect(checkEgress('telemetry', leakyAnswer, secrets).ok).toBe(false);
  });
});

describe('egress client: retry-then-block', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('masks offending fields via fail-closed sanitizer, re-checks once, then sends', async () => {
    const { vault, s, payload } = setup();
    payload.elements[0]!.name = 'Contact priya@example.org' as never;
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const phases: string[] = [];
    const client = new EgressClient({ secrets: () => vault.secretForms(), failClosed: () => s.failClosed(), onGate: (r) => phases.push(`${r.phase}:${r.attempt}`) });
    const res = await client.send('plan', 'http://localhost:8000/plan', payload);
    expect(res.sent).toBe(true);
    expect(phases).toEqual(['failed:1', 'passed:2']);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string) as PlannerPayload;
    expect(body.elements[0]!.name).toBe(REDACTED);
    expect(JSON.stringify(body)).not.toContain('priya');
  });
  it('hard-blocks (nothing sent) when remediation cannot fix it', async () => {
    const { vault, s, payload } = setup();
    const bad = { ...payload, html: '<p>x</p>' };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new EgressClient({ secrets: () => vault.secretForms(), failClosed: () => s.failClosed() });
    const res = await client.send('plan', 'http://localhost:8000/plan', bad);
    expect(res.sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    if (!res.sent) {
      expect(res.blocked.phase).toBe('blocked');
      expect(JSON.stringify(res.blocked)).not.toContain('<p>');
    }
  });
  it('remediate refuses whole-message failures', () => {
    expect(remediate({ a: 'x' }, [{ rule: 'G6_TRIPWIRE', path: [] }], REDACTED)).toBeNull();
  });
});
