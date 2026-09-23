// Side panel ⇄ content script protocol (extension-internal; never leaves the device).

import type { RawElement, RawSnapshot } from './ir';

export type ExecCommand =
  | { kind: 'click'; id: string }
  | { kind: 'type'; id: string; text: string }
  | { kind: 'select'; id: string; option: string }
  | { kind: 'scroll_by'; dy: number }
  | { kind: 'scroll_to'; id: string };

export type ContentRequest =
  | { type: 'ping' }
  | { type: 'snapshot' }
  /** Re-read one element (optionally scrolling it into view first) for V2/V3 checks. */
  | { type: 'inspect'; id: string; scrollIntoView: boolean }
  /** Execute one command, wait for settle, verify locally. `expectedFingerprint` re-checked atomically. */
  | { type: 'execute'; command: ExecCommand; expectedFingerprint?: string };

export interface PingResponse {
  ok: true;
  version: string;
}

export interface SnapshotResponse {
  ok: true;
  snapshot: RawSnapshot;
}

export interface InspectResponse {
  ok: true;
  exists: boolean;
  element?: RawElement;
}

export interface ExecResponse {
  ok: boolean;
  /** Machine-readable failure code; never contains values. */
  error?: 'not_found' | 'stale' | 'not_editable' | 'no_such_option' | 'exception';
  mutations: number;
  settle_ms: number;
  settled: boolean;
  /** Any observable DOM/state change (click verification). */
  changed: boolean;
  /** type/select: the control holds the intended value after settle (compared in the content script). */
  value_matches?: boolean;
  scroll_changed?: boolean;
}

export interface ErrorResponse {
  ok: false;
  error: string;
}

export type ContentResponse = PingResponse | SnapshotResponse | InspectResponse | ExecResponse | ErrorResponse;
