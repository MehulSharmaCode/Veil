"""LLM provider adapter. One real implementation (Groq, OpenAI-compatible REST API via httpx).
Test stubs live in tests/ only."""

from __future__ import annotations

import copy
import json
import logging
import time
from dataclasses import dataclass
from typing import Any, Callable, Protocol

import httpx

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

            log.warning("groq attempt %d: HTTP %d", attempt, r.status_code)
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


def _retry_after(r: httpx.Response) -> float | None:
    try:
        v = float(r.headers.get("retry-after", ""))
    except ValueError:
        return None
    return v if v >= 0 else None
