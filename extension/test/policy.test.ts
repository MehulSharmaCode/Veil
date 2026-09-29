import { describe, expect, it } from 'vitest';
import { ActionSchema, PlanResponseSchema } from '../src/shared/actions';
import { classifyField } from '../src/shared/fieldCategory';
import type { RawElement } from '../src/shared/ir';
import { isSubmitLike } from '../src/policy/submitLike';
import { validateAction, validateLive, type PolicyContext } from '../src/policy/validator';
import { Vault } from '../src/privacy/vault';

const ORIGIN = 'http://localhost:8080';

function el(id: string, over: Partial<RawElement> = {}): RawElement {
  return {
    id, kind: 'interactive', role: 'textbox', tag: 'input', input_type: 'text', name: 'Field', text: '',
    state: { editable: true, value_category: 'free_text' }, bbox: { x: 0, y: 0, w: 10, h: 10 },
    visible: true, in_viewport: true, occluded: false, context: {}, fingerprint: `f${id}`, ...over,
  };
}

function ctx(elements: RawElement[], pageOrigin = ORIGIN): { c: PolicyContext; vault: Vault } {
  const vault = new Vault();
  vault.assign('EMAIL', 'mehul.test@example.com', { source: 'task', origin: ORIGIN });
  vault.assign('ADDRESS', '12 MG Road, Pune 411005', { source: 'task', origin: ORIGIN });
  vault.assign('CARD', '4111111111111111', { source: 'task', origin: ORIGIN });
  vault.assign('PERSON', 'Rahul Sharma', { source: 'page', origin: 'http://other.test', fingerprint: 'fx' });
  return { vault, c: { snapshot: new Map(elements.map((e) => [e.id, e])), vault, secrets: vault.secretForms(), taskOrigin: ORIGIN, pageOrigin } };
}

const emailField = el('e1', { input_type: 'email', state: { editable: true, value_category: 'email' } });
const addrField = el('e2', { tag: 'textarea', input_type: undefined, state: { editable: true, value_category: 'address' } });
const pwField = el('e3', { input_type: 'password', state: { editable: true, value_category: 'password' } });
const nameField = el('e4', { state: { editable: true, value_category: 'person_name' } });
const saveBtn = el('e5', { role: 'button', tag: 'button', input_type: undefined, name: 'Save changes', text: 'Save changes', state: { submitter: true } });
const heading = el('e6', { kind: 'heading', role: 'heading', tag: 'h2', name: 'Profile', state: {} });
const select = el('e7', { role: 'combobox', tag: 'select', input_type: undefined, state: { editable: false } });
const all = [emailField, addrField, pwField, nameField, saveBtn, heading, select];

describe('V1 action schema', () => {
  it('accepts valid actions and rejects unknown/invalid ones', () => {
    expect(ActionSchema.safeParse({ type: 'type', target: 'e1', text: '[EMAIL_1]' }).success).toBe(true);
    expect(ActionSchema.safeParse({ type: 'scroll', direction: 'down', amount_px: 500 }).success).toBe(true);
    expect(ActionSchema.safeParse({ type: 'scroll', target: 'e4' }).success).toBe(true);
    expect(ActionSchema.safeParse({ type: 'navigate', url: 'x' }).success).toBe(false);
    expect(ActionSchema.safeParse({ type: 'eval', code: 'x' }).success).toBe(false);
    expect(ActionSchema.safeParse({ type: 'wait', ms: 5000 }).success).toBe(false);
    expect(ActionSchema.safeParse({ type: 'scroll', direction: 'down', amount_px: 9000 }).success).toBe(false);
    expect(ActionSchema.safeParse({ type: 'click', target: 'e1', extra: 1 }).success).toBe(false);
    expect(ActionSchema.safeParse({ type: 'type', target: 'e1', text: 'x'.repeat(201) }).success).toBe(false);
    expect(PlanResponseSchema.safeParse({ status: 'continue', actions: [{ type: 'done', summary: 'ok' }], message: 'm' }).success).toBe(true);
  });
});

describe('validator', () => {
  it('allows a compatible placeholder into a matching field', () => {
    const { c } = ctx(all);
    expect(validateAction({ type: 'type', target: 'e1', text: '[EMAIL_1]' }, c)).toEqual({
      kind: 'allow',
      confirm: [],
      checked: ['V1_ACTION', 'V2_TARGET', 'V4_SUITABILITY', 'T1_CREDENTIAL', 'T2_CATEGORY', 'T3_ORIGIN'],
      placeholder: '[EMAIL_1]',
    });
    expect(validateAction({ type: 'type', target: 'e2', text: '[ADDRESS_1]' }, c).kind).toBe('allow');
  });
  it('V2: rejects targets not in the latest snapshot', () => {
    const { c } = ctx(all);
    expect(validateAction({ type: 'click', target: 'e42' }, c)).toMatchObject({ kind: 'reject', rule: 'V2_TARGET' });
  });
  it('V4: type only into editable controls, select only into selects', () => {
    const { c } = ctx(all);
    expect(validateAction({ type: 'type', target: 'e6', text: 'hi' }, c)).toMatchObject({ rule: 'V4_SUITABILITY' });
    expect(validateAction({ type: 'type', target: 'e5', text: 'hi' }, c)).toMatchObject({ rule: 'V4_SUITABILITY' });
    expect(validateAction({ type: 'select', target: 'e1', option: 'x' }, c)).toMatchObject({ rule: 'V4_SUITABILITY' });
    expect(validateAction({ type: 'select', target: 'e7', option: 'x' }, c).kind).toBe('allow');
    expect(validateAction({ type: 'click', target: 'e6' }, c)).toMatchObject({ rule: 'V4_SUITABILITY' });
  });
  it('T1: credential fields and card values are handed to the user', () => {
    const { c } = ctx(all);
    expect(validateAction({ type: 'type', target: 'e3', text: 'hunter2' }, c)).toMatchObject({ kind: 'handoff', rule: 'T1_CREDENTIAL' });
    expect(validateAction({ type: 'type', target: 'e1', text: '[CARD_1]' }, c)).toMatchObject({ kind: 'handoff', rule: 'T1_CREDENTIAL' });
  });
  it('T2: category mismatch requires confirmation', () => {
    const { c } = ctx(all);
    const v = validateAction({ type: 'type', target: 'e4', text: '[EMAIL_1]' }, c);
    expect(v.kind).toBe('allow');
    if (v.kind === 'allow') expect(v.confirm.map((x) => x.rule)).toEqual(['T2_CATEGORY']);
    const free = validateAction({ type: 'type', target: 'e8', text: '[EMAIL_1]' }, ctx([...all, el('e8')]).c);
    if (free.kind === 'allow') expect(free.confirm.map((x) => x.rule)).toEqual(['T2_CATEGORY']);
  });
  it('T3: values used on another origin require confirmation', () => {
    const { c } = ctx(all);
    const v = validateAction({ type: 'type', target: 'e4', text: '[PERSON_1]' }, c); // page-sourced on other.test
    if (v.kind === 'allow') expect(v.confirm.map((x) => x.rule)).toEqual(['T3_ORIGIN']);
    const other = ctx(all, 'http://elsewhere.test').c;
    const v2 = validateAction({ type: 'type', target: 'e1', text: '[EMAIL_1]' }, other);
    if (v2.kind === 'allow') expect(v2.confirm.map((x) => x.rule)).toEqual(['T3_ORIGIN']);
  });
  it('T4: literal text cannot smuggle vault values or PII', () => {
    const { c } = ctx(all);
    expect(validateAction({ type: 'type', target: 'e8', text: 'mehul.test@example.com' }, ctx([...all, el('e8')]).c)).toMatchObject({ rule: 'T4_SMUGGLING' });
    expect(validateAction({ type: 'type', target: 'e1', text: 'MEHUL.TEST@example.com please' }, c)).toMatchObject({ rule: 'T4_SMUGGLING' });
    expect(validateAction({ type: 'type', target: 'e1', text: 'x [EMAIL_1]' }, c)).toMatchObject({ rule: 'V1_ACTION' });
    expect(validateAction({ type: 'type', target: 'e1', text: '[EMAIL_9]' }, c)).toMatchObject({ rule: 'V1_ACTION' });
    expect(validateAction({ type: 'type', target: 'e1', text: 'Not applicable' }, c).kind).toBe('allow');
  });
  it('risk class: submit-like clicks always require confirmation', () => {
    const { c } = ctx(all);
    const v = validateAction({ type: 'click', target: 'e5' }, c);
    expect(v).toMatchObject({ kind: 'allow', confirm: [{ rule: 'R1_SUBMIT_LIKE' }] });
  });
  it('reports exactly the rules it evaluated (telemetry evidence)', () => {
    const { c } = ctx(all);
    const checked = (a: Parameters<typeof validateAction>[0]) => {
      const v = validateAction(a, c);
      return v.kind === 'allow' ? v.checked : v.kind;
    };
    expect(checked({ type: 'done', summary: 'ok' })).toEqual(['V1_ACTION']);
    expect(checked({ type: 'scroll', direction: 'down', amount_px: 300 })).toEqual(['V1_ACTION']);
    expect(checked({ type: 'scroll', target: 'e6' })).toEqual(['V1_ACTION', 'V2_TARGET']);
    expect(checked({ type: 'click', target: 'e5' })).toEqual(['V1_ACTION', 'V2_TARGET', 'V4_SUITABILITY', 'R1_SUBMIT_LIKE']);
    expect(checked({ type: 'select', target: 'e7', option: 'x' })).toEqual(['V1_ACTION', 'V2_TARGET', 'V4_SUITABILITY']);
    expect(checked({ type: 'type', target: 'e2', text: 'hello there' })).toEqual(['V1_ACTION', 'V2_TARGET', 'V4_SUITABILITY', 'T1_CREDENTIAL', 'T4_SMUGGLING']);
    // Rejections and hand-offs carry their rule instead of a checked list.
    expect(checked({ type: 'type', target: 'e3', text: '[EMAIL_1]' })).toBe('handoff');
    expect(checked({ type: 'type', target: 'e9', text: '[EMAIL_1]' })).toBe('reject');
  });

  it('V2/V3 live checks', () => {
    expect(validateLive(emailField, { exists: true, visible: true, occluded: false, fingerprint: 'fe1' })).toBeNull();
    expect(validateLive(emailField, { exists: true, visible: true, occluded: false, fingerprint: 'zzz' })).toMatchObject({ rule: 'V3_FINGERPRINT' });
    expect(validateLive(emailField, { exists: false, visible: false, occluded: false, fingerprint: '' })).toMatchObject({ rule: 'V2_TARGET' });
    expect(validateLive(emailField, { exists: true, visible: true, occluded: true, fingerprint: 'fe1' })).toMatchObject({ rule: 'V2_TARGET' });
  });
});

describe('submit-like detection', () => {
  const base = { tag: 'button', role: 'button', state: {}, name: '', text: '' };
  it('detects submit types, form submitters and submit-ish labels', () => {
    expect(isSubmitLike({ ...base, tag: 'input', input_type: 'submit' })).toBe(true);
    expect(isSubmitLike({ ...base, state: { submitter: true }, name: 'Go' })).toBe(true);
    for (const w of ['Save', 'Confirm booking', 'Apply', 'Register', 'Pay now', 'Send', 'Delete account', 'Place order'])
      expect(isSubmitLike({ ...base, name: w })).toBe(true);
  });
  it('does not flag ordinary buttons or non-clickables', () => {
    expect(isSubmitLike({ ...base, name: 'Show help' })).toBe(false);
    expect(isSubmitLike({ ...base, tag: 'p', role: 'text', text: 'Remember to save your work' })).toBe(false);
  });
});

describe('field category classification', () => {
  it('uses type, autocomplete and label tokens', () => {
    expect(classifyField({ tag: 'input', input_type: 'email', hints: [] })).toBe('email');
    expect(classifyField({ tag: 'input', input_type: 'text', autocomplete: 'shipping street-address', hints: [] })).toBe('address');
    expect(classifyField({ tag: 'input', input_type: 'text', hints: ['PAN', 'pan_number'] })).toBe('pan');
    expect(classifyField({ tag: 'input', input_type: 'text', hints: ['Full name'] })).toBe('person_name');
    expect(classifyField({ tag: 'input', input_type: 'text', hints: ['Username'] })).toBe('free_text');
    expect(classifyField({ tag: 'input', input_type: 'text', hints: ['Company name'] })).toBe('free_text');
    expect(classifyField({ tag: 'input', input_type: 'text', hints: ['Enter OTP'] })).toBe('otp');
    expect(classifyField({ tag: 'input', input_type: 'text', hints: ['cardNumber'] })).toBe('card_number');
    expect(classifyField({ tag: 'input', input_type: 'text', hints: ['altEmail', 'Alternate email'] })).toBe('email');
    expect(classifyField({ tag: 'input', input_type: 'text', hints: ['Company'] })).toBe('free_text');
    expect(classifyField({ tag: 'input', input_type: 'password', hints: ['Email'] })).toBe('password');
  });
});
