// DOM → IR. Produces visible, relevant elements (interactive controls, headings, text blocks) and
// opaque visual regions (metadata only, no pixels). Generic: no site-specific logic.
// Field values are never read into the IR — only `has_value` and a value category.

import { CONFIG } from '../shared/config';
import { classifyField } from '../shared/fieldCategory';
import type { ElementState, RawElement, RawRegion, RawSnapshot, RegionKind } from '../shared/ir';
import {
  accessibleName, collapse, fingerprint, headingLevel, idFor, implicitRole, inViewport, isEditingHost, isHidden,
  isInteractive, isOccluded, labelText, rectOf,
} from './dom';

const SKIP_TAGS = new Set(['script', 'style', 'template', 'noscript', 'head', 'meta', 'link', 'iframe', 'object', 'embed']);
const REGION_TAGS: Record<string, RegionKind> = { img: 'img', canvas: 'canvas', video: 'video', svg: 'svg' };
const INLINE_DISPLAYS = new Set(['inline', 'contents']);

function hasValue(el: Element): boolean {
  if (el instanceof HTMLInputElement) return ['checkbox', 'radio'].includes(el.type) ? el.checked : el.value !== '';
  if (el instanceof HTMLTextAreaElement) return el.value !== '';
  if (el instanceof HTMLSelectElement) return el.selectedIndex > 0 || (el.selectedIndex === 0 && el.value !== '' && !!el.options[0]?.value);
  if (isEditingHost(el)) return ((el as HTMLElement).innerText ?? '').trim() !== '';
  return false;
}

function isSubmitter(el: Element): boolean {
  if (el instanceof HTMLButtonElement) return el.type === 'submit' && !!el.form;
  if (el instanceof HTMLInputElement) return (el.type === 'submit' || el.type === 'image') && !!el.form;
  return false;
}

function formName(el: Element): string | undefined {
  const form = (el as HTMLInputElement).form ?? el.closest('form');
  if (!form) return undefined;
  const heading = form.querySelector('h1,h2,h3,h4,h5,h6,legend');
  return collapse(form.getAttribute('aria-label') || (heading ? labelText(heading) : '') || form.getAttribute('name') || form.id || 'form', 120);
}

function stateOf(el: Element, role: string, name: string): ElementState {
  const s: ElementState = {};
  const h = el as HTMLInputElement;
  const tag = el.tagName.toLowerCase();
  if (h.disabled || el.getAttribute('aria-disabled') === 'true') s.disabled = true;
  if (h.required || el.getAttribute('aria-required') === 'true') s.required = true;
  if (h.readOnly || el.getAttribute('aria-readonly') === 'true') s.readonly = true;
  if (tag === 'input' && ['checkbox', 'radio'].includes(h.type)) s.checked = h.checked;
  else if (el.hasAttribute('aria-checked')) s.checked = el.getAttribute('aria-checked') === 'true';
  if (el.hasAttribute('aria-selected')) s.selected = el.getAttribute('aria-selected') === 'true';
  if (el.hasAttribute('aria-expanded')) s.expanded = el.getAttribute('aria-expanded') === 'true';
  if (isSubmitter(el)) s.submitter = true;

  const textInput = tag === 'input' && !['checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'file', 'range', 'color'].includes(h.type);
  const editable = textInput || tag === 'textarea' || isEditingHost(el) || role === 'textbox' || role === 'searchbox';
  if (editable) s.editable = true;
  if (editable || tag === 'select') {
    s.has_value = hasValue(el);
    s.value_category = classifyField({
      tag,
      input_type: tag === 'input' ? h.type : undefined,
      autocomplete: el.getAttribute('autocomplete') ?? undefined,
      hints: [name, el.getAttribute('name') ?? '', el.id, el.getAttribute('placeholder') ?? '', el.getAttribute('aria-label') ?? ''],
    });
  }
  return s;
}

/** Nearest non-inline ancestor of a text node: the "block" its text belongs to. */
function blockOf(node: Node, cache: Map<Element, boolean>): Element | null {
  for (let el = node.parentElement; el; el = el.parentElement) {
    let inline = cache.get(el);
    if (inline === undefined) {
      inline = INLINE_DISPLAYS.has(getComputedStyle(el).display);
      cache.set(el, inline);
    }
    if (!inline) return el;
  }
  return null;
}

function insideAny(set: Set<Element>, el: Element | null): boolean {
  for (let n = el; n; n = n.parentElement) if (set.has(n)) return true;
  return false;
}

interface Candidate {
  el: Element;
  order: number;
  entry: RawElement;
}

export function takeSnapshot(): RawSnapshot {
  const t0 = performance.now();
  const order = new Map<Element, number>();
  const all = document.body ? [document.body, ...document.body.querySelectorAll('*')] : [];
  all.forEach((el, i) => order.set(el, i));

  const candidates: Candidate[] = [];
  const regions: RawRegion[] = [];
  const consumed = new Set<Element>(); // interactive/heading subtrees: their text is already captured
  const hiddenCache = new Map<Element, boolean>();
  const hidden = (el: Element) => {
    let h = hiddenCache.get(el);
    if (h === undefined) hiddenCache.set(el, (h = isHidden(el)));
    return h;
  };

  // Headings in document order give the "nearest section heading" context.
  const headings: { order: number; text: string }[] = [];

  for (const el of all) {
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag) || el.closest('select')?.contains(el) && tag !== 'select') continue;
    if (el.closest('svg') && tag !== 'svg') continue;
    if (!REGION_TAGS[tag] && !isInteractive(el) && insideAny(consumed, el.parentElement)) continue;

    const region = REGION_TAGS[tag];
    if (region) {
      if (hidden(el)) continue;
      const r = rectOf(el);
      if (r.w < 24 || r.h < 24) continue; // icons
      regions.push({
        id: idFor(el),
        kind: region,
        bbox: r,
        label: collapse(el.getAttribute('alt') || el.getAttribute('aria-label') || el.getAttribute('title') || el.querySelector?.('title')?.textContent || '', 160),
        in_viewport: inViewport(el),
        status: 'unperceived',
      });
      continue;
    }

    const level = headingLevel(el);
    const interactive = isInteractive(el);
    if (!interactive && level === undefined) continue;
    if (hidden(el)) continue;

    const role = implicitRole(el);
    const name = interactive ? accessibleName(el) : labelText(el);
    const editable = interactive && (tag === 'textarea' || tag === 'select' || isEditingHost(el) || (tag === 'input' && !['button', 'submit', 'reset', 'image', 'checkbox', 'radio'].includes((el as HTMLInputElement).type)));
    // Visible text: captions for buttons/links; never the content of value-bearing controls.
    const text = interactive ? (editable ? '' : labelText(el)) : name;
    const entry: RawElement = {
      id: idFor(el),
      kind: interactive ? 'interactive' : 'heading',
      role,
      tag,
      name,
      text: text === name ? '' : text,
      state: interactive ? stateOf(el, role, name) : {},
      bbox: rectOf(el),
      visible: true,
      in_viewport: inViewport(el),
      occluded: isOccluded(el),
      context: {},
      fingerprint: fingerprint(el, role, name),
    };
    if (tag === 'input') entry.input_type = (el as HTMLInputElement).type;
    const ac = el.getAttribute('autocomplete');
    if (ac) entry.autocomplete = ac;
    if (level !== undefined) {
      entry.level = level;
      headings.push({ order: order.get(el)!, text: name });
    }
    if (el instanceof HTMLSelectElement) {
      entry.options = [...el.options].slice(0, CONFIG.MAX_SELECT_OPTIONS).map((o) => collapse(o.label || o.text, 120));
    }
    if (el instanceof HTMLAnchorElement && el.href) {
      try {
        const u = new URL(el.href, location.href);
        entry.link_path = u.origin === location.origin ? u.pathname : `${u.origin}${u.pathname}`; // query & fragment dropped
      } catch {
        /* ignore */
      }
    }
    const f = formName(el);
    if (f) entry.context.form = f;
    candidates.push({ el, order: order.get(el)!, entry });
    consumed.add(el);
  }

  // Text blocks: group visible text nodes by their nearest block container, so inline markup
  // ("Signed in as <b>Name</b>") stays one string and context cues keep working.
  const displayCache = new Map<Element, boolean>();
  const blocks = new Map<Element, string>();
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement;
    if (!parent || !(n.textContent ?? '').trim()) continue;
    if (parent.closest('script,style,template,noscript,select,textarea,svg,[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]')) continue;
    if (insideAny(consumed, parent)) continue;
    const label = parent.closest('label') as HTMLLabelElement | null;
    if (label?.control && consumed.has(label.control)) continue; // already the control's name
    if (hidden(parent)) continue;
    const block = blockOf(n, displayCache);
    if (!block) continue;
    blocks.set(block, (blocks.get(block) ?? '') + (n.textContent ?? ''));
  }
  for (const [block, raw] of blocks) {
    const text = collapse(raw);
    if (!text) continue;
    candidates.push({
      el: block,
      order: order.get(block) ?? 0,
      entry: {
        id: idFor(block),
        kind: 'text',
        role: 'text',
        tag: block.tagName.toLowerCase(),
        name: '',
        text,
        state: {},
        bbox: rectOf(block),
        visible: true,
        in_viewport: inViewport(block),
        occluded: false,
        context: {},
        fingerprint: fingerprint(block, 'text', ''),
      },
    });
  }

  candidates.sort((a, b) => a.order - b.order);
  headings.sort((a, b) => a.order - b.order);
  for (const c of candidates) {
    let section: string | undefined;
    for (const h of headings) {
      if (h.order <= c.order) section = h.text;
      else break;
    }
    if (section && c.entry.kind !== 'heading') c.entry.context.section = section;
  }

  // Budget: prune off-viewport text first, then in-viewport text, then off-viewport interactive.
  const total = candidates.length;
  let kept = candidates.map((c) => c.entry);
  const prune = (pred: (e: RawElement) => boolean) => {
    const excess = kept.length - CONFIG.IR_MAX_ELEMENTS;
    if (excess <= 0) return;
    const victims = new Set(kept.filter(pred).slice(-excess));
    kept = kept.filter((e) => !victims.has(e));
  };
  prune((e) => e.kind !== 'interactive' && !e.in_viewport);
  prune((e) => e.kind === 'text');
  prune((e) => e.kind === 'interactive' && !e.in_viewport);

  return {
    page: {
      origin: location.origin,
      path: location.pathname,
      title: document.title,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      scroll: { x: Math.round(scrollX), y: Math.round(scrollY), max_y: Math.max(0, document.documentElement.scrollHeight - window.innerHeight) },
    },
    elements: kept,
    regions: regions.slice(0, 60),
    stats: { candidates: total, pruned: total - kept.length, duration_ms: Math.round(performance.now() - t0) },
  };
}

/** Re-read a single element for live validation. */
export function describeElement(el: Element): RawElement {
  const role = implicitRole(el);
  const interactive = isInteractive(el);
  const name = interactive ? accessibleName(el) : labelText(el);
  return {
    id: idFor(el),
    kind: interactive ? 'interactive' : headingLevel(el) !== undefined ? 'heading' : 'text',
    role,
    tag: el.tagName.toLowerCase(),
    name,
    text: '',
    state: interactive ? stateOf(el, role, name) : {},
    bbox: rectOf(el),
    visible: !isHidden(el),
    in_viewport: inViewport(el),
    occluded: isOccluded(el),
    context: {},
    fingerprint: interactive || headingLevel(el) !== undefined ? fingerprint(el, role, name) : fingerprint(el, 'text', ''),
  };
}
