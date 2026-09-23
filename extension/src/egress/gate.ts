// Egress gate: a pure checker run on every outbound message (planner payloads and telemetry).
// It never modifies the message. Any exception is a failure (fail closed).

import { CONFIG } from '../shared/config';
import { digitsOnly } from '../privacy/normalize';
import { scanStrict } from '../privacy/sanitizer';
import { PlannerPayloadSchema, TelemetryEventSchema } from './schema';

export type EgressKind = 'plan' | 'telemetry';

export const GATE_RULES = {
  G0_GATE_ERROR: 'exception inside the gate',
  G1_SCHEMA: 'schema invalid or unexpected field',
  G2_FORBIDDEN_KEY: 'disallowed field name',
  G3_HTML: 'raw HTML markup in a string',
  G4_URL_QUERY: 'URL query string or fragment',
  G5_RESIDUAL_PII: 'residual PII found by strict scan',
  G6_TRIPWIRE: 'known vault value present',
  G7_SIZE: 'message too large',
} as const;
export type GateRule = keyof typeof GATE_RULES;

export interface GateFailure {
  rule: GateRule;
  /** Path segments to the offending field; [] = whole message. Never includes the offending value. */
  path: (string | number)[];
}

export interface GateResult {
  ok: boolean;
  failures: GateFailure[];
  bytes: number;
}

export interface Secrets {
  text: string[];
  digits: string[];
}

const FORBIDDEN_KEYS = new Set([
  'value', 'values', 'raw', 'raw_value', 'password', 'passwd', 'pwd', 'secret', 'token', 'html', 'outerhtml', 'innerhtml',
  'dom', 'cookie', 'cookies', 'query', 'querystring', 'search_params', 'href', 'url', 'screenshot', 'pixels', 'image_data',
  'vault', 'normalized', 'otp', 'cvv', 'cvc',
]);

/** Keys whose (schema-validated) values are VEIL-generated identifiers, exempt from the residual scan only. */
const STRUCTURAL_KEYS = new Set(['schema_version', 'session_id', 'event_id', 'id', 'target', 'type', 'stage', 'kind', 'role', 'tag', 'category', 'rule', 'result', 'status', 'value_category', 'input_type', 'autocomplete']);

const HTML_RE = /<\/?[a-zA-Z][\w:-]*(?:\s[^<>]*)?\/?>|<!--|<!doctype/i;
const URL_WITH_QUERY_RE = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s"]*[?#]/i;
const PATH_KEYS = new Set(['path', 'link_path']);
const MAX_DEPTH = 12;

export function pathToString(path: (string | number)[]): string {
  return path.length ? path.join('.') : '$';
}

function walk(
  node: unknown,
  path: (string | number)[],
  visit: (key: string | number | undefined, value: unknown, path: (string | number)[]) => void,
): void {
  if (path.length > MAX_DEPTH) throw new Error('too deep');
  visit(path[path.length - 1], node, path);
  if (Array.isArray(node)) node.forEach((v, i) => walk(v, [...path, i], visit));
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, [...path, k], visit);
}

export function checkEgress(kind: EgressKind, message: unknown, secrets: Secrets): GateResult {
  let bytes = 0;
  try {
    const failures: GateFailure[] = [];
    const serialized = JSON.stringify(message);
    bytes = new TextEncoder().encode(serialized).length;

    // 1. schema validity (closed schemas: strict objects reject unexpected fields)
    const schema = kind === 'plan' ? PlannerPayloadSchema : TelemetryEventSchema;
    const parsed = schema.safeParse(message);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) failures.push({ rule: 'G1_SCHEMA', path: issue.path.map((p) => (typeof p === 'symbol' ? String(p) : p)) });
    }

    const lowerSecrets = secrets.text.map((s) => s.toLowerCase());
    let stringTripwireHit = false;

    walk(message, [], (key, value, path) => {
      // 2. forbidden field names
      if (typeof key === 'string' && FORBIDDEN_KEYS.has(key.toLowerCase())) failures.push({ rule: 'G2_FORBIDDEN_KEY', path });
      if (typeof value !== 'string') return;
      // 3. raw HTML
      if (HTML_RE.test(value)) failures.push({ rule: 'G3_HTML', path });
      // 4. URL query strings / fragments
      if (URL_WITH_QUERY_RE.test(value) || (typeof key === 'string' && PATH_KEYS.has(key) && /[?#]/.test(value))) {
        failures.push({ rule: 'G4_URL_QUERY', path });
      }
      // 5. residual scan (strict)
      const structural = typeof key === 'string' && STRUCTURAL_KEYS.has(key) && /^[\w\-[\]]{0,40}$/.test(value);
      if (!structural && scanStrict(value).length > 0) {
        failures.push({ rule: 'G5_RESIDUAL_PII', path });
      }
      // 6. known-secret tripwire, per string
      const lower = value.toLowerCase();
      const digits = digitsOnly(value);
      if (lowerSecrets.some((s) => lower.includes(s)) || secrets.digits.some((d) => digits.includes(d))) {
        failures.push({ rule: 'G6_TRIPWIRE', path });
        stringTripwireHit = true;
      }
    });

    // 6b. tripwire over the whole serialized message (catches values spread across keys/numbers)
    if (!stringTripwireHit) {
      const lowerAll = serialized.toLowerCase();
      if (lowerSecrets.some((s) => lowerAll.includes(s)) || secrets.digits.some((d) => serialized.includes(d))) {
        failures.push({ rule: 'G6_TRIPWIRE', path: [] });
      }
    }

    // 7. size
    const max = kind === 'plan' ? CONFIG.PAYLOAD_MAX_BYTES : CONFIG.TELEMETRY_MAX_BYTES;
    if (bytes > max) failures.push({ rule: 'G7_SIZE', path: [] });

    return { ok: failures.length === 0, failures, bytes };
  } catch {
    return { ok: false, failures: [{ rule: 'G0_GATE_ERROR', path: [] }], bytes };
  }
}
