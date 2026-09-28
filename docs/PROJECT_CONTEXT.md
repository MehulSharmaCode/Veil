# VEIL: Project Context (current state)

> **Role of this file:** the canonical snapshot of what Veil is and what exists **now**.
> - It does not describe future plans; those are in `ROADMAP.md`.
> - It does not keep dated history; that is in `CHANGELOG.md`.
> - Detailed verification logs and the current checklist are in `PROGRESS.md`.
> - **Update it in the same task as any change that affects it** (see "Documentation governance" in `CLAUDE.md`).
>
> **Last reconciled:** 2026-09-28, after the Phase 1 live validation and freeze. Checked against a local test run and
> the live runs recorded in `PROGRESS.md`.

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
| **C. Read-only dashboard** | `dashboard/` (:8090) | Static app. Uses only `GET /telemetry/state` and SSE `GET /telemetry/stream`. Never in the control path. |
| **D. Backend** | `server/` (:8000) | FastAPI: `/health`, `POST /plan`, and a `/telemetry/*` in-memory relay on a separate router. |
| **Planner** | `server/app/providers.py` | `PlannerProvider` protocol, with `GroqProvider` as the only runtime implementation. `ScriptedTestProvider` exists only in `server/tests/`. |
| **Tooling** | `scripts/` | `check_leaks.py` (canary leak check, 9 synthetic seeds) and `e2e_cdp.mjs` (headless Chrome E2E driver; may know demo specifics). |

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

1. The user types a task in the side panel. The sanitizer masks it, and detected values go into the in-memory vault.
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
   the dashboard over SSE.

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
| M8 Dashboard polish | mostly done; remaining polish scheduled after the Phase 1 freeze |

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
- **Leak check:** `make leaks` found 0/9 over 24 payloads and 36 telemetry events. The server console had 0 hits.

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
  - Names are found only via cues or once already vaulted.
  - An address with neither a cue nor a PIN code is not detected.
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
- Scope is DOM-only and localhost-only. `inspect` scrolls the target into view before acting.
- Panel-close telemetry is best-effort (`keepalive`). Dashboard `ERROR` events don't light a stage.
- `sidepanel.js` is about 840 KB unminified.
- pytest prints a Starlette deprecation warning (`httpx` with `TestClient`). It is harmless and the tests pass.

## 10. Open issues

The full list is in `PROGRESS.md` → "Open items".
1. The toolbar-icon open and the panel's own close button have not been exercised by a human hand. The automated
   runs used `chrome.sidePanel.open()`/`close()`.
2. The T1 credential hand-off has not been validated live; the demo page has no credential or card field.
3. Planner-quality and rate-limit issues (§9).
4. The local pre-fix incident evidence file (`server/logs/received_payloads.pre-address-fix.jsonl`) is no longer on
   disk as of 2026-09-28, and why is unknown. The incident write-up in `PROGRESS.md` is intact.

## 11. Current next task

1. M8 dashboard polish (ROADMAP §1, step 4).
2. Then discuss the next phase with the user. Nothing in ROADMAP §2–§5, OCR/vision included, starts automatically.
3. Optional: a human repeats one task using the toolbar icon and the panel's close button.

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
- Fingerprints are not sent to the backend.
- Executes are never re-sent. A verification failure leads to a re-snapshot and re-plan, and 2 consecutive failures
  lead to `ask_user`.
- zod v4 runs `jitless` under the MV3 CSP. `platform/chrome.ts` is the only module that touches `chrome.*`.
- The E2E driver uses CDP `Extensions.loadUnpacked`, because Chrome 137 and later ignore `--load-extension`.

## 14. Current test baseline

Re-run locally on 2026-09-28 after the live validation (`make test`; no application code changed):

| Suite | Result |
|---|---|
| `tsc --noEmit` (extension) | clean |
| vitest (extension: privacy, egress, policy) | **53 / 53** passed (3 files) |
| pytest (server, incl. `test_groq_provider.py` on MockTransport, no network) | **54 / 54** passed, 1 deprecation warning |
| `make leaks` (`check_leaks.py --telemetry`) | **0/9**, 2026-09-28, over 24 planner payloads and 36 telemetry events from the live runs |
