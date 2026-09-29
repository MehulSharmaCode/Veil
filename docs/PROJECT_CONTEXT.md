# VEIL: Project Context (current state)

> **Role of this file:** the canonical snapshot of what Veil is and what exists **now**.
> - It does not describe future plans; those are in `ROADMAP.md`.
> - It does not keep dated history; that is in `CHANGELOG.md`.
> - Detailed verification logs and the current checklist are in `PROGRESS.md`.
> - **Update it in the same task as any change that affects it** (see "Documentation governance" in `CLAUDE.md`).
>
> **Last reconciled:** 2026-09-29, after the release-candidate validation of the dashboard UI/UX redesign, the v0.1
> hardening pass and M8 (which followed the Phase 1 freeze). Checked against a local test run and the live runs
> recorded in `PROGRESS.md`.

## 1. Project identity

- **Name:** Veil (VEIL), a privacy-preserving browser agent.
- **Context:** SIH 2026, problem statement **SIH26171: On-device Visual Perception for Light-weight Browser Agents**.
- **Repository:** github.com/MehulSharmaCode/Veil, branch `main`.

**Purpose:** Veil is a Chrome Manifest V3 extension that performs simple web tasks for a user (for example "fill my
email and address, don't submit") without sending the user's sensitive values to any server.
- The extension reads the page locally and replaces sensitive values with typed placeholders (`[EMAIL_1]`).
- It sends only a sanitized page description to a backend, where a hosted LLM plans the next action.
- Local code validates that action, resolves placeholders to real values locally, executes the action in the page
  and verifies the result.
- The final direction is a local visual ("need-to-see") perception pipeline. It is **not built**; only seams exist.

## 2. Current architecture

| Part | Path | What it is now |
|---|---|---|
| **A. VEIL extension** (the agent) | `extension/` | TypeScript, bundled by esbuild into `extension/dist/`. Permissions: `sidePanel`, `activeTab`, `scripting`. Hosts: `http://localhost/*`, `http://127.0.0.1/*` only. Contains generic primitives only, no demo-site knowledge. |
| **B. Controlled demo site** | `demo-site/` (:8080) | Static "Edit profile" test fixture. Not part of Veil. |
| **C. Read-only proof dashboard** ("proof console") | `dashboard/` (:8090) | Static ES-module app. Uses only `GET /telemetry/state` and SSE `GET /telemetry/stream`, and is never in the control path. `model.js` is a pure reducer: a stage or check is shown as passed/blocked/failed only if an event says so. `app.js` renders with `textContent` only. Layout (2026-09-29 redesign): task + outcome, a two-lane pipeline split by the device boundary (only the planner is remote) with a step × stage "whole task" matrix, the privacy boundary (on this device vs sent to the planner), "the AI proposes, VEIL decides", what the browser did, and collapsible evidence (payload, IR, timeline). |
| **D. Backend** | `server/` (:8000) | FastAPI: `/health`, `POST /plan`, and a `/telemetry/*` in-memory relay on a separate router. |
| **Planner** | `server/app/providers.py` | `PlannerProvider` protocol, with `GroqProvider` as the only runtime implementation. `ScriptedTestProvider` exists only in `server/tests/`. |
| **Tooling** | `scripts/` | `check_leaks.py` (canary leak check, 19 synthetic seeds) and `e2e_cdp.mjs` (Chrome E2E driver, headless or visible with the real side panel, IR audit, order evidence, screenshots; may know demo specifics). |

**Inside the extension:**
- **Content script** (top frame, localhost):
  - builds the DOM snapshot into the raw IR (values never read);
  - executes actions: native setter plus `input`/`change` events, a pointer/mouse click sequence, select, scroll;
  - waits for the DOM to settle (MutationObserver, 300 ms quiet / 3 s max) and verifies the result.
- **Side panel:** the orchestrator and UI. It owns the vault and runs the agent loop.
- **Service worker:** stateless; it only opens the side panel.
- **Privacy boundary:** the sanitizer (`privacy/`) turns raw text into `SanitizedText` (a branded type) plus vault
  entries. The egress gate (`egress/gate.ts`, rules G0–G7) and the single egress client (`egress/client.ts`, the only
  `fetch`) guard every outbound request, whether planner or telemetry.
- **Action execution:** the returned action goes through V1 (zod), then V2–V4, T1–T4 and R1
  (`policy/validator.ts`). The placeholder is resolved from the vault in the side panel, then the content script
  executes the action and verifies it.

## 3. Current data flow

1. The user types a task in the side panel. The sanitizer masks it (user-typed text: weak address cues count), and
   detected values go into the in-memory vault.
2. The content script snapshots the DOM into the raw IR: elements, accessible names, `has_value` plus a value
   category, bboxes, occlusion, fingerprints, and `regions[]` marked `unperceived`. The side panel receives it.
3. `sanitizeSnapshot` and the payload builder produce a closed-schema payload (sanitized IR, task and history; target
   size ≤ 30 KB). Fingerprints stay local.
4. The egress gate checks it (G0–G7). The egress client sends `POST /plan`. On a gate failure the client masks the
   failing fields once and re-checks; if it still fails, the task is blocked.
5. On the server, pydantic (`extra="forbid"`) checks the payload. The prompt wraps page data in
   `<untrusted_page_data>`, and `GroqProvider` returns strict-JSON-Schema output. The server validates it, makes one
   repair attempt if needed, and otherwise returns 502. With no key configured it returns 503.
6. In the extension: zod validation (V1), then local validation V2–V4, taint rules T1–T4, and R1 confirmation for
   submit-like clicks.
7. The placeholder is resolved locally, and only the real value for that single `type` action goes to the content
   script. The content script executes, waits for the DOM to settle, and verifies.
8. The loop takes a fresh snapshot for the next step, until `done`, `ask_user`, Stop, a failure or the 15-step limit.
   The vault is cleared when the task ends.
9. Sanitized telemetry events go through the same gate and client to `POST /telemetry/events`, then the relay, then
   the dashboard over SSE. Event types:
   - task and loop: `TASK_STARTED` (with planner provider/model/effort and limits), `DOM_SNAPSHOT_CREATED`,
     `IR_CREATED` (interactive elements with structural flags, no values or fingerprints), `PII_DETECTED`,
     `SANITIZATION_COMPLETE`, `VAULT_UPDATED`;
   - egress and planner: `EGRESS_CHECK_PASSED`/`FAILED`/`BLOCKED` (with the rules checked), `REQUEST_SENT` (request
     id, HTTP status, response time, the exact sanitized payload), `LLM_ACTION_RECEIVED` (after local zod
     validation);
   - local safety: `ACTION_VALIDATED` (rules evaluated, live checks, taint decision), `ACTION_REJECTED`,
     `CONFIRMATION_REQUESTED`/`RESOLVED` (with `blocked_not_executed` on a denial), `USER_ANSWERED` (sanitized
     answer);
   - action and outcome: `PLACEHOLDER_RESOLVED` (placeholder id and category only), `ACTION_EXECUTED` (with
     `after_stop: true` when an already-dispatched action finished after Stop), `VERIFICATION_COMPLETE`,
     `TASK_COMPLETED`, `ERROR` (code plus sanitized reason).
   - An invalid planner response emits a single `ACTION_REJECTED` (V1) with no action.

Limits (`extension/src/shared/config.ts`):
- `MAX_ACTIONS_PER_STEP = 1`, `MAX_STEPS = 15`, `MAX_CONSECUTIVE_FAILURES = 2` (then `ask_user`),
  `PLAN_TIMEOUT_MS = 60000`.
- Actions: `click`, `type`, `select`, `scroll`, `wait`, `ask_user`, `done`.

## 4. Current provider and model

| Setting | Value |
|---|---|
| Provider | **Groq**, `GroqProvider` (REST via `httpx`, no SDK) |
| Endpoint | `POST https://api.groq.com/openai/v1/chat/completions` |
| Model | **`openai/gpt-oss-20b`** (`VEIL_MODEL`) |
| Reasoning effort | **`medium`** (`VEIL_EFFORT`: `low`, `medium` or `high`) |
| Output | Strict JSON Schema (`veil_plan`), `max_completion_tokens` 4096 |
| Budget | 20 s per HTTP attempt, 25 s per call, at most 3 attempts. With the one repair call the worst case is 50 s, under the extension's 60 s abort. |
| Schema adaptation | Provider-local: same-`type` `anyOf` variants (the two `scroll` variants) are merged for Groq, and nulls are stripped from the output. The canonical schemas are unchanged. |
| Key | `GROQ_API_KEY`, only in `server/.env` (gitignored). The user adds it. |

Anthropic is **no longer used**. `AnthropicProvider` was removed, and `anthropic` is not in `server/requirements.txt`.

## 5. Current implementation status

- VEIL v0.1 (DOM-only) is fully implemented.
- **Phase 1 status: FROZEN WITH DOCUMENTED MANUAL LIMITATIONS** (2026-09-28). The commit is "Freeze Veil Phase 1" on
  `main`.
  - The real planner loop was verified headless on 2026-09-25.
  - On 2026-09-28 it was verified in a **visible Chrome 154 with the real Chrome side panel**: tests A–G in
    `PROGRESS.md` → "Live validation 2026-09-28".
  - The limitations:
    - CDP drove the runs, not a human hand;
    - the panel was opened and closed with `chrome.sidePanel.open()`/`close()`, not the toolbar icon or the panel's
      close button;
    - T1 has not been exercised live.
- The 2026-09-28 validation found no local-code defect, and no application code changed.
- **M8 (dashboard completion) is done** (2026-09-28):
  - the dashboard was rebuilt as a proof surface over the real telemetry stream;
  - small privacy-safe instrumentation was added (§3, item 9);
  - it was validated live in a visible Chrome (`PROGRESS.md` → "M8 dashboard completion").
- **Final hardening pass done** (2026-09-28): 12 defects fixed and re-validated live (`PROGRESS.md` → "Hardening
  pass 2026-09-28"):
  - address under- and over-masking in task text;
  - cue-less `ask_user` answers;
  - custom ARIA widget values entering the IR;
  - Stop/failure truthfulness;
  - dashboard current-step vs task-wide scope and event ordering;
  - the Groq `json_validate_failed` retry.
- **Dashboard UI/UX redesign done** (2026-09-29, presentation only): new information hierarchy and visual system,
  checked in Chrome at 1440/1024/390 px against real telemetry (`PROGRESS.md` → "Dashboard redesign 2026-09-29").
  No telemetry, reducer, transport or agent change.
- **Release-candidate validation passed** (2026-09-29): `make test`, `make leaks` 0/19, a live Groq smoke run to DONE
  and a Chrome check of the dashboard (`PROGRESS.md` → "Release-candidate validation 2026-09-29"). The M8, hardening
  and redesign work is committed as "Finalize Veil Phase 1 hardening and dashboard".
- Nothing from ROADMAP §2–§5 has been started.

## 6. Completed milestones

| Milestone | State |
|---|---|
| M1 Skeleton | done |
| M2 DOM → IR | done |
| M3 Sanitizer + vault | done |
| M4 Payload + egress gate | done |
| M5 LLM planner | done (live, Groq) |
| M6 Validation/taint/confirm/execute/verify | done (live) |
| M7 Full loop | done: live headless (09-25) and in a visible Chrome with the real side panel (09-28) |
| M8 Dashboard completion | done (2026-09-28): proof dashboard, validated live |

## 7. Verified capabilities

**Live, visible Chrome 154, real side panel, real Groq planner (2026-09-28):**
- **A. Single action:** `type` → verified → `done`. Save was not clicked.
- **B. Multi-step with `ask_user`:** the answer was sanitized to `[ADDRESS_1]`. There were 4 planner calls; both fields
  were typed and verified, then `done`.
- **C. Save protection:** R1 paused each of 4 Save proposals, all were denied, and **Save never executed**.
- **D. Stop mid-task:** the loop halted, the vault went to 0, the dashboard showed `TASK_COMPLETED stopped`, and there
  was no page change afterwards.
- **E. Panel close mid-task (`chrome.sidePanel.close()`):** the context was destroyed, the relay received
  `panel_closed` and `vault cleared`, and there was no page input after the close (timestamped).
- **F. Values written in the task text:** the server received only `[EMAIL_1]` / `[ADDRESS_1]`, and both fields were
  filled with the exact seeded values and verified.
- **G. Dashboard:** it reflected every run live and showed 0/9 seeded values in its text and HTML.

**M8 dashboard, live in visible Chrome with the real Groq planner (2026-09-28):**
- **Representative task with values in the text:** every stage lit from its own event across 3 steps, with 0/9 seeded
  values in the dashboard.
- **Save + Deny:** the confirmation card showed "CONFIRMATION REQUIRED · R1_SUBMIT_LIKE". The step ended "blocked
  (user denied)", and resolve/execute/verify were skipped.
- **`ask_user`:** the answer was shown as "sanitized to [ADDRESS_1]".
- **Stop while planning:** the planner stage showed INTERRUPTED and the outcome STOPPED.
- `make leaks` found 0/9 over 36 payloads.
- **Leak check:** `make leaks` found 0/9 over 24 payloads and 36 telemetry events. The server console had 0 hits.

**Hardening pass, live with the real Groq planner (2026-09-28)** (headless, plus visible Chrome with the real side
panel for tests 5/7 and 12):
- email + address, a PIN-less address followed by another instruction, a PIN-less `ask_user` answer, and an
  adversarial prose task (5 categories) were all masked exactly, typed and verified;
- Save/Deny: 4/4 blocked;
- Stop while planning, and Stop during an execute (`after_stop` reported, not verified);
- panel close via `chrome.sidePanel.close()` (0 page inputs after it);
- verification failure → hand-over;
- stale target → V3;
- prompt injection and look-alikes defused;
- the IR audit found 0/13 fixture values;
- 0 causal-order violations; `make leaks` 0/19 over 91 payloads.

**Earlier:**
- Headless live runs, 2026-09-25: single action, multi-step, Save/Deny.
- Snapshot, executor on a controlled input, stale-fingerprint refusal, click/scroll, and the no-key 503 path, in real
  Chrome.

**Unit tests** cover the rest (see §14). Details are in `PROGRESS.md`.

## 8. Security and privacy invariants

These are the non-negotiable invariants defined in `CLAUDE.md` → "Privacy invariants".
1. Raw sensitive values never cross the network boundary.
2. Raw DOM/HTML is never sent.
3. Input field values are never serialized; only `has_value` and a category are.
4. All outbound traffic goes through one egress client, after the egress gate passes.
5. The vault is local and in memory only. A value leaves it only for the single `type` action that uses it.
6. The LLM is only a planner and never the final safety authority.
7. The dashboard, logs and telemetry show no raw values.
8. Fail closed.
9. No arbitrary code execution: no `eval`, no JS from the LLM, no downloads.

**Status:** these are engineering controls backed by unit tests and a canary leak check, not a formal guarantee.
Detection is heuristic.

## 9. Known limitations

- Detection is heuristic, and there is no NER.
  - Names are found only via cues, as the answer to a name question, or once already vaulted.
  - Addresses are found via cues ("my address is X", "address X", "X as my address", "X in the address field"),
    house-number/street shapes, a PIN near address words, or as the answer to an address question. Page text with
    none of these is not detected.
  - DOB becomes `[REDACTED_TEXT]`.
  - Obfuscated emails are missed.
  - Cue false positives are possible.
- Synthetic events have `isTrusted=false`. Sites that check it fail verification, and the step is handed to the user.
- The Groq free tier allows 8K tokens/min, and a step costs about 2.5K. Tasks of 4 or more steps hit 429, and a
  wait longer than the budget fails the task.
- `gpt-oss-20b` planner quality:
  - it phrases `ask_user` questions awkwardly;
  - it re-proposes a denied Save several times;
  - it may take unrequested but allowed actions.
  Local validation and R1 hold in every case.
- Stop and panel close don't recall an `execute` that was already dispatched to the page. The stop flag is checked
  before every dispatch, so nothing new is sent after it.
  - After Stop, the finished action is reported with `after_stop` and is not verified.
  - After a panel close, the dashboard shows it as "may have run; result not observed".
- Scope is DOM-only and localhost-only. `inspect` scrolls the target into view before acting.
- Panel-close telemetry is best-effort (`keepalive`).
- Dashboard:
  - it shows the latest session only (the relay is in memory);
  - server-side provider retries and repair attempts are not observable, and appear only as planner latency;
  - `REQUEST_SENT` is emitted when the response arrives, and `EGRESS_CHECK_PASSED` marks the dispatch;
  - the leak check is offline (`make leaks`) and is shown as "not observed";
  - T1 hand-off completion by the user emits no event, and neither does the local hand-over question after 2
    consecutive failures while it is pending;
  - telemetry arrives after the fact (ms locally), so the page can change before the dashboard repaints. The
    timeline is ordered by emit time and shows the delivery delay.
- `sidepanel.js` is about 840 KB unminified.
- pytest prints a Starlette deprecation warning (`httpx` with `TestClient`). It is harmless and the tests pass.

## 10. Open issues

The full list is in `PROGRESS.md` → "Open items".
1. The toolbar-icon open and the panel's own close button have not been exercised by a human hand. The automated
   runs used `chrome.sidePanel.open()`/`close()`.
2. The T1 credential hand-off has not been validated live; the demo page has no credential or card field.
3. Planner-quality and rate-limit issues (§9).
4. The Groq `json_validate_failed` retry is unit-tested only; the running backend was not restarted during the
   hardening pass.
5. The local pre-fix incident evidence file (`server/logs/received_payloads.pre-address-fix.jsonl`) is no longer on
   disk as of 2026-09-28, and why is unknown. The incident write-up in `PROGRESS.md` is intact.
6. The redesigned dashboard has not yet shown a live Save/Deny run (Groq free-tier limits during the redesign); that
   state was checked with the reducer's test fixtures (`PROGRESS.md` → "Dashboard redesign 2026-09-29"). A complete
   live DONE was shown on 2026-09-29 (`PROGRESS.md` → "Release-candidate validation 2026-09-29").

## 11. Current next task

1. Discuss the next phase with the user. Nothing in ROADMAP §2–§5, OCR/vision included, starts automatically.
2. Optional: a human repeats one task using the toolbar icon and the panel's close button.

## 12. Explicitly deferred functionality

These are not built; see `ROADMAP.md` §6.
- The visual stack: capture, ROI, ONNX Runtime Web, PP-OCRv5, YuNet, redaction.
- NER, WebGPU, Firefox, offscreen documents.
- iframes and shadow DOM beyond the generic snapshot.
- A per-origin runtime permission flow, and `storage.session`.
- The `navigate` and `inspect` actions, and action batching.
- Benchmarks and canary infrastructure.

`extension/src/perception/` and `extension/src/inference/` are reserved and must not be stubbed.
**Never:** `chrome.debugger`, `<all_urls>`, `cookies`, `webRequest`.

## 13. Important architectural decisions

The full table with dates is in `PROGRESS.md` → "Decisions".
- Groq `openai/gpt-oss-20b`, effort `medium`, strict JSON Schema over REST with `httpx`, adding no dependency. This
  replaced the never-run Anthropic provider on 2026-09-25.
- The provider-local schema adaptation keeps the canonical schemas unchanged.
- The provider time budget (20 s / 25 s / 3 attempts) fits the extension's 60 s `/plan` abort.
- One sanitizer, one egress gate, one egress client. Outbound strings are the branded `SanitizedText`.
- A telemetry gate failure drops the event; a planner gate failure blocks the task.
- Overlapping detections are merged. Unclassifiable numbers of 9 or more digits become `[REDACTED_TEXT]`.
  Placeholder look-alikes in page or task text are defused.
- A PIN-code address detection grows to the surrounding address tokens. This was the fix for the 2026-09-25 incident.
- All address detectors share one token-boundary engine that stops at instruction/label words, other PII and
  clause-starting connectors. Weak cues count only in user-typed text. `ask_user` answers use the question's expected
  category. This was the 2026-09-28 hardening.
- ARIA `textbox`/`searchbox`/`spinbutton`/`combobox` content is a value: it is never read into the IR.
- Fingerprints are not sent to the backend.
- Executes are never re-sent. A verification failure leads to a re-snapshot and re-plan, and 2 consecutive failures
  lead to `ask_user`.
- zod v4 runs `jitless` under the MV3 CSP. `platform/chrome.ts` is the only module that touches `chrome.*`.
- The E2E driver uses CDP `Extensions.loadUnpacked`, because Chrome 137 and later ignore `--load-extension`.
- The dashboard is a proof surface:
  - statuses come only from events;
  - anything unproven is shown as pending, skipped, interrupted or not observed;
  - it separates "observed this session" from "enforced by design";
  - pipeline stages are current-step ("N/A this step" when the action has no such stage; such stages say what
    happened there earlier in the task), with a "Whole task so far" summary and a step × stage agent-loop matrix;
  - the outcome card names the outcome ("DONE · DECLARED" for a planner-declared DONE), so it never reads as a
    verified action;
  - it is presentation over the same reducer: the 2026-09-29 redesign changed layout, wording and visual system
    only (`index.html`, `style.css`, `app.js`, plus presentation data in `registry.js`);
  - events are ordered by emit time;
  - its instrumentation goes through the same `Telemetry.emit` → egress client → gate path, with no second network
    path;
  - it has no new dependencies.

## 14. Current test baseline

Re-run locally on 2026-09-29 for the release-candidate validation (`make test`; same counts as after the 2026-09-28 hardening pass and the dashboard redesign):

| Suite | Result |
|---|---|
| `tsc --noEmit` (extension) | clean |
| vitest (extension: privacy, egress, policy, agent loop) | **116 / 116** passed (4 files) |
| pytest (server, incl. `test_groq_provider.py` on MockTransport, no network) | **57 / 57** passed, 1 deprecation warning |
| dashboard reducer (`node --test dashboard/test/model.test.mjs`) | **14 / 14** passed |
| `make leaks` (`check_leaks.py --telemetry`, 19 seeds) | **0/19**, 2026-09-29 after the release-candidate live runs, over 128 planner payloads and the latest session's telemetry |
