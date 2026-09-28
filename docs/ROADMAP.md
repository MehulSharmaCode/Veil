# VEIL Roadmap

> **Role of this file:** planned future phases and deferred scope.
> - What exists now is in `PROJECT_CONTEXT.md`.
> - Verification results are in `PROGRESS.md`.
> - History is in `CHANGELOG.md`.

## 1. v0.1 — DOM-only proof (current)
Real privacy-preserving agent loop on DOM-accessible content: snapshot → IR → sanitize → placeholders/vault → egress
gate → hosted LLM planner → local validation/taint/confirmation → local resolution → execution → verification.
Milestones M1–M8 are tracked in `PROGRESS.md`.

Status: M1–M7 done. **Phase 1 was frozen on 2026-09-28**, with documented manual limitations (`PROGRESS.md` →
"Live validation 2026-09-28"). M8 polish remains.
- **Done (1a):** planner provider swapped to Groq `openai/gpt-oss-20b` (server provider layer only, plus a
  provider-local strict-schema adaptation). Details are in `PROGRESS.md` → "Next session".
- **Done (1b, headless):**
  - live single-action, multi-step (`ask_user`) and Save/Deny runs;
  - real-provider leak check 0/9, after fixing a cue-less address leak the live run exposed.
- A resolved privacy bug from the live runs (cue-less address partially masked) is recorded in `PROGRESS.md` →
  "Security incident 2026-09-25 (resolved)".
- **Done (1c, 2026-09-28):**
  - live validation in a visible Chrome with the real side panel: tests A–G, including Stop and panel close;
  - `make leaks` 0/9;
  - freeze commit "Freeze Veil Phase 1".
- **Next:** M8 polish, then discuss the next phase with the user. Sections 2–5 are not started, and none of
  them, OCR/vision included, is started automatically.

## 2. Real-website compatibility
In order: controlled demo site → simple generic external site (harmless form) → dynamic React site → more complex sites.
Log problems in: React/controlled inputs, dynamic DOM, iframes & shadow DOM, unusual a11y markup, unstable ids, async
updates, login/session pages, cross-origin limits, `isTrusted` checks. Never live banking or government sites.
Needs: programmatic injection for user-granted origins (the `ensureContentScript()` seam).

## 3. Visual perception (need-to-see)
`regions[]` (`status: "unperceived"`) already flow through IR and payload. Add: need-to-see decision (`inspect` action)
→ screenshot capture → ROI crop → ONNX Runtime Web (WASM) → PP-OCRv5 det/rec + YuNet face detection → OCR lines into
the same sanitizer (`source: "ocr"`) → redaction. Pixel-free by default: only sanitized structured OCR leaves the device.
Code goes in `extension/src/perception/` and `extension/src/inference/`; WASM/models copied verbatim by the esbuild script.
Dashboard stages for `VISUAL_REGION_DETECTED`, `LOCAL_OCR_COMPLETE`, `REDACTION_APPLIED`, `PIXELS_WITHHELD` are registry-driven.

## 4. Safety hardening
Per-origin runtime permissions (`optional_host_permissions`), iframes/shadow DOM, stricter taint tracking,
adversarial tests (prompt injection in page text, placeholder smuggling, look-alike fields), NER-based detection.

## 5. Benchmarking and polish
Configs C1–C5 (e.g. raw-DOM baseline vs. sanitized vs. sanitized+visual), canary suite, latency/memory measurements,
task success rates.

## 6. Explicitly deferred (not in v0.1)
Visual stack; NER; WebGPU; Firefox; offscreen documents; iframes/shadow DOM beyond the generic snapshot; per-origin
runtime permission flow; `storage.session`; `navigate`/`inspect`; action batching; benchmark configs and advanced
canary infrastructure. **Never:** `chrome.debugger`, broad permissions (`<all_urls>`, `cookies`, `webRequest`).
