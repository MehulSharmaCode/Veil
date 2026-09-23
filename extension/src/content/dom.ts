// Generic DOM helpers for the content script: stable ids, visibility, roles, accessible names,
// fingerprints. Nothing here knows about any particular website.

import { CONFIG } from '../shared/config';

// ---- stable ids (no attributes are written into the page) -------------------------------------

const ids = new WeakMap<Element, string>();
const byId = new Map<string, WeakRef<Element>>();
let counter = 0;

export function idFor(el: Element): string {
  let id = ids.get(el);
  if (!id) {
    id = `e${++counter}`;
    ids.set(el, id);
    byId.set(id, new WeakRef(el));
  }
  return id;
}

export function elementById(id: string): Element | null {
  const el = byId.get(id)?.deref() ?? null;
  return el && el.isConnected ? el : null;
}

// ---- visibility ---------------------------------------------------------------------------------

export function isHidden(el: Element): boolean {
  if (el.closest('[aria-hidden="true"], [inert]')) return true;
  const anyEl = el as Element & { checkVisibility?: (o: object) => boolean };
  if (anyEl.checkVisibility && !anyEl.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return true;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) {
    // zero-size wrappers of visible content (e.g. display:contents) are handled by their children
    return true;
  }
  return false;
}

export function rectOf(el: Element) {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
}

export function inViewport(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
}

/** Occluded if another, unrelated element is on top at the element's (clamped) centre. */
export function isOccluded(el: Element): boolean {
  if (!inViewport(el)) return false;
  const r = el.getBoundingClientRect();
  const x = Math.min(Math.max(r.left + r.width / 2, 0), window.innerWidth - 1);
  const y = Math.min(Math.max(r.top + r.height / 2, 0), window.innerHeight - 1);
  const hit = document.elementFromPoint(x, y);
  if (!hit || hit === el || el.contains(hit)) return false;
  const label = hit.closest('label');
  if (label && (label as HTMLLabelElement).control === el) return false;
  // Hitting an ancestor means the element lets pointer events through; nothing covers it.
  return !hit.contains(el);
}

// ---- roles --------------------------------------------------------------------------------------

export const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option',
  'combobox', 'listbox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem',
]);

export function implicitRole(el: Element): string {
  const explicit = el.getAttribute('role')?.trim().split(/\s+/)[0]?.toLowerCase();
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'a':
      return el.hasAttribute('href') ? 'link' : 'generic';
    case 'button':
    case 'summary':
      return 'button';
    case 'select':
      return (el as HTMLSelectElement).multiple || (el as HTMLSelectElement).size > 1 ? 'listbox' : 'combobox';
    case 'textarea':
      return 'textbox';
    case 'input': {
      const t = (el as HTMLInputElement).type;
      if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'range') return 'slider';
      if (t === 'number') return 'spinbutton';
      if (t === 'search') return 'searchbox';
      return 'textbox';
    }
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
      return 'heading';
    case 'img':
      return 'img';
    default:
      return (el as HTMLElement).isContentEditable ? 'textbox' : 'generic';
  }
}

export function isEditingHost(el: Element): boolean {
  const h = el as HTMLElement;
  return h.isContentEditable && !(h.parentElement?.isContentEditable ?? false);
}

export function isInteractive(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === 'input') return (el as HTMLInputElement).type !== 'hidden';
  if (tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'summary') return true;
  if (tag === 'a') return el.hasAttribute('href');
  if (isEditingHost(el)) return true;
  const role = el.getAttribute('role')?.toLowerCase();
  return !!role && INTERACTIVE_ROLES.has(role);
}

export function headingLevel(el: Element): number | undefined {
  const m = /^h([1-6])$/i.exec(el.tagName);
  if (m) return Number(m[1]);
  if (el.getAttribute('role') === 'heading') return Number(el.getAttribute('aria-level')) || 2;
  return undefined;
}

// ---- text & accessible name (practical heuristic chain, not the full accname spec) --------------

export function collapse(s: string | null | undefined, cap: number = CONFIG.TEXT_CAP): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > cap ? `${t.slice(0, cap - 1)}…` : t;
}

/** Visible text of an element, skipping form-control contents (which are values, not labels). */
export function labelText(root: Element): string {
  let out = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(n) {
      if (n.nodeType === Node.ELEMENT_NODE) {
        const tag = (n as Element).tagName.toLowerCase();
        if (['select', 'textarea', 'input', 'script', 'style', 'template', 'noscript'].includes(tag)) return NodeFilter.FILTER_REJECT;
        if ((n as HTMLElement).isContentEditable) return NodeFilter.FILTER_REJECT;
        if ((n as Element).getAttribute('aria-hidden') === 'true') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out += n.textContent ?? '';
  return collapse(out);
}

function isValueBearing(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') return !['button', 'submit', 'reset', 'image'].includes((el as HTMLInputElement).type);
  return isEditingHost(el);
}

/** aria-labelledby → aria-label → <label for> / wrapping <label> → placeholder → title → own text. */
export function accessibleName(el: Element): string {
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const t = labelledby
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter((x): x is HTMLElement => !!x)
      .map((x) => labelText(x))
      .join(' ');
    if (t.trim()) return collapse(t);
  }
  const aria = el.getAttribute('aria-label');
  if (aria?.trim()) return collapse(aria);
  const labels = (el as HTMLInputElement).labels;
  if (labels && labels.length) {
    const t = [...labels].map((l) => labelText(l)).join(' ');
    if (t.trim()) return collapse(t);
  }
  const ph = el.getAttribute('placeholder');
  if (ph?.trim()) return collapse(ph);
  const title = el.getAttribute('title');
  if (title?.trim()) return collapse(title);
  if (isValueBearing(el)) return ''; // never fall back to a field's own content (that's its value)
  const tag = el.tagName.toLowerCase();
  if (tag === 'input') return collapse((el as HTMLInputElement).value || (el as HTMLInputElement).alt); // button caption
  const own = labelText(el);
  if (own) return own;
  const img = el.querySelector('img[alt]');
  return collapse(img?.getAttribute('alt'));
}

// ---- fingerprint ----------------------------------------------------------------------------------

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function domIndexPath(el: Element): string {
  const parts: number[] = [];
  for (let n: Element | null = el; n && n !== document.body && n.parentElement; n = n.parentElement) {
    parts.push(Array.prototype.indexOf.call(n.parentElement.children, n));
  }
  return parts.reverse().join('/');
}

/** Hash of stable properties. Not position, so scrolling doesn't invalidate it. */
export function fingerprint(el: Element, role: string, label: string): string {
  return `f${fnv1a(
    [el.tagName, role, el.getAttribute('type') ?? '', el.getAttribute('name') ?? '', el.id, label, domIndexPath(el)].join('␟'),
  )}`;
}
