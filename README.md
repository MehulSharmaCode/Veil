# Veil

Veil is a privacy-preserving browser agent, built as a Chrome (Manifest V3) extension. It performs simple web tasks
for a user ("fill in my email and address, don't submit") while keeping the user's sensitive values on the device.
The extension reads the page locally and replaces sensitive values with typed placeholders such as `[EMAIL_1]`. Only
that sanitized description goes to a backend, where a hosted LLM plans the next action. The extension then checks
the proposed action locally, swaps the placeholder back for the real value locally, performs the action in the page
and verifies the result.

Built for SIH 2026, problem statement **SIH26171: On-device Visual Perception for Light-weight Browser Agents**.

> **Status: v0.1 (DOM-only), Phase 1 demonstrated.** On the controlled demo site, in headless Chrome, a real hosted
> planner (Groq, `openai/gpt-oss-20b`) has driven:
> - a single-action task;
> - a multi-step task, including `ask_user`;
> - a Save attempt that local confirmation blocked.
>
> Each action was validated locally, executed in the page and verified.
>
> One privacy bug was found and fixed during those runs: a partially masked address was sent to the planner (see
> [Privacy incident log](#privacy-incident-log)). After the fix, the real-provider leak check found 0 of 9 known
> synthetic values.
>
> Still outstanding: a short manual (non-headless) side-panel checklist. No external websites are supported. See
> [Current limitations](#current-limitations).

---

## Overview

Browser agents usually send the whole page (raw HTML or screenshots, form values included) to a hosted model. Veil
takes the opposite approach. The page is perceived locally, sensitive data is replaced before anything leaves the
extension, and the hosted model is used only as a planner over that sanitized representation. Local code, not the
LLM, has the final say on every action.

**What v0.1 demonstrates:**
- A DOM snapshot turned into a structured intermediate representation (IR). Field values are never read into it.
- Local detection and sanitization of personal data, with typed placeholders and an in-memory vault.
- An egress gate that every outbound message must pass, and a single egress client.
- A FastAPI planner endpoint with strict request/response schemas.
- Local action validation, confirmation for submit-like actions, execution in the page and verification.
- A read-only dashboard that shows the real events of a run.
- A canary leak check over what the backend received.

**Why DOM-only first:** the final direction is a local *visual* pipeline (on-device OCR and face detection) that
perceives and redacts image/canvas regions only when needed. That pipeline needs a trustworthy agent loop, privacy
boundary and validation layer to plug into. v0.1 builds and verifies that foundation on DOM-accessible content.
Image regions are already carried through the IR as `unperceived` placeholders so the visual stack can be added later.

---

## Current Architecture

```
 User task (typed in the side panel)
        │
        ▼
┌──────────────────────────── VEIL extension (Chrome, local) ─────────────────────────────┐
│                                                                                         │
│  Content script (page)                      Side panel (orchestrator, owns the vault)   │
│  ─────────────────────                      ───────────────────────────────────────     │
│  DOM snapshot ──► raw IR (no field values) ──► sanitizer ──► placeholders + local vault │
│                                                  │                                      │
│                                                  ▼                                      │
│                                        payload builder (sanitized IR + task + history)  │
│                                                  │                                      │
│                                                  ▼                                      │
│                                        egress gate (G0–G7) ──► egress client (only fetch)
│                                                                         │               │
└─────────────────────────────────────────────────────────────────────────┼───────────────┘
                                                                          │ POST /plan
                                                                          ▼
                                              ┌────────── FastAPI backend (:8000) ───────────┐
                                              │ schema check → prompt → LLM provider          │
                                              │ → structured JSON action → validate / repair  │
                                              └──────────────────────────┬───────────────────┘
                                                                         │ structured action
┌────────────────────────────────────────────────────────────────────────┼────────────────┐
│  VEIL extension                                                        ▼                │
│  schema check (V1) → local validation (V2–V4) + taint (T1–T4) + submit confirmation (R1)│
│  → resolve placeholder from vault (locally) → execute in page → settle → verify         │
│  → next step (fresh snapshot) … until done / ask_user / stop / step limit              │
└─────────────────────────────────────────────────────────────────────────────────────────┘

 Telemetry (sanitized events, same egress gate + client) ──► POST /telemetry/events
      ──► in-memory relay ──► GET /telemetry/state + SSE /telemetry/stream ──► Dashboard (:8090, read-only)
```

Each step sends one action at most (`MAX_ACTIONS_PER_STEP = 1`). A task is capped at 15 steps, and two consecutive
failures hand control back to the user (`ask_user`). The supported actions are `click`, `type`, `select`, `scroll`,
`wait`, `ask_user` and `done`.

### VEIL Extension

`extension/` is the agent itself. It is written in TypeScript and bundled with esbuild into `extension/dist/`.
- **Content script:** runs in the top frame of `localhost` pages. It builds the IR from the live DOM: visible
  elements, accessible labels, `has_value` plus a value *category* (never the value), bounding boxes, occlusion and a
  position-free fingerprint. It also executes actions (native value setter plus `input`/`change` events, a
  pointer/mouse click sequence, select, scroll), waits for the DOM to settle and verifies the result.
- **Side panel:** the orchestrator and UI. It owns all agent state, including the vault. It runs the loop, sanitizes
  the IR, builds the payload, calls the planner through the egress gate and client, validates the returned action,
  asks the user for confirmation when needed, and resolves placeholders to real values only for the single action
  that types them.
- **Service worker:** minimal and stateless. It only opens the side panel.
- The extension uses only generic primitives. It contains no knowledge of the demo site.

### Controlled Demo Site

`demo-site/` is a static HTML/JS test fixture served on `:8080`: a college-portal style "Edit profile" page. It
contains:
- prefilled name, phone and PAN fields;
- empty email and address fields;
- a controlled "Alternate email" input that re-renders from JS state;
- an application number that should *not* be masked, and a profile image;
- a submit-type **Save changes** button with success feedback.

It exists to exercise and demonstrate the agent in a reproducible way. It is **not** part of Veil. The extension must
never special-case it (no demo-specific ids, selectors, names or values in `extension/`). Only the dev tooling in
`scripts/` knows about it.

### Visualization Dashboard

`dashboard/` is a static, read-only observability app served on `:8090`. It shows the real telemetry events of a run:
- stage tracker;
- task (with placeholders);
- IR summary;
- detected categories and the placeholder table;
- vault status (counts and categories);
- the sanitized outbound payload and the egress gate result;
- the planner's action, validation, execution and verification results;
- a live timeline.

It only issues `GET /telemetry/state` and subscribes to `GET /telemetry/stream` (SSE). **It never sends anything to
the extension or the backend and is not part of the agent's control path.** Events reach it only after passing the
same egress gate as planner requests, so it shows placeholders, categories and counts, never raw values.

### Backend

`server/` is a FastAPI app on `:8000`:
- **`GET /health`:** status, plus whether a planner provider is configured (and its name and model). The side panel
  reads this.
- **`POST /plan`:** validates the incoming payload against a closed pydantic schema (`extra="forbid"`), builds the
  prompt (page data is wrapped as `<untrusted_page_data>`) and asks the configured LLM provider for structured JSON.
  It validates the response, makes one repair attempt if it is invalid, and otherwise returns 502. With no provider
  configured it logs the payload and returns **503**. In development, received payloads are appended to
  `server/logs/received_payloads.jsonl` for the leak check.
- **`/telemetry/*`:** an in-memory relay on a separate router (`POST /events`, `GET /state`, SSE `GET /stream`).
  CORS allows `GET` from the dashboard origin only.

The LLM provider sits behind the `PlannerProvider` protocol in `server/app/providers.py`. The current implementation is
`GroqProvider`:
- It calls Groq's chat-completions REST API with `httpx`, using strict JSON Schema structured output and a
  configurable reasoning effort.
- Time is bounded: 20 s per HTTP attempt, 25 s per call, at most 3 attempts. With the one repair call, a `/plan`
  request therefore finishes before the extension's 60 s deadline.
- Groq's strict mode rejects `anyOf` variants that share a `type` value, so the provider merges the two `scroll`
  variants for the request and maps the output back. The canonical schema and validators are unchanged.

The provider only ever receives the gate-checked sanitized payload, so swapping providers does not move the privacy
boundary.

---

## Privacy and Security Model

The design principle is that **the hosted planner should receive only the sanitized representation it needs to
reason about the next step**. The mechanisms below enforce this in v0.1. They are engineering controls backed by
tests and a canary leak check, not a formal guarantee. Detection is heuristic (see
[limitations](#current-limitations)), and the system is designed to fail closed: when uncertain, it masks more, sends
less or asks the user.

- **Raw sensitive values stay local.** Values detected in the task text and page text (email, phone, PAN, Aadhaar
  with Verhoeff check, card numbers with Luhn check, address/name/DOB cues) are replaced before anything leaves the
  extension. Unclassifiable long digit strings become `[REDACTED_TEXT]`.
- **Placeholders stand in for values.** Outbound text contains typed placeholders (`[EMAIL_1]`, `[ADDRESS_1]`, …),
  reused consistently for the same value. Placeholder look-alikes that appear in page or task text are defused, so a
  page cannot forge a vault reference.
- **A local vault holds the real values.** It lives in memory in the side panel only. A real value leaves it only
  when it is passed to the content script for the single `type` action that needs it.
- **Field values are never serialized.** The IR records only `has_value` and a value category for inputs.
- **Raw DOM/HTML is not sent.** The planner receives an IR-derived, sanitized payload built against a closed schema.
- **Every outbound message passes the egress gate.** Planner requests and telemetry both go through one egress
  client, and only after the gate passes. Gate rules:

  | Rule | Checks |
  |---|---|
  | G0 | any exception inside the gate (fail closed) |
  | G1 | closed schema (unexpected fields rejected) |
  | G2 | forbidden key names (`value`, `html`, `url`, `password`, `cookie`, …) |
  | G3 | raw HTML markup |
  | G4 | URL query strings or fragments |
  | G5 | residual PII found by a strict re-scan |
  | G6 | tripwire: a known vault value appears anywhere |
  | G7 | size limit |

  On failure the client masks the offending fields once and re-checks. If the message still fails, a planner request
  blocks the task and a telemetry event is dropped.
- **Actions are validated locally before execution.** The LLM is a planner only; it never touches the browser or the
  vault.
  - **V1:** schema-valid action.
  - **V2:** target present in the latest snapshot, visible and not occluded.
  - **V3:** target fingerprint unchanged. Stale or changed targets are rejected, re-checked live right before acting.
  - **V4:** action suits the element.
  - **Taint rules:**
    - **T1:** credential and card fields are handed to the user, never filled by the agent.
    - **T2:** placeholder category must match the field, otherwise the user confirms.
    - **T3:** a value used on a different origin needs confirmation.
    - **T4:** literal text must not smuggle vault values or PII-shaped text.
- **Submit/save-like actions need confirmation (R1).** A click on a submit-like control is paused for explicit local
  user confirmation, and **Deny** prevents it.
- **Ending a task clears the vault.** When a task finishes for any reason (done, error, Stop), the vault is cleared.
  Closing the side panel destroys its JS context, which stops the agent and discards the vault (the kill switch).
- **No raw values in logs, telemetry or the dashboard.** These show placeholders, categories and counts only.
- **No arbitrary code execution.** No `eval`, no LLM-supplied JavaScript, no downloads. zod runs `jitless` under the
  MV3 CSP.
- **Minimal permissions.** `sidePanel`, `activeTab` and `scripting`, with host access limited to `http://localhost/*`
  and `http://127.0.0.1/*`. No `chrome.debugger`, `<all_urls>`, `cookies` or `webRequest`.
- **API keys are never committed.** A planner key belongs only in `server/.env`, which is gitignored. It is never put
  in the extension.

---

## Project Structure

```
Veil/
├── extension/                 # A. The VEIL Chrome extension (the agent)
│   ├── src/
│   │   ├── background/        #   minimal service worker (opens the side panel)
│   │   ├── content/           #   dom.ts, snapshot.ts (DOM → IR), execute.ts (act, settle, verify)
│   │   ├── sidepanel/         #   agent.ts (the loop, owns the vault), main.ts (UI)
│   │   ├── privacy/           #   normalize, detectors, checksums, sanitizer, vault, sanitized (branded type)
│   │   ├── egress/            #   schema.ts (closed zod schemas), payload.ts, gate.ts (G0–G7), client.ts (only fetch)
│   │   ├── policy/            #   validator.ts (V1–V4, T1–T4, R1), submitLike.ts
│   │   ├── telemetry/         #   event emitter (through the same egress client)
│   │   ├── platform/          #   chrome.ts: the only module touching chrome.*
│   │   └── shared/            #   config.ts, ir.ts, actions.ts, messages.ts, fieldCategory.ts, zod.ts
│   ├── static/                # manifest.json, sidepanel.html/.css, icon (copied verbatim into dist/)
│   ├── test/                  # vitest suites: privacy, egress, policy
│   ├── build.mjs              # esbuild build script → extension/dist/
│   ├── package.json
│   └── tsconfig.json
├── server/                    # D. FastAPI backend
│   ├── app/
│   │   ├── main.py            #   create_app, /health, /plan, CORS, dev payload logging
│   │   ├── schemas.py         #   pydantic mirror of the extension schemas (extra="forbid")
│   │   ├── prompt.py          #   system prompt, <untrusted_page_data> framing, response JSON schema
│   │   ├── planner.py         #   validate → one repair → 502
│   │   ├── providers.py       #   PlannerProvider protocol + GroqProvider (the provider seam)
│   │   ├── config.py          #   settings from server/.env
│   │   └── telemetry.py       #   in-memory telemetry relay + SSE
│   ├── tests/                 # pytest (includes a test-only scripted provider)
│   ├── requirements.txt
│   └── .env.example           # template for server/.env (no key)
├── demo-site/                 # B. Controlled test fixture (static, :8080)
├── dashboard/                 # C. Read-only observability app (static, :8090)
├── scripts/
│   ├── check_leaks.py         # canary leak check over logged payloads (+ live telemetry)
│   └── e2e_cdp.mjs            # headless Chrome E2E driver (dev tool, no npm deps)
├── docs/
│   ├── PROGRESS.md            # detailed status, verification log, decisions, known issues
│   └── ROADMAP.md             # phases after v0.1
├── CLAUDE.md                  # AI-assistant/project context (not a setup guide)
├── Makefile                   # setup, build, run, test, leak-check targets
└── README.md
```

---

## Prerequisites

| Tool | Requirement | Source |
|---|---|---|
| **Node.js / npm** | Node `^22.12.0`, `^24.0.0` or `>=26.0.0`. This is the engine range of the pinned `vitest` 5; the build tools alone accept Node ≥ 18. No npm version is pinned; use the npm bundled with Node. | `extension/package-lock.json` |
| **Python** | **3.11 or newer** (developed with 3.13). `make setup` creates the venv with whatever `python3` is on your `PATH`. | `docs/PROGRESS.md` |
| **Google Chrome** | Chrome **116+** for the extension (`minimum_chrome_version` in the manifest). The headless E2E driver needs a recent Chrome, **137+**, because it loads the extension over CDP (`Extensions.loadUnpacked`); it was verified on Chrome 153. | `extension/static/manifest.json`, `scripts/e2e_cdp.mjs` |
| **make** | Used for all setup/run/test commands. | `Makefile` |
| **git** | To clone the repository. | |

Notes:
- The Makefile and run instructions are written for **macOS**, and the E2E driver defaults to the macOS Chrome path.
  Override it with the `CHROME` environment variable on other systems. Other platforms have not been tested.
- A **Groq API key** (console.groq.com) is needed for the live planner. The free tier works, but see the rate-limit
  note under [Current limitations](#current-limitations). Everything except planning runs without a key.

---

## Installation

### Clone

```bash
git clone https://github.com/MehulSharmaCode/Veil.git
cd Veil
```

### Install dependencies

```bash
make setup
```

This runs:
1. `npm install` in `extension/` (esbuild, TypeScript, vitest, `@types/chrome`, zod).
2. `python3 -m venv server/.venv` and `pip install -r server/requirements.txt` (FastAPI, uvicorn, pydantic,
   python-dotenv, anthropic, httpx, pytest).
3. Copies `server/.env.example` to `server/.env` **only if `server/.env` does not already exist**.

### Configure the backend (`server/.env`)

`server/.env` is gitignored and is the **only** place a planner API key may live. Never commit it, and never put a
key in the extension.

| Variable | Default | Purpose |
|---|---|---|
| `GROQ_API_KEY` | *(empty)* | Groq API key for `GroqProvider`. If empty, no provider is built: `/health` reports `planner_configured: false` and `/plan` returns 503. |
| `VEIL_MODEL` | `openai/gpt-oss-20b` | Groq model id. It must support strict JSON Schema output. |
| `VEIL_EFFORT` | `medium` | Reasoning effort: `low` \| `medium` \| `high`. |
| `VEIL_DEV_LOG_PAYLOADS` | `1` | Dev only: append each received `/plan` payload to `server/logs/received_payloads.jsonl` (used by the leak check). |
| `VEIL_DASHBOARD_ORIGIN` | `http://localhost:8090,http://127.0.0.1:8090` | Origins allowed by CORS (dashboard GETs). |

Edit `server/.env` in your own editor. After editing it, restart `make dev`, then check the backend with
`curl -s localhost:8000/health`. It should report `"planner_configured":true,"provider":"groq"`.

---

## Running the Project

### Start all servers

```bash
make dev
```

This builds the extension, then starts all three servers in one terminal (Ctrl-C stops all of them):

| Service | URL | Make target |
|---|---|---|
| FastAPI backend | http://localhost:8000 (`/health`, `/plan`, `/telemetry/*`) | `make server` |
| Demo site | http://localhost:8080 | `make demo` |
| Dashboard | http://localhost:8090 | `make dashboard` |

Each can also be started on its own with the listed target. All servers bind to `127.0.0.1`.

### Build and load the Chrome extension

```bash
make ext         # build → extension/dist/
make ext-watch   # rebuild on change (static/ is copied only at start; restart after editing it)
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select `extension/dist`.
3. Open the demo site at http://localhost:8080.
4. Click the VEIL toolbar icon to open the side panel.
5. Optionally, open the dashboard at http://localhost:8090 to watch events.

The side panel shows the backend `/health` status, a task box, Start/Stop, the current stage, vault metadata
(placeholders and categories only), confirmation / ask-user prompts, a step log and a sanitized-IR debug view.

**MV3 notes:**
- After reloading the extension, reload any open demo tabs, or messages fail with "Receiving end does not exist".
  The extension also tries to re-inject the content script as a fallback.
- Closing the side panel stops the agent and discards the vault.
- The extension can only operate on `http://localhost` / `http://127.0.0.1` pages in v0.1.

### Example tasks (demo site)

With a Groq key configured, these tasks have been run end to end (headless) with the real planner:
- `Fill my alternate email with my email. Do not submit.` The model types the header email's placeholder into
  "Alternate email", the value is verified, and the task ends with `done`.
- `Fill my email and address. Do not submit.` The model asks for the address. Your answer is sanitized locally to
  `[ADDRESS_n]`. The model then fills Email and Address one step at a time, each verified, and ends with `done`.
- `…and save the changes.` The Save click is proposed, then paused for your confirmation (R1). Denying it prevents
  the click.

Without a key, the non-LLM path still runs: snapshot → IR → sanitization → placeholders/vault → payload → egress gate
→ `POST /plan`, which logs the sanitized payload and returns 503. The agent then stops cleanly with "Planner error".

### Headless E2E driver (dev tool)

`scripts/e2e_cdp.mjs` launches a separate headless Chrome with a throwaway profile, loads the real built extension and
drives the real side-panel page. It needs the servers running (`make dev`) and a built extension. It has no npm
dependencies. This harness may know demo-site specifics; the extension may not.

```bash
node scripts/e2e_cdp.mjs --snapshot            # print the sanitized IR of the demo page
node scripts/e2e_cdp.mjs --exec-check          # exercise executor primitives directly
node scripts/e2e_cdp.mjs --dashboard --task "…" [--confirm allow|deny] [--answer "…"] [--stop-after-ms N] [--close-panel-after-ms N]
```

---

## Testing

```bash
make test          # all of the below
make typecheck     # extension: tsc --noEmit
make test-ext      # extension: vitest
make test-server   # server: pytest
make leaks         # canary leak check (the telemetry part needs the server running)
```

What the suites cover:
- **vitest (extension):**
  - normalizer and detectors (including the extent of cue-less addresses);
  - Luhn/Verhoeff/PAN checksums;
  - placeholder reuse and vault views;
  - every egress gate rule, including the tripwire and mask-once-then-block;
  - validator V1–V4, T1–T4 and R1;
  - submit-like detection and field categories.
- **pytest (server):**
  - payload validation;
  - response validation and repair (with a **test-only** scripted provider);
  - provider errors → 502, no provider → 503;
  - the telemetry relay and CORS;
  - `GroqProvider`: request shape, strict-schema rules and the scroll merge/restore, error mapping, and
    429/5xx/timeout retries within the budget. These tests use `httpx.MockTransport`: no network, no key.
- **`scripts/check_leaks.py`:** seeds 9 known sensitive values (the demo-site values and the representative task's
  values). It searches everything the backend logged, plus the relay's current telemetry state with `--telemetry`, for
  exact, lowercase and digits-only matches. It prints only labels and locations, never the values, and exits 1 on any
  match.

Latest results (see `docs/PROGRESS.md`):

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| vitest | 53 / 53 passing |
| pytest | 54 / 54 passing |
| `check_leaks.py --telemetry` | 0 of 9 seeded values in the payloads and telemetry of the real-Groq runs |

The leak-check result covers the specific synthetic values and runs tested so far. It is evidence for those runs, not
a general guarantee. The first live multi-step run did leak address fragments (see limitations). That led to a fix in
address detection, and the result above is from after the fix.

---

## Current Limitations

- **Live testing so far is narrow.** It covers headless Chrome, one demo page and a handful of tasks.
  - The manual, non-headless side-panel flow has not been fully validated.
  - Stop and panel-close mid-task have not been verified with a live planner.
  - The T1 credential hand-off has not been validated live, because the demo page has no credential or card field.
    It is unit-tested.
  - The representative task with the email and address written into the task text was not run live. The equivalent
    `ask_user` flow passed.
- **Planner wording:** `openai/gpt-oss-20b` phrases `ask_user` questions awkwardly ("provide a placeholder for the
  address"). It still works, because the answer is sanitized locally.
- **Groq free-tier rate limit (8K tokens/min).** One planner step is about 2.5K tokens, so tasks of 4 or more steps
  hit HTTP 429.
  - The provider waits out `retry-after` only within its 25 s budget, which made one step take about 20 s in testing.
  - If the wait doesn't fit, the task stops with "Planner error: … rate limit reached".
- **Detection is heuristic; there is no NER.**
  - Names are found through contextual cues.
  - Addresses are found through cues ("my address …"), or through a 6-digit PIN code near address words, grown to
    the surrounding address tokens. An address with neither a cue nor a PIN is not detected.
  - This gap was exposed live: see [Privacy incident log](#privacy-incident-log).
  - DOB becomes `[REDACTED_TEXT]` rather than a typed placeholder.
  - Obfuscated emails are not detected.
  - Cue false positives are possible.
- **Synthetic events are `isTrusted = false`.** Sites that check this will fail verification, and the step is handed
  to the user. This is by design; there is no workaround.
- **Scope is DOM-only and localhost-only.** Not supported yet:
  - visual perception (OCR, face detection, redaction);
  - iframes and shadow DOM beyond the generic snapshot;
  - per-origin runtime permissions;
  - `navigate` / `inspect` actions and action batching;
  - Firefox, WebGPU, benchmarks.
- **Dashboard:** `ERROR` events appear in the timeline but don't light a stage. Panel-close telemetry is best-effort.

The full list is in `docs/PROGRESS.md` → "Open items".

## Privacy incident log

**2026-09-25: address fragments sent to the planner (resolved).**
- **What happened:** in the first live multi-step run, a synthetic address typed as an answer to `ask_user` was
  masked only at its 6-digit PIN code. The street and locality reached the Groq planner in 3 payloads, and appeared
  in telemetry and on the dashboard. Only synthetic test data was involved.
- **Why the gate missed it:** the egress gate's residual scan uses the same detector logic, so it did not catch the
  leftover text independently.
- **How it was found:** the canary leak check and the dashboard check both flagged it.
- **Fix:** in `extension/src/privacy/detectors.ts`, a PIN-code detection now grows to the surrounding address tokens.
  Regression tests were added.
- **After the fix:** 0 of 9 known synthetic values in the planner payloads, telemetry, dashboard and server console
  output.
- Full write-up: `docs/PROGRESS.md` → "Security incident 2026-09-25 (resolved)".

---

## Next Development Phase

From `docs/ROADMAP.md` and `docs/PROGRESS.md`:

1. **Finish Phase 1**, in this order (the provider swap to Groq and the live headless runs are done):
   1. the manual non-headless side-panel checklist in `docs/PROGRESS.md`: the three live tasks, Stop and
      panel-close mid-task, with the dashboard watched;
   2. `make leaks`;
   3. freeze and commit the Phase 1 milestone;
   4. dashboard polish (M8).
2. **Then decide the next phase together.** None of the phases below is started automatically.
3. **Real-website compatibility:** from the demo site to simple external forms, dynamic React sites and more complex
   pages (never live banking or government sites).
4. **Visual perception ("need-to-see"):** on-device OCR (PP-OCRv5) and face detection (YuNet) with ONNX Runtime Web
   (WASM). This perceives and redacts image/canvas regions only when needed, feeds OCR text through the same
   sanitizer, and by default sends no pixels off the device.
5. **Safety hardening, then benchmarking:**
   - per-origin permissions;
   - iframes and shadow DOM;
   - stricter taint tracking;
   - adversarial tests (prompt injection, placeholder smuggling);
   - NER;
   - a canary suite and latency/success benchmarks.

---

## Contributing notes

- Keep the privacy invariants intact. Outbound strings must come from the sanitizer, and all traffic must go through
  the egress gate and client.
- Keep `extension/` generic. Never reference demo-site ids, names, selectors or values.
- No fakes at runtime. Test stubs belong only in tests.
- Keep `docs/PROGRESS.md` and `docs/ROADMAP.md` current at each milestone.
