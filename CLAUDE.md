# VEIL — Privacy-Preserving Browser Agent

SIH 2026, problem statement **SIH26171: On-device Visual Perception for Light-weight Browser Agents**.

VEIL is a Chrome MV3 extension that performs web tasks for a user ("fill my email and address, don't submit")
without sending the user's sensitive data to any server. The extension reads the page locally, replaces sensitive
values with typed placeholders (`[EMAIL_1]`), sends only a sanitized page description to a backend, which asks a hosted
LLM to plan the next action. The extension validates that action locally, resolves placeholders to real values locally,
executes it in the page, and verifies the result.

**Final direction:** a local visual pipeline (on-device OCR + face detection with ONNX Runtime Web WASM, PP-OCRv5 and
YuNet) that perceives and redacts canvas/image regions only when their content is needed ("need-to-see").
**Not built in v0.1** — only seams exist (see `docs/ROADMAP.md`).

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

## Layout

| Path | Part | Notes |
|---|---|---|
| `extension/` | A. VEIL extension (the agent) | TS, esbuild → `extension/dist/`. Generic primitives only. |
| `demo-site/` | B. Test fixture (:8080) | Static HTML/JS. VEIL must never special-case it. |
| `dashboard/` | C. Read-only observability app (:8090) | Consumes telemetry SSE. Never controls the agent. |
| `server/` | D. FastAPI backend (:8000) | `/plan` (LLM planner) + `/telemetry/*` relay (separate router). |
| `scripts/` | Tooling | `check_leaks.py`, dev helpers. |
| `docs/` | `PROGRESS.md`, `ROADMAP.md` | Keep current at every milestone. |

Extension module map (`extension/src/`): `platform/` (only place that touches `chrome.*`), `background/` (minimal SW),
`content/` (snapshot/IR, execute, settle), `sidepanel/` (UI + orchestrator), `privacy/` (normalize, detectors,
sanitizer, vault), `egress/` (payload builder, gate, client), `policy/` (action validator, taint, submit-like),
`telemetry/`, `shared/` (types, config). Reserved for later: `perception/`, `inference/` (do not stub).

## v0.1 scope

DOM-only private agent loop, end to end, for real. Actions: `click`, `type`, `select`, `scroll`, `wait`, `ask_user`,
`done`; `MAX_ACTIONS_PER_STEP = 1`. **Deferred:** visual stack (capture, ROI, ONNX, PP-OCRv5, YuNet, redaction),
NER, WebGPU, Firefox, offscreen docs, iframes/shadow DOM beyond the generic snapshot, per-origin runtime permissions,
`storage.session`, `navigate`/`inspect`, batching, benchmarks/canary suite. **Never:** `chrome.debugger`, broad permissions.

## Dev rules

- **No fakes.** No hardcoded DOM, scripted LLM decisions, simulated actions or fabricated privacy results. A provider
  stub may exist **only in tests**, named as such, unreachable from runtime. If something doesn't work, write it in `docs/PROGRESS.md`.
- **Generic primitives.** Nothing in `extension/` may reference demo-site ids, names, selectors, values or structure.
- **Fail closed.** Mask more / send less / ask the user.
- **No raw values in logs, telemetry or the dashboard.** Placeholders, categories, counts only.
- Outbound strings must be `SanitizedText` (branded type) — only the sanitizer produces it.
- No validators that codegen (`ajv`, zod JIT): zod runs with `jitless: true`. Ask before adding dependencies.
- Don't change the architecture casually; stop and ask on a genuine incompatibility.

## Running on macOS

```sh
# one-time
cd extension && npm install && cd ..
python3 -m venv server/.venv && server/.venv/bin/pip install -r server/requirements.txt
cp server/.env.example server/.env   # then set ANTHROPIC_API_KEY (+ optional VEIL_MODEL)

# each session (separate terminals, or `make dev`)
make server      # FastAPI on :8000
make demo        # demo site on :8080
make dashboard   # dashboard on :8090
make ext         # build extension → extension/dist (make ext-watch for rebuilds)

# tests
make test        # vitest + pytest
make leaks       # scripts/check_leaks.py over server/logs/received_payloads.jsonl
```

Load the extension: `chrome://extensions` → Developer mode → **Load unpacked** → `extension/dist`. Click the toolbar
icon to open the side panel on the demo tab.

Headless E2E (dev tool, no deps; real extension, real backend/LLM): `node scripts/e2e_cdp.mjs --snapshot`,
`--exec-check`, or `--task "…" [--confirm allow|deny] [--answer "…"] [--stop-after-ms N] [--close-panel-after-ms N] [--dashboard]`.
It uses a throwaway profile and CDP `Extensions.loadUnpacked` (Chrome ignores `--load-extension` since 137).

Telemetry relay URL and planner URL are configured separately (`extension/src/shared/config.ts`). In v0.1 both are
`localhost:8000`; in the final system **telemetry must stay local even if the planner is remote**.

## MV3 gotchas

- After reloading the extension, reload open demo tabs — otherwise the content script is gone and messages fail with
  "Receiving end does not exist". (VEIL also re-injects programmatically via `ensureContentScript()` as a fallback.)
- Extension pages can `fetch` the backend only if its origin is in `host_permissions`. The server still needs CORS for the dashboard origin.
- The service worker can be terminated at any time, so it holds no state. All agent state lives in the side panel.
- Closing the side panel destroys its JS context → agent stops and the vault is gone (the kill switch).
- Extension CSP forbids `eval`/`new Function` — hence zod `jitless`.
