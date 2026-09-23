# VEIL Progress Log

## Next session: start here

**State (end of 2026-09-23):** VEIL v0.1 is fully implemented. Everything up to and including `POST /plan` has been
verified in a real (headless) Chrome. The **real LLM planner call has NOT been executed yet**. No agent-driven action
(type/click chosen by an LLM) has ever run, so M5 (live) and M7 are open.

**Exact blocker:** there is no LLM credential. `server/.env` does not exist, `ANTHROPIC_API_KEY` is not set, and
there's no `ant` CLI profile. With no key, `create_app()` builds no provider, so `/health` reports
`planner_configured: false` and `/plan` logs the payload then returns **503** ("No LLM provider configured"). The user
will not use a paid Anthropic key.

**Current planner configuration (unchanged, not yet run live):**
- Provider: `AnthropicProvider` (`server/app/providers.py`), `anthropic` Python SDK 1.8.0.
- Model: `VEIL_MODEL`, default **`claude-sonnet-5`**; effort: `VEIL_EFFORT`, default `medium`.
- Request: `messages.create(..., max_tokens=16000, output_config={"effort", "format": {"type": "json_schema", "schema": RESPONSE_SCHEMA}})`.
- Client: timeout 60 s, `max_retries=2`.
- Errors: refusal / `max_tokens` / API / network errors → `ProviderError` → HTTP 502.
- Key: `ANTHROPIC_API_KEY` read from `server/.env` (gitignored; the user adds it; never add a key yourself).

**Immediate next task:** replace the Anthropic planner provider with a suitable **free** provider (likely **Groq**).
Change only the provider layer:
1. In `server/app/providers.py`, add a provider class implementing the existing `PlannerProvider` protocol:
   `name`, `model`, `complete_json(system, turns, schema) -> str`. It must raise `ProviderError`, with a safe message
   and no payload content, on auth/rate-limit/API/network errors, refusals or truncation.
2. In `server/app/config.py`, `main.py` and `.env.example`, add provider selection and key/model settings (e.g.
   `VEIL_PROVIDER`, `GROQ_API_KEY`, `VEIL_MODEL`). `create_app()` picks the provider. Decide with the user whether
   `AnthropicProvider` stays as an option or is removed.
3. Use the provider's native structured-output / JSON-schema mode with the existing `RESPONSE_SCHEMA`, if the chosen
   model supports it. **Verify in Groq's current docs**; support varies by model. Otherwise use its JSON mode.
   Either way, keep the pydantic `PlanResponse` validation and the one repair attempt in `planner.py`. The schema's
   `anyOf` may need adapting for Groq; if so, keep the same action set and response shape.
4. **Ask the user before adding a dependency** (e.g. the `groq` SDK). `httpx` is already in `requirements.txt`.
   Update `requirements.txt` and the model table in this file.
5. Add pytest coverage for provider selection and error mapping. Keep `ScriptedTestProvider` test-only.
   Run `make test`.
6. The user puts the key in `server/.env`. Then run M5 live and M7 with `scripts/e2e_cdp.mjs` and the manual
   checklist below, then `make leaks`.

**Must not change:**
- Planner payload/response schemas (extension `egress/schema.ts`, `shared/actions.ts`; server `schemas.py`).
- The prompt's untrusted-data framing.
- Sanitizer/vault, egress gate + client, validator/taint/confirmation, executor/settle/verification, telemetry
  events, dashboard, extension code.
- The extension needs no change for a provider swap: the side panel only reads `/health` →
  `planner_configured` and `model`.

**Watch-outs for the swap:**
- Free tiers have rate limits (429). Map them to `ProviderError`; the agent stops with "Planner error: …".
- The extension aborts `/plan` after 60 s (`PLAN_TIMEOUT_MS`). The server's provider timeout × retries should stay under that.
- Smaller models may pick wrong ids or try to submit. That is what local validation, R1 confirmation and the repair
  path are for. Record any such behaviour here rather than adding workarounds to the extension.

## Status summary

| Milestone | State | Notes |
|---|---|---|
| M1 Skeleton | ✅ done | Extension loads; content script answers ping; panel shows `/health`; dashboard shows real `TASK_STARTED` via relay. |
| M2 DOM → IR | ✅ done | Real snapshot in Chrome: 26 elements + 1 region on the demo page; stable ids, fingerprints, occlusion, debug view. |
| M3 Sanitizer + vault | ✅ done | Unit-tested; dashboard shows categories/placeholders only. |
| M4 Payload + egress gate | ✅ done | Unit-tested incl. tripwire and retry-then-block; `/plan` receives and logs real sanitized payloads. |
| M5 LLM planner | 🟡 built, **never run live** | Anthropic adapter written; validation + repair tested only with the test-only stub. Provider swap pending. |
| M6 Validation/taint/confirm/execute/verify | 🟡 built | Policy unit-tested; executor verified in real Chrome. Never driven by real LLM output. |
| M7 Full loop | ⛔ blocked | Needs a working planner provider + key. |
| M8 Dashboard polish | 🟡 mostly done | All views, registry-driven stages, generic rendering of unknown events. Polish after M7. |

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

**Repo:** the user created the git repo and committed/pushed `d661cc8 Initial Veil v0.1 implementation` to
`origin` (github.com/MehulSharmaCode/Veil). The 2026-09-24 doc updates are uncommitted.

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

**Not yet verified:**
- Any LLM-planned step.
- Save confirmation, Deny, Stop and panel-close mid-task, and `ask_user` / hand-off flows in the live agent loop.
- Testing in a real (non-headless) side panel by a person.

## Test results (latest: 2026-09-24)

| Suite | Result |
|---|---|
| `tsc --noEmit` (extension) | ✅ clean |
| vitest: normalizer, detectors, Luhn/Verhoeff/PAN, placeholder reuse, vault views, every gate rule incl. tripwire and retry-then-block, validator V1–V4/T1–T4/R1, submit-like, field categories | ✅ 51/51 |
| pytest: payload validation, response validation + repair (test-only stub), provider errors → 502, no provider → 503, telemetry relay, CORS | ✅ 21/21 |
| `scripts/check_leaks.py` (5 payloads) | ✅ 0/9 |

## Decisions

| Date | Decision | Why |
|---|---|---|
| 09-23 | Anthropic, `claude-sonnet-5`, effort `medium` | Initial user choice; **to be replaced by a free provider (next session)**. |
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

## Known issues / limitations

- **The real LLM planner has never run.** Prompt quality, id selection and `done` behaviour are untested.
- **Detection is heuristic (no NER):**
  - Names are found only via cues or once already vaulted.
  - Addresses are found via cues or a PIN code near address words.
  - DOB becomes `[REDACTED_TEXT]` (no DOB placeholder).
  - Obfuscated emails are not detected.
  - Cue false positives are possible ("Hello World" → `[PERSON_n]`).
- Synthetic events have `isTrusted=false`. Sites that check it fail verification and the step is handed to the user (no workaround, by design).
- `inspect` (live V2/V3 check) scrolls the target into view before execution.
- Panel-close telemetry is best-effort (`keepalive` fetch).
- Dashboard: `ERROR` events don't light a stage (they appear in the timeline).
- Anthropic client: 60 s timeout × up to 3 attempts can exceed the extension's 60 s `/plan` abort (relevant to the provider swap).
- `sidepanel.js` is ~840 KB unminified (mostly zod). Fine for v0.1.

## Deferred in v0.1 (by plan)

Everything in ROADMAP §6. No extra deferrals.

## Manual E2E checklist

Prerequisites: servers up (`make dev`), a working planner key in `server/.env`, extension loaded, side panel open on
the demo tab. `node scripts/e2e_cdp.mjs --dashboard --task "…" [--confirm deny]` drives the same flow headlessly.

- [ ] Representative task: "Fill my email mehul.test@example.com and my address 12 MG Road, Shivajinagar, Pune 411005. Do not submit."
  - Task shows `[EMAIL_1]` / `[ADDRESS_1]`.
  - Email and address are filled and verified.
  - Ends with `done`.
  - *Verified only up to the planner call.*
- [ ] A Save attempt (task "…and save") triggers the local confirmation; Deny prevents the click.
- [ ] Stop halts the loop and clears the vault (count → 0).
- [ ] Closing the side panel mid-task stops the agent (dashboard shows `panel_closed`).
- [ ] The controlled field (Alternate email) keeps an agent-typed value after settle. *(Executor verified directly; not via the agent.)*
- [x] `make leaks` → 0/N. *(0/9 on no-LLM runs; re-check after M7.)*
- [x] Dashboard never shows a raw value. *(0/9 on no-LLM run; re-check after M7.)*
