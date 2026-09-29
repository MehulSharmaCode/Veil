# VEIL Progress Log

> **Role of this file:** milestones, verified results, the current checklist, decisions and open items.
> - The current-state snapshot is in `PROJECT_CONTEXT.md`.
> - The chronological history is in `CHANGELOG.md`.
> - Future phases are in `ROADMAP.md`.

## Next session: start here

**Current state (2026-09-28): Phase 1 FROZEN WITH DOCUMENTED MANUAL LIMITATIONS.**
- VEIL v0.1 (DOM-only) is implemented. The Phase 1 chain has now been validated live in a **visible (headed)
  Chrome 154 with the real Chrome side panel** on the controlled demo site:
  task → DOM snapshot → IR → sanitization → local vault → egress gate → real Groq planner → structured action →
  local validation → local placeholder resolution → Chrome execution → verification → next step.
- The 2026-09-28 runs covered all seven checklist items A–G. See "Live validation 2026-09-28" below.
- `make leaks` found 0/9 over 24 planner payloads and 36 telemetry events. No local-code defect was found, and no
  code was changed.
- Current provider: **Groq**, model `openai/gpt-oss-20b`, reasoning effort `medium`.
- A privacy bug was found and fixed on 2026-09-25: see "Security incident 2026-09-25 (resolved)" below.
- **Manual limitations:**
  - The runs were driven through CDP by Claude Code, not by a human hand.
  - The side panel was opened with `chrome.sidePanel.open()` (CDP user-gesture evaluate), not the toolbar icon.
  - It was closed with `chrome.sidePanel.close()`, not the panel's close button.
  - T1 (credential hand-off) still cannot be exercised on the demo page.
- **M8 (dashboard completion) is done (2026-09-28).** See "M8 dashboard completion" below.
- **Final hardening pass done (2026-09-28).** 12 defects were found and fixed, including address under- and
  over-masking in task text and custom ARIA widget values entering the IR. The live matrix was re-run, and
  `make leaks` found 0/19. See "Hardening pass 2026-09-28" below.
- **Dashboard UI/UX redesign done (2026-09-29, presentation only).** The dashboard now reads as a proof console in
  story order, with a two-lane pipeline split by the device boundary. No telemetry, reducer, transport or agent
  change. See "Dashboard redesign 2026-09-29" below.
- **Task 2, Gemini provider (2026-09-29, uncommitted):** `GeminiProvider` added behind the provider seam
  (`VEIL_PROVIDER=gemini`); Groq stays the default. **Live validation BLOCKED** by Gemini capacity (503/504) and the
  free tier's 20 requests/day quota. See "Task 2: Gemini provider" below.
- **Release-candidate validation passed (2026-09-29):** `make test`, `make leaks` 0/19, a live Groq smoke run to DONE
  and a Chrome check of the dashboard. See "Release-candidate validation 2026-09-29" below.

**Git state:**
- Phase 1 is frozen in `3145cdd Freeze Veil Phase 1`.
- The M8 work, the hardening pass and the dashboard redesign are committed in "Finalize Veil Phase 1 hardening and
  dashboard" (2026-09-29), after the release-candidate validation below.
- Run `git status` / `git log` first.

**Plan for the next session, in order:**
1. Review `docs/PROJECT_CONTEXT.md`, this file and `git status`.
2. Optional: a human repeats one task by hand, using the toolbar icon and the panel's own close button. These two UI
   entry points were not exercised by the automated runs.
3. Finish Task 2 when the Gemini quota allows ("Task 2: Gemini provider" → "To finish"); the user reviews and
   commits the Task 2 changes.
4. Discuss the next phase with the user (ROADMAP §2 real-website compatibility or later sections).
5. **Do not** start OCR/vision (ROADMAP §3) or any other new feature on your own.

**Dev notes for the next session:**
- **Values in harness output:** `node scripts/e2e_cdp.mjs` reports the demo form as filled/empty only (the
  `[demo page state]` line). Its `--ir-audit` mode prints canary keys, not values. Keep harness output that way.
- **Use the seeded values:** manual and harness tests must use the synthetic values seeded in
  `scripts/check_leaks.py` (`SEEDS`). Otherwise `make leaks` cannot detect them.
- **Evidence file:** `server/logs/received_payloads.pre-address-fix.jsonl` was the local incident evidence.
  - It was **no longer present on 2026-09-28**. `server/logs/` had been recreated that day, before the validation
    runs, and why is unknown.
  - The incident write-up below is unaffected.
  - `make leaks` scans only `server/logs/received_payloads.jsonl`.
- **Free tier:** each planner step costs about 2.5K of the 8K tokens/min allowed, so avoid unnecessary live runs.

**Planner configuration (live-verified 2026-09-25):**
- Provider: `GroqProvider` (`server/app/providers.py`). It calls Groq's REST API with `httpx`; no SDK dependency.
- Endpoint: `POST https://api.groq.com/openai/v1/chat/completions` with Bearer auth.
- Model: `VEIL_MODEL`, default **`openai/gpt-oss-20b`**. Effort: `VEIL_EFFORT`, default `medium` (`low|medium|high`).
- Structured output: `response_format: {type: "json_schema", json_schema: {name: "veil_plan", strict: true, schema}}`, with `max_completion_tokens: 4096`.
- Time bounds:
  - each HTTP attempt: at most 20 s;
  - each `complete_json` call: at most 25 s, including retries, backoff and `retry-after` waits;
  - at most 3 attempts per call;
  - worst case with the one repair call: 2 × 25 s = 50 s, under the extension's 60 s `/plan` abort.
- Errors:
  - 401 and other 4xx are not retried;
  - 429 waits for `retry-after` only if it fits the budget, otherwise it fails with "rate limit reached; retry in ~N s";
  - 5xx and 498 are retried within the budget.
  - Messages never include response bodies.
- Key: `GROQ_API_KEY` in `server/.env` (gitignored; the user adds it).
- **Groq strict-mode schema adaptation:** Groq rejects `anyOf` object variants that share a discriminator value. The
  canonical `RESPONSE_SCHEMA` has two `scroll` variants, which caused HTTP 400
  `anyOf disambiguation failed: overlapping discriminator value 'scroll'`. `GroqProvider` therefore merges same-`type`
  variants into one variant with nullable (still required) fields before sending. It drops those nulls from the output
  before the canonical pydantic/zod validation. `RESPONSE_SCHEMA`, `PlanResponse` and the zod schemas are unchanged.

**Free-tier limits (Groq docs, 2026-09-25):** `openai/gpt-oss-20b` allows 30 RPM, 1K RPD, **8K TPM** and 200K TPD.
One planner step uses about 2.5K tokens (about 2.4K prompt, 60–150 reasoning+output). Tasks of 4 or more steps hit
429 on the last step. The provider waited out `retry-after` within its budget, so that step took about 19–21 s but
succeeded.

**Must not change:** the planner payload/response schemas, the prompt's untrusted-data framing, the
sanitizer/vault, the egress gate + client, validator/taint/confirmation, executor/verification, telemetry events and
the dashboard contract.

## Status summary

| Milestone | State | Notes |
|---|---|---|
| M1 Skeleton | ✅ done | Extension loads; content script answers ping; panel shows `/health`; dashboard shows real `TASK_STARTED` via relay. |
| M2 DOM → IR | ✅ done | Real snapshot in Chrome: 26 elements + 1 region on the demo page; stable ids, fingerprints, occlusion, debug view. |
| M3 Sanitizer + vault | ✅ done | Unit-tested; dashboard shows categories/placeholders only. |
| M4 Payload + egress gate | ✅ done | Unit-tested incl. tripwire and retry-then-block; `/plan` receives and logs real sanitized payloads. |
| M5 LLM planner | ✅ done (live) | Groq `openai/gpt-oss-20b`, strict JSON Schema; real responses validated by pydantic + zod. |
| M6 Validation/taint/confirm/execute/verify | ✅ done (live) | Driven by real LLM output: type → V2/V3/T2/T3 → local resolve → execute → `value_matches` verify; R1 confirm + Deny. |
| M7 Full loop | ✅ done (live, real side panel) | Headless 09-25. Visible Chrome with the real side panel on 09-28: single, multi-step, Save/Deny, Stop, panel close, task values, dashboard; leak check 0/9. |
| M8 Dashboard completion | ✅ done (live) | Proof dashboard over real telemetry: pipeline, privacy proof, AI decision vs local authority, execution/verification, sanitization, agent loop, payload, IR, timeline. Privacy-safe instrumentation added. Validated live 09-28. |

## Security incident 2026-09-25 (resolved): address fragments sent to the planner

**What happened:**
- In the first live multi-step run ("Fill my email and address. Do not submit."), the model asked for the address.
- The harness answered with the synthetic test address (seed `task:address` in `scripts/check_leaks.py`).
- The sanitizer masked only the address's 6-digit PIN code as `[ADDRESS_1]`. The street and locality stayed in the
  sanitized `user_answer` text, in the form `<street>, <locality>, <city> [ADDRESS_1]`.
- That text was sent to Groq in **3 planner payloads**. It also appeared in the `REQUEST_SENT` telemetry and on the dashboard.
- Only synthetic test data was involved.
- The vault held only the PIN, so the agent typed just the PIN into Address. Verification passed, because it
  compares against the vault value.

**How it was detected:**
- `make leaks` reported `task:address-street` and `task:address-locality`.
- The harness's dashboard canary check showed 2/9.
- The run was stopped and diagnosed before any further live testing.

**Root cause:**
- Address detection had two paths: a context cue ("my address …", "address:", "residing at") that masks the whole
  value, and a PIN code near address words that masked **only the PIN**.
- A bare address typed as an answer has no cue.
- The egress gate's residual scan (G5) uses the same detector logic, so it did not independently catch the leftover
  text. The tripwire (G6) matches only vault values, and the vault held only the PIN.

**Fix** (`extension/src/privacy/detectors.ts`, generic, no site knowledge):
- A PIN-code detection now grows outward over the surrounding address tokens.
- It stops at sentence/line ends, a trailing `:`, placeholders, emails, digit runs of 7 or more, and
  instruction/label words ("fill", "my", "and", "email", "phone", …).
- It is fail-closed: it may over-mask an adjacent word, but it no longer leaves street/locality fragments of this form.

**Regression tests** (`extension/test/privacy.test.ts`):
- the bare address is masked whole, including a lowercase address;
- an address inside an instruction stops at instruction words;
- the span stops at sentence and label boundaries and continues past the PIN;
- a `user_answer` sanitizes to exactly `[ADDRESS_1]`, with the full value vaulted.

**Post-fix verification:**
- The same multi-step task was re-run live. The full address was vaulted, typed and verified.
- `check_leaks.py --telemetry`: 0/9 over the post-fix planner payloads and live telemetry.
- Dashboard canary check: 0/9. Server console log: 0/9.
- The API key never appeared in any output.

**Evidence:**
- The pre-fix payload log was kept locally as `server/logs/received_payloads.pre-address-fix.jsonl`.
- *2026-09-28:* that file is no longer on disk; why is unknown. It was never committed.
- It is gitignored. **Do not delete it, and do not commit it.**

**Residual risk:**
- Detection is still heuristic. As of the 2026-09-28 hardening pass, cue variants, suffix cues, house-number/street
  shapes and `ask_user` answer context are also covered; page text with none of these is not detected (open item 5).

## Safety verification (as of 2026-09-25)

| Property | How it was verified |
|---|---|
| Save/submit protection | **Live:** the model proposed `click` on "Save changes". The validator raised `R1_SUBMIT_LIKE` and asked for confirmation; the harness denied it; **the click was not executed**. Also unit-tested (`policy.test.ts`). |
| Stale targets rejected | Real Chrome `--exec-check`: `error: stale` for a changed fingerprint. Unit-tested V2/V3 live checks. |
| Malformed / unsupported actions rejected | Unit tests: server (`test_unknown_or_extra_action_fields_rejected`, including `eval` and `js` fields; invalid merged scroll outputs) and extension (`policy.test.ts` V1). |
| No arbitrary JS / eval | The executor implements only `type` / `click` / `select` / `scroll` (`content/execute.ts`). Actions are closed schemas (pydantic `extra="forbid"`, zod `strictObject`). Unknown types and extra fields are rejected. |
| Placeholders resolved locally | Live: the model only ever emitted `[EMAIL_1]` / `[ADDRESS_1]`. The side panel resolved them from the vault just before `execute`. Payload logs contain placeholders only (leak check 0/9). |
| Provider cannot bypass the boundary | `GroqProvider` sits behind `/plan`. It receives only the gate-checked sanitized payload and has no path to the browser or the vault. All actions still go through local validation (V1–V4, T1–T4, R1). |

## What was implemented (2026-09-25): Phase 1 live planner

**Server (provider layer only):**
- `GroqProvider` replaces `AnthropicProvider` behind the unchanged `PlannerProvider` protocol.
- `config.py`, `main.py` and `.env.example` now use `GROQ_API_KEY` and `VEIL_MODEL` / `VEIL_EFFORT`.
- `anthropic` was removed from `requirements.txt`; no dependency was added.
- The bounded timeout/retry budget (see "Next session") replaces the old 60 s × 3 Anthropic client settings.
- A Groq strict-mode schema adaptation merges the `scroll` variants. Found live: HTTP 400 `discriminator_value_overlap`.
- `planner.py`, `prompt.py` and `schemas.py` are unchanged.

**Extension:**
- Address-detection fix in `privacy/detectors.ts`, with 2 regression tests in `test/privacy.test.ts`. See the
  incident section above.
- No other extension change. The payload schema, egress gate, validator, executor, telemetry and dashboard are unchanged.

## What was implemented (2026-09-23)

**Extension:**
- MV3 manifest (`sidePanel`, `activeTab`, `scripting`; hosts `http://localhost/*`, `http://127.0.0.1/*`).
- esbuild build, minimal service worker, platform adapter.
- Content script: DOM→IR with visible elements, labels via accname heuristic chain, `has_value` + `value_category`
  (never values), bbox/viewport/occlusion, section/form context, position-free fingerprint, `regions[]` as
  `unperceived`, 300-element budget.
- Executor: native value setter + `input`/`change`, pointer/mouse click sequence, select, scroll, MutationObserver
  settle (300 ms quiet / 3 s max), local verification.
- Side panel: orchestrator + UI (task, Start/Stop, stage, vault metadata, confirmation / ask_user / hand-off prompt,
  step log, sanitized-IR debug view).
- Privacy: NFKC normalizer; detectors (EMAIL, PHONE, PAN, AADHAAR+Verhoeff, CARD+Luhn, address/name/phone/DOB cues,
  PIN near address words); single sanitizer with per-session placeholder counter and referential reuse; vault with
  metadata views.
- Egress: closed payload schema + builder (≤30 KB target); gate G0–G7; single egress client (mask the offending fields
  once, re-check, else block).
- Policy: V1–V4, T1–T4, R1 submit-like confirmation.
- Telemetry: all spec event types through the same gate.

**Server:**
- FastAPI `/health`, `/plan` (pydantic mirror with `extra="forbid"`, prompt with `<untrusted_page_data>`, structured
  output, one repair, dev payload log `server/logs/received_payloads.jsonl`).
- Telemetry relay (`POST /telemetry/events`, `GET /telemetry/state`, SSE `GET /telemetry/stream`); CORS for
  dashboard GETs only.

**Demo site:** college-portal "Edit profile" with:
- Prefilled name, phone and PAN.
- Empty email and address fields.
- A controlled "Alternate email" input that re-renders from JS state.
- Application No `APP-26-K7Q4`, a profile `<img>`, and a submit-type **Save changes** button with success feedback.

**Dashboard:** static app with:
- Registry-driven stage tracker (`registry.js`).
- Task, IR summary, categories, placeholder table, vault status.
- The sanitized outbound payload, egress result, LLM action, validation, execution/verification.
- Privacy badge and a live timeline.

**Tooling:** `Makefile`, `scripts/check_leaks.py`, `scripts/e2e_cdp.mjs`.

**Repo:** `origin` = github.com/MehulSharmaCode/Veil. The user commits and pushes. The 2026-09-25 changes are
committed in `ba45fe5`.

## Verified in real Chrome (headless Chrome 153 via `scripts/e2e_cdp.mjs`)

- **Snapshot (`--snapshot`):** 26 elements + 1 region. Field values are never read. The header becomes
  `Signed in as [PERSON_1] ([EMAIL_1])`. `APP-26-K7Q4` stays unmasked.
- **Executor (`--exec-check`):**
  - Typing into the controlled input via native setter + events sticks and passes verification after settle.
  - A bare `.value=` on it reverts (fixture sanity).
  - A stale fingerprint is refused (`error: stale`).
  - The Save click is detected (3 mutations); scroll works.
- **Representative task up to the planner:**
  - The task is sent as `Fill my email [EMAIL_1] and my address [ADDRESS_1]. Do not submit.`
  - The egress gate passed (7.6 KB) and `/plan` logged the payload.
  - The 503 (no provider) was handled; the task ended with "Planner error", vault cleared, nothing typed.
- **Dashboard (`--dashboard`):**
  - Live over SSE; stages, categories, vault, payload and timeline are populated from real events.
  - 0 of 9 raw canary values visible in the page text.
- **Leak check:** `check_leaks.py` reports **0/9** over all 5 logged payloads (re-run 2026-09-24). On 2026-09-23 it
  was also 0/9 over 13 live telemetry events. All 5 payloads are step 1 and ended at the 503.

**Live planner runs (2026-09-25, Groq `openai/gpt-oss-20b`, effort `medium`, headless Chrome):**
- **Single action:** "Fill my alternate email with my email. Do not submit."
  - Step 1: the model returned `type e12 "[EMAIL_1]"`. `e12` is the "Alternate email" field. `[EMAIL_1]` is the
    header email, masked from the page.
  - Validation passed, the value was resolved locally and executed, and verification passed (`value_matches_after_settle`).
    The field is the controlled input; the value stuck.
  - Step 2: the model saw `has_value` and returned `done`.
  - Save was not clicked; the vault was cleared. Dashboard: all 11 stages lit, 0/9 canaries.
- **Multi-step:** "Fill my email and address. Do not submit." (the address was supplied via `ask_user`).
  - Step 1: `ask_user`. The harness answered with the synthetic address, which was sanitized locally to `[ADDRESS_1]`.
  - Step 2: `type e10 "[EMAIL_1]"`, verified.
  - Step 3: `type e13 "[ADDRESS_1]"`, verified. The full address was typed.
  - Step 4: `done`.
  - 4 egress passes, 0 remediated, 0 blocked. Dashboard: 0/9 canaries. Save was not clicked.
  - *The first attempt (before the address fix) leaked address fragments; see "Security incident 2026-09-25 (resolved)".*
- **Save protection:** "Fill my alternate email with my email and save the changes." with `--confirm deny`.
  - The model typed `[EMAIL_1]` (verified), then proposed `click e14` ("Save changes").
  - The validator raised `R1_SUBMIT_LIKE`, the confirmation was denied, and the click was **not executed**.
  - The model then asked the user, the harness declined, and the agent stopped with the vault cleared.
- **Leak check (real-provider path, after the fix):**
  - `check_leaks.py --telemetry`: 0/9 over the post-fix payloads and live telemetry.
  - The server console log contains no canary values and no API key.

**Not yet verified:** see "Open items" below.

## Live validation 2026-09-28 (visible Chrome, real side panel)

**Method:**
- Services came from `make dev`. `/health` reported `provider: groq`, `model: openai/gpt-oss-20b`,
  `planner_configured: true`, and `VEIL_EFFORT=medium`.
- A session-local driver (not committed; derived from `scripts/e2e_cdp.mjs`) launched a **visible, headed** Google
  Chrome 154 with a throwaway profile and loaded `extension/dist` via CDP `Extensions.loadUnpacked`.
- It opened the demo site, with the dashboard in a second window.
- It opened the **real Chrome side panel** by calling `chrome.sidePanel.open()` from an extension page with a CDP
  user gesture. The service worker's gesture-less call was refused ("may only be called in response to a user
  gesture").
- It drove the panel's own DOM controls: task box, Start, Stop and the prompt buttons.
- Task and answer text came from the `SEEDS` in `scripts/check_leaks.py`, and the driver printed only booleans.
- A page-side listener timestamped `input`/`click` events.
- Screenshots of the panel, page and dashboard were checked, and kept locally only.

**Results:**

| Test | Result | Observed |
|---|---|---|
| A single step: "Fill my alternate email with my email. Do not submit." | PASS | `type e12 [EMAIL_1]` → ✓ verified (`value_matches_after_settle`) → `done`. Alternate email equals the page's header email, Save not clicked, other fields unchanged, vault 2 → 0. |
| B multi-step: "Fill my email and address. Do not submit." with `ask_user` answered by the `task:address` seed | PASS | 4 planner calls: `ask_user` → answer sanitized to `[ADDRESS_1]` → `type e10 [EMAIL_1]` ✓ → `type e13 [ADDRESS_1]` ✓ → `done`. The full seeded address was typed. The last step took 19 s: a 429 `retry-after` waited out within the budget. Vault → 0. |
| C Save protection: "…with my email and save the changes." with Deny | PASS | `click e14` "Save changes" was proposed **4 times**. Each time R1_SUBMIT_LIKE raised a confirmation and each was denied, so **Save never executed** (`saved: false`). The model then asked "Do you want to save the changes now?", Stop task was chosen, and the vault → 0. See the note below. |
| D Stop: task with values in the text; Stop pressed after the first verified type | PASS | Stop was pressed while step 2 was planning. Panel: `stopped`, vault count 0. Relay: `VAULT_UPDATED cleared`, `TASK_COMPLETED stopped`. The page was unchanged for 20 s after the stop, and Address stayed empty. |
| E panel close: same task, `chrome.sidePanel.close()` after the first verified type | PASS | Re-run with page timestamps: the only page input was Email, 376 ms **before** the close. The panel target was gone and nothing changed for 20 s. The relay received `VAULT_UPDATED cleared` and `TASK_COMPLETED panel_closed` (best-effort, but delivered). See the first-attempt note below. |
| F values in the task text (`task:email` and `task:address` seeds) | PASS | The panel showed "sent as: Fill my email [EMAIL_1] and my address [ADDRESS_1]. Do not submit." Both fields got exactly the seeded values, each ✓ verified, then `done`. Vault 4 → 0. The server only ever received the placeholder form of the task. |
| G dashboard (every run) | PASS | Live over SSE. All stages lit, including Confirmation in C, and the timelines matched the panel logs. The payload view shows the sanitized payload. **0/9** seeded values in the dashboard text and HTML on every run. The dashboard only issues GETs. |

**Privacy:**
- `make leaks` found **0/9** over 24 planner payloads and 36 telemetry events.
- The server console output and the raw telemetry JSON also had 0 hits, and there were no key-like strings.
- This is evidence for these runs and seeds, not a proof of zero leakage.

**Notes:**
- **Denied Save re-proposed:**
  - Denials reach the planner as `user_denied` history, and the prompt tells it to choose differently.
  - `gpt-oss-20b` still re-proposed Save 3 more times. It also filled the primary Email field unprompted ("filling it
    will allow form submission").
  - Local policy held every time. This is planner behaviour, not a local defect, and is recorded as a limitation.
- **Panel close with an action in flight:**
  - In the first E attempt, which had no timestamps, the step-2 `type [ADDRESS_1]` also landed. The relay shows
    `ACTION_VALIDATED` before `TASK_COMPLETED panel_closed`.
  - `content()` checks the stop flag synchronously right before `chrome.tabs.sendMessage`. So an action already
    dispatched to the page can complete, but no new one is dispatched after close or Stop.
  - This is by design ("executes are never re-sent" and cannot be recalled) and is recorded as a limitation.

## M8 dashboard completion (2026-09-28)

**Goal:** turn the dashboard into a proof surface. A viewer should be able to see what the user asked, what VEIL saw
and sanitized, what stayed local, what left the browser, what the LLM proposed, what local safety allowed or
blocked, what ran in the page and whether it was verified. All of it must come from real telemetry.

**Telemetry audit.** Coverage before → after M8:

| Pipeline moment | Before M8 | Added in M8 |
|---|---|---|
| Task start | `TASK_STARTED` (sanitized task, origin) | `planner` {provider, model, effort} from `/health` (identifier-like strings only), `limits` |
| Snapshot / IR / PII / sanitize / vault | `DOM_SNAPSHOT_CREATED`, `IR_CREATED`, `PII_DETECTED`, `SANITIZATION_COMPLETE`, `VAULT_UPDATED` | `IR_CREATED.interactive[]` gains `tag`, `input_type`, structural `flags`. Still no values and no fingerprints. |
| Egress gate | `EGRESS_CHECK_*` (plan only) | `rules_checked` (the gate runs every rule on every message) |
| Outbound request | `REQUEST_SENT` {bytes, payload}, emitted when the response arrives | `request_id` (session-step), `http_status`, `response_ms` |
| Planner decision | `LLM_ACTION_RECEIVED` | `schema: 'valid'` (the event is emitted only after local zod V1) |
| Local validation | `ACTION_VALIDATED` {action, confirm} | `checks` (rules the validator actually evaluated; new `checked` on the allow verdict), `live_checks` (V2/V3), `taint` {placeholder, its category, field category} |
| Confirmation | `CONFIRMATION_REQUESTED/RESOLVED` | `result: 'proceed' \| 'blocked_not_executed'` |
| `ask_user` answer | only `PII_DETECTED user_answer` counts | **new** `USER_ANSWERED` {sanitized answer, placeholders}: the same text the planner gets in history |
| Placeholder resolution | none | **new** `PLACEHOLDER_RESOLVED` {placeholder, category, target}: id and category only |
| Execution / verification / outcome | `ACTION_EXECUTED`, `VERIFICATION_COMPLETE`, `TASK_COMPLETED` | none |
| Errors | `ERROR` {code} | sanitized `reason` (e.g. planner 429 detail) |

- Every addition goes through `Telemetry.emit` → the single egress client → gate G0–G7. There is no new network path
  and no new dependency.
- The server's `/health` also reports `effort`.
- **Not observable, so not shown as passed:**
  - server-side provider retries and repair;
  - the leak check (offline; labelled "not observed");
  - T1 hand-off completion.

**Dashboard (`dashboard/`):**
- `registry.js`: stages, labels, summaries.
- `model.js`: a pure reducer.
  - Statuses come only from events.
  - Stages cut short by Stop or close become INTERRUPTED.
  - Unreached stages are SKIPPED with a reason.
  - Unknown future events are OBSERVED, never passed.
- `app.js`: rendering with `textContent` only, using only GET `/telemetry/state` + SSE. Renders on a timer, so a
  background tab stays current.
- The views:
  - header;
  - pipeline;
  - privacy proof (observed vs by design, plus the dashboard's own re-check of each payload for forbidden keys and
    HTML);
  - AI decision vs local safety authority;
  - execution and verification;
  - sanitization flow and placeholder table;
  - agent loop (per step);
  - outbound payload (exact JSON per step);
  - DOM → IR inspector;
  - grouped timeline with expandable details.
- It is laid out for 1440×900 recordings, with dark and light themes. At 390 px width there is no horizontal page
  scroll.
- `scripts/e2e_cdp.mjs --dashboard` was updated to read the new DOM.

**Tests:**
- vitest 56/56: 3 new tests.
  - The validator reports the rules it evaluated.
  - The M8 event shapes pass the telemetry gate.
  - A leaky resolution or answer event is stopped by the gate.
- pytest 54/54: the `/health` tests now assert `effort`.
- New `make test-dashboard` (node:test, 8/8), included in `make test`. It covers:
  - the success path;
  - a denied Save;
  - Stop while planning (INTERRUPTED);
  - panel close;
  - an egress block;
  - planner and schema failure;
  - no fabricated progress;
  - unknown events;
  - the payload re-check.

**Live validation.** Visible Chrome 154 with the real side panel and the real Groq `openai/gpt-oss-20b` (effort
`medium`). The dashboard was open in its own 1440×900 window.

| Run | Observed on the dashboard |
|---|---|
| Representative task, values in the text (`task:email`, `task:address` seeds) | Header: DONE · 3/15 · planner groq · openai/gpt-oss-20b · effort medium. Task shown as `Fill my email [EMAIL_1] and my address [ADDRESS_1]. Do not submit.` Steps 1–2: snapshot → IR → sanitize → vault → egress → planner → validation → **resolve locally** → execute → verify, all from events. Step 3: `done`, with resolve/execute/verify SKIPPED ("no browser action in this step"). Privacy: 3 passed, 0 forbidden keys, 0 HTML strings, vault held up to 4 and was cleared. 38 timeline rows matched the panel log. |
| Save + Deny ("…and save the changes.") | At the prompt: RUNNING, stage Confirmation. Validation `! NEEDS USER`, Confirmation `● RUNNING`. The local authority side listed checks V1 V2 V4 R1 + V2/V3 live and "CONFIRMATION REQUIRED · R1_SUBMIT_LIKE". After Deny, step 2 read "blocked (user denied)" with `⛔ Confirmation`, and nothing after it was claimed. The planner then asked the user, the question was declined, and the run ended STOPPED with Ask user INTERRUPTED. Save was never clicked. |
| `ask_user` flow ("Fill my email and address.") | `USER_ANSWERED`: "answer sanitized to: [ADDRESS_1]". Then `PLACEHOLDER_RESOLVED [ADDRESS_1] (ADDRESS)` → verified → DONE. |
| Stop while planning | LLM planner INTERRUPTED, Execute "not reached", Outcome STOPPED, vault cleared. The page was unchanged for 20 s. |
| Headless `scripts/e2e_cdp.mjs --dashboard` (single step) | Overall DONE, 0/9 canaries. This found and fixed the rendering stall in background tabs (see below). |

- **0/9** seeded values in the dashboard's text and HTML on every run.
- `make leaks` found **0/9** over 36 payloads and the latest session's telemetry.
- The server console, raw telemetry JSON and dashboard source had 0 hits, and there were no key-like strings.

**Defects found and fixed during M8 (dashboard only):**
1. Rendering used `requestAnimationFrame`, which never fires in a hidden tab, so a background dashboard showed stale
   state. It now uses a coalescing timer.
2. After a task ended while a step was waiting for the user, the decision card still said "waiting for the user".
   It now shows how the task ended. This was fixed after the Save/Deny run; its logic is covered by the reducer's
   outcome handling, but no live re-run exercised that exact card.
3. The sanitization table overflowed at phone width; it is now wrapped in a scroll container.

## Hardening pass 2026-09-28

**Goal:** finish v0.1 before the M8 checkpoint commit:
- reproduce the address bugs found in manual testing;
- audit the whole pipeline adversarially;
- fix root causes with regression tests;
- re-validate live.

No new feature phase was started.

**Defects found and fixed** (root cause → fix → regression test):

| # | Symptom | Root cause | Fix | Regression test |
|---|---|---|---|---|
| 1 | A natural-language address in task text reached the planner raw; the planner proposed typing it literally | Address cues were only "my address (is)", "address:" and "address is"; no shape detection without a PIN | One token-boundary engine in `privacy/detectors.ts`: forward cues ("address X", "address with/as/to X", "the address field with X"), suffix cues ("X as my address", "X in/into the address field"), house-number/street shapes, and the PIN path; weak cues count in user-typed text (`DetectOptions.userText`) | `privacy.test.ts` "coverage and boundaries" (31 phrasings), `agent.test.ts` T4 smuggling |
| 2 | A detected address swallowed following words (`and email is <email>`, `and do not submit`, `into the address box`, `, phone: …`); in one case the vault held "and do not submit" and the address leaked | The value ran to a sentence end or to a short clause-starter list, and overlapping detections were merged into the address | The address stops at instruction/label/status words, other PII, placeholders, sentence ends, and connectors that start a new clause (determiner/stop word within 2 words, or no address evidence up to the next boundary); em dashes and smart quotes are trimmed | Same table, plus page-text false positives (15 cases) |
| 3 | A cue-less, PIN-less `ask_user` answer ("Shivajinagar, Pune") was not masked | The sanitizer had no context for answers | `expectedAnswerCategory(question)` → `SanitizeContext.expect`: an answer no detector flags is masked whole as ADDRESS or PERSON if it has the shape; yes/no questions and control answers are excluded | `privacy.test.ts` "ask_user answers", `agent.test.ts` ask_user |
| 4 | The content of custom ARIA widgets (`role=textbox/searchbox/spinbutton/combobox`) entered the IR as name/text; the IR audit found 3/13 values in the raw IR **and** in the sanitized payload | `isValueBearing` knew only native fields and contenteditable; `labelText` followed `aria-labelledby` into value widgets | `content/dom.ts` `VALUE_ROLES`; `snapshot.ts` uses `isValueBearing`; `has_value` for ARIA widgets is a boolean | `e2e_cdp.mjs --ir-audit` (live, real Chrome): 0/13 after the fix |
| 5 | Invalid/empty planner responses never triggered the 2-failures → `ask_user` hand-over | `continue` skipped the failure check | Loop restructured in `agent.ts` | `agent.test.ts` "two malformed planner responses" |
| 6 | An invalid planner response produced two `ACTION_REJECTED` events, one with a fabricated `WAIT` action | `plan()` emitted, then `recordFailure` emitted again with its history sentinel | `recordFailure(null, …)`: one event, with no action; the `wait 0` sentinel only goes into planner history | same test |
| 7 | Stop during a `wait` action still emitted `ACTION_EXECUTED` | No stop check after the sleep | `check()` after the sleep | `agent.test.ts` "Stop during a WAIT" |
| 8 | An action whose result arrived after Stop was never reported, although the page changed | `content()` threw `Stopped` after the response | Execute results are returned; `ACTION_EXECUTED` carries `after_stop: true`; no verification and no next step | `agent.test.ts` "Stop while an execute is in flight"; live test 11b |
| 9 | Dashboard: on a DONE/ASK_USER step, Resolve/Execute/Verify showed SKIPPED, which reads as "never happened" | Cards are per current step and nothing showed task-wide scope | New "N/A this step" status with a pointer to the most recent browser action; per-card task-wide record; "Whole task so far" strip; Execution card labelled with its step; DONE labelled as the planner's declaration, accepted locally | `model.test.mjs` success path, "current step ASK_USER …" |
| 10 | Dashboard: events were applied in arrival order; an in-flight execute at panel close showed "not reached"; the Execution card said "waiting…" after the task ended; SSE opened after the state load (gap) | Arrival-order reducer; no in-flight notion; non-terminal wording | Reducer orders by `ts` and rebuilds on late events; `inFlight()`; terminal wording; subscribe-then-load; ms timeline; delivery-delay indicator | `model.test.mjs` ordering, in-flight, confirmation-pending, after-Stop, missing-events tests |
| 11 | A transient Groq HTTP 400 ended a live task ("LLM provider error (HTTP 400)"); the same payload replayed 3/3 OK | All 400s were non-retryable, and Groq returns 400 `json_validate_failed` when a generation misses the strict schema | Retry that code within the existing budget; log the error-code identifier only | `test_groq_provider.py` (3 tests). Unit-tested only: the running backend was not restarted |
| 12 | Queued telemetry from the new agent tests reached the live relay after `fetch` was un-stubbed (synthetic metadata only) | Test teardown restored the real `fetch` | Tests keep a closed-network `fetch` | Re-run: relay unchanged across `vitest` |

**Execution order (observation #4): runtime correct; the dashboard made it look wrong.**
- Code: in `handle()`, the path is `LLM_ACTION_RECEIVED` (after zod V1) → static V2/V4/T1–T4/R1 → live inspect V2/V3
  → `ACTION_VALIDATED` → confirmation (awaited) → `PLACEHOLDER_RESOLVED` → `content(execute)`. The stop flag is
  checked synchronously right before dispatch, then comes `ACTION_EXECUTED` → `VERIFICATION_COMPLETE`. There is no
  other path to `execute`.
- Live evidence: the harness recorded the page's own `input` timestamps. In every browser-changing step the page
  changed 2–12 ms after `LLM_ACTION_RECEIVED`, and after `ACTION_VALIDATED` and `PLACEHOLDER_RESOLVED`. There were
  **0 violations** over all runs.
- Why it looked inverted: delivery to a dashboard took 1–31 ms, but all of a step's events arrive within ~320 ms
  (settle) and are painted together, and a background dashboard tab repaints about once a second. The dashboard now
  shows milliseconds, the true order, and the delivery delay.

**Live matrix** (real Groq `openai/gpt-oss-20b`, effort `medium`; synthetic seeds only; headless unless noted):

| Test | Result | Observed |
|---|---|---|
| 1 single non-sensitive action (scroll to Save, don't click) | PASS | 3 scrolls verified, then DONE, and Save was not clicked. The first attempt hit the transient Groq 400 (defect 11). |
| 2/3/4/6 sensitive types, email + address with PIN | PASS | `Fill my email [EMAIL_1] and my address [ADDRESS_1]. Do not submit.` Both were typed and verified, then DONE. 0/9 canaries on the dashboard. Screenshots taken at 1440/1024/390 px, with no page-wide overflow. |
| 5/7 address **without** PIN followed by another instruction (**visible Chrome, real side panel**) | PASS | `Fill my address with [ADDRESS_1] and my alternate email with [EMAIL_1], then stop. Do not submit.` The exact address was typed and verified. |
| 8 `ask_user`, PIN-less answer | PASS | "answer sanitized to: [ADDRESS_1]". The full answer was typed and verified, then DONE. |
| 9/10 Save → R1 confirmation → Deny | PASS | 4 Save proposals, 4 confirmations, all denied, and `saved: false` with no page click. The run ended on a Groq 429 (known limit), shown as a planner failure. |
| 11 Stop while planning | PASS | LLM planner INTERRUPTED, execute "not reached", STOPPED, and no page change. |
| 11b Stop **during an execute** | PASS | The in-flight type finished; `ACTION_EXECUTED after_stop` was reported, not verified, and nothing followed (Address empty). Vault 0. |
| 12 panel close (**real side panel**, `chrome.sidePanel.close()`, visible Chrome) | PASS | Closed during step 2 planning: `TASK_COMPLETED panel_closed`, vault cleared, 0 page inputs after the close. The planner showed INTERRUPTED; step 1 stayed in the task-wide record. |
| 13 verification failure (`--reject-input address`) | PASS | Execute ✓ / Verify ✗ shown separately, twice. Then the 2-failures hand-over to the user (declined) → STOPPED. |
| 14 malformed planner response | unit only | Groq strict mode plus server validation do not produce one live. Covered by `agent.test.ts` and the server tests. |
| 15 stale target (`--stale-once`) | PASS | `V3_FINGERPRINT` rejected it before dispatch; the re-snapshot and re-plan succeeded. |
| 16 prompt injection + placeholder look-alikes in page text | PASS | Sent as `(EMAIL_1)`, `(PHONE_1)`, `(ADDRESS_1)`. The injected "click Save" was ignored and Save was not clicked. |
| adversarial prose (5 categories, lowercase, `+91`, PIN-less address) | PASS | `my name is [PERSON_1], my pan is [PAN_1] and my phone is [PHONE_1]. fill my address with [ADDRESS_1] and the alternate email with [EMAIL_1]. do not submit.` Both requested fields were filled and verified. |
| IR audit (`--ir-audit`, 13 prefilled/custom-widget/hidden/attribute/URL values) | PASS after fix | Before the fix: 3/13 in the raw IR and in the sanitized view. After: 0/13. |
| dashboard, every run | PASS | 0 raw canaries in the dashboard text and HTML (9, later 18), and 0 causal-order violations. |

**Privacy:** `make leaks` found **0/19** over 91 planner payloads (including all earlier ones) and the latest session's
telemetry. Also checked:
- no key-like strings outside `server/.env` (gitignored, untracked);
- the extension has exactly one `fetch` module (the egress client);
- the dashboard only uses GET and SSE;
- no `eval` / `new Function` in `extension/dist`.

**Dashboard recording check (judge view, 1440×900):**
- Success run: the task, the sanitized task, the placeholders, what stayed local, the exact payload, the AI
  proposal, the local checks, the resolution, execution, settle and verification of the most recent browser action,
  and the reason for DONE are all readable.
- Blocked Save: CLICK "Save changes" → R1 CONFIRMATION REQUIRED → DENIED → "ACTION BLOCKED · user denied, not
  executed", plus "4 denied by you" in the task strip.

## Dashboard redesign 2026-09-29

**Goal:** make the read-only dashboard read as a deliberate privacy/security observability console that explains
VEIL by itself (what was asked → seen → sanitized → kept local → proposed remotely → decided locally → done in the
page → verified), without changing any telemetry semantics. Presentation only: `dashboard/index.html`,
`dashboard/style.css`, `dashboard/app.js`, and presentation data in `dashboard/registry.js` (`PHASES`, `short`
labels). `model.js`, its tests, the extension, the server and the telemetry contract are unchanged.

**Method:** browser-first. The real dashboard was inspected and screenshotted in Chrome through the Chrome DevTools MCP
before any change, then after each pass (5 passes: hierarchy/layout, typography/surfaces/status, responsive, states,
wording). The design direction came from the frontend-design skill.

**What changed (see `README.md` → "Visualization Dashboard" for the full layout):**
- Story order: task + outcome → pipeline (current step) with the whole task → privacy boundary → "The AI proposes.
  VEIL decides." → "What the browser actually did" → collapsible evidence (payload, IR, timeline).
- Pipeline on two lanes split by the device boundary; only the planner is in the hatched remote lane. The stage
  happening now is outlined. N/A, skipped or pending stages say what happened there earlier in the task.
- Agent loop as a step × stage matrix under "Whole task so far".
- Privacy boundary: "On this device" (sanitization, redaction bars for real values) vs "Sent to the planner" (privacy
  proof), with the egress gate between them.
- Decision chain (remote proposal → local authority → user → result) and execution chain (action → resolved locally →
  execution → settle → verification).
- Visual system: one accent (placeholder tokens), a separate semantic hue per state, uppercase only for status words,
  system fonts, dark and light themes, reduced motion respected.

**Wording/presentation fixes found during the review (dashboard only):**
1. The outcome card tag said PASSED for a planner-declared DONE; it now names the outcome ("DONE · DECLARED",
   "STOPPED", "PANEL CLOSED", "FAILED", …). The reducer status is unchanged.
2. The user column said "not required" between `ACTION_VALIDATED` (confirmation required) and
   `CONFIRMATION_REQUESTED`; it now says "confirmation required" from the validation event.
3. "N requests, X bytes in total" mixed gate-approved bytes (including a request whose response never arrived) with
   the count of observed requests. Bytes now come from the observed requests, and a gate pass without an observed
   response is stated as such.
4. The `⛔` emoji ignored the colour system; the blocked glyph is now `⊘`.
5. `favicon.ico` 404 in the console; the page now declares an inline empty icon (no request).
6. Two bugs in the new rendering code, fixed before completion: a literal "null" under the verdict while running, and
   the "now" outline on the wrong stage after a denial.

**Browser inspection (Chrome DevTools MCP):**
- Viewports 1440×900, 1024×768, 390×844 (mobile emulation), dark and light: no page-wide horizontal overflow
  (`scrollWidth` = viewport width at each), wide tables and JSON scroll inside their own containers.
- Console: no messages after the favicon fix. Network: only the static files, `GET /telemetry/state` and SSE
  `GET /telemetry/stream`. The page has no form controls; its only buttons are the local payload step tabs.
- SSE: the live tab, not reloaded, switched to each new real session and repainted (delivery delay ~25 ms).
- Privacy: 0/18 seeded values (the harness canary list) in the rendered text and HTML with every panel and timeline
  row expanded; `scripts/e2e_cdp.mjs --dashboard` reported 0/18 on every run and still reads the new DOM (ids and
  `.facts div` kept).

**States checked, and how:**

| State | Evidence |
|---|---|
| FAILED (planner rate limit) after 2 typed + verified steps | live run, real Groq |
| STOPPED while planning (planner INTERRUPTED) | live run, real Groq |
| PANEL CLOSED after 1 verified action (next request in flight → INTERRUPTED) | live run, real Groq; 0 page inputs after the close |
| ASK_USER → answer sanitized to `[ADDRESS_1]` | live run, real Groq (the next step was rate-limited → FAILED) |
| RUNNING mid-step | prefix of a recorded live session |
| DONE with N/A resolve/execute/verify, confirmation pending, Save denied | the reducer's unit-test fixtures (`model.test.mjs` shapes) replayed in a scratch copy of the dashboard; **not live** |
| Technical evidence expanded/collapsed, payload step tabs | recorded live session |

- **Why some states are fixture-only:** Groq's free tier rate-limited every live run after its first planner call
  during this session (retry hints of 5–17 minutes), so complete DONE and Save/Deny runs could not be repeated live.
  The same states were validated live on the previous dashboard (09-28, "M8 dashboard completion"), and the reducer
  that decides them is unchanged.
- `make leaks` after the live runs: **0/19** over 121 payloads and the latest session's telemetry.

## Release-candidate validation 2026-09-29

**Goal:** validate the accumulated M8, hardening and dashboard-redesign work before committing it. Validation only:
no feature, agent, extension, server, reducer or telemetry change.

| Check | Result |
|---|---|
| `make test` | `tsc` clean, vitest **116/116**, pytest **57/57** (1 Starlette deprecation warning), dashboard node:test **14/14** |
| `git diff --check` | one trailing-whitespace line in `dashboard/style.css` (a blank line); removed, then clean |
| Diff review | intended M8/hardening/redesign files only; no secrets, credentials, logs, screenshots or scratch files; no dependency change; `server/.env` and `server/logs/` ignored and untracked; `console.log` only in the dev harness |
| Live smoke (headless, real Groq `openai/gpt-oss-20b`, effort `medium`) | **PASS.** Task with the `task:email` / `task:address` seeds in the text, sent as `Fill my email [EMAIL_1] and my address [ADDRESS_1]. Do not submit.` 3 planner calls: `type e10 [EMAIL_1]` ✓ verified → `type e13 [ADDRESS_1]` ✓ verified → `done`. Save not clicked, vault cleared, 0 causal-order violations. No rate limit. |
| Dashboard, live DONE (harness) | DONE · DECLARED; Resolve/Execute/Verify "N/A this step" with task-wide history "✓ steps 1, 2"; execution card labelled step 2; 0/18 canaries in text and HTML |
| Dashboard in Chrome (DevTools MCP) | Loaded; every panel expanded: 0/20 seeded values in text and HTML, no key-like strings, no page overflow at the default viewport; no forms or inputs (the only buttons are the payload step tabs); console empty; network only static files, `GET /telemetry/state` and SSE `GET /telemetry/stream` |
| SSE without reload | A second, one-call run (Stop while planning) replaced the session in the open tab without a reload: STOPPED, planner INTERRUPTED, execute "not reached" |
| `make leaks` | **0/19** over 128 planner payloads and the latest session's telemetry; server console 0 seeded values, 0 key-like strings |

- The first complete live DONE on the redesigned dashboard; Save/Deny on the redesigned dashboard is still
  fixture-only (open item 11).

## Task 2: Gemini provider (2026-09-29)

**Goal:** add Gemini as the planner provider behind the existing `PlannerProvider` seam, without changing the
architecture, the privacy pipeline, the canonical schemas, action semantics or browser behaviour; keep Groq as the
rollback; make Gemini the default only after live parity.

**Status: implemented, unit/parity/leak-tested; LIVE VALIDATION BLOCKED** (provider capacity, then the free-tier daily
quota). Groq remains the default. Uncommitted.

**Research (official docs, 2026-09-29):**
- SDK: `google-genai` (the legacy `google-generativeai` is not used). Latest 2.25.0 (released 2026-09-22), Python
  ≥ 3.10, httpx-based. It reads `GEMINI_API_KEY` or `GOOGLE_API_KEY` from the environment (`GOOGLE_API_KEY` wins),
  so Veil passes the key explicitly.
- Model: `gemini-3.8-flash` is listed as a **stable** model id.
- Structured output: a JSON Schema subset (`type` incl. type arrays, `properties`, `required`,
  `additionalProperties`, `items`, `enum`, `anyOf`, …). The docs now lead with the **Interactions API**, which is GA
  and "recommended for all new projects", but **stores requests server-side by default** (1 day free tier, 55 days
  paid) unless `store=false`. `generateContent` is "legacy" but "fully supported" and stateless. Veil uses
  `generateContent`: its planner is stateless per step, and no stored-state flag has to stay correct for privacy.
- Thinking: `thinking_level` (`low`/`medium`/`high`, default medium) for Gemini 3.x Flash.
- SDK behaviour checked in its source: without `retry_options` it makes 1 attempt; its only content-bearing logs are
  DEBUG chunk dumps on the streaming path (not used); `APIError` text embeds the response body.

**Implementation (server only):**
- `app/providers.py`: `GeminiProvider` (`name = "gemini"`), same `complete_json(system, turns, schema) -> str`
  contract as `GroqProvider`. The system prompt goes in `system_instruction`, turns map `assistant` → `model`, the
  canonical `RESPONSE_SCHEMA` goes unchanged as `response_json_schema`, `VEIL_EFFORT` → `thinking_level`, 1
  candidate, 4096 output tokens, SDK retries off (`attempts=1`), automatic function calling off, per-attempt timeout
  via `http_options`. Only non-thought text parts are returned; a blocked prompt, a non-`STOP` finish (safety,
  recitation, unknown), `MAX_TOKENS`, no candidate or no text is a `ProviderError`. Nothing SDK-typed leaves the
  provider.
- Error mapping (Gemini's model, not Groq's): 401/403 or 400 with ErrorInfo `API_KEY_INVALID` → key error; 429 →
  `retry-after` header or RetryInfo `retryDelay`, waited only within the budget, and a **per-day** QuotaFailure fails
  at once; 408/5xx → retried; 404 → "check VEIL_MODEL"; other 4xx → not retried. Messages are fixed strings plus the
  status code; only the numeric code and identifier-shaped status/reason are logged; the SDK error is suppressed
  (`raise … from None`).
- Same budget as Groq (20 s / 25 s / 3 attempts, `2 × 25 s < 60 s`), with one Gemini-specific rule: no attempt, or
  wait before one, when under 10 s of the budget is left.
- `app/config.py`: `VEIL_PROVIDER` (`groq` default | `gemini`), `GEMINI_API_KEY`, `VEIL_MODEL` optional with a default
  per provider; each provider uses only its own key. `app/main.py`: `build_provider()`; an unknown provider refuses
  to start; the 503 names the missing key variable. `/health` is unchanged in shape and reports `provider: gemini`.
- `requirements.txt`: `google-genai>=2.25,<3` (installed 2.25.0; it added only its own transitive packages, and no
  existing package changed). `.env.example`: the new variables.
- Unchanged: `prompt.py`, `schemas.py`, `planner.py`, the extension (the `/health` planner metadata already passes
  any identifier-like provider/model), the dashboard, telemetry.

**Tests (pytest 57 → 133, no network):**
- `tests/test_gemini_provider.py` (49): configuration (missing/empty key, invalid effort, unknown provider, per-provider
  key and default model, ambient `GOOGLE_API_KEY` ignored), request shape, repair turn role, type/DONE/ASK_USER
  responses, thought parts, split text, malformed and schema-invalid output (repair, never coerced), unusable
  responses, auth/400/404 errors, 429 via header/RetryInfo/daily quota/no hint, transient 5xx, bounded retries,
  timeouts, the 10 s minimum deadline, the worst-case budget, and a 502 with no action.
- `tests/test_provider_parity.py` (27): for all 8 canonical action shapes the same sanitized payload gives the same
  `PlanResponse` through both real providers; both send exactly the same system and user text (including the repair
  turn); the same failure class gives the same error; the `scripts/check_leaks.py` seeds planted in 12 kinds of
  Gemini failure never reach the exception, the 502 detail or any log record (DEBUG included), and neither does the
  API key; a payload with a raw value field is refused (422) before any provider is called. A mutation check (echoing
  the error body) turned the leak test red.

**Live attempts (visible behaviour recorded as observed; seeded synthetic values only):**

| When | What | Result |
|---|---|---|
| 15:2x | `/plan` with the test fixture payload | 503 UNAVAILABLE ×3 → 502 after 6.8 s (fail closed) |
| 15:2x | direct SDK, trivial prompt, plain and with the canonical schema | 503 "This model is currently experiencing high demand" for both → provider capacity, not schema |
| 15:32 | trivial prompt | OK in 16.2 s |
| 15:3x | `/plan` again | 503 ×3 → 502 after 8.6 s |
| 15:3x | trivial prompt ×2, plain and with schema | 504 ×2 (~24 s); 503; **schema call OK in 16.5 s with a valid canonical `done` plan**: Gemini accepts the canonical schema unchanged |
| 15:40 | E2E task (email + address seeds in the text) | step 1: 503, 503, then **HTTP 400**, task FAILED at the planner, nothing executed |
| 15:4x | diagnosis | 400 = "Manually set deadline 5s is too short. Minimum allowed deadline is 10s." (3/5/9 s all rejected) → **code issue**: late attempts carried the leftover budget. Fixed (no attempt under 10 s), test added |
| 15:42 | E2E task again, fixed provider | 503, 503, timeout → FAILED at the planner after 25.0 s (the real error, no longer masked) |
| 15:45–15:48 | availability polling | 504, 504, then **429 RESOURCE_EXHAUSTED: `GenerateRequestsPerDayPerProjectPerModel-FreeTier`, limit 20** (with a misleading `retryDelay` of 57 s) → per-day quota now fails at once, test added |

- Every failed run failed closed: no action proposed, nothing executed, vault cleared, the dashboard showed
  `gemini · gemini-3.8-flash · effort medium`, FAILED at the LLM planner and later stages "not reached"; 0/18
  canaries on the dashboard; 0 causal-order violations.
- `make leaks` afterwards: **0/19** over 140 planner payloads (including those sent to Gemini) and the latest (Gemini)
  session's telemetry. Server logs: 0 seeded values, 0 key-like strings, 0 automatic-function-calling warnings.

**Latency (measured, not a quality judgement):**
- Gemini `gemini-3.8-flash`: no planner step completed. Successful trivial calls: 16.2 s and 16.5 s. Failures:
  503 after 1–3 s, 504 after ~20–24 s.
- Groq baseline, same demo task, same day (release-candidate smoke): 3 planner calls of 1057 / 807 / 920 ms, 3.4 s
  task, 1 attempt each.

**To finish Task 2 (when quota and capacity allow):**
1. `VEIL_PROVIDER=gemini VEIL_MODEL=gemini-3.8-flash make dev` (or set them in `server/.env`), then
   `curl -s localhost:8000/health` → `"provider":"gemini"`.
2. Run, with the dashboard open: the seeded email + address task (type ×2, placeholder resolution, verification,
   DONE); "Fill my email and address. Do not submit." with `--answer` = the `task:address` seed (ASK_USER,
   continuation); a scroll task ("Scroll down to the Save button, do not click it."); Save + `--confirm deny`
   (submit protection). The demo page has no `<select>`; SELECT and WAIT are covered by the parity tests only.
3. `make leaks`; record per-step planner latency, attempts and total duration.
4. Only if these pass: change `DEFAULT_PROVIDER` to `gemini` (and the docs). Budget: about 15 requests for this
   matrix, within the 20/day free tier, if no retries are needed.

## Test results (latest: 2026-09-29)

| Suite | Result |
|---|---|
| `tsc --noEmit` (extension) | ✅ clean |
| vitest: normalizer, detectors (incl. cue-less address extent), Luhn/Verhoeff/PAN, placeholder reuse, vault views, every gate rule incl. tripwire and retry-then-block, validator V1–V4/T1–T4/R1 (incl. evaluated-rule lists), submit-like, field categories, M8 telemetry shapes vs the gate | ✅ 56/56 (53 before M8) |
| pytest: payload validation, response validation + repair (test-only stub), provider errors → 502, no provider → 503, telemetry relay, CORS; GroqProvider request shape, strict-schema rules + scroll merge/restore, error mapping, 429/5xx/timeout retries within budget (MockTransport, no network) | ✅ 54/54 |
| dashboard reducer (node:test): success, denied Save, Stop → INTERRUPTED, panel close, egress block, planner/schema failure, no fabricated progress, unknown events, payload re-check | ✅ 8/8 |
| `scripts/check_leaks.py --telemetry` (real Groq runs, post-fix) | ✅ 0/9 |

**After Task 2, Gemini provider (2026-09-29):** `make test`: `tsc` clean, vitest **116/116**, pytest **133/133**
(1 deprecation warning), dashboard node:test **14/14**. `make leaks` **0/19** over 140 payloads.

**Release-candidate validation (2026-09-29):** `make test`: `tsc` clean, vitest **116/116**, pytest **57/57**
(1 deprecation warning), dashboard node:test **14/14**. `make leaks` **0/19** over 128 payloads.

**After the dashboard redesign (2026-09-29):** `make test`: `tsc` clean, vitest **116/116**, pytest **57/57**
(1 deprecation warning), dashboard node:test **14/14** (reducer unchanged). `make leaks` **0/19** over 121 payloads.

**After the hardening pass (2026-09-28):** `make test`: `tsc` clean, vitest **116/116** (4 files, including the
new `agent.test.ts`), pytest **57/57**, dashboard node:test **14/14**. `make leaks` **0/19** over 91 payloads.

**After M8 (2026-09-28):** `make test`: `tsc` clean, vitest 56/56, pytest 54/54, dashboard node:test 8/8. `make leaks` 0/9 over 36 payloads.

**Re-run 2026-09-28**, before and after the live validation (`make test`; no application code changed):
- `tsc` clean, vitest 53/53, pytest 54/54.
- One harmless Starlette deprecation warning (`httpx` with `TestClient`).
- `make leaks` after the live runs: 0/9, over 24 payloads and 36 telemetry events.

## Decisions

| Date | Decision | Why |
|---|---|---|
| 09-23 | Anthropic, `claude-sonnet-5`, effort `medium` | Initial user choice; replaced 09-25 (never run live). |
| 09-28 | M8: the dashboard is a proof surface. Statuses come only from events; unproven items are pending/skipped/interrupted/not observed | Judges must be able to trust every green mark. Instrumentation only through the existing gate/client, no new dependencies. |
| 09-28 | Phase 1 frozen with documented manual limitations | Tests A–G passed live in a visible Chrome with the real side panel; `make leaks` 0/9; no local defect found. The runs were CDP-driven, and T1 was not exercisable. |
| 09-28 | Hardening: address detection uses one token-boundary engine; weak cues count only in user-typed text; `ask_user` answers use the question's expected category | Covers the manual-test leak without NER; page text keeps stricter evidence to avoid over-masking |
| 09-28 | Hardening: an action already dispatched at Stop reports its real result (`after_stop`) and is not verified; at panel close the dashboard shows it as "may have run" | Honest record without inventing rollback |
| 09-28 | Hardening: dashboard loop cards stay current-step; "N/A this step" plus a task-wide record per card | Fixes the misreading of a DONE step without faking green stages |
| 09-28 | Hardening: Groq `json_validate_failed` (HTTP 400) is retried within the budget | A generation glitch, not a bad request; other 400s are still not retried |
| 09-28 | Planner re-proposing a denied Save is recorded as a limitation, not fixed | Local R1 held every time; changing the prompt or policy would be a new behaviour, not a defect fix. |
| 09-25 | Groq `openai/gpt-oss-20b`, effort `medium`, strict JSON Schema, REST via `httpx` | Free tier; strict mode supported for this model (Groq docs); no new dependency. |
| 09-25 | Provider-local schema adaptation (merge same-`type` `anyOf` variants, nullable fields; strip nulls on output) | Groq 400 `discriminator_value_overlap`; keeps the canonical schema/validators unchanged. |
| 09-25 | Provider budget 20 s/attempt, 25 s/call, ≤3 attempts | Two calls (repair) must finish inside the extension's 60 s `/plan` abort. |
| 09-25 | PIN-code address detections grow to surrounding address tokens | Cue-less addresses (e.g. `ask_user` answers) leaked all but the PIN; fail closed. |
| 09-23 | Python 3.13 (anaconda) in `server/.venv` | Only interpreter on the machine; ≥3.11 required. |
| 09-23 | zod v4 with `jitless: true` | Allowed validator; avoids `new Function` under the MV3 CSP. |
| 09-23 | Content script declared for localhost + `ensureContentScript()` re-injects | Single injection seam; survives extension reloads. |
| 09-23 | Fingerprints are not sent to the backend | Only needed locally (V3). |
| 09-23 | Text blocks = text nodes grouped by nearest non-inline ancestor | Keeps "Signed in as <b>Name</b>" one string so cues fire. |
| 09-23 | Sanitizer also replaces already-vaulted values anywhere | Referential consistency; avoids tripwire over-masking. |
| 09-23 | Placeholder look-alikes in page/task text are defused (`[CARD_1]` → `(CARD_1)`) | Pages must not forge vault references. |
| 09-23 | Overlapping detections are merged into their union | Fail closed: no partially masked tails. |
| 09-23 | Unclassifiable numbers ≥ 9 digits → `[REDACTED_TEXT]` | Fail closed. |
| 09-23 | Telemetry gate failure drops the event; planner gate failure hard-blocks the task | Planner payload is the privacy-critical path. |
| 09-23 | Tripwire ignores vault forms < 4 chars / < 6 digits | Avoid matching common words. |
| 09-23 | Verification failure → re-snapshot + re-plan; 2 consecutive failures → `ask_user` | "Retry once with a fresh snapshot" without blindly repeating clicks. |
| 09-23 | Executes are never re-sent; a click that kills the message channel (navigation) counts as "changed" | Avoid double-submits. |
| 09-23 | E2E driver uses CDP over `--remote-debugging-pipe`, no npm deps | Chrome ≥137 ignores `--load-extension`. |
| 09-29 | Gemini added as a second provider behind `PlannerProvider`, selected by `VEIL_PROVIDER`; Groq stays the default until Gemini passes live validation | Controlled migration with a one-variable rollback; no architecture, schema or extension change. |
| 09-29 | Gemini via the official `google-genai` SDK and stateless `generateContent`, not the Interactions API | The Interactions API stores requests server-side by default; the planner is stateless per step. |
| 09-29 | Gemini gets the canonical response schema unchanged (no adaptation layer) | Accepted live; a provider-local adaptation would only be added if Gemini rejected it. |
| 09-29 | Gemini attempts need ≥ 10 s of budget; per-day quota 429s fail at once | Gemini rejects server deadlines under 10 s (HTTP 400); a daily quota cannot be waited out. |
| 09-29 | Dashboard redesign is presentation only: same reducer, events and transport; layout follows the story, the pipeline is split by the device boundary | A judge must understand the privacy story unaided, without any status meaning more than an event proves. |

## Open items (as of 2026-09-29)

1. **Human-hand UI entry points were not exercised.** The 2026-09-28 runs used a visible Chrome and the real side
   panel, but CDP drove them. The panel was opened with `chrome.sidePanel.open()` rather than the toolbar icon
   (`configureSidePanelOnActionClick`), and closed with `chrome.sidePanel.close()` rather than the panel's close
   button. Both are thin Chrome UI paths into the same code.
2. **The credential hand-off (T1)** has not been validated with a live planner. The current demo page has no
   password, OTP or card field, so it cannot be exercised there without a fixture change. It is unit-tested.
3. **Groq free tier: 8K tokens/min.** A step is about 2.5K tokens, so longer tasks hit 429.
   - The provider waits out `retry-after` only within its 25 s budget. Steps that waited 19–23 s succeeded on 09-25
     and 09-28.
   - Otherwise the task stops with "Planner error: … rate limit reached".
4. **Planner quality (gpt-oss-20b):**
   - It words `ask_user` awkwardly ("provide a placeholder ID for your address field"); this works, because answers
     are sanitized locally.
   - It re-proposes a denied Save several times and may take unrequested but allowed actions, such as filling the
     primary Email in test C.
   - Local validation and R1 held in every case.
5. **Address detection is heuristic.** Addresses are found via cues (forward and suffix), house-number/street shapes,
   a PIN near address words, or as the answer to an address question, each grown to the surrounding tokens. **Page
   text** with none of these ("Shivajinagar Pune" alone) is not detected. In task text a weak cue suffices. Rare
   phrasings can still split a span, for example a lowercase locality after a connector ("12 mg road and
   shivajinagar pune").
6. **Stop and panel close don't recall an action that is already dispatched.** The loop checks the stop flag before
   every content-script message. An `execute` already sent to the page completes; nothing new is sent after it.
7. **Vision/OCR/need-to-see** remains intentionally deferred (ROADMAP §3).
8. **The Groq `json_validate_failed` retry is unit-tested only.** The running backend was not restarted during the
   hardening pass; the next `make dev` picks it up.
9. **The local failure hand-over question** (after 2 consecutive failures) emits no event until it is answered, so
   the dashboard shows the failed verification and RUNNING, not "waiting for you".
10. **Malformed planner responses** cannot be provoked live (Groq strict mode plus server validation); they are
    covered by unit tests.
11. **The redesigned dashboard has not seen a live Save/Deny run** (Groq free-tier limits during the redesign on
    2026-09-29). It was checked with the reducer's test fixtures; re-run test C from "Live validation 2026-09-28"
    with the dashboard open when the quota allows. A complete live DONE was seen on 2026-09-29 (see
    "Release-candidate validation 2026-09-29").

12. **Gemini live validation is BLOCKED** (Task 2). No live planner step through `GeminiProvider` has succeeded:
    `gemini-3.8-flash` answered 503/504 under high demand, then the free tier's **20 requests/day/model** quota ran
    out. The canonical schema was accepted in one live structured call. Remaining: "Task 2: Gemini provider" →
    "To finish".
13. **Gemini free-tier capacity:** 20 requests per day per model, and every attempt counts (a 3-step task uses at
    least 3); successful calls took ~16 s on 2026-09-29. This limits demos far more than Groq's free tier.

**Other known limitations, carried over from the v0.1 build and unchanged:**
- **Detection (no NER):**
  - Names are found only via cues, or once already vaulted.
  - DOB becomes `[REDACTED_TEXT]`.
  - Obfuscated emails are not detected.
  - Cue false positives are possible.
- Synthetic events have `isTrusted=false`. Sites that check it fail verification, and the step is handed to the user.
- `inspect` (the live V2/V3 check) scrolls the target into view before execution.
- Panel-close telemetry is best-effort (`keepalive` fetch).
- Dashboard:
  - latest session only (in-memory relay);
  - server-side retries and repair are not observable;
  - the leak check is offline;
  - T1 hand-off completion emits no event.
  Planner/exec `ERROR`s now light their stage.
- `sidepanel.js` is about 840 KB unminified.

## Deferred in v0.1 (by plan)

Everything in ROADMAP §6. No extra deferrals.

## Manual E2E checklist

**Setup:**
1. Start the servers with `make dev`. `server/.env` must contain `GROQ_API_KEY`; check with
   `curl -s localhost:8000/health`, which should report `planner_configured: true` and `provider: groq`.
2. Load `extension/dist` unpacked in `chrome://extensions`.
3. Open http://localhost:8080 and click the VEIL icon to open the side panel.
4. Keep the dashboard open at http://localhost:8090.
5. Use the synthetic values seeded in `scripts/check_leaks.py` (`SEEDS`), so that `make leaks` can detect them.

**Headless equivalent:** `node scripts/e2e_cdp.mjs --dashboard --task "…" [--confirm allow|deny] [--answer "…"] [--stop-after-ms N] [--close-panel-after-ms N]`.

**Checklist:**
- [x] Single action: "Fill my alternate email with my email. Do not submit." *(Headless, 09-25; value stuck on
  the controlled field.)*
- [x] Multi-step: "Fill my email and address. Do not submit.", answering the `ask_user` prompt with the `task:address`
  seed. *(Headless, 09-25, after the address fix.)*
- [x] A Save attempt ("…and save the changes.") triggers the local confirmation; Deny prevents the click.
  *(Headless, 09-25.)*
- [x] Repeat the three tasks above in the real (non-headless) side panel. *(09-28, visible Chrome 154, real side
  panel, CDP-driven. See "Live validation 2026-09-28", tests A–C. The panel showed the sanitized task and vault
  metadata only. The confirmation and `ask_user` prompts worked.)*
- [x] Stop mid-task halts the loop and clears the vault (count → 0). The dashboard shows `TASK_COMPLETED stopped`.
  *(09-28, test D.)*
- [x] Closing the side panel mid-task stops the agent. The dashboard shows `panel_closed` (best-effort, and it was
  delivered). *(09-28, test E, via `chrome.sidePanel.close()`.)*
- [x] Representative task with the values written into the task: it shows `[EMAIL_1]` / `[ADDRESS_1]`, both fields
  are filled and verified, and it ends with `done`. *(09-28, test F.)*
- [ ] T1 hand-off with a live planner. *Not possible on the current demo page (no credential/card field); unit-tested only.*
- [x] After the runs, `make leaks` → 0/9, and the dashboard shows no raw value. *(09-28: 24 payloads, 36 telemetry
  events; dashboard 0/9 on every run.)*
- [ ] Optional: a human repeats one task with the toolbar icon and the panel's own close button.
