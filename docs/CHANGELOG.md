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
