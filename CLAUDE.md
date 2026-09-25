# VEIL — Privacy-Preserving Browser Agent

SIH 2026, problem statement **SIH26171: On-device Visual Perception for Light-weight Browser Agents**.

> **Start here in a new session:** read `docs/PROGRESS.md` → "Next session" first.
> - **Status:** Phase 1 was verified **headless** on the demo site on 2026-09-25. That is the real DOM loop through a
>   hosted planner (Groq `openai/gpt-oss-20b`, effort `medium`).
> - **Privacy bug:** one was found and fixed that day (a partially masked address was sent to the planner). See
>   "Security incident 2026-09-25 (resolved)" in PROGRESS.
> - **Next:** the manual non-headless side-panel checklist (Stop, panel close, dashboard), then `make leaks`, then the
>   user freezes and commits Phase 1, then the next phase is discussed.
> - **Do not start OCR/vision or other new features on your own.**

VEIL is a Chrome MV3 extension that performs web tasks for a user ("fill my email and address, don't submit")
without sending the user's sensitive data to any server. The extension reads the page locally, replaces sensitive
values with typed placeholders (`[EMAIL_1]`), and sends only a sanitized page description to a backend. The backend
asks a hosted LLM to plan the next action. The extension validates that action locally, resolves placeholders to
real values locally, executes it in the page, and verifies the result.

**Final direction:** a local visual pipeline (on-device OCR + face detection with ONNX Runtime Web WASM, PP-OCRv5 and
YuNet) that perceives and redacts canvas/image regions only when needed ("need-to-see").
**Not built in v0.1**; only seams exist (see `docs/ROADMAP.md`).

## Privacy invariants (non-negotiable)

1. **Raw sensitive values never cross the network boundary.** Only sanitized data leaves the extension.
2. **Raw DOM/HTML is never sent** to the backend. Only the IR-derived sanitized payload is sent.
3. **Input field values are never serialized into outbound data.** Only `has_value` and a value category.
4. **All outbound traffic goes through one egress client**, and only after the **egress gate** passes. This applies to the planner request and to dashboard telemetry.
5. **The vault is local and in-memory only.** Real values never leave it, except to the content script for the single action that types them.
6. **The LLM is only a planner.** It never touches the browser, never sees the vault, and is never the final safety authority. Local code decides.
7. **The dashboard and all logs never show raw sensitive values.** They show placeholders, categories and counts only. `console.log` of raw values is a bug.
8. **Fail closed.** When uncertain, mask more, send less, or ask the user.
9. **No arbitrary code execution.** No `eval`, no JS-from-LLM, no downloads.

The LLM provider is behind the backend. Whatever provider is used only ever receives the gate-checked sanitized
payload, so swapping providers does not change the privacy boundary.

## Architecture

```
side panel (orchestrator, owns vault)            content script (top frame, localhost)
  task → sanitizer → vault ─────────────┐          snapshot → raw IR (no values)
  raw IR ← sendMessage ─────────────────┼────────  execute(type/click/select/scroll) → settle → local verify
  sanitizeSnapshot → payload builder    │
  egress gate → egress client ──POST /plan──► FastAPI server ──► LLM provider (structured JSON)
  zod-validate response (V1)            │        └ /telemetry/events → SSE → dashboard (read-only)
  validator + taint + confirm → resolve placeholder locally → execute ─┘
```

| Path | Part | Notes |
|---|---|---|
| `extension/` | A. VEIL extension (the agent) | TS, esbuild → `extension/dist/`. Generic primitives only. |
| `demo-site/` | B. Test fixture (:8080) | Static HTML/JS. VEIL must never special-case it. |
| `dashboard/` | C. Read-only observability app (:8090) | GET `/telemetry/state` + SSE `/telemetry/stream` only. Never controls the agent. |
| `server/` | D. FastAPI backend (:8000) | `/health`, `/plan` (planner), `/telemetry/*` relay (separate router, in-memory). |
| `scripts/` | Tooling | `check_leaks.py` (canary leak check), `e2e_cdp.mjs` (headless Chrome E2E driver). |
| `docs/` | `PROGRESS.md`, `ROADMAP.md` | Keep current at every milestone. |

**Extension (`extension/src/`):**
- `platform/chrome.ts`: the only module that touches `chrome.*`; `ensureContentScript()` is the single injection seam.
- `background/`: minimal service worker (opens the side panel; no state).
- `content/`: `dom.ts` (ids via WeakMap, visibility, accname chain, fingerprint), `snapshot.ts` (DOM → IR), `execute.ts` (native setter + events, click sequence, settle, verify).
- `sidepanel/`: `agent.ts` (the loop), `main.ts` (UI).
- `privacy/`: `normalize`, `detectors`, `checksums`, `sanitizer` (the single sanitizer + `scanStrict`), `vault`, `sanitized` (branded `SanitizedText`).
- `egress/`: `schema.ts` (closed zod schemas), `payload.ts` (sanitizeSnapshot + builder/pruning), `gate.ts` (G0–G7), `client.ts` (the only `fetch`; remediate-once-then-block).
- `policy/`: `validator.ts` (V1–V4, T1–T4, R1), `submitLike.ts`.
- `telemetry/`: event emitter (through the same egress client).
- `shared/`: `config.ts`, `ir.ts`, `actions.ts` (action/response schema), `messages.ts`, `fieldCategory.ts`, `zod.ts`.
- Reserved for later: `perception/`, `inference/` (do not stub).

**Server (`server/app/`):**
- `main.py` (`create_app`, CORS for dashboard GETs, payload logging).
- `schemas.py` (pydantic mirror of the extension schemas, `extra="forbid"`).
- `prompt.py` (`SYSTEM_PROMPT`, `build_user_message` with `<untrusted_page_data>`, `RESPONSE_SCHEMA`).
- `planner.py` (validate, then one repair, then 502).
- `providers.py` (`PlannerProvider` protocol + `GroqProvider`; **the provider seam**; bounded timeout/retry budget;
  provider-local strict-schema adaptation).
- `config.py` (`.env`).
- `telemetry.py` (relay).

## v0.1 scope

DOM-only private agent loop, end to end, for real. Actions: `click`, `type`, `select`, `scroll`, `wait`, `ask_user`,
`done`; `MAX_ACTIONS_PER_STEP = 1`, 15 steps max, 2 consecutive failures → `ask_user`.

**Deferred:**
- Visual stack (capture, ROI, ONNX, PP-OCRv5, YuNet, redaction).
- NER.
- WebGPU, Firefox, offscreen docs.
- iframes/shadow DOM beyond the generic snapshot.
- Per-origin runtime permissions, `storage.session`.
- `navigate`/`inspect` actions, batching.
- Benchmarks/canary suite.

**Never:** `chrome.debugger`, broad permissions.

## Dev rules

- **No fakes.** No hardcoded DOM, scripted LLM decisions, simulated actions or fabricated privacy results. A provider
  stub may exist **only in tests** (`ScriptedTestProvider` in `server/tests/`), unreachable from runtime. If something
  doesn't work, write it in `docs/PROGRESS.md`.
- **Generic primitives.** Nothing in `extension/` may reference demo-site ids, names, selectors, values or structure.
- **Fail closed.** Mask more / send less / ask the user.
- **No raw values in logs, telemetry or the dashboard.** Placeholders, categories, counts only.
- Outbound strings must be `SanitizedText` (branded type); only the sanitizer produces it.
- No validators that codegen (`ajv`, zod JIT): zod runs with `jitless: true`. **Ask before adding dependencies.**
- Don't change the architecture casually; stop and ask on a genuine incompatibility.
- Git: repo `origin` = github.com/MehulSharmaCode/Veil. **The user commits and pushes.** Don't commit unless asked.
- Never write API keys into files other than the user's own `server/.env` (gitignored). Don't add keys yourself.

## Running on macOS

```sh
make setup       # npm install, server/.venv + requirements, copies .env.example → server/.env if missing
# put the planner API key in server/.env yourself (GROQ_API_KEY; model/effort via VEIL_MODEL/VEIL_EFFORT)

make dev         # builds extension, then server :8000 + demo :8080 + dashboard :8090 (Ctrl-C stops all)
make ext         # rebuild extension → extension/dist   (make ext-watch; static/ copied only at start)

make test        # tsc --noEmit + vitest + pytest
make leaks       # scripts/check_leaks.py --telemetry (needs server running for the telemetry part)
```

Load the extension: `chrome://extensions` → Developer mode → **Load unpacked** → `extension/dist`. Open the demo tab,
click the toolbar icon to open the side panel.

Headless E2E (dev tool, no deps, real extension + real backend/LLM, needs servers running and a built extension):
```sh
node scripts/e2e_cdp.mjs --snapshot            # sanitized IR of the demo page
node scripts/e2e_cdp.mjs --exec-check          # executor primitives (harness messages the content script directly)
node scripts/e2e_cdp.mjs --dashboard --task "…" [--confirm allow|deny] [--answer "…"] [--stop-after-ms N] [--close-panel-after-ms N]
```
It opens `sidepanel.html` as a tab next to the active demo tab (same code path as the real panel), uses a throwaway
profile and CDP `Extensions.loadUnpacked` (Chrome ≥137 ignores `--load-extension`). The harness may know demo-site
specifics; the extension may not.

Planner URL and telemetry relay URL are configured separately (`extension/src/shared/config.ts`). Both are
`localhost:8000` in v0.1; in the final system **telemetry must stay local even if the planner is remote**.

## MV3 gotchas

- After reloading the extension, reload open demo tabs, otherwise messages fail with "Receiving end does not exist".
  (`ensureContentScript()` also re-injects via `scripting` as a fallback.)
- Extension pages can `fetch` the backend only if its origin is in `host_permissions` (`http://localhost/*`,
  `http://127.0.0.1/*`). The server still needs CORS for the dashboard origin.
- The service worker can be terminated at any time, so it holds no state. All agent state lives in the side panel.
- Closing the side panel destroys its JS context → agent stops, vault gone (the kill switch). The Stop button also clears the vault.
- Extension CSP forbids `eval`/`new Function`, hence zod `jitless`.
