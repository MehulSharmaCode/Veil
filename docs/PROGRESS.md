# VEIL Progress Log

## Next session: start here

**Current state (end of 2026-09-25):**
- VEIL v0.1 (DOM-only) is implemented.
- **Phase 1**, the real planner loop, has been **verified in headless Chrome** on the controlled demo site. The chain
  is: task → DOM snapshot → IR → sanitization → local vault → egress gate → real Groq planner → structured action →
  local validation → local placeholder resolution → Chrome execution → verification → next step.
- Current provider: **Groq**, model `openai/gpt-oss-20b`, reasoning effort `medium`.
- Live single-step and multi-step planner-driven runs succeeded **after** the address-detection fix. The final leak
  check passed: 0/9 known synthetic values.
- A privacy bug was found and fixed during the live runs: see "Security incident 2026-09-25 (resolved)" below.
- **Not yet done:** the short **manual, non-headless** side-panel checklist (bottom of this file).

**Uncommitted work (the user reviews and commits manually):**
- Code: `extension/src/privacy/detectors.ts`, `extension/test/privacy.test.ts`, `server/app/providers.py`,
  `server/tests/test_groq_provider.py`.
- Docs: `CLAUDE.md`, `README.md`, `docs/PROGRESS.md`, `docs/ROADMAP.md`.
- The last commit is `f4a1545 Add Groq planner provider`, which contains the first Groq provider without the
  schema adaptation. Run `git status` first.

**Plan for the next session, in order:**
1. Review these docs (`CLAUDE.md`, `README.md`, this file, `docs/ROADMAP.md`) and `git status`.
2. Do the remaining **manual non-headless Chrome validation** ("Manual E2E checklist" below). The user runs the
   real side panel; `make dev` must be running and `server/.env` must hold the key.
3. Confirm the side-panel lifecycle: Stop mid-task, and closing the panel mid-task (kill switch, vault cleared).
4. Confirm the dashboard during those manual runs: live stages, and no raw values. Run `make leaks` afterwards.
5. If those checks pass, **freeze the Phase 1 milestone**. The user commits.
6. Only after that, discuss the next phase with the user (ROADMAP §2 real-website compatibility or later sections).
7. **Do not** start OCR/vision (ROADMAP §3) or any other new feature on your own.

**Dev notes for the next session:**
- **Values in harness output:** `node scripts/e2e_cdp.mjs` prints a `[demo page state]` line with the demo form's
  raw field values to the terminal. That output is local only and never reaches logs or telemetry. Don't paste it
  into reports; summarize it as filled/empty instead.
- **Use the seeded values:** manual and harness tests must use the synthetic values seeded in
  `scripts/check_leaks.py` (`SEEDS`). Otherwise `make leaks` cannot detect them.
- **Evidence file:** `server/logs/received_payloads.pre-address-fix.jsonl` is incident evidence. Keep it local and
  gitignored. `make leaks` scans only `server/logs/received_payloads.jsonl`, so don't merge the two.
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
| M7 Full loop | ✅ demonstrated (headless) | Single-action, multi-step with `ask_user`, and Save/Deny, on the demo site. Manual side-panel checks still open (see checklist). |
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
- The pre-fix payload log is kept locally as `server/logs/received_payloads.pre-address-fix.jsonl`.
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

**Repo:** `origin` = github.com/MehulSharmaCode/Veil. The user commits and pushes; the 2026-09-25 changes are uncommitted.

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

## Test results (latest: 2026-09-25)

| Suite | Result |
|---|---|
| `tsc --noEmit` (extension) | ✅ clean |
| vitest: normalizer, detectors (incl. cue-less address extent), Luhn/Verhoeff/PAN, placeholder reuse, vault views, every gate rule incl. tripwire and retry-then-block, validator V1–V4/T1–T4/R1, submit-like, field categories | ✅ 53/53 |
| pytest: payload validation, response validation + repair (test-only stub), provider errors → 502, no provider → 503, telemetry relay, CORS; GroqProvider request shape, strict-schema rules + scroll merge/restore, error mapping, 429/5xx/timeout retries within budget (MockTransport, no network) | ✅ 54/54 |
| `scripts/check_leaks.py --telemetry` (real Groq runs, post-fix) | ✅ 0/9 |

## Decisions

| Date | Decision | Why |
|---|---|---|
| 09-23 | Anthropic, `claude-sonnet-5`, effort `medium` | Initial user choice; replaced 09-25 (never run live). |
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

## Open items (as of 2026-09-25)

1. **The manual non-headless side-panel flow has not been fully validated.** All live runs so far were headless
   (`scripts/e2e_cdp.mjs`).
2. **Stop and closing the side panel mid-task** have not been verified with a live planner.
3. **The credential hand-off (T1)** has not been validated with a live planner. The current demo page has no
   password, OTP or card field, so it cannot be exercised there without a fixture change. It is unit-tested.
4. **Groq free tier: 8K tokens/min.** A step is about 2.5K tokens, so longer tasks hit 429.
   - The provider waits out `retry-after` only within its 25 s budget. In the multi-step run the final step waited
     about 19–21 s and succeeded.
   - Otherwise the task stops with "Planner error: … rate limit reached".
5. **Awkward `ask_user` wording:** gpt-oss-20b asks the user to "provide a placeholder for the address". It works,
   because the answer is sanitized locally.
6. **Address detection is heuristic.** Addresses are found via a cue, or via a PIN near address words (grown to the
   surrounding tokens). An address with **neither a cue nor a PIN is not detected**.
7. **The exact representative task** (email and address written into the task text) was not the task used in the
   final live validation. The equivalent `ask_user` flow passed.
8. **Vision/OCR/need-to-see** remains intentionally deferred (ROADMAP §3).

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

## Manual E2E checklist (next session: non-headless)

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
- [ ] **Manual:** repeat the three tasks above in the real (non-headless) side panel.
  - Check that the panel shows the sanitized task and vault metadata (placeholders only).
  - Check that the confirmation and `ask_user` prompts work by hand.
- [ ] **Manual:** Stop mid-task halts the loop and clears the vault (count → 0).
  - The dashboard should show `TASK_COMPLETED stopped`.
- [ ] **Manual:** closing the side panel mid-task stops the agent.
  - The dashboard should show `panel_closed`; this is best-effort.
- [ ] Representative task with the values written into the task:
  `Fill my email <task:email seed> and my address <task:address seed>. Do not submit.`
  - The task should show `[EMAIL_1]` / `[ADDRESS_1]`.
  - Both fields should be filled and verified, ending with `done`.
  - *Not yet run live.*
- [ ] T1 hand-off with a live planner. *Not possible on the current demo page (no credential/card field); unit-tested only.*
- [ ] **After the manual runs:** `make leaks` → 0/9, and the dashboard shows no raw value.
  - Earlier results: 0/9 on the post-fix headless runs (09-25); the pre-fix run showed 2/9.
