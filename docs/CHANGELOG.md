# VEIL Changelog

> **Role of this file:** the chronological implementation history. It is **append-only, oldest first**: add new
> entries at the bottom and don't rewrite old ones. To correct one, add a dated note.
> - Current state is in `PROJECT_CONTEXT.md`, and verification detail in `PROGRESS.md`.
> - Entries before 2026-09-28 were reconstructed on 2026-09-28 from git history and the committed docs.
> - The original task prompts are not stored in the repository. Where a prompt summary is given it is inferred from
>   the docs and marked *(inferred)*.
> - Anything that could not be established is marked *unknown*.
> - Never write API keys or raw sensitive values here.

Entry template:

```
## YYYY-MM-DD: <change title>
- Phase / milestone:
- Objective:
- Prompt/task summary:
- Files changed:
- Implementation changes:
- Validation/tests:
- Problems discovered:
- Fixes applied:
- Security/privacy implications:
- Documentation updated:
- Git commit:
```

---

## 2026-09-23: Initial Veil v0.1 build (DOM-only)

- **Phase / milestone:** v0.1; M1–M4 done, M5/M6 built, M7 blocked, M8 mostly done.
- **Objective:** build the complete DOM-only privacy-preserving agent loop: extension, demo site, dashboard and
  backend.
- **Prompt/task summary:** *(inferred)* implement VEIL v0.1 per the SIH26171 architecture spec, with an Anthropic
  planner.
- **Files changed:** 65 files, all new:
  - `extension/` (content, sidepanel, privacy, egress, policy, telemetry, platform, shared, static, tests);
  - `server/app/*`, `server/tests/test_server.py`;
  - `demo-site/`, `dashboard/`;
  - `scripts/check_leaks.py`, `scripts/e2e_cdp.mjs`;
  - `Makefile`, `.gitignore`, `CLAUDE.md`, `docs/PROGRESS.md`, `docs/ROADMAP.md`.
- **Implementation changes:**
  - MV3 extension:
    - DOM → IR, with values never read;
    - sanitizer with detectors, checksums, placeholders and an in-memory vault;
    - closed payload schema, egress gate G0–G7 and a single egress client;
    - validator V1–V4, taint rules T1–T4 and R1 confirmation;
    - executor with settle and verify;
    - telemetry.
  - FastAPI `/health`, `/plan` (pydantic `extra="forbid"`, `<untrusted_page_data>` framing, one repair) and the
    telemetry relay.
  - `AnthropicProvider` (`claude-sonnet-5`, effort `medium`).
- **Validation/tests:**
  - Headless Chrome 153 via CDP: snapshot (26 elements + 1 region), executor, the full flow up to `/plan` (503 with
    no key), dashboard over SSE.
  - `check_leaks.py --telemetry`: 0/9.
  - Unit test counts at this commit: *unknown*.
- **Problems discovered:** there was no LLM credential, so the real planner never ran and M7 was blocked.
- **Fixes applied:** none needed at this point.
- **Security/privacy implications:** the privacy boundary (sanitizer, gate, client, vault) was established.
- **Documentation updated:** `CLAUDE.md`, `docs/PROGRESS.md`, `docs/ROADMAP.md` created.
- **Git commit:** `d661cc8 Initial Veil v0.1 implementation`.

## 2026-09-24: Handoff update: planner blocked, provider swap planned

- **Phase / milestone:** v0.1; M5 built but never run live, M7 blocked.
- **Objective:** record the exact blocker and plan a swap to a free provider.
- **Prompt/task summary:** *(inferred)* update the handoff docs for the next session.
- **Files changed:** `CLAUDE.md`, `docs/PROGRESS.md`, `docs/ROADMAP.md`.
- **Implementation changes:** none; documentation only.
- **Validation/tests:** leak check re-run: 0/9 over 5 logged payloads, per PROGRESS.
- **Problems discovered:**
  - there was no `ANTHROPIC_API_KEY`;
  - the user would not use a paid Anthropic key.
- **Fixes applied:** none yet. The next task was to replace the provider layer with a free provider (likely Groq),
  touching only the provider layer.
- **Security/privacy implications:** none.
- **Documentation updated:** PROGRESS got a "Next session" section, with M7 marked "blocked". ROADMAP got 1a/1b.
- **Git commit:** `542c155 Update Veil project handoff state`. The commit time is 2026-09-24 00:09 +0530; the docs
  describe the state at the end of 2026-09-23.

## 2026-09-25: README created

- **Phase / milestone:** v0.1 documentation.
- **Objective:** a human-facing README covering overview, architecture, setup, usage, testing and limitations.
- **Prompt/task summary:** *(inferred)* write the project README.
- **Files changed:** `README.md` (new, 474 lines).
- **Implementation changes:** none.
- **Validation/tests:** none recorded.
- **Problems discovered:** *unknown*.
- **Fixes applied:** none.
- **Security/privacy implications:** none.
- **Documentation updated:** `README.md`. It was rewritten later in `ba45fe5`.
- **Git commit:** `3d83ef3 Add Veil v0.1 README`.

## 2026-09-25: Groq planner provider integration

- **Phase / milestone:** Phase 1a (M5).
- **Objective:** replace the Anthropic provider with a free provider, touching only the provider layer.
- **Prompt/task summary:** *(inferred)* implement the provider swap planned on 2026-09-24.
- **Files changed:**
  - `server/app/providers.py`, `server/app/config.py`, `server/app/main.py`;
  - `server/.env.example`, `server/requirements.txt`;
  - `server/tests/test_groq_provider.py` (new), `server/tests/test_server.py`.
- **Implementation changes:**
  - `GroqProvider` (REST via `httpx`, strict JSON Schema, configurable reasoning effort) replaces
    `AnthropicProvider` behind the unchanged `PlannerProvider` protocol.
  - Settings changed to `GROQ_API_KEY` and `VEIL_MODEL` (default `openai/gpt-oss-20b`) / `VEIL_EFFORT` (default
    `medium`).
  - Bounded budget: 20 s per attempt, 25 s per call, at most 3 attempts. 401/4xx are not retried; 429 waits for
    `retry-after` only within the budget; 5xx and 498 are retried.
  - `anthropic` was removed from `requirements.txt`, and no dependency was added.
- **Validation/tests:** `test_groq_provider.py` was added (22 test functions at this commit), using MockTransport
  with no network. The full-suite result at this commit is *unknown*.
- **Problems discovered:** the strict-schema HTTP 400 was found in the live run after this commit (next entry).
- **Fixes applied:** see next entry.
- **Security/privacy implications:** the provider receives only the gate-checked payload; the boundary is unchanged.
  The key lives only in `server/.env`.
- **Documentation updated:** the handoff docs were updated in `ba45fe5`.
- **Git commit:** `f4a1545 Add Groq planner provider`.

## 2026-09-25: Groq strict-mode HTTP 400: diagnosis and provider-local fix

- **Phase / milestone:** Phase 1b (M5 live).
- **Objective:** make live `/plan` calls succeed with Groq strict mode.
- **Prompt/task summary:** *(inferred)* run the live planner and fix what fails.
- **Files changed:** `server/app/providers.py`, `server/tests/test_groq_provider.py`.
- **Implementation changes:**
  - `adapt_schema_for_groq` merges `anyOf` object variants that share a `type` discriminator (the two `scroll`
    variants) into one variant with nullable, still-required fields.
  - `restore_merged_variants` strips those nulls before canonical validation.
- **Validation/tests:** 4 new provider tests: strict-mode rules, merges only overlapping variants and keeps the
  canonical schema, maps back to the canonical action, invalid merged outputs still rejected. Then live runs
  (entry below).
- **Problems discovered:** HTTP 400 `anyOf disambiguation failed: overlapping discriminator value 'scroll'`
  (`discriminator_value_overlap`).
- **Fixes applied:** the adaptation above. `RESPONSE_SCHEMA`, `PlanResponse` and the zod schemas are unchanged.
- **Security/privacy implications:** none. Output is still validated against the canonical closed schemas.
- **Documentation updated:** `PROGRESS.md` ("Next session", Decisions), `README.md` (Backend).
- **Git commit:** `ba45fe5 Complete Veil Phase 1 and update handoff`.

## 2026-09-25: Privacy incident: cue-less address partially masked (found and fixed)

- **Phase / milestone:** Phase 1b.
- **Objective:** stop address fragments reaching the planner.
- **Prompt/task summary:** *(inferred)* diagnose the leak flagged by `make leaks` in the first live multi-step run,
  and fix it generically.
- **Files changed:** `extension/src/privacy/detectors.ts`, `extension/test/privacy.test.ts`.
- **Implementation changes:** a PIN-code address detection now grows outward over the surrounding address tokens. It
  stops at sentence/line ends, a trailing `:`, placeholders, emails, runs of 7 or more digits, and instruction/label
  words. It is fail-closed and may over-mask an adjacent word.
- **Validation/tests:**
  - 2 regression tests: a cue-less address is masked whole around its PIN; a bare `user_answer` sanitizes to exactly
    `[ADDRESS_1]` with the full value vaulted.
  - The live re-run passed. Leak check: 0/9. Dashboard and server console: 0/9.
- **Problems discovered:**
  - The synthetic address given as an `ask_user` answer was masked only at its PIN.
  - Street and locality reached Groq in 3 planner payloads, and appeared in telemetry and on the dashboard.
  - G5 shares the detector logic, and G6 only matches vault values, so the gate did not catch it.
  - Only synthetic data was involved.
- **Fixes applied:** the detector change above.
- **Security/privacy implications:**
  - A real boundary failure under heuristic detection, now closed for this form.
  - Residual risk: an address with neither a cue nor a PIN is still not detected.
  - The pre-fix evidence is kept locally in the gitignored `server/logs/received_payloads.pre-address-fix.jsonl`.
- **Documentation updated:**
  - `PROGRESS.md` → "Security incident 2026-09-25 (resolved)";
  - `README.md` → "Privacy incident log";
  - `CLAUDE.md` start-here note.
- **Git commit:** `ba45fe5`.

## 2026-09-25: Phase 1 live planner validation (headless) and handoff

- **Phase / milestone:** Phase 1b; M5 and M6 done live, M7 demonstrated headless.
- **Objective:** run the real loop end to end with the real planner.
- **Prompt/task summary:** *(inferred)* validate Phase 1 live via `scripts/e2e_cdp.mjs`, then update the handoff.
- **Files changed:** `CLAUDE.md`, `README.md`, `docs/PROGRESS.md`, `docs/ROADMAP.md`, plus the code in the two
  entries above.
- **Implementation changes:** none beyond the two entries above.
- **Validation/tests:**
  - Headless Chrome 153 with Groq `openai/gpt-oss-20b`, effort `medium`: single-action run; multi-step run with
    `ask_user`; Save attempt denied under R1, click not executed.
  - `check_leaks.py --telemetry`: 0/9 after the fix.
  - vitest 53/53, pytest 54/54, `tsc` clean.
- **Problems discovered:**
  - The Groq free tier (8K TPM) causes 429s on tasks of 4 or more steps.
  - `ask_user` wording is awkward.
- **Fixes applied:** none. The provider waits out `retry-after` within its budget.
- **Security/privacy implications:** R1 blocked a live Save. Placeholders were resolved only locally.
- **Documentation updated:** all four docs. The manual non-headless checklist was left open.
  - These committed docs said the 2026-09-25 work was "uncommitted" and that the last commit was `f4a1545`. That was
    stale as soon as `ba45fe5` was made; it was corrected on 2026-09-28.
- **Git commit:** `ba45fe5 Complete Veil Phase 1 and update handoff`.

## 2026-09-28: Documentation reconciliation and governance

- **Phase / milestone:** Phase 1, documentation only. No code change.
- **Objective:** reconcile the docs with the actual git and implementation state, add a canonical current-state
  file and a changelog, and make documentation updates mandatory.
- **Prompt/task summary:**
  - verify git, provider, dependency and phase state;
  - create `PROJECT_CONTEXT.md` and `CHANGELOG.md`;
  - add a governance rule to `CLAUDE.md`, with explicit doc roles;
  - fix clear inconsistencies;
  - no code, no commit.
- **Files changed:**
  - new: `docs/PROJECT_CONTEXT.md`, `docs/CHANGELOG.md`;
  - modified: `CLAUDE.md`, `README.md`, `docs/PROGRESS.md`, `docs/ROADMAP.md`.
- **Implementation changes:** none.
- **Validation/tests:**
  - `make test` at HEAD `ba45fe5`: `tsc` clean, vitest 53/53, pytest 54/54 (1 Starlette deprecation warning);
  - `git diff --check` clean;
  - `server/.env` still gitignored;
  - no API key in tracked files.
- **Problems discovered:**
  1. `PROGRESS.md` said the 2026-09-25 work was uncommitted and the last commit was `f4a1545`, but HEAD is `ba45fe5`
     and the tree is clean.
  2. `README.md` listed `anthropic` among the pip packages installed by `make setup`; it is no longer in
     `requirements.txt`.
  3. `CLAUDE.md` and `PROGRESS.md` "Next" omitted M8 polish, which README and ROADMAP place after the freeze and before
     the next-phase discussion.
  4. The docs say "freeze and commit Phase 1" after the manual checks, but Phase 1 code was already committed as
     "Complete Veil Phase 1" before those checks.
- **Fixes applied:**
  - 1–3 corrected in the docs;
  - 4 recorded explicitly as an open question for the user (what the freeze commit contains), with no
    reinterpretation of the order.
- **Security/privacy implications:** none. No values or keys were added to any doc.
- **Documentation updated:** as listed above.
- **Git commit:** none; uncommitted, for the user to review and commit.

## 2026-09-28: Phase 1 live validation (visible Chrome, real side panel) and freeze

- **Phase / milestone:** Phase 1 freeze; M7 done.
- **Objective:**
  - perform the remaining Phase 1 checklist live;
  - run the leak check;
  - fix only genuine defects;
  - freeze, commit and push if the acceptance criteria hold.
- **Prompt/task summary:**
  - validate tests A–G (single step, multi-step, Save protection, Stop, panel close, values in the task, dashboard)
    in real, visible Chrome;
  - run `make leaks`;
  - update the docs;
  - commit "Freeze Veil Phase 1" and push only if everything passes.
- **Files changed:** documentation only: `CLAUDE.md`, `README.md`, `docs/PROJECT_CONTEXT.md`, `docs/PROGRESS.md`,
  `docs/ROADMAP.md`, `docs/CHANGELOG.md`. No application code, test, config or dependency changed.
- **Implementation changes:** none.
- **Validation/tests:**
  - `make dev` was running. `/health` reported `groq` / `openai/gpt-oss-20b` / `planner_configured: true`, and
    `VEIL_EFFORT=medium`.
  - `make test`: `tsc` clean, vitest 53/53, pytest 54/54, both before and after the runs.
  - Live runs in a visible Google Chrome 154 (throwaway profile, `extension/dist` loaded via CDP) with the **real
    Chrome side panel**. The panel was opened with `chrome.sidePanel.open()` under a CDP user gesture, and its own DOM
    controls were driven via CDP. The session-local driver is not committed.
  - A to G all passed; details are in `PROGRESS.md` → "Live validation 2026-09-28":
    - A: single step;
    - B: multi-step with `ask_user` (4 planner calls);
    - C: 4 Save proposals, all denied, Save never ran;
    - D: Stop, vault 0, no later page change;
    - E: `chrome.sidePanel.close()`, `panel_closed` delivered, no page input after the close (timestamped);
    - F: task values sent as `[EMAIL_1]` / `[ADDRESS_1]`, exact values typed;
    - G: dashboard live, 0/9 on every run.
  - `make leaks` found 0/9 over 24 payloads and 36 telemetry events. The server console and raw telemetry had 0 hits.
- **Problems discovered:** none in local code. Observations:
  1. `gpt-oss-20b` re-proposed a denied Save 3 more times, and filled the primary Email unasked. Local policy held
     every time; this is recorded as a limitation.
  2. In the first panel-close attempt (no timestamps), an action dispatched just before the close still landed. By
     design, the stop flag is checked before every dispatch and in-flight actions can't be recalled. The timestamped
     re-run showed no input after the close. Recorded as a limitation.
  3. The local incident evidence file `server/logs/received_payloads.pre-address-fix.jsonl` is no longer on disk;
     why is unknown. It was never committed. The written incident history is intact.
- **Fixes applied:** none needed.
- **Security/privacy implications:**
  - The privacy boundary held for every run and seed tested: 0/9.
  - This is evidence for these runs, not a proof of zero leakage.
- **Documentation updated:**
  - Phase status is set to "frozen with documented manual limitations" in all docs.
  - PROGRESS now has the live validation section, updated checklist, open items and decisions.
  - README status and limitations are updated.
- **Git commit:** "Freeze Veil Phase 1". It also includes the uncommitted 2026-09-28 documentation reconciliation
  above.

## 2026-09-28: M8 dashboard completion (proof surface)

- **Phase / milestone:** M8 (the last v0.1 milestone), after the Phase 1 freeze.
- **Objective:** make the real VEIL pipeline visibly understandable to judges from real telemetry only. That covers:
  - what was asked, seen and sanitized;
  - what stayed local and what left the browser;
  - the LLM's proposal versus the local safety decision;
  - execution, verification and outcome, including blocked, stopped and failed cases.
- **Prompt/task summary:**
  - audit the dashboard against the real events;
  - add only the minimal privacy-safe instrumentation needed;
  - rebuild the dashboard around the pipeline;
  - validate it live in visible Chrome, including a blocked safety case;
  - run the privacy audit and the leak check;
  - sync the docs. No commit was authorized.
- **Files changed:**
  - extension: `extension/src/sidepanel/agent.ts`, `extension/src/sidepanel/main.ts`,
    `extension/src/telemetry/telemetry.ts`, `extension/src/policy/validator.ts`, `extension/test/policy.test.ts`,
    `extension/test/egress.test.ts`;
  - server: `server/app/main.py`, `server/tests/test_server.py`, `server/tests/test_groq_provider.py`;
  - dashboard: `dashboard/index.html`, `dashboard/style.css`, `dashboard/registry.js`, `dashboard/app.js`,
    `dashboard/model.js` (new), `dashboard/test/model.test.mjs` (new);
  - tooling: `scripts/e2e_cdp.mjs`, `Makefile`;
  - docs: `README.md`, `CLAUDE.md`, `docs/PROJECT_CONTEXT.md`, `docs/PROGRESS.md`, `docs/ROADMAP.md`,
    `docs/CHANGELOG.md`.
- **Missing telemetry discovered:**
  - no planner provider/model/effort in the stream;
  - `REQUEST_SENT` had no request id, HTTP status or response time, and is emitted only when the response arrives;
  - the validator did not report which rules it evaluated, and there was no taint summary;
  - no event for local placeholder resolution;
  - an `ask_user` answer was visible only as detection counts;
  - a denial did not say the action was not executed;
  - `ERROR` dropped its reason;
  - the IR had no structural flags.
  - Not observable at all: server-side retries and repair, and the leak check.
- **Instrumentation added (all through `Telemetry.emit` → egress client → gate, no new network path):**
  - `TASK_STARTED.planner`/`limits`;
  - `EGRESS_CHECK_*.rules_checked`;
  - `REQUEST_SENT.request_id`/`http_status`/`response_ms`;
  - `LLM_ACTION_RECEIVED.schema`;
  - `ACTION_VALIDATED.checks`/`live_checks`/`taint`, backed by a new `checked` list on the validator's allow verdict;
  - `CONFIRMATION_RESOLVED.result`;
  - new `USER_ANSWERED` (sanitized answer) and `PLACEHOLDER_RESOLVED` (id and category only);
  - `ERROR.reason` (sanitized);
  - `IR_CREATED.interactive[].tag`/`input_type`/`flags`;
  - `/health` reports `effort`.
  - Agent behaviour, planner behaviour, action semantics and schemas are unchanged.
- **Dashboard changes:**
  - Rebuilt as ES modules: `registry.js` (data), `model.js` (pure reducer), `app.js` (render, read-only transport).
  - Views: header; pipeline; privacy proof (observed vs by design, with the dashboard's own payload re-check); AI
    decision vs local safety authority; execution and verification; sanitization flow; agent loop; exact outbound
    payload per step; DOM → IR inspector; grouped timeline.
  - Statuses come only from events. Unproven items show as pending, skipped, interrupted or not observed.
- **Validation/tests:**
  - `make test`: `tsc` clean, vitest 56/56 (+3), pytest 54/54, dashboard node:test 8/8 (new `make test-dashboard`).
  - Live in visible Chrome 154 with the real side panel and real Groq, dashboard in a 1440×900 window:
    - the representative task with values in the text: 3 steps, every stage from events, DONE;
    - Save + Deny: R1 confirmation, "blocked (user denied)", then STOPPED;
    - `ask_user`: "answer sanitized to: [ADDRESS_1]";
    - Stop while planning: INTERRUPTED/STOPPED.
  - The headless `e2e_cdp.mjs --dashboard` run passed.
  - Dark theme and 390 px width were checked by screenshot.
- **Problems discovered:**
  - the dashboard froze in hidden tabs (`requestAnimationFrame`);
  - the decision card kept saying "waiting" after the task ended;
  - a table overflowed at phone width;
  - the old harness selectors broke.
- **Fixes applied:** timer-based rendering; outcome-aware decision card; scroll wrapper; harness updated. The
  decision-card fix was not re-exercised by a live run.
- **Security/privacy implications:**
  - Privacy audit: the dashboard makes only GET/SSE requests, has no HTML sinks, logging or storage, and renders
    with `textContent` only.
  - The extension still has one `fetch` module. The new events carry placeholders, categories, ids and structural
    metadata only.
  - New gate tests show that a leaky resolution or answer event would be stopped.
  - `make leaks` 0/9 over 36 payloads. The dashboard had 0/9 on every live run. The server console and telemetry
    had 0 hits.
- **Documentation updated:** README (dashboard, `/health`, testing, structure, limitations), CLAUDE.md (status,
  dashboard row, `make test`), PROJECT_CONTEXT, PROGRESS ("M8 dashboard completion", status, decisions, open
  items), ROADMAP (§1).
- **Git commit:** none. The M8 work is uncommitted, for the user to review and commit.

## 2026-09-28: v0.1 final hardening pass (bug discovery, fixes, live E2E validation)

- **Phase / milestone:** v0.1 hardening before the M8 checkpoint commit. No new feature phase was started.
- **Objective:** reproduce the address privacy bugs found in manual testing, audit the whole pipeline for further
  defects, fix root causes with regression tests, and re-validate live (privacy, execution order, dashboard semantics,
  failure/safety behaviour).
- **Bugs found and fixed:**
  1. *Address under-detection (privacy).* Cue-less task phrasings ("fill address X", "use this address X", "set the
     address to X", "X as my address", "X in the address field") left the raw address in the outbound task.
     → A new generic token-boundary address engine (`privacy/detectors.ts`) covers forward and suffix cues,
     house-number/street shapes and the PIN path. Weak cues count in user-typed text.
  2. *Address over-masking (privacy/correctness).* Spans swallowed following instructions or other fields, for
     example `and email is <email>`, `and do not submit`, `into the address box`, `, phone: …`.
     → The address now stops at instruction words, field labels, other PII, clause-starting connectors (with
     lookahead) and sentence ends; em dashes and smart quotes are trimmed.
  3. *Cue-less `ask_user` answers (privacy).* "Shivajinagar, Pune" as an answer to "What is your address?" was not
     masked. → The sanitizer gets the expected category from the question (`expectedAnswerCategory`); an answer no
     detector flags is masked whole as ADDRESS or PERSON (yes/no and control answers excepted).
  4. *Custom ARIA widget values in the IR (invariant 3).* The content of `role=textbox/searchbox/spinbutton/combobox`
     elements became their accessible name or text (3 of 13 IR-audit values reached the raw IR and the sanitized
     payload). → `content/dom.ts` and `content/snapshot.ts` treat them as value-bearing, including via
     `aria-labelledby`. The IR audit now finds 0/13.
  5. *Consecutive-failure rule bypassed (safety).* Invalid or empty planner responses `continue`d past the
     2-failures → `ask_user` check. → Fixed in `agent.ts`.
  6. *Fabricated/duplicate rejection event (dashboard truthfulness).* An invalid planner response emitted two
     `ACTION_REJECTED` events, one with a made-up `WAIT` action. → One event, with no action.
  7. *False `ACTION_EXECUTED` after Stop (truthfulness).* A `wait` interrupted by Stop still reported that it had
     executed. → Checked after the wait.
  8. *Unreported in-flight action after Stop (truthfulness).* A result arriving after Stop was dropped, although the
     page had changed. → It is now reported as `ACTION_EXECUTED` with `after_stop: true`, and never verified; nothing
     follows it.
  9. *Dashboard current-step vs task-wide ambiguity.* Resolve/Execute/Verify showed SKIPPED on a DONE/ASK_USER
     step. → Added the "N/A this step" status, a per-card task-wide record, the "Whole task so far" strip and a
     most-recent-browser-action label; DONE is labelled as the planner's declaration, accepted locally.
  10. *Dashboard ordering and in-flight states.* Events were applied in arrival order; an execute in flight at panel
      close showed "not reached"; the Execution card said "waiting…" forever after the task ended. → The reducer
      orders by `ts` (rebuilding on late arrivals); in-flight actions show "may have run; result not observed";
      terminal wording is used; SSE subscribes before loading state; the timeline shows milliseconds and the header
      shows the delivery delay.
  11. *Transient Groq `json_validate_failed` HTTP 400 killed the task.* → `GroqProvider` retries that code within the
      existing budget; other 400s are still not retried. Only the error-code identifier is logged.
  12. *Test hygiene.* Queued telemetry from the new agent tests reached the live relay after `fetch` was un-stubbed
      (synthetic metadata only). → Tests keep a closed-network `fetch`.
- **Execution-order finding (observation #4):** the runtime order was correct. Live evidence: the page's own input
  event follows `ACTION_VALIDATED` and `PLACEHOLDER_RESOLVED` in every step, with 0 violations across the matrix. The
  apparent inversion was delivery and render aggregation (all of a step's events land within ~320 ms and are painted
  together; a background tab repaints ~1/s). This was addressed in the dashboard (bug 10), not in the runtime.
- **Files changed:**
  - extension: `src/privacy/detectors.ts`, `src/privacy/sanitizer.ts`, `src/sidepanel/agent.ts`,
    `src/content/dom.ts`, `src/content/snapshot.ts`, `test/privacy.test.ts`, `test/agent.test.ts` (new);
  - server: `app/providers.py`, `tests/test_groq_provider.py`;
  - dashboard: `model.js`, `app.js`, `index.html`, `style.css`, `test/model.test.mjs`;
  - tooling: `scripts/e2e_cdp.mjs`, `scripts/check_leaks.py`;
  - docs: `README.md`, `CLAUDE.md`, `docs/PROJECT_CONTEXT.md`, `docs/PROGRESS.md`, `docs/ROADMAP.md`,
    `docs/CHANGELOG.md`.
- **Validation/tests:**
  - `make test`: `tsc` clean, vitest 116/116 (4 files), pytest 57/57, dashboard node:test 14/14.
  - Live matrix with real Groq `openai/gpt-oss-20b`, headless and visible Chrome with the real side panel: see
    `PROGRESS.md` → "Hardening pass 2026-09-28".
  - `make leaks`: 0/19 over 91 payloads.
- **Security/privacy implications:** strictly more masking in task text and answers, and fewer raw values in the IR.
  The gate's residual scan and T4 now also recognise house-number/street shapes. No new network path and no new
  dependency.
- **Git commit:** none (the user reviews and commits).

## 2026-09-29: Dashboard UI/UX redesign (proof console)
- **Phase / milestone:** presentation pass on the M8 dashboard, after the Phase 1 freeze and the hardening pass. Dashboard
  only; no agent, extension, server, telemetry or reducer change.
- **Objective:** make the read-only dashboard read as a deliberate privacy/security observability console that explains
  VEIL on its own: what was asked, what VEIL saw and kept local, what crossed to the remote planner, what the planner
  proposed, what local code decided, what the browser did and whether it was verified.
- **Prompt/task summary:** redesign the dashboard's hierarchy, visual system and wording, browser-first (inspect the real
  rendering in Chrome through the Chrome DevTools MCP, iterate, re-inspect), keeping it read-only, privacy-safe and
  semantically identical (current step vs whole task, DONE declared vs verified, N/A vs skipped, interrupted vs
  failed, not observed).
- **Files changed:** `dashboard/index.html`, `dashboard/style.css`, `dashboard/app.js`, `dashboard/registry.js`
  (presentation data only: `PHASES` and `short` stage labels); docs.
- **Implementation changes:**
  - Page order follows the story: task + outcome → pipeline (current step) with the whole task → privacy boundary →
    "The AI proposes. VEIL decides." → "What the browser actually did" → collapsible evidence.
  - Pipeline: stages grouped into phases on two lanes split by the device boundary; only the planner sits in the
    hatched remote lane, with "request ↓ / ↑ proposal" at the crossing. The stage happening now is outlined. A stage
    that is N/A, skipped or pending in the current step says what happened there earlier in the task.
  - Whole task: inline counts plus the agent loop as a step × stage matrix (one row per step, a status mark per stage,
    the step result; current step marked).
  - Privacy boundary: "On this device" (sanitization flow + placeholder table with a fixed-size redaction bar in the
    "real value" column) and "Sent to the planner" (privacy proof ledger), with the egress gate between them.
    Relabelled checks, for example "Network privacy check: 0 forbidden keys detected".
  - Decision chain: remote proposal (dashed, hatched, "Proposes") → local authority ("Decides": checks, taint, risk
    policy, verdict) → user (confirmation or answer) → result. The user block says "confirmation required" as soon as
    local validation requires one.
  - Execution chain: action → resolved locally → execution → settle → verification.
  - Evidence: outbound payload, DOM → IR and the timeline in `<details>` panels with summary lines (payload and IR
    collapsed, timeline open).
  - Outcome card tag names the outcome ("DONE · DECLARED", "STOPPED", "PANEL CLOSED", …) instead of PASSED; the hero
    explains each outcome in one sentence and says when a step is paused for the user.
  - Visual system: graphite ground, one accent (placeholder tokens), semantic status colours with a separate hue per
    state (blocked orange ≠ failed red; stopped/interrupted lilac), uppercase only for status words, system fonts
    (no web fonts, no new network request), dark and light themes, reduced-motion respected. The blocked glyph is
    `⊘` (the `⛔` emoji ignored the colour system). An inline empty favicon removes the `favicon.ico` 404.
  - Stage clock times moved to the stage tooltip (the timeline keeps every event to the millisecond).
  - "Requests sent to the planner" counts bytes of the observed requests only; a gate pass whose response was never
    observed (for example in flight at panel close) is stated as such instead of being added to the total.
- **Validation/tests:** `make test` (tsc clean, vitest 116/116, pytest 57/57, dashboard node:test 14/14); `make leaks`
  0/19 over 121 payloads after the live runs. Visual review in
  Chrome through the Chrome DevTools MCP at 1440×900, 1024×768 and 390×844 (dark and light), with no page-wide
  horizontal overflow. Details, including which states were checked with live telemetry and which with the reducer's
  test fixtures, are in `PROGRESS.md` → "Dashboard redesign 2026-09-29".
- **Problems discovered:** a literal "null" printed under the verdict while running and a "now" highlight on the wrong
  stage after a denial (both in the new rendering code; fixed before completion). Groq's free tier rate-limited every
  live run after its first planner call during this session (retry hints of 5–17 minutes), so complete live DONE,
  Save/Deny and ASK_USER runs could not be repeated.
- **Fixes applied:** see above; no fix outside `dashboard/`.
- **Security/privacy implications:** none. Same read-only transport (only `GET /telemetry/state` and SSE
  `/telemetry/stream`), `textContent`-only rendering, no new dependency or network request. The redaction bar is a
  fixed-size CSS element with no content. The rendered UI showed 0/18 seeded values with every panel expanded.
- **Documentation updated:** `README.md` (dashboard section), `CLAUDE.md` (status), `docs/PROJECT_CONTEXT.md`,
  `docs/PROGRESS.md`, this file.
- **Git commit:** none (the user reviews and commits).

## 2026-09-29: Release-candidate validation and commit of M8, hardening and dashboard redesign
- **Phase / milestone:** v0.1 release-candidate checkpoint after M8, the hardening pass and the dashboard redesign.
  Validation only; no new feature.
- **Objective:** re-validate the accumulated uncommitted work (tests, leak check, diff review, one live smoke run,
  dashboard check in Chrome) and commit it only if everything passed.
- **Files changed:** `dashboard/style.css` (one blank line with trailing whitespace, flagged by `git diff --check`;
  no rendering change); docs: `CLAUDE.md`, `README.md` (leak-check row), `docs/PROJECT_CONTEXT.md`,
  `docs/PROGRESS.md` (new "Release-candidate validation 2026-09-29", open item 11, a stale dev note about harness
  output), this file.
- **Validation/tests:**
  - `make test`: `tsc` clean, vitest 116/116, pytest 57/57, dashboard node:test 14/14.
  - Live smoke with real Groq `openai/gpt-oss-20b` (effort `medium`), headless: seeded email + address in the task
    text → 3 planner calls → both fields typed and verified → DONE; Save not clicked; vault cleared; 0 causal-order
    violations; dashboard 0/18 canaries.
  - Dashboard in Chrome (DevTools MCP): 0/20 seeded values with every panel expanded, empty console, only GET/SSE
    requests, no form controls; SSE switched the open tab to a second (Stop while planning) session without a reload.
  - `make leaks`: 0/19 over 128 payloads and the latest session's telemetry; server console clean.
- **Problems discovered:** the trailing-whitespace line; a dev note in `PROGRESS.md` still said the harness prints raw
  field values (it prints filled/empty only). Both fixed. No code defect was found.
- **Security/privacy implications:** none; no code change.
- **Git commit:** "Finalize Veil Phase 1 hardening and dashboard" (the M8, hardening and redesign work plus this
  validation record).

## 2026-09-29: Task 2, Gemini planner provider (live validation blocked)
- **Phase / milestone:** Task 2, a controlled planner-provider migration after the v0.1 release-candidate commit. No
  architecture, privacy-pipeline, schema, extension or dashboard change.
- **Objective:** add Gemini behind the existing `PlannerProvider` seam with a configuration toggle and Groq as the
  rollback; prove parity with unit, contract and leak tests and live runs; make Gemini the default only after live
  parity.
- **Research:** official Gemini docs and the SDK source (2026-09-29): `google-genai` 2.25.0 (not the legacy
  `google-generativeai`); `gemini-3.8-flash` is a stable model id; structured output via a JSON Schema subset;
  `thinking_level` low/medium/high; the Interactions API stores requests by default, so the stateless
  `generateContent` API is used; the SDK retries only when configured and its error text embeds the response body.
- **Files changed:**
  - server: `app/providers.py` (`GeminiProvider` and Gemini error helpers; `GroqProvider` untouched), `app/config.py`
    (`VEIL_PROVIDER`, `GEMINI_API_KEY`, per-provider default model, `api_key`/`key_var`), `app/main.py`
    (`build_provider`, unknown provider refuses to start, provider-aware 503), `requirements.txt`
    (`google-genai>=2.25,<3`), `.env.example`;
  - tests: `tests/test_gemini_provider.py` (new, 49), `tests/test_provider_parity.py` (new, 27);
  - docs: `README.md`, `CLAUDE.md`, `docs/PROJECT_CONTEXT.md`, `docs/PROGRESS.md`, this file.
- **Implementation:** see `PROGRESS.md` → "Task 2: Gemini provider". The canonical `RESPONSE_SCHEMA` is sent to Gemini
  unchanged (accepted live, so no adaptation layer); SDK retries and automatic function calling are off; the same
  20 s / 25 s / 3-attempt budget; Gemini-specific error mapping; only non-thought text parts are returned.
- **Validation/tests:** `make test`: `tsc` clean, vitest 116/116, pytest **133/133** (57 before), dashboard 14/14. A
  mutation check confirmed the leak test fails if a provider error echoes its body. `make leaks` 0/19 over 140
  payloads, including those sent to Gemini.
- **Problems discovered (live):**
  1. `gemini-3.8-flash` answered 503 "high demand" and 504 most of the session; successful calls took ~16 s.
     (provider capacity)
  2. After two slow 503s the third attempt carried the leftover budget as its deadline, and Gemini rejected it with
     HTTP 400 "Minimum allowed deadline is 10s", which hid the real error. (code issue)
  3. The free tier allows 20 requests/day/model; once exhausted, the 429 carries a misleading 57 s `retryDelay`.
     (provider quota)
- **Fixes applied:** (2) no Gemini attempt, or wait before one, with under 10 s of budget left; (3) a per-day
  QuotaFailure fails at once with "daily request quota exhausted". Both regression-tested. (1) is not fixable in Veil
  and is documented.
- **Live result:** BLOCKED. The canonical schema was accepted in one live structured call, and the E2E runs failed
  closed at the planner (nothing executed, vault cleared, dashboard truthful, 0/18 canaries), but no planner step
  succeeded, so parity is not shown live and Groq remains the default.
- **Security/privacy implications:** none weakened. Gemini receives exactly the prompt text Groq receives (tested).
  The key is server-side only, passed explicitly, and never logged or echoed. The extension and dashboard are
  unchanged. Only metadata is logged.
- **Documentation updated:** README (provider seam, setup, configuration, tests, limitations), CLAUDE.md, PROJECT_CONTEXT,
  PROGRESS, this file. ROADMAP unchanged (no milestone affected).
- **Git commit:** none (the user reviews and commits).
