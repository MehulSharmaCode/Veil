# Veil

Veil is a privacy-preserving browser agent, built as a Chrome (Manifest V3) extension. It performs simple web tasks
for a user ("fill in my email and address, don't submit") while keeping the user's sensitive values on the device.
The extension reads the page locally and replaces sensitive values with typed placeholders such as `[EMAIL_1]`. Only
that sanitized description goes to a backend, where a hosted LLM plans the next action. The extension then checks
the proposed action locally, swaps the placeholder back for the real value locally, performs the action in the page
and verifies the result.

Built for SIH 2026, problem statement **SIH26171: On-device Visual Perception for Light-weight Browser Agents**.

> **Status: v0.1 (DOM-only), Phase 1 frozen (2026-09-28) with documented manual limitations.** On the controlled
> demo site, a real hosted planner (Groq, `openai/gpt-oss-20b`) drove the loop in a visible Chrome with the real side
> panel:
> - a single-action task;
> - a multi-step task, including `ask_user`;
> - a task with the values written into the task text;
> - Save attempts that local confirmation blocked;
> - Stop mid-task and closing the panel mid-task.
>
> Each action was validated locally, executed in the page and verified. The leak check found 0 of 9 known synthetic
> values in the planner payloads and telemetry.
>
> One privacy bug was found and fixed on 2026-09-25: a partially masked address was sent to the planner (see
> [Privacy incident log](#privacy-incident-log)).
>
> A final **hardening pass (2026-09-28)** fixed address under- and over-masking in task text, custom ARIA widget
> values entering the IR, several Stop/failure truthfulness gaps and the dashboard's current-step vs task-wide
> ambiguity. It re-ran the live matrix with the real planner; the leak check found 0 of 19 synthetic values. Details:
> `docs/PROGRESS.md` → "Hardening pass 2026-09-28".
>
> The runs were driven through CDP rather than by hand; see [Current limitations](#current-limitations). No external
> websites are supported.

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
- A read-only dashboard that makes the real pipeline visible, event by event, including blocked and stopped cases.
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

`dashboard/` is a static, read-only "proof console" served on `:8090`. It makes the real pipeline visible from the
real telemetry stream, as it happens, and reads top to bottom in the order of the story: what was asked, what VEIL
saw and kept local, what crossed to the remote planner, what the planner proposed, what local code decided, what
the browser actually did and whether it was verified.
- **Task and outcome:** the task exactly as it left the browser (placeholders set as tokens), the overall state
  (RUNNING, DONE, STOPPED, PANEL CLOSED, BLOCKED, FAILED, STEP LIMIT) with a one-line meaning and the outcome message,
  then step, current stage, elapsed time, planner provider/model/effort and session.
- **Pipeline (current step):** the stages grouped into phases (asked → seen locally → kept local → boundary →
  proposed remotely → decided locally → acted in the page → checked → outcome) on two lanes split by the device
  boundary. Only the planner sits in the hatched **remote** lane; everything else runs in this browser. The stage
  that is happening now is outlined. A stage the current step's action does not have (DONE and ASK_USER have nothing
  to resolve, execute or verify) is "N/A this step", and such stages say what happened there earlier in the task.
- **Whole task so far:** counts (steps, browser actions, verified/denied/rejected, answers, in flight) and the most
  recent browser action, then the **agent loop** as a step × stage matrix: one row per step with the planner's
  proposal, a status mark per stage and the step result. The current step's row is marked.
- **What stayed local, and what left the browser:** two sides of the egress gate. *On this device* (sanitization):
  local inputs → detected categories → placeholders → vault, and a placeholder table whose "real value" column is a
  fixed-size redaction bar (never the value). *Sent to the planner* (privacy proof): egress results, requests and
  bytes, the dashboard's own network privacy re-check of each payload (forbidden keys, HTML), the placeholders that
  stood in for values, the vault lifecycle and the leak check (not observed), plus what is enforced by design.
- **The AI proposes. VEIL decides.** A chain: the remote planner's untrusted proposal → the local checks, taint
  decision, risk policy and verdict → the user's decision (confirmation or answer, if any) → the result.
- **What the browser actually did:** the most recent browser action (labelled with its step): action and target,
  local placeholder resolution, execution, settle and verification. An action that was dispatched when the task was
  stopped or closed is shown as "may have run; result not observed", or as "ran after Stop" if its result arrived.
- **Inspect the evidence** (collapsible): the outbound payload (the exact sanitized JSON of each planner request,
  with a summary), DOM → IR (the interactive elements VEIL saw: ids, roles, sanitized names, field category,
  `has_value`, flags) and the event timeline (every event in the order it happened, side-panel clock in
  milliseconds, grouped by step, with expandable details). Telemetry is delivered after the fact; the header shows
  the current delivery delay, and a late event is slotted in by its timestamp.

It has dark and light themes (following the system setting) and is laid out for 1440, 1024 and 390 px widths.

Nothing is shown as passed unless an event says so. Stages the stream does not prove stay "pending", "skipped" (the
step ended before them), "N/A this step" or "not observed". DONE is labelled as the planner's declaration, accepted
locally. A stage cut short by Stop or panel close is shown as "interrupted". The leak check is an offline tool
(`make leaks`) and is labelled as not observed in the stream.

It only issues `GET /telemetry/state` and subscribes to `GET /telemetry/stream` (SSE). **It never sends anything to
the extension or the backend and is not part of the agent's control path.** Events reach it only after passing the
same egress gate as planner requests, so it shows placeholders, categories and counts, never raw values.

### Backend

`server/` is a FastAPI app on `:8000`:
- **`GET /health`:** status, plus whether a planner provider is configured (and its name, model and reasoning
  effort). The side panel reads this and passes the planner identity into the task's telemetry for the dashboard.
- **`POST /plan`:** validates the incoming payload against a closed pydantic schema (`extra="forbid"`), builds the
  prompt (page data is wrapped as `<untrusted_page_data>`) and asks the configured LLM provider for structured JSON.
  It validates the response, makes one repair attempt if it is invalid, and otherwise returns 502. With no provider
  configured it logs the payload and returns **503**. In development, received payloads are appended to
  `server/logs/received_payloads.jsonl` for the leak check.
- **`/telemetry/*`:** an in-memory relay on a separate router (`POST /events`, `GET /state`, SSE `GET /stream`).
  CORS allows `GET` from the dashboard origin only.

The LLM provider sits behind the `PlannerProvider` protocol in `server/app/providers.py`. `VEIL_PROVIDER` selects one
of two implementations (the default is `groq`); nothing else in the backend, the extension or the dashboard depends
on which one runs:
- **`GroqProvider`** calls Groq's chat-completions REST API with `httpx`, using strict JSON Schema structured output
  and a configurable reasoning effort. Groq's strict mode rejects `anyOf` variants that share a `type` value, so the
  provider merges the two `scroll` variants for the request and maps the output back.
- **`GeminiProvider`** calls Gemini's stateless `generateContent` through the official `google-genai` SDK, with the
  canonical response schema as `response_json_schema` (Gemini accepts it unchanged, so there is no adaptation layer)
  and `VEIL_EFFORT` as the thinking level. The SDK's own retries and automatic function calling are turned off, and
  the stateful Interactions API (which stores requests server-side by default) is not used.
- Both use the same time budget: 20 s per HTTP attempt, 25 s per call, at most 3 attempts. With the one repair call,
  a `/plan` request therefore finishes before the extension's 60 s deadline. (Gemini rejects server deadlines under
  10 s, so its provider only starts an attempt when at least 10 s of the budget are left.)
- Both return the raw JSON text; the canonical pydantic model (`PlanResponse`) and then the extension's zod schema and
  local validator judge it. Provider errors become fixed messages with status codes only, never response content.

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
  with Verhoeff check, card numbers with Luhn check, address/name/DOB cues, house-number/street address shapes) are
  replaced before anything leaves the extension. An `ask_user` answer to an address or name question is masked whole
  when no detector flags it. Unclassifiable long digit strings become `[REDACTED_TEXT]`.
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
│   │   ├── providers.py       #   PlannerProvider protocol + GroqProvider + GeminiProvider (the provider seam)
│   │   ├── config.py          #   settings from server/.env
│   │   └── telemetry.py       #   in-memory telemetry relay + SSE
│   ├── tests/                 # pytest (test-only scripted provider; Groq/Gemini on mocked HTTP; parity + leak tests)
│   ├── requirements.txt
│   └── .env.example           # template for server/.env (no key)
├── demo-site/                 # B. Controlled test fixture (static, :8080)
├── dashboard/                 # C. Read-only proof dashboard (static, :8090)
│   ├── registry.js            #   stages, labels, summaries (data)
│   ├── model.js               #   pure reducer: events → state (statuses come only from events)
│   ├── app.js                 #   rendering + read-only transport (GET state, SSE stream)
│   └── test/                  #   node:test suite for the reducer
├── scripts/
│   ├── check_leaks.py         # canary leak check over logged payloads (+ live telemetry)
│   └── e2e_cdp.mjs            # headless Chrome E2E driver (dev tool, no npm deps)
├── docs/
│   ├── PROJECT_CONTEXT.md     # canonical current-state snapshot
│   ├── PROGRESS.md            # milestones, verification log, checklist, decisions, open items
│   ├── ROADMAP.md             # phases after v0.1, deferred scope
│   └── CHANGELOG.md           # chronological implementation history
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
- A planner API key is needed for the live planner: a **Groq API key** (console.groq.com) for the default provider,
  or a **Gemini API key** (aistudio.google.com) with `VEIL_PROVIDER=gemini`. The free tiers work, but see the
  rate-limit and availability notes under [Current limitations](#current-limitations). Everything except planning
  runs without a key.

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
   python-dotenv, httpx, google-genai, pytest).
3. Copies `server/.env.example` to `server/.env` **only if `server/.env` does not already exist**.

### Configure the backend (`server/.env`)

`server/.env` is gitignored and is the **only** place a planner API key may live. Never commit it, and never put a
key in the extension.

| Variable | Default | Purpose |
|---|---|---|
| `VEIL_PROVIDER` | `groq` | Planner provider: `groq` \| `gemini`. Any other value stops the server at startup. Switching back is the rollback. |
| `GROQ_API_KEY` | *(empty)* | Groq API key, used when `VEIL_PROVIDER=groq`. |
| `GEMINI_API_KEY` | *(empty)* | Gemini API key, used when `VEIL_PROVIDER=gemini` (passed to the SDK explicitly; an ambient `GOOGLE_API_KEY` is not used). |
| `VEIL_MODEL` | per provider | Model id. Unset: `openai/gpt-oss-20b` (Groq) or `gemini-3.8-flash` (Gemini). Set it only to override; when switching providers, change or remove it too. |
| `VEIL_EFFORT` | `medium` | `low` \| `medium` \| `high`: Groq `reasoning_effort` or Gemini `thinking_level`. |
| `VEIL_DEV_LOG_PAYLOADS` | `1` | Dev only: append each received `/plan` payload to `server/logs/received_payloads.jsonl` (used by the leak check). |
| `VEIL_DASHBOARD_ORIGIN` | `http://localhost:8090,http://127.0.0.1:8090` | Origins allowed by CORS (dashboard GETs). |

If the selected provider's key is empty, no provider is built: `/health` reports `planner_configured: false` and
`/plan` returns 503 naming the missing variable.

Edit `server/.env` in your own editor. After editing it, restart `make dev`, then check the backend with
`curl -s localhost:8000/health`. It should report `"planner_configured":true` and the provider you selected
(`"provider":"groq"` or `"provider":"gemini"`).

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

With a Groq key configured, these tasks have been run end to end with the real planner, headless and in a visible
Chrome with the real side panel:
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
node scripts/e2e_cdp.mjs --ir-audit            # prefilled fields and custom widgets: no value may reach the raw IR
node scripts/e2e_cdp.mjs --exec-check          # exercise executor primitives directly
node scripts/e2e_cdp.mjs --dashboard --task "…" [--confirm allow|deny] [--answer "…"] [--stop-after-ms N] [--close-panel-after-ms N]
```

More options (all documented at the top of the script):
- `--headed` and `--real-panel` run a visible Chrome with the real Chrome side panel.
- `--shots DIR` saves dashboard screenshots at 1440, 1024 and 390 px.
- `--stop-when-stage S` and `--close-after-verified N` time Stop and panel close.
- `--stale-once`, `--reject-input ID` and `--inject-attack` add harness-side page fixtures (a stale target, a field
  that rejects script input, prompt-injection and placeholder look-alike text).
- With `--dashboard`, it prints causal-order evidence: event emit times against the page's own input timestamps and
  the dashboard arrival times.
- It reports demo field state as filled/empty only.

---

## Testing

```bash
make test          # all of the below
make typecheck     # extension: tsc --noEmit
make test-ext      # extension: vitest
make test-server   # server: pytest
make test-dashboard  # dashboard reducer: node --test (no dependencies)
make leaks         # canary leak check (the telemetry part needs the server running)
```

What the suites cover:
- **vitest (extension):**
  - normalizer and detectors, including a table of address phrasings (cues, "X as my address", no PIN, lowercase,
    followed by another instruction), page-text false positives and `ask_user` answer masking;
  - Luhn/Verhoeff/PAN checksums;
  - placeholder reuse and vault views;
  - every egress gate rule, including the tripwire and mask-once-then-block;
  - validator V1–V4, T1–T4 and R1, including the list of rules each verdict reports as evaluated;
  - submit-like detection and field categories;
  - the telemetry event shapes the dashboard uses pass the gate, and a leaky one would be stopped;
  - the agent loop itself (`agent.test.ts`: mocked Chrome seam, test-only scripted planner). It covers causal
    order, denied Save, stale targets, T4 smuggling, unknown placeholders, consecutive malformed responses, Stop
    while planning/executing/waiting, panel close and `ask_user` sanitization.
- **pytest (server):**
  - payload validation;
  - response validation and repair (with a **test-only** scripted provider);
  - provider errors → 502, no provider → 503;
  - the telemetry relay and CORS;
  - `GroqProvider`: request shape, strict-schema rules and the scroll merge/restore, error mapping, and
    429/5xx/timeout/`json_validate_failed` retries within the budget;
  - `GeminiProvider` (the real `google-genai` SDK): request shape (stateless `generateContent`, canonical schema,
    explicit key), DONE/ASK_USER/type responses, thought parts, blocked/truncated/safety/empty responses, key and
    model errors, 429 `retry-after`/`RetryInfo`, 5xx and timeout retries within the budget, the 10 s minimum
    deadline, provider selection and the missing-key 503;
  - provider parity: the same sanitized request through both providers gives the same canonical plan for every
    action type, the same prompt text on the wire (including the repair turn) and the same error for the same
    failure;
  - seeded leak tests: the `scripts/check_leaks.py` seeds planted in every Gemini failure body never reach the
    exception, the 502 detail or any log record (even at DEBUG), and never the API key either.
  - These tests use `httpx.MockTransport`: no network, no key.
- **node:test (dashboard):** the reducer that turns events into the dashboard's state. It covers the success path,
  denied Save, Stop while planning, panel close, egress block, planner failure, no fabricated progress, unknown future
  events, the payload re-check, out-of-order arrival, in-flight and after-Stop actions, "N/A this step" versus
  task-wide history, and missing events never becoming passed.
- **`scripts/check_leaks.py`:** seeds 19 known synthetic values: the demo-site values, the representative task's
  values, an adversarial set (lowercase prose, `+91` phone, PAN, a cue-less address, mixed-case email), and IR-audit
  fixture values. It searches everything the backend logged, plus the relay's current telemetry state with `--telemetry`, for
  exact, lowercase and digits-only matches. It prints only labels and locations, never the values, and exits 1 on any
  match.

Latest results (see `docs/PROGRESS.md`):

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| vitest | 116 / 116 passing (4 files) |
| pytest | 57 / 57 passing |
| dashboard (node:test) | 14 / 14 passing |
| `check_leaks.py --telemetry` | 0 of 19 seeded values in 128 logged planner payloads and the latest session's telemetry (2026-09-29, release-candidate validation) |

The leak-check result covers the specific synthetic values and runs tested so far. It is evidence for those runs, not
a general guarantee. The first live multi-step run on 2026-09-25 did leak address fragments (see the incident log). That led to a fix in
address detection, and the result above is from after the fix.

---

## Current Limitations

- **Live testing so far is narrow.** It covers one demo page and a handful of tasks, in headless Chrome (2026-09-25)
  and in a visible Chrome with the real side panel (2026-09-28).
  - The 2026-09-28 runs were driven through CDP, not by hand. The panel was opened and closed with
    `chrome.sidePanel.open()`/`close()`, so the toolbar icon and the panel's close button were not exercised.
  - The T1 credential hand-off has not been validated live, because the demo page has no credential or card field.
    It is unit-tested.
  - Stop and panel close halt the loop before the next dispatch. An action already sent to the page still completes.
    After Stop its result is reported (flagged "after Stop") but not verified; after a panel close it is shown as
    "may have run; result not observed".
- **Planner quality (`openai/gpt-oss-20b`):**
  - It phrases `ask_user` questions awkwardly ("provide a placeholder for the address"). This still works, because the
    answer is sanitized locally.
  - After a denied Save it re-proposed Save several times, and it once filled an extra field it wasn't asked to.
  - Local validation and confirmation held every time.
- **Groq free-tier rate limit (8K tokens/min).** One planner step is about 2.5K tokens, so tasks of 4 or more steps
  hit HTTP 429.
  - The provider waits out `retry-after` only within its 25 s budget, which made one step take about 20 s in testing.
  - If the wait doesn't fit, the task stops with "Planner error: … rate limit reached".
- **Gemini (`gemini-3.8-flash`) is not yet validated live.** On 2026-09-29 the model often answered HTTP 503
  ("experiencing high demand") or 504, successful calls took about 16 s, and the free tier allows only **20 requests
  per day per model** (every attempt counts). A step whose attempts all fail within the 25 s budget ends the task
  with a planner error (fail closed: no action is taken). Groq therefore stays the default. Details:
  `docs/PROGRESS.md` → "Task 2: Gemini provider".
- **Detection is heuristic; there is no NER.**
  - Names are found through contextual cues, or as the answer to a name question.
  - Addresses are found through cues ("my address is …", "address …", "… as my address", "… in the address field"),
    house-number/street shapes ("Flat 3B", "12 MG Road"), a 6-digit PIN near address words, or as the answer to an
    address question. Each is grown to the surrounding address tokens and stops at instruction words, other fields and
    sentence ends. Page text with none of these (for example "Shivajinagar Pune" alone) is not detected.
  - These gaps were exposed live: see [Privacy incident log](#privacy-incident-log).
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
- **Dashboard:**
  - It shows the latest session only, since the relay is in memory. Panel-close telemetry is best-effort.
  - Server-side retries and repair attempts are not visible to the extension; they show up only as planner latency.
  - The leak check is not part of the live stream.
  - The local question VEIL asks after 2 consecutive failures emits no event of its own until it is answered.
  - Telemetry is delivered after the fact (a few ms locally; a background dashboard tab repaints about once a second),
    so the page can change before the dashboard shows the proposal that caused it. The timeline shows the true order.

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
  output. This was confirmed again in the 2026-09-28 live validation.
- Full write-up: `docs/PROGRESS.md` → "Security incident 2026-09-25 (resolved)".

**2026-09-28: address under- and over-masking in task text (resolved, found in manual testing).**
- **What happened:** with a custom task, the email was masked but a natural-language address was not ("fill address
  X", "use this address X", "X as my address"). The raw address reached the planner, which proposed typing it
  literally. In another phrasing the address was detected, but its span swallowed the following words
  ("… and email is …", "… and do not submit").
- **Root cause:** the only cues were "my address (is)" / "address:" / "address is"; the value then ran to a sentence
  end or to a short list of clause starters, and overlapping detections were merged into the address.
- **Fix:** one generic token-boundary engine for all address detectors: cue variants, suffix cues, house-number/street
  shapes and the PIN path. It stops at instruction words, other field labels, other PII and connectors that start a
  new clause. An `ask_user` answer is masked whole when the question asked for an address or name.
- Regression tests cover 31 phrasings plus page-text false positives. The live matrix was re-run, and the leak check
  found 0 of 19. Write-up: `docs/PROGRESS.md` → "Hardening pass 2026-09-28".

---

## Next Development Phase

From `docs/ROADMAP.md` and `docs/PROGRESS.md`:

1. **Phase 1 is frozen** (2026-09-28), and **M8 (dashboard completion) is done** (2026-09-28).
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
- Update the documentation in the same change as the code. Every meaningful change adds a `docs/CHANGELOG.md`
  entry, updates `docs/PROJECT_CONTEXT.md`, and updates whichever README/PROGRESS/ROADMAP sections it affects.
  `CLAUDE.md` → "Documentation roles and governance" defines each file's role.
