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

**Git state:** Phase 1 is frozen in the commit "Freeze Veil Phase 1", which follows
`ba45fe5 Complete Veil Phase 1 and update handoff`. Run `git status` / `git log` first.

**Plan for the next session, in order:**
1. Review `docs/PROJECT_CONTEXT.md`, this file and `git status`.
2. Optional: a human repeats one task by hand, using the toolbar icon and the panel's own close button. These two UI
   entry points were not exercised by the automated runs.
3. M8 dashboard polish (ROADMAP §1, step 4).
4. Then discuss the next phase with the user (ROADMAP §2 real-website compatibility or later sections).
5. **Do not** start OCR/vision (ROADMAP §3) or any other new feature on your own.

**Dev notes for the next session:**
- **Values in harness output:** `node scripts/e2e_cdp.mjs` prints a `[demo page state]` line with the demo form's
  raw field values to the terminal. That output is local only and never reaches logs or telemetry. Don't paste it
  into reports; summarize it as filled/empty instead.
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
| M8 Dashboard polish | 🟡 mostly done | All views, registry-driven stages, generic rendering of unknown events. Polish after M7. |

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
- Detection is still heuristic. An address with neither a cue nor a PIN is not detected (open item 6).

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

## Test results (latest: 2026-09-28)

| Suite | Result |
|---|---|
| `tsc --noEmit` (extension) | ✅ clean |
| vitest: normalizer, detectors (incl. cue-less address extent), Luhn/Verhoeff/PAN, placeholder reuse, vault views, every gate rule incl. tripwire and retry-then-block, validator V1–V4/T1–T4/R1, submit-like, field categories | ✅ 53/53 |
| pytest: payload validation, response validation + repair (test-only stub), provider errors → 502, no provider → 503, telemetry relay, CORS; GroqProvider request shape, strict-schema rules + scroll merge/restore, error mapping, 429/5xx/timeout retries within budget (MockTransport, no network) | ✅ 54/54 |
| `scripts/check_leaks.py --telemetry` (real Groq runs, post-fix) | ✅ 0/9 |

**Re-run 2026-09-28**, before and after the live validation (`make test`; no application code changed):
- `tsc` clean, vitest 53/53, pytest 54/54.
- One harmless Starlette deprecation warning (`httpx` with `TestClient`).
- `make leaks` after the live runs: 0/9, over 24 payloads and 36 telemetry events.

## Decisions

| Date | Decision | Why |
|---|---|---|
| 09-23 | Anthropic, `claude-sonnet-5`, effort `medium` | Initial user choice; replaced 09-25 (never run live). |
| 09-28 | Phase 1 frozen with documented manual limitations | Tests A–G passed live in a visible Chrome with the real side panel; `make leaks` 0/9; no local defect found. The runs were CDP-driven, and T1 was not exercisable. |
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

## Open items (as of 2026-09-28)

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
5. **Address detection is heuristic.** Addresses are found via a cue, or via a PIN near address words (grown to the
   surrounding tokens). An address with **neither a cue nor a PIN is not detected**.
6. **Stop and panel close don't recall an action that is already dispatched.** The loop checks the stop flag before
   every content-script message. An `execute` already sent to the page completes; nothing new is sent after it.
7. **Vision/OCR/need-to-see** remains intentionally deferred (ROADMAP §3).

**Other known limitations, carried over from the v0.1 build and unchanged:**
- **Detection (no NER):**
  - Names are found only via cues, or once already vaulted.
  - DOB becomes `[REDACTED_TEXT]`.
  - Obfuscated emails are not detected.
  - Cue false positives are possible.
- Synthetic events have `isTrusted=false`. Sites that check it fail verification, and the step is handed to the user.
- `inspect` (the live V2/V3 check) scrolls the target into view before execution.
- Panel-close telemetry is best-effort (`keepalive` fetch).
- Dashboard: `ERROR` events don't light a stage.
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
