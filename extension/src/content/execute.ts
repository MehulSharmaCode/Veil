// Execution primitives, settle detection and local verification. Generic; no site knowledge.
// The value for a `type` command lives only in this call's scope and is never retained.

import { CONFIG } from '../shared/config';
import type { ExecCommand, ExecResponse } from '../shared/messages';
import { elementById, isEditingHost } from './dom';
import { describeElement } from './snapshot';

/**
 * Arm a MutationObserver around one action. Settled after SETTLE_QUIET_MS without mutations,
 * capped at SETTLE_MAX_MS. Disarmed afterwards (this is not a monitoring loop).
 */
async function withSettle(action: () => void): Promise<{ mutations: number; settle_ms: number; settled: boolean }> {
  let mutations = 0;
  let last = performance.now();
  const obs = new MutationObserver((recs) => {
    mutations += recs.length;
    last = performance.now();
  });
  obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  const start = performance.now();
  try {
    action();
    last = performance.now();
    await new Promise<void>((resolve) => {
      const tick = () => {
        const now = performance.now();
        if (now - last >= CONFIG.SETTLE_QUIET_MS || now - start >= CONFIG.SETTLE_MAX_MS) resolve();
        else setTimeout(tick, 50);
      };
      setTimeout(tick, 50);
    });
  } finally {
    obs.disconnect();
  }
  const settle_ms = Math.round(performance.now() - start);
  return { mutations, settle_ms, settled: settle_ms < CONFIG.SETTLE_MAX_MS };
}

/** Observable state around a click that may not produce DOM mutations. */
function stateSignature(el: Element): string {
  const h = el as HTMLInputElement;
  return [
    location.href,
    document.activeElement === el,
    'checked' in h ? h.checked : '',
    el.getAttribute('aria-expanded'),
    el.getAttribute('aria-pressed'),
    el.getAttribute('aria-checked'),
    el.getAttribute('aria-selected'),
    (el as HTMLDetailsElement).open ?? '',
    Math.round(scrollY),
  ].join('|');
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (!setter) throw new Error('no native setter');
  setter.call(el, value);
}

function fireInputEvents(el: Element, data: string): void {
  el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function currentValue(el: Element): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return el.value;
  if (isEditingHost(el)) return (el as HTMLElement).innerText.replace(/\n$/, '');
  return '';
}

function focusAndReveal(el: Element): void {
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  (el as HTMLElement).focus?.({ preventScroll: true });
}

function click(el: Element): void {
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  const r = el.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
  el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerType: 'mouse', isPrimary: true }));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  (el as HTMLElement).focus?.({ preventScroll: true });
  el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerType: 'mouse', isPrimary: true }));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  (el as HTMLElement).click();
}

function findOption(sel: HTMLSelectElement, wanted: string): HTMLOptionElement | undefined {
  const w = wanted.trim().toLowerCase();
  const opts = [...sel.options];
  return opts.find((o) => o.label.trim().toLowerCase() === w || o.text.trim().toLowerCase() === w) ?? opts.find((o) => o.value.toLowerCase() === w);
}

const fail = (error: ExecResponse['error']): ExecResponse => ({ ok: false, error, mutations: 0, settle_ms: 0, settled: true, changed: false });

export async function execute(cmd: ExecCommand, expectedFingerprint?: string): Promise<ExecResponse> {
  if (cmd.kind === 'scroll_by') {
    const before = scrollY;
    const s = await withSettle(() => window.scrollBy({ top: cmd.dy, behavior: 'instant' as ScrollBehavior }));
    const moved = Math.round(scrollY) !== Math.round(before);
    return { ok: true, ...s, changed: moved, scroll_changed: moved };
  }

  const el = elementById(cmd.id);
  if (!el) return fail('not_found');
  if (expectedFingerprint && describeElement(el).fingerprint !== expectedFingerprint) return fail('stale');

  try {
    if (cmd.kind === 'scroll_to') {
      const before = scrollY;
      const s = await withSettle(() => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
      return { ok: true, ...s, changed: true, scroll_changed: Math.round(scrollY) !== Math.round(before) };
    }

    if (cmd.kind === 'click') {
      const before = stateSignature(el);
      const s = await withSettle(() => click(el));
      const changed = s.mutations > 0 || !el.isConnected || stateSignature(el) !== before;
      return { ok: true, ...s, changed };
    }

    if (cmd.kind === 'select') {
      if (!(el instanceof HTMLSelectElement)) return fail('not_editable');
      const opt = findOption(el, cmd.option);
      if (!opt) return fail('no_such_option');
      const s = await withSettle(() => {
        focusAndReveal(el);
        setNativeValue(el, opt.value);
        fireInputEvents(el, opt.value);
      });
      return { ok: true, ...s, changed: true, value_matches: el.value === opt.value };
    }

    // type
    const text = cmd.text;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el.disabled || el.readOnly) return fail('not_editable');
      const s = await withSettle(() => {
        focusAndReveal(el);
        setNativeValue(el, text);
        fireInputEvents(el, text);
      });
      // Verified after settle, so controlled inputs that revert their value are caught.
      return { ok: true, ...s, changed: true, value_matches: currentValue(el) === text };
    }
    if (isEditingHost(el)) {
      const s = await withSettle(() => {
        focusAndReveal(el);
        const sel = getSelection();
        sel?.selectAllChildren(el);
        // execCommand keeps the host's undo stack and editor frameworks in sync; fall back to textContent.
        if (!document.execCommand('insertText', false, text)) {
          el.textContent = text;
          fireInputEvents(el, text);
        }
      });
      return { ok: true, ...s, changed: true, value_matches: currentValue(el).trim() === text.trim() };
    }
    return fail('not_editable');
  } catch {
    return fail('exception');
  }
}
