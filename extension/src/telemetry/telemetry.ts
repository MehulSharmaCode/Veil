// Structured telemetry events for the read-only dashboard. Every event goes through the same
// egress client + gate as planner payloads. `data` must contain only sanitized/metadata content.

import { CONFIG } from '../shared/config';
import type { EgressClient } from '../egress/client';
import type { Secrets } from '../egress/gate';
import type { TelemetryEvent } from '../egress/schema';

export type EventType =
  | 'TASK_STARTED' | 'DOM_SNAPSHOT_CREATED' | 'IR_CREATED' | 'PII_DETECTED' | 'SANITIZATION_COMPLETE' | 'VAULT_UPDATED'
  | 'EGRESS_CHECK_PASSED' | 'EGRESS_CHECK_FAILED' | 'EGRESS_BLOCKED' | 'REQUEST_SENT' | 'LLM_ACTION_RECEIVED'
  | 'ACTION_VALIDATED' | 'ACTION_REJECTED' | 'CONFIRMATION_REQUESTED' | 'CONFIRMATION_RESOLVED' | 'ACTION_EXECUTED'
  | 'VERIFICATION_COMPLETE' | 'TASK_COMPLETED' | 'ERROR';

export type Stage = 'task' | 'snapshot' | 'ir' | 'sanitize' | 'vault' | 'egress' | 'plan' | 'validate' | 'confirm' | 'execute' | 'verify' | 'done' | 'error';

function randomId(n: number, alphabet: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

/** Session ids are letters only, so they can never look like a number/identifier. */
export function newSessionId(): string {
  return randomId(16, 'abcdefghijklmnopqrstuvwxyz');
}

export class Telemetry {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly egress: EgressClient,
    private readonly sessionId: string,
    private readonly getStep: () => number,
    /** Vault forms captured at emit time, so events queued before a vault clear keep the tripwire. */
    private readonly getSecrets: () => Secrets,
    private readonly onBlocked: (type: string, rules: string[]) => void,
  ) {}

  emit(type: EventType, stage: Stage, data: Record<string, unknown> = {}, opts: { immediate?: boolean } = {}): void {
    const ev: TelemetryEvent = {
      event_id: randomId(20, 'abcdefghijklmnopqrstuvwxyz0123456789'),
      ts: Date.now(),
      session_id: this.sessionId,
      step: this.getStep(),
      type,
      stage,
      data,
    };
    const secrets = this.getSecrets();
    const send = async () => {
      try {
        const r = await this.egress.send('telemetry', `${CONFIG.TELEMETRY_URL}/telemetry/events`, ev, { keepalive: opts.immediate, secrets });
        if (!r.sent) this.onBlocked(type, r.blocked.failures.map((f) => `${f.rule}@${f.path}`));
      } catch {
        /* relay down: telemetry is best-effort and never affects the agent */
      }
    };
    if (opts.immediate) void send();
    else this.queue = this.queue.then(send);
  }
}
