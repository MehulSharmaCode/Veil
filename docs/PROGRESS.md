# VEIL Progress Log

## Status summary (2026-09-23)

| Milestone | State | Notes |
|---|---|---|
| M1 Skeleton | ✅ done | Extension loads, content script answers ping, `/health` shown in panel, dashboard shows real `TASK_STARTED` via relay. |
| M2 DOM → IR | ✅ done | Real snapshot in headless Chrome: 26 elements + 1 region on demo page; stable ids, fingerprints, occlusion, debug view. |
| M3 Sanitizer + vault | ✅ done | Unit-tested; dashboard shows categories/placeholders only (verified 0/9 canaries on dashboard). |
| M4 Payload + egress gate | ✅ done | Unit-tested incl. tripwire + retry-then-block; `/plan` receives and logs real sanitized payloads. |
| M5 LLM planner | 🟡 built, **not live-tested** | Anthropic adapter (structured output), validation + repair tested with a test-only stub. **Needs `ANTHROPIC_API_KEY` in `server/.env`.** |
| M6 Validation + taint + confirmation + execution | 🟡 built | Policy unit-tested; executor verified in real Chrome (controlled input, stale fingerprint, click, scroll). Agent-driven path awaits M5 live. |
| M7 Full loop | ⛔ blocked on API key | Everything up to the LLM call runs for real; leak check 0/9 on real payload + telemetry. |
| M8 Dashboard polish | 🟡 mostly done | All views + registry-driven stages + generic rendering for unknown events. Polish after M7. |

## Log

### 2026-09-23
- Repo inspected: `Desktop/Veil` was empty. The enclosing git repo is the user's home dir; per user decision no
  nested repo was created and nothing is committed (`.gitignore` added for later).
- LLM provider: **Anthropic Claude**, `anthropic` Python SDK 1.8, `claude-sonnet-5` default (configurable), native
  structured output (`output_config.format` JSON schema), effort `medium`.
- Built all four parts (extension, demo site, dashboard, server) + `scripts/check_leaks.py` + `scripts/e2e_cdp.mjs`.
- Verified in a real (headless) Chrome 153 via CDP `Extensions.loadUnpacked`:
  - snapshot/IR of the demo page (values never read; header text → `Signed in as [PERSON_1] ([EMAIL_1])`);
  - executor: native-setter typing into the controlled input sticks and verifies after settle; bare `.value=` reverts
    (fixture sanity); stale fingerprint refused; Save click detected (3 mutations); scroll;
  - full task up to the planner: task → `Fill my email [EMAIL_1] and my address [ADDRESS_1]. Do not submit.`,
    egress gate passed (7.6 KB), payload logged by `/plan`, 503 (no key) handled, vault cleared;
  - dashboard live via SSE, all stages/timeline populated, 0/9 raw canary values visible;
  - `check_leaks.py --telemetry`: **0/9** canary values in received payloads and telemetry.

## Decisions

| Date | Decision | Why |
|---|---|---|
| 2026-09-23 | Anthropic Claude, `claude-sonnet-5` default | User choice; model/effort via `VEIL_MODEL` / `VEIL_EFFORT`. |
| 2026-09-23 | Python 3.13 (anaconda) in `server/.venv` | Only interpreter on the machine; ≥3.11 as required. |
| 2026-09-23 | zod v4 with `z.config({ jitless: true })` | Allowed validator; jitless avoids `new Function` under MV3 CSP. |
| 2026-09-23 | Content script declared for `localhost/*` + `ensureContentScript()` re-injects via `scripting` | Single injection seam; also removes the "reload the tab after reloading the extension" pain. |
| 2026-09-23 | Fingerprints are **not** sent to the backend | Only needed locally (V3); less data out. |
| 2026-09-23 | Text blocks = text nodes grouped by nearest non-inline ancestor | Keeps "Signed in as <b>Name</b>" as one string so context cues still fire (fragmenting would leak names). |
| 2026-09-23 | Sanitizer also replaces **already-vaulted values** anywhere (e.g. a name in a heading without a cue) | Referential consistency; the tripwire would otherwise mask the whole field. |
| 2026-09-23 | Page text that looks like a placeholder (`[CARD_1]`) is defused to `(CARD_1)` | Pages must not forge vault references. |
| 2026-09-23 | Overlapping detections are merged into their union | Fail closed: no partially masked tails. |
| 2026-09-23 | Unclassifiable numbers ≥ 9 digits → `[REDACTED_TEXT]` | Fail closed (e.g. Aadhaar with bad checksum). |
| 2026-09-23 | Telemetry gate failures drop the event (logged in panel) but don't pause the task; planner gate failures hard-block | Telemetry is best-effort observability; the planner payload is the privacy-critical path. |
| 2026-09-23 | Tripwire ignores vault forms < 4 chars (text) / < 6 digits | Avoid matching common words; documented trade-off. |
| 2026-09-23 | Verification failure → recorded, fresh snapshot, re-plan; 2 consecutive failures → `ask_user` | Implements "retry once with a fresh snapshot → ask_user" without blindly repeating clicks. |
| 2026-09-23 | A click whose message channel dies (navigation) counts as "changed"; executes are never re-sent | Avoid double-submits. |
| 2026-09-23 | Dev E2E driver uses Chrome's own CDP over `--remote-debugging-pipe` (no npm deps) | Chrome 137+ ignores `--load-extension`; `Extensions.loadUnpacked` works. |

## Known issues / limitations

- **No live LLM run yet** (no API key on this machine). M5 live check and M7 pending.
- Detection is heuristic (no NER): names only via cues (`my name is`, `signed in as`, `Name:`, greetings) or when
  already vaulted; addresses via cues or PIN-near-address-words; DOB is masked as `[REDACTED_TEXT]` (no DOB placeholder).
- Name cue false positives are possible ("Hello World" → `[PERSON_n]`) — fail-closed by design.
- Synthetic events have `isTrusted=false`; sites that check it will fail verification → handed to user (by design, no workaround).
- Side panel "pagehide" telemetry on close is best-effort (`keepalive` fetch).
- Content-script `inspect` scrolls the target into view during validation (visible side effect before execution).
- Dashboard stage tracker doesn't light a stage for `ERROR` events (they appear in the timeline).

## Test results (2026-09-23)

| Suite | Result |
|---|---|
| `tsc --noEmit` (extension) | ✅ clean |
| vitest (normalizer, detectors, Luhn/Verhoeff/PAN, placeholder reuse, vault views, every gate rule incl. tripwire and retry-then-block, validator V1–V4/T1–T4/risk, submit-like, field categories) | ✅ 51/51 |
| pytest (payload validation, response validation + repair path w/ test-only stub, provider errors, telemetry relay, CORS) | ✅ 21/21 |
| Headless Chrome: snapshot / executor / task-to-planner / dashboard | ✅ (see log above) |
| `scripts/check_leaks.py --telemetry` | ✅ 0/9 (1 payload, 13 events) |

## Deferred in v0.1 (by plan)

Everything in ROADMAP §6. No additional deferrals so far.

## Manual E2E checklist

Run with server, demo site, dashboard up (`make dev`), `ANTHROPIC_API_KEY` set, extension loaded; open the side panel on the demo tab.
(`node scripts/e2e_cdp.mjs --dashboard --task "…" [--confirm deny]` drives the same flow headlessly.)

- [ ] Representative task: "Fill my email mehul.test@example.com and my address 12 MG Road, Shivajinagar, Pune 411005. Do not submit." → task shows `[EMAIL_1]`/`[ADDRESS_1]`; email + address fields filled and verified; ends with `done`. *(verified up to the planner call; needs key)*
- [ ] A Save attempt (e.g. task "…and save") triggers the local confirmation dialog; Deny prevents the click.
- [ ] Stop button halts the loop and clears the vault (vault count → 0).
- [ ] Closing the side panel mid-task stops the agent (no further actions; dashboard shows `panel_closed`).
- [ ] Controlled/dynamic field (Alternate email) keeps the typed value after settle (verification = true). *(executor verified in headless Chrome)*
- [x] `make leaks` reports `0/N` matches. *(0/9 on the no-key run)*
- [x] Dashboard never shows a raw value. *(0/9 canaries in dashboard text on the no-key run)*
