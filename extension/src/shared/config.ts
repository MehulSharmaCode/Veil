// Central configuration. Nothing here may reference a specific website.

export const CONFIG = {
  SCHEMA_VERSION: 'veil.v0.1',
  /** Planner backend. May become remote later. */
  PLANNER_URL: 'http://localhost:8000',
  /** Telemetry relay. Must stay local even if the planner moves to a remote host. */
  TELEMETRY_URL: 'http://localhost:8000',

  MAX_ACTIONS_PER_STEP: 1,
  MAX_STEPS: 15,
  MAX_CONSECUTIVE_FAILURES: 2,
  HISTORY_LENGTH: 6,
  PLAN_TIMEOUT_MS: 60_000,

  IR_MAX_ELEMENTS: 300,
  TEXT_CAP: 200,
  MAX_SELECT_OPTIONS: 25,

  PAYLOAD_TARGET_BYTES: 30_000,
  PAYLOAD_MAX_BYTES: 48_000,
  TELEMETRY_MAX_BYTES: 64_000,

  SETTLE_QUIET_MS: 300,
  SETTLE_MAX_MS: 3_000,

  /** Tripwire: ignore vault forms shorter than this (avoid matching common short words). */
  TRIPWIRE_MIN_TEXT_LEN: 4,
  TRIPWIRE_MIN_DIGITS_LEN: 6,
} as const;
