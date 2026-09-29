"""LLM provider adapters behind one seam (`PlannerProvider`). Two real implementations, selected by
`VEIL_PROVIDER`: Groq (OpenAI-compatible REST API via httpx) and Gemini (official `google-genai` SDK,
stateless `generateContent`). Test stubs live in tests/ only."""

from __future__ import annotations

import copy
import json
import logging
import re
import time
from dataclasses import dataclass
from typing import Any, Callable, Protocol

import httpx
from google import genai
from google.genai import errors as genai_errors
from google.genai import types as genai_types

log = logging.getLogger("veil")


class ProviderError(Exception):
    """Provider failed (network, auth, refusal, truncation). Message is safe to return to the client."""


@dataclass
class ChatTurn:
    role: str  # "user" | "assistant"
    content: str


class PlannerProvider(Protocol):
    name: str
    model: str

    def complete_json(self, system: str, turns: list[ChatTurn], schema: dict[str, Any]) -> str:
        """Return the raw JSON text produced under the provider's native structured-output mode."""
        ...


GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_EFFORTS = ("low", "medium", "high")  # reasoning_effort values documented for openai/gpt-oss-*

# Timing bounds. The extension aborts /plan after 60 s and planner.plan() may call the provider twice
# (one repair), so one complete_json call must finish within 25 s including retries and waits.
ATTEMPT_TIMEOUT_S = 20.0
CALL_BUDGET_S = 25.0
MAX_ATTEMPTS = 3
BACKOFF_S = 1.0
MIN_ATTEMPT_S = 2.0  # don't start an attempt with less time than this left


class GroqProvider:
    """Groq chat completions with strict JSON Schema structured output.

    Only the gate-checked, sanitized prompt is sent. Error messages never include request or
    response content (only status codes), and nothing from the request/response is logged.
    """

    name = "groq"

    def __init__(
        self,
        api_key: str,
        model: str,
        effort: str = "medium",
        *,
        max_completion_tokens: int = 4096,
        attempt_timeout_s: float = ATTEMPT_TIMEOUT_S,
        call_budget_s: float = CALL_BUDGET_S,
        max_attempts: int = MAX_ATTEMPTS,
        transport: httpx.BaseTransport | None = None,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if effort not in GROQ_EFFORTS:
            raise ValueError(f"VEIL_EFFORT must be one of {', '.join(GROQ_EFFORTS)}")
        self.model = model
        self.effort = effort
        self.max_completion_tokens = max_completion_tokens
        self.attempt_timeout_s = attempt_timeout_s
        self.call_budget_s = call_budget_s
        self.max_attempts = max_attempts
        self._clock = clock
        self._sleep = sleep
        self._client = httpx.Client(
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            transport=transport,
        )

    def _body(self, system: str, turns: list[ChatTurn], schema: dict[str, Any]) -> dict[str, Any]:
        return {
            "model": self.model,
            "messages": [{"role": "system", "content": system}, *({"role": t.role, "content": t.content} for t in turns)],
            "response_format": {"type": "json_schema", "json_schema": {"name": "veil_plan", "strict": True, "schema": schema}},
            "reasoning_effort": self.effort,
            "max_completion_tokens": self.max_completion_tokens,
            "stream": False,
        }

    def complete_json(self, system: str, turns: list[ChatTurn], schema: dict[str, Any]) -> str:
        wire_schema, merged = adapt_schema_for_groq(schema)
        return restore_merged_variants(self._request(self._body(system, turns, wire_schema)), merged)

    def _request(self, body: dict[str, Any]) -> str:
        deadline = self._clock() + self.call_budget_s
        last_error = "Could not reach the LLM provider"

        for attempt in range(1, self.max_attempts + 1):
            remaining = deadline - self._clock()
            if remaining < MIN_ATTEMPT_S:
                break
            try:
                r = self._client.post(GROQ_CHAT_URL, json=body, timeout=min(self.attempt_timeout_s, remaining))
            except httpx.TimeoutException:
                last_error = "LLM provider timed out"
                log.warning("groq attempt %d: timeout", attempt)
                continue
            except httpx.HTTPError:
                last_error = "Could not reach the LLM provider"
                log.warning("groq attempt %d: connection error", attempt)
                self._wait(BACKOFF_S, deadline)
                continue

            if r.status_code == 200:
                return self._extract(r)

            code = _error_code(r)
            log.warning("groq attempt %d: HTTP %d%s", attempt, r.status_code, f" ({code})" if code else "")
            if r.status_code == 401:
                raise ProviderError("LLM provider rejected the API key (check GROQ_API_KEY in server/.env)")
            if r.status_code == 429:
                wait = _retry_after(r)
                if wait is None or not self._wait(wait, deadline):
                    hint = f"; retry in ~{int(wait + 0.999)} s" if wait is not None else ""
                    raise ProviderError(f"LLM provider rate limit reached{hint}")
                last_error = "LLM provider rate limit reached"
                continue
            if r.status_code in (498, 500, 502, 503, 504):
                last_error = f"LLM provider error (HTTP {r.status_code})"
                self._wait(BACKOFF_S, deadline)
                continue
            if r.status_code == 400 and code == "json_validate_failed":
                # The model's output failed Groq's strict-schema check: a generation glitch, not a bad
                # request. Retry within the same budget (the body holds model output: never echoed).
                last_error = "LLM output failed the response schema"
                continue
            # 400/403/404/413/422 etc.: not retryable. Never echo the body (it may contain model output).
            raise ProviderError(f"LLM provider error (HTTP {r.status_code})")

        raise ProviderError(f"{last_error} (gave up within {int(self.call_budget_s)} s)")

    def _wait(self, seconds: float, deadline: float) -> bool:
        """Sleep if the wait still leaves time for another attempt; otherwise don't sleep."""
        if self._clock() + seconds + MIN_ATTEMPT_S > deadline:
            return False
        self._sleep(seconds)
        return True

    @staticmethod
    def _extract(r: httpx.Response) -> str:
        try:
            choice = r.json()["choices"][0]
            message = choice["message"]
        except (ValueError, KeyError, IndexError, TypeError) as e:
            raise ProviderError("LLM provider returned an unexpected response") from e
        finish = choice.get("finish_reason")
        if message.get("refusal"):
            raise ProviderError("The model declined to plan this step")
        if finish == "length":
            raise ProviderError("The model's response was truncated")
        if finish == "content_filter":
            raise ProviderError("The model declined to plan this step")
        content = message.get("content")
        if not isinstance(content, str) or not content.strip():
            raise ProviderError("The model returned no text output")
        return content


def _discriminator(variant: Any) -> str | None:
    """The single `type` value of an object variant (`{"type": {"enum": [v]}}`), if it has one."""
    if not isinstance(variant, dict) or variant.get("type") != "object":
        return None
    enum = (variant.get("properties") or {}).get("type", {}).get("enum")
    return enum[0] if isinstance(enum, list) and len(enum) == 1 else None


def _nullable(s: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(s)
    if isinstance(out.get("type"), str):
        out["type"] = [out["type"], "null"]
    else:
        return {"anyOf": [out, {"type": "null"}]}
    if "enum" in out:
        out["enum"] = [*out["enum"], None]
    return out


def adapt_schema_for_groq(schema: dict[str, Any]) -> tuple[dict[str, Any], dict[str, set[str]]]:
    """Groq strict mode rejects `anyOf` object variants that share a discriminator value (observed:
    HTTP 400 "anyOf disambiguation failed: overlapping discriminator value"). Merge such variants into
    one whose non-shared properties are nullable (still required, as strict mode demands). Returns the
    wire schema and, per merged discriminator value, the nullable keys so outputs can be mapped back.
    The canonical schema is not modified."""
    merged: dict[str, set[str]] = {}

    def walk(node: Any) -> Any:
        if isinstance(node, list):
            return [walk(v) for v in node]
        if not isinstance(node, dict):
            return node
        out = {k: walk(v) for k, v in node.items()}
        variants = out.get("anyOf")
        if isinstance(variants, list):
            groups: dict[str, list[dict[str, Any]]] = {}
            for v in variants:
                d = _discriminator(v)
                if d is not None:
                    groups.setdefault(d, []).append(v)
            new_variants: list[Any] = []
            for v in variants:
                d = _discriminator(v)
                if d is None or len(groups[d]) == 1:
                    new_variants.append(v)
                elif v is groups[d][0]:
                    new_variants.append(_merge(d, groups[d], merged))
            out["anyOf"] = new_variants
        return out

    return walk(schema), merged


def _merge(d: str, group: list[dict[str, Any]], merged: dict[str, set[str]]) -> dict[str, Any]:
    props: dict[str, Any] = {}
    for v in group:
        for k, s in v["properties"].items():
            if k in props and props[k] != s:
                raise ValueError(f"cannot merge '{d}' variants: conflicting definitions of '{k}'")
            props[k] = s
    shared = set.intersection(*(set(v["properties"]) for v in group))
    nullable = set(props) - shared
    merged[d] = nullable
    props = {k: (_nullable(s) if k in nullable else s) for k, s in props.items()}
    return {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}


def restore_merged_variants(raw: str, merged: dict[str, set[str]]) -> str:
    """Inverse of adapt_schema_for_groq on the output: drop the null placeholders of merged variants so
    the canonical validators (pydantic here, zod in the extension) judge the canonical shape. Anything
    that is not valid JSON is returned unchanged (the planner's repair path handles it)."""
    if not merged:
        return raw
    try:
        data = json.loads(raw)
    except ValueError:
        return raw

    def walk(node: Any) -> Any:
        if isinstance(node, list):
            return [walk(v) for v in node]
        if not isinstance(node, dict):
            return node
        keys = merged.get(node.get("type")) if isinstance(node.get("type"), str) else None
        return {k: walk(v) for k, v in node.items() if not (keys and k in keys and v is None)}

    return json.dumps(walk(data), ensure_ascii=False)


_CODE_RE = re.compile(r"^[a-z_]{1,40}$")


def _error_code(r: httpx.Response) -> str | None:
    """Groq's machine-readable `error.code` (an identifier like "json_validate_failed"), else None.
    Only an identifier-shaped value is returned; nothing else from the body is read or kept."""
    try:
        code = r.json().get("error", {}).get("code")
    except (ValueError, AttributeError):
        return None
    return code if isinstance(code, str) and _CODE_RE.match(code) else None


def _retry_after(r: httpx.Response) -> float | None:
    try:
        v = float(r.headers.get("retry-after", ""))
    except ValueError:
        return None
    return v if v >= 0 else None


# ---- Gemini -------------------------------------------------------------------------------------

GEMINI_EFFORTS = ("low", "medium", "high")  # thinking_level values documented for gemini-3.x Flash
# Retryable per the Gemini API error guide: 429 RESOURCE_EXHAUSTED (handled separately), 408 and 5xx.
GEMINI_RETRYABLE = (408, 500, 502, 503, 504)
# Gemini answers an invalid key with HTTP 400 INVALID_ARGUMENT and an ErrorInfo reason, not with 401.
GEMINI_KEY_REASONS = ("API_KEY_INVALID", "API_KEY_SERVICE_BLOCKED", "API_KEY_HTTP_REFERRER_BLOCKED")
# The Gemini API rejects a request whose server deadline is under 10 s with HTTP 400 INVALID_ARGUMENT
# ("Manually set deadline 5s is too short. Minimum allowed deadline is 10s.", observed live 2026-09-29),
# so an attempt is only started, or waited for, when at least this much of the call budget is left.
GEMINI_MIN_DEADLINE_S = 10.0
_RETRY_DELAY_RE = re.compile(r"^(\d{1,5}(?:\.\d{1,9})?)s$")


class GeminiProvider:
    """Gemini `generateContent` (stateless: nothing is stored server-side for later turns) with the
    canonical response JSON Schema as `response_json_schema`, through the official `google-genai` SDK.

    Same contract as GroqProvider: only the gate-checked, sanitized prompt is sent; error messages are
    fixed strings plus status codes, never request/response content; the SDK's own retries and automatic
    function calling are off, so this class alone decides attempts, waits and timeouts, within the same
    budget (ATTEMPT_TIMEOUT_S / CALL_BUDGET_S / MAX_ATTEMPTS)."""

    name = "gemini"

    def __init__(
        self,
        api_key: str,
        model: str,
        effort: str = "medium",
        *,
        max_output_tokens: int = 4096,
        attempt_timeout_s: float = ATTEMPT_TIMEOUT_S,
        call_budget_s: float = CALL_BUDGET_S,
        max_attempts: int = MAX_ATTEMPTS,
        transport: httpx.BaseTransport | None = None,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if not api_key:
            raise ValueError("GEMINI_API_KEY is empty")
        if effort not in GEMINI_EFFORTS:
            raise ValueError(f"VEIL_EFFORT must be one of {', '.join(GEMINI_EFFORTS)}")
        self.model = model
        self.effort = effort
        self.max_output_tokens = max_output_tokens
        self.attempt_timeout_s = attempt_timeout_s
        self.call_budget_s = call_budget_s
        self.max_attempts = max_attempts
        self._clock = clock
        self._sleep = sleep
        # The key is passed explicitly: the SDK would otherwise prefer GOOGLE_API_KEY from the environment.
        self._client = genai.Client(
            api_key=api_key,
            http_options=genai_types.HttpOptions(
                retry_options=genai_types.HttpRetryOptions(attempts=1),
                client_args={"transport": transport} if transport is not None else None,
            ),
        )

    def _config(self, system: str, schema: dict[str, Any], timeout_s: float) -> genai_types.GenerateContentConfig:
        return genai_types.GenerateContentConfig(
            system_instruction=system,
            response_mime_type="application/json",
            response_json_schema=schema,  # the canonical schema, unmodified
            thinking_config=genai_types.ThinkingConfig(thinking_level=self.effort.upper()),
            max_output_tokens=self.max_output_tokens,
            candidate_count=1,
            automatic_function_calling=genai_types.AutomaticFunctionCallingConfig(disable=True),
            http_options=genai_types.HttpOptions(timeout=max(1, int(timeout_s * 1000))),
        )

    @staticmethod
    def _contents(turns: list[ChatTurn]) -> list[genai_types.Content]:
        return [genai_types.Content(role="model" if t.role == "assistant" else "user", parts=[genai_types.Part(text=t.content)]) for t in turns]

    def complete_json(self, system: str, turns: list[ChatTurn], schema: dict[str, Any]) -> str:
        contents = self._contents(turns)
        deadline = self._clock() + self.call_budget_s
        last_error = "Could not reach the LLM provider"

        for attempt in range(1, self.max_attempts + 1):
            remaining = deadline - self._clock()
            if remaining < GEMINI_MIN_DEADLINE_S:
                break
            config = self._config(system, schema, min(self.attempt_timeout_s, remaining))
            try:
                response = self._client.models.generate_content(model=self.model, contents=contents, config=config)
            except httpx.TimeoutException:
                last_error = "LLM provider timed out"
                log.warning("gemini attempt %d: timeout", attempt)
                continue
            except httpx.HTTPError:
                last_error = "Could not reach the LLM provider"
                log.warning("gemini attempt %d: connection error", attempt)
                self._wait(BACKOFF_S, deadline)
                continue
            except genai_errors.APIError as e:
                # str(e) embeds the response body (it may contain model output): only the numeric code and
                # identifier-shaped status/reason are read, and only those are logged.
                code = e.code if isinstance(e.code, int) else 0
                status = _identifier(e.status)
                reason = _gemini_reason(e.details)
                log.warning("gemini attempt %d: HTTP %d%s%s", attempt, code, f" ({status})" if status else "", f" [{reason}]" if reason else "")
                if code in (401, 403) or reason in GEMINI_KEY_REASONS:
                    raise ProviderError("LLM provider rejected the API key (check GEMINI_API_KEY in server/.env)") from None
                if code == 429:
                    if _gemini_daily_quota(e.details):
                        # A per-day quota (the free tier allows 20 requests/day/model): waiting cannot help,
                        # whatever retryDelay says.
                        raise ProviderError("LLM provider daily request quota exhausted (see ai.dev/rate-limit)") from None
                    wait = _gemini_retry_after(e)
                    if wait is None or not self._wait(wait, deadline):
                        hint = f"; retry in ~{int(wait + 0.999)} s" if wait is not None else ""
                        raise ProviderError(f"LLM provider rate limit reached{hint}") from None
                    last_error = "LLM provider rate limit reached"
                    continue
                if code in GEMINI_RETRYABLE:
                    last_error = f"LLM provider error (HTTP {code})"
                    self._wait(BACKOFF_S, deadline)
                    continue
                if code == 404:
                    raise ProviderError("LLM provider does not know this model (check VEIL_MODEL)") from None
                # 400 INVALID_ARGUMENT / FAILED_PRECONDITION etc.: not retryable.
                raise ProviderError(f"LLM provider error (HTTP {code})") from None
            except Exception as e:  # noqa: BLE001 - SDK parse/validation failures: fail closed, never echo
                log.warning("gemini attempt %d: unexpected %s", attempt, type(e).__name__)
                raise ProviderError("LLM provider returned an unexpected response") from None
            return self._extract(response)

        raise ProviderError(f"{last_error} (gave up within {int(self.call_budget_s)} s)")

    def _wait(self, seconds: float, deadline: float) -> bool:
        """Sleep if the wait still leaves time for another attempt (with Gemini's minimum deadline)."""
        if self._clock() + seconds + GEMINI_MIN_DEADLINE_S > deadline:
            return False
        self._sleep(seconds)
        return True

    @staticmethod
    def _extract(response: Any) -> str:
        """The model's answer text: the non-thought text parts of the single candidate. Anything else
        (a blocked prompt, a safety/recitation stop, truncation, no candidate, no text) is an error."""
        feedback = getattr(response, "prompt_feedback", None)
        if feedback is not None and getattr(feedback, "block_reason", None):
            raise ProviderError("The model declined to plan this step")
        candidates = getattr(response, "candidates", None)
        if not isinstance(candidates, list) or not candidates:
            raise ProviderError("LLM provider returned an unexpected response")
        candidate = candidates[0]
        finish = getattr(candidate.finish_reason, "value", candidate.finish_reason)
        if finish == "MAX_TOKENS":
            raise ProviderError("The model's response was truncated")
        if finish != "STOP":
            # SAFETY, RECITATION, BLOCKLIST, PROHIBITED_CONTENT, SPII, OTHER, unknown future values…
            raise ProviderError("The model declined to plan this step")
        parts = getattr(candidate.content, "parts", None) or []
        text = "".join(p.text for p in parts if isinstance(getattr(p, "text", None), str) and not getattr(p, "thought", False))
        if not text.strip():
            raise ProviderError("The model returned no text output")
        return text


_IDENT_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")


def _identifier(v: Any) -> str | None:
    """An UPPER_SNAKE identifier (a gRPC status or ErrorInfo reason), else None. Nothing else is kept."""
    return v if isinstance(v, str) and _IDENT_RE.match(v) else None


def _gemini_details(details: Any) -> list[Any]:
    error = details.get("error") if isinstance(details, dict) else None
    items = error.get("details") if isinstance(error, dict) else None
    return items if isinstance(items, list) else []


def _gemini_reason(details: Any) -> str | None:
    """The `reason` of a google.rpc.ErrorInfo detail (e.g. API_KEY_INVALID), if identifier-shaped."""
    for d in _gemini_details(details):
        if isinstance(d, dict) and str(d.get("@type", "")).endswith("google.rpc.ErrorInfo"):
            return _identifier(d.get("reason"))
    return None


_QUOTA_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,120}$")


def _gemini_daily_quota(details: Any) -> bool:
    """Whether a 429's google.rpc.QuotaFailure names a per-day quota (e.g.
    GenerateRequestsPerDayPerProjectPerModel-FreeTier). Only identifier-shaped ids are inspected."""
    for d in _gemini_details(details):
        if isinstance(d, dict) and str(d.get("@type", "")).endswith("google.rpc.QuotaFailure"):
            for v in d.get("violations") or []:
                qid = v.get("quotaId") if isinstance(v, dict) else None
                if isinstance(qid, str) and _QUOTA_ID_RE.match(qid) and "PerDay" in qid:
                    return True
    return False


def _gemini_retry_after(e: genai_errors.APIError) -> float | None:
    """Seconds to wait from a 429: the `retry-after` header, else a google.rpc.RetryInfo `retryDelay`."""
    headers = getattr(getattr(e, "response", None), "headers", None)
    if headers is not None:
        try:
            v = float(headers.get("retry-after", ""))
            if v >= 0:
                return v
        except (TypeError, ValueError):
            pass
    for d in _gemini_details(e.details):
        if isinstance(d, dict) and str(d.get("@type", "")).endswith("google.rpc.RetryInfo"):
            m = _RETRY_DELAY_RE.match(str(d.get("retryDelay", "")))
            if m:
                return float(m.group(1))
    return None
