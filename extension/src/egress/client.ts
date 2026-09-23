// The one egress client. Every outbound request (planner and telemetry) goes through `send`,
// which runs the egress gate first. This is the only module in the extension that calls fetch().

import { checkEgress, pathToString, type EgressKind, type GateFailure, type GateResult, type Secrets } from './gate';
import type { SanitizedText } from '../privacy/sanitized';

export type GatePhase = 'passed' | 'failed' | 'blocked';

export interface GateReport {
  kind: EgressKind;
  phase: GatePhase;
  attempt: 1 | 2;
  bytes: number;
  /** Rule ids and field paths only — never values. */
  failures: { rule: string; path: string }[];
}

export type SendResult<T> =
  | { sent: true; message: T; response: Response; gate: GateResult }
  | { sent: false; blocked: GateReport };

export interface EgressDeps {
  secrets: () => Secrets;
  /** Fail-closed sanitizer mode (mask whole field). */
  failClosed: () => SanitizedText;
  onGate?: (report: GateReport) => void;
}

function report(kind: EgressKind, phase: GatePhase, attempt: 1 | 2, r: GateResult): GateReport {
  return { kind, phase, attempt, bytes: r.bytes, failures: r.failures.map((f) => ({ rule: f.rule, path: pathToString(f.path) })) };
}

/**
 * Replace offending string fields with the fail-closed mask. Returns null when a failure cannot be
 * remediated by masking (schema/key/size/whole-message failures), which leads to a hard block.
 */
export function remediate<T>(message: T, failures: GateFailure[], mask: SanitizedText): T | null {
  const clone = structuredClone(message) as unknown;
  for (const f of failures) {
    if (!['G3_HTML', 'G4_URL_QUERY', 'G5_RESIDUAL_PII', 'G6_TRIPWIRE'].includes(f.rule) || f.path.length === 0) return null;
    let node = clone as Record<string | number, unknown>;
    for (const seg of f.path.slice(0, -1)) node = node[seg] as Record<string | number, unknown>;
    const last = f.path[f.path.length - 1]!;
    if (typeof node?.[last] !== 'string') return null;
    node[last] = mask;
  }
  return clone as T;
}

export class EgressClient {
  constructor(private readonly deps: EgressDeps) {}

  /** Gate → (remediate → re-gate once) → fetch. On a second failure nothing is sent. */
  async send<T>(
    kind: EgressKind,
    url: string,
    message: T,
    init: { signal?: AbortSignal; keepalive?: boolean; secrets?: Secrets } = {},
  ): Promise<SendResult<T>> {
    const secrets = init.secrets ?? this.deps.secrets();
    let r = checkEgress(kind, message, secrets);
    let toSend = message;
    if (!r.ok) {
      this.deps.onGate?.(report(kind, 'failed', 1, r));
      const fixed = remediate(message, r.failures, this.deps.failClosed());
      const r2 = fixed === null ? r : checkEgress(kind, fixed, secrets);
      if (fixed === null || !r2.ok) {
        const blocked = report(kind, 'blocked', 2, r2);
        this.deps.onGate?.(blocked);
        return { sent: false, blocked };
      }
      toSend = fixed;
      r = r2;
      this.deps.onGate?.(report(kind, 'passed', 2, r));
    } else {
      this.deps.onGate?.(report(kind, 'passed', 1, r));
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toSend),
      signal: init.signal,
      keepalive: init.keepalive,
    });
    return { sent: true, message: toSend, response, gate: r };
  }

  /** Plain GET (no body leaves the extension), e.g. /health. */
  async get(url: string, signal?: AbortSignal): Promise<Response> {
    if (/[?#]/.test(url)) throw new Error('egress: GET URLs may not carry query strings');
    return fetch(url, { method: 'GET', signal });
  }
}
