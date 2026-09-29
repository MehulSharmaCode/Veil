"""GeminiProvider tests. The official google-genai SDK runs for real, but its HTTP goes to an in-process
httpx.MockTransport: no network, no real key."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any, Callable

import httpx
import pytest
from fastapi.testclient import TestClient

from app import config
from app.config import Settings
from app.main import build_provider, create_app
from app.planner import PlanningFailed, plan
from app.prompt import RESPONSE_SCHEMA, SYSTEM_PROMPT
from app.providers import CALL_BUDGET_S, ChatTurn, GeminiProvider, ProviderError
from app.schemas import PlannerPayload

from test_server import GOOD, VALID_PAYLOAD

FAKE_KEY = "gemini-test-key-NOT-REAL-7f3a"
MODEL = "gemini-3.8-flash"


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.t

    def sleep(self, s: float) -> None:
        self.sleeps.append(s)
        self.t += s


def gen(text: str | None = None, finish: str = "STOP", parts: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """A generateContent response body."""
    return {
        "candidates": [{"content": {"role": "model", "parts": parts if parts is not None else [{"text": text}]}, "finishReason": finish, "index": 0}],
        "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 5},
        "modelVersion": MODEL,
    }


def gerr(code: int, status: str, message: str = "m", details: list[dict[str, Any]] | None = None, headers: dict[str, str] | None = None) -> httpx.Response:
    return httpx.Response(code, json={"error": {"code": code, "message": message, "status": status, "details": details or []}}, headers=headers)


def make(handler: Callable[[httpx.Request], httpx.Response], clock: Clock | None = None, **kw: Any) -> tuple[GeminiProvider, list[httpx.Request], Clock]:
    clock = clock or Clock()
    seen: list[httpx.Request] = []

    def record(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        return handler(req)

    p = GeminiProvider(FAKE_KEY, MODEL, "medium", transport=httpx.MockTransport(record), clock=clock, sleep=clock.sleep, **kw)
    return p, seen, clock


def call(p: GeminiProvider) -> str:
    return p.complete_json(SYSTEM_PROMPT, [ChatTurn("user", "hello")], RESPONSE_SCHEMA)


def gemini_settings(tmp_path: Path, key: str = FAKE_KEY, **kw: Any) -> Settings:
    return Settings("", kw.pop("model", MODEL), kw.pop("effort", "medium"), False, tmp_path / "p.jsonl", [], provider=kw.pop("provider", "gemini"), gemini_api_key=key)


# ---- configuration --------------------------------------------------------------------------------


def test_missing_key_rejected_by_provider() -> None:
    with pytest.raises(ValueError, match="GEMINI_API_KEY"):
        GeminiProvider("", MODEL)


def test_invalid_effort_rejected() -> None:
    with pytest.raises(ValueError, match="VEIL_EFFORT"):
        GeminiProvider(FAKE_KEY, MODEL, "max")


def test_settings_select_gemini_and_its_default_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VEIL_PROVIDER", " Gemini ")
    monkeypatch.setenv("GEMINI_API_KEY", " k ")
    monkeypatch.setenv("GROQ_API_KEY", "")
    monkeypatch.delenv("VEIL_MODEL", raising=False)
    monkeypatch.delenv("VEIL_EFFORT", raising=False)
    s = config.load_settings()
    assert (s.provider, s.model, s.effort, s.gemini_api_key) == ("gemini", "gemini-3.8-flash", "medium", "k")
    assert s.planner_configured and s.key_var == "GEMINI_API_KEY"
    monkeypatch.setenv("VEIL_MODEL", "gemini-3.7-flash")
    assert config.load_settings().model == "gemini-3.7-flash"


def test_settings_default_provider_is_unchanged(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("VEIL_PROVIDER", raising=False)
    monkeypatch.delenv("VEIL_MODEL", raising=False)
    monkeypatch.setenv("GROQ_API_KEY", "g")
    monkeypatch.setenv("GEMINI_API_KEY", "")
    s = config.load_settings()
    assert (s.provider, s.model, s.api_key) == ("groq", "openai/gpt-oss-20b", "g")


def test_selected_provider_needs_its_own_key(tmp_path: Path) -> None:
    # A Groq key does not configure Gemini (and vice versa): each provider only uses its own key.
    s = Settings("groq-key", MODEL, "medium", False, tmp_path / "p.jsonl", [], provider="gemini", gemini_api_key="")
    assert not s.planner_configured and build_provider(s) is None


def test_unknown_provider_refuses_to_start(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="VEIL_PROVIDER"):
        create_app(gemini_settings(tmp_path, provider="openai"))


def test_missing_gemini_key_is_503_and_names_the_variable(tmp_path: Path) -> None:
    client = TestClient(create_app(gemini_settings(tmp_path, key="")))
    health = client.get("/health").json()
    assert health == {"status": "ok", "planner_configured": False, "provider": None, "model": None, "effort": None}
    r = client.post("/plan", json=VALID_PAYLOAD)
    assert r.status_code == 503 and "GEMINI_API_KEY" in r.json()["detail"]


def test_create_app_builds_gemini_provider(tmp_path: Path) -> None:
    health = TestClient(create_app(gemini_settings(tmp_path))).get("/health").json()
    assert health == {"status": "ok", "planner_configured": True, "provider": "gemini", "model": MODEL, "effort": "medium"}


def test_budget_fits_extension_deadline() -> None:
    assert 2 * CALL_BUDGET_S < 60


# ---- request shape ----------------------------------------------------------------------------------


def test_request_is_stateless_generate_content_with_canonical_schema(monkeypatch: pytest.MonkeyPatch) -> None:
    # An ambient GOOGLE_API_KEY would win inside the SDK; the configured key is passed explicitly.
    monkeypatch.setenv("GOOGLE_API_KEY", "ambient-google-key-should-not-be-used")
    before = copy.deepcopy(RESPONSE_SCHEMA)
    p, seen, _ = make(lambda r: httpx.Response(200, json=gen(GOOD)))
    assert call(p) == GOOD
    req = seen[0]
    assert req.method == "POST"
    assert str(req.url) == f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
    assert req.headers["x-goog-api-key"] == FAKE_KEY
    body = json.loads(req.content)
    assert set(body) == {"contents", "systemInstruction", "generationConfig"}  # no tools, no cached content
    assert body["systemInstruction"]["parts"] == [{"text": SYSTEM_PROMPT}]
    assert body["contents"] == [{"role": "user", "parts": [{"text": "hello"}]}]
    cfg = body["generationConfig"]
    assert cfg["responseMimeType"] == "application/json"
    assert cfg["responseJsonSchema"] == RESPONSE_SCHEMA  # canonical schema, not adapted
    assert cfg["candidateCount"] == 1 and cfg["maxOutputTokens"] == 4096
    assert json.dumps(cfg["thinkingConfig"]) in ('{"thinkingLevel": "MEDIUM"}', '{"thinking_level": "MEDIUM"}')
    assert RESPONSE_SCHEMA == before
    assert req.extensions["timeout"]["read"] == 20.0


def test_repair_turn_is_sent_as_model_role() -> None:
    outputs = [json.dumps({"status": "continue", "actions": [{"type": "wait", "ms": 99999}], "message": ""}), GOOD]
    p, seen, _ = make(lambda r: httpx.Response(200, json=gen(outputs.pop(0))))
    result = plan(PlannerPayload.model_validate(VALID_PAYLOAD), p)
    assert result.actions[0].type == "type"
    roles = [c["role"] for c in json.loads(seen[1].content)["contents"]]
    assert roles == ["user", "model", "user"]


# ---- valid responses --------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "out",
    [
        {"status": "continue", "actions": [{"type": "type", "target": "e4", "text": "[EMAIL_1]"}], "message": "fill email"},
        {"status": "done", "actions": [{"type": "done", "summary": "Filled [EMAIL_1]"}], "message": "done"},
        {"status": "need_user", "actions": [{"type": "ask_user", "question": "Which address should I use?"}], "message": "ask"},
    ],
)
def test_plan_through_gemini_returns_validated_action(out: dict[str, Any]) -> None:
    p, seen, _ = make(lambda r: httpx.Response(200, json=gen(json.dumps(out))))
    result = plan(PlannerPayload.model_validate(VALID_PAYLOAD), p)
    assert result.model_dump(exclude_none=True) == out and len(seen) == 1


def test_thought_parts_are_not_part_of_the_answer() -> None:
    parts = [{"text": "I should type the email.", "thought": True}, {"text": GOOD}]
    p, _, _ = make(lambda r: httpx.Response(200, json=gen(parts=parts)))
    assert call(p) == GOOD


def test_answer_split_over_text_parts_is_joined() -> None:
    p, _, _ = make(lambda r: httpx.Response(200, json=gen(parts=[{"text": GOOD[:20]}, {"text": GOOD[20:]}])))
    assert call(p) == GOOD


def test_malformed_output_twice_fails() -> None:
    p, seen, _ = make(lambda r: httpx.Response(200, json=gen('{"status":"continue","actions":[{"type":"eval"}]')))
    with pytest.raises(PlanningFailed):
        plan(PlannerPayload.model_validate(VALID_PAYLOAD), p)
    assert len(seen) == 2  # one repair, no more


def test_schema_invalid_output_is_repaired_not_coerced() -> None:
    bad = json.dumps({"status": "continue", "actions": [{"type": "click", "target": "e4", "js": "alert(1)"}], "message": ""})
    outputs = [bad, GOOD]
    p, seen, _ = make(lambda r: httpx.Response(200, json=gen(outputs.pop(0))))
    assert plan(PlannerPayload.model_validate(VALID_PAYLOAD), p).actions[0].type == "type" and len(seen) == 2


# ---- unusable responses -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "body, msg",
    [
        (gen(GOOD, finish="MAX_TOKENS"), "truncated"),
        (gen(GOOD, finish="SAFETY"), "declined"),
        (gen(GOOD, finish="RECITATION"), "declined"),
        (gen(GOOD, finish="SOME_FUTURE_REASON"), "declined"),
        ({"promptFeedback": {"blockReason": "SAFETY"}}, "declined"),
        ({"candidates": []}, "unexpected response"),
        ({"usageMetadata": {}}, "unexpected response"),
        (gen(""), "no text output"),
        (gen(parts=[]), "no text output"),
        (gen(parts=[{"text": "thinking only", "thought": True}]), "no text output"),
    ],
)
@pytest.mark.filterwarnings("ignore:SOME_FUTURE_REASON is not a valid FinishReason")
def test_unusable_responses(body: dict[str, Any], msg: str) -> None:
    p, seen, _ = make(lambda r: httpx.Response(200, json=body))
    with pytest.raises(ProviderError, match=msg):
        call(p)
    assert len(seen) == 1


def test_non_json_200_body() -> None:
    p, seen, _ = make(lambda r: httpx.Response(200, text="<html>"))
    with pytest.raises(ProviderError, match="unexpected response"):
        call(p)
    assert len(seen) == 1


# ---- API errors, retries, timeouts -------------------------------------------------------------------------


@pytest.mark.parametrize(
    "resp",
    [
        lambda: gerr(400, "INVALID_ARGUMENT", "API key not valid.", [{"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": "API_KEY_INVALID", "domain": "googleapis.com"}]),
        lambda: gerr(403, "PERMISSION_DENIED"),
        lambda: gerr(401, "UNAUTHENTICATED"),
    ],
)
def test_auth_errors_not_retried(resp: Callable[[], httpx.Response]) -> None:
    p, seen, _ = make(lambda r: resp())
    with pytest.raises(ProviderError, match=r"rejected the API key \(check GEMINI_API_KEY"):
        call(p)
    assert len(seen) == 1


def test_other_400_not_retried_and_body_not_echoed() -> None:
    p, seen, _ = make(lambda r: gerr(400, "INVALID_ARGUMENT", "SECRET-ECHO [EMAIL_1] bad schema"))
    with pytest.raises(ProviderError) as e:
        call(p)
    assert str(e.value) == "LLM provider error (HTTP 400)" and len(seen) == 1


def test_unknown_model_is_a_clear_config_error() -> None:
    p, seen, _ = make(lambda r: gerr(404, "NOT_FOUND", "models/x is not found"))
    with pytest.raises(ProviderError, match="check VEIL_MODEL"):
        call(p)
    assert len(seen) == 1


def test_rate_limit_retry_after_header_within_budget() -> None:
    responses = [gerr(429, "RESOURCE_EXHAUSTED", headers={"retry-after": "3"}), httpx.Response(200, json=gen(GOOD))]
    p, seen, clock = make(lambda r: responses.pop(0))
    assert call(p) == GOOD
    assert clock.sleeps == [3.0] and len(seen) == 2


def test_rate_limit_retry_info_within_budget() -> None:
    info = [{"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "4.5s"}]
    responses = [gerr(429, "RESOURCE_EXHAUSTED", details=info), httpx.Response(200, json=gen(GOOD))]
    p, seen, clock = make(lambda r: responses.pop(0))
    assert call(p) == GOOD
    assert clock.sleeps == [4.5] and len(seen) == 2


def test_rate_limit_beyond_budget_fails_fast() -> None:
    info = [{"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "40s"}]
    p, seen, clock = make(lambda r: gerr(429, "RESOURCE_EXHAUSTED", details=info))
    with pytest.raises(ProviderError, match=r"rate limit reached; retry in ~40 s"):
        call(p)
    assert clock.sleeps == [] and len(seen) == 1


def test_daily_quota_exhausted_fails_fast_without_waiting() -> None:
    # Observed live 2026-09-29: the free tier's per-day quota (20 requests/day/model) answers 429 with a
    # RetryInfo of ~57 s. Waiting cannot help, so no wait and no "retry in ~57 s" hint.
    details = [
        {"@type": "type.googleapis.com/google.rpc.QuotaFailure", "violations": [{"quotaMetric": "generativelanguage.googleapis.com/generate_content_free_tier_requests", "quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier", "quotaValue": "20"}]},
        {"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "5s"},
    ]
    p, seen, clock = make(lambda r: gerr(429, "RESOURCE_EXHAUSTED", "You exceeded your current quota", details))
    with pytest.raises(ProviderError, match=r"^LLM provider daily request quota exhausted"):
        call(p)
    assert clock.sleeps == [] and len(seen) == 1


def test_per_minute_quota_still_waits_within_budget() -> None:
    details = [
        {"@type": "type.googleapis.com/google.rpc.QuotaFailure", "violations": [{"quotaId": "GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}]},
        {"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "2s"},
    ]
    responses = [gerr(429, "RESOURCE_EXHAUSTED", details=details), httpx.Response(200, json=gen(GOOD))]
    p, seen, clock = make(lambda r: responses.pop(0))
    assert call(p) == GOOD and clock.sleeps == [2.0] and len(seen) == 2


def test_rate_limit_without_retry_hint_fails() -> None:
    p, seen, _ = make(lambda r: gerr(429, "RESOURCE_EXHAUSTED"))
    with pytest.raises(ProviderError, match=r"^LLM provider rate limit reached$"):
        call(p)
    assert len(seen) == 1


@pytest.mark.parametrize("code, status", [(500, "INTERNAL"), (503, "UNAVAILABLE"), (504, "DEADLINE_EXCEEDED")])
def test_transient_error_then_success(code: int, status: str) -> None:
    responses = [gerr(code, status), httpx.Response(200, json=gen(GOOD))]
    p, seen, _ = make(lambda r: responses.pop(0))
    assert call(p) == GOOD and len(seen) == 2


def test_server_errors_retried_with_bounded_attempts() -> None:
    p, seen, clock = make(lambda r: gerr(503, "UNAVAILABLE"))
    with pytest.raises(ProviderError, match=r"HTTP 503.*gave up"):
        call(p)
    assert len(seen) == 3 and clock.t - 1000.0 <= CALL_BUDGET_S


def test_timeouts_respect_call_budget() -> None:
    clock = Clock()
    timeouts: list[float] = []

    def handler(req: httpx.Request) -> httpx.Response:
        t = req.extensions["timeout"]["read"]
        timeouts.append(t)
        clock.t += t  # the attempt consumes its whole timeout
        raise httpx.ReadTimeout("timeout", request=req)

    p, _, clock = make(handler, clock)
    with pytest.raises(ProviderError, match="timed out"):
        call(p)
    # 5 s would be left for a second attempt, under Gemini's 10 s minimum deadline: not started.
    assert timeouts == [20.0]
    assert clock.t - 1000.0 <= CALL_BUDGET_S


def test_no_attempt_below_gemini_minimum_deadline_keeps_the_real_error() -> None:
    # Found live 2026-09-29: two slow 503s left < 10 s, the third attempt carried a 5 s deadline and Gemini
    # answered 400 "Minimum allowed deadline is 10s", which hid the real error. Every attempt now gets
    # >= 10 s, and the error reported is the provider's own (503).
    clock = Clock()
    timeouts: list[float] = []

    def handler(req: httpx.Request) -> httpx.Response:
        timeouts.append(req.extensions["timeout"]["read"])
        clock.t += 9.0  # a slow 503
        return gerr(503, "UNAVAILABLE")

    p, seen, clock = make(handler, clock)
    with pytest.raises(ProviderError, match=r"^LLM provider error \(HTTP 503\) \(gave up within 25 s\)$"):
        call(p)
    assert all(t >= 10.0 for t in timeouts), timeouts
    assert len(seen) == 2 and clock.t - 1000.0 <= CALL_BUDGET_S


def test_connection_error_retried_then_fails() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down", request=req)

    p, seen, clock = make(handler)
    with pytest.raises(ProviderError, match="Could not reach"):
        call(p)
    assert len(seen) == 3 and clock.t - 1000.0 <= CALL_BUDGET_S


def test_worst_case_plan_stays_under_extension_deadline() -> None:
    clock = Clock()

    def handler(req: httpx.Request) -> httpx.Response:
        clock.t += req.extensions["timeout"]["read"]
        raise httpx.ReadTimeout("timeout", request=req)

    p, _, clock = make(handler, clock)
    with pytest.raises(PlanningFailed):
        plan(PlannerPayload.model_validate(VALID_PAYLOAD), p)
    assert clock.t - 1000.0 <= CALL_BUDGET_S


def test_provider_error_via_endpoint_is_502_without_action(tmp_path: Path) -> None:
    p, _, _ = make(lambda r: gerr(403, "PERMISSION_DENIED"))
    r = TestClient(create_app(gemini_settings(tmp_path), p)).post("/plan", json=VALID_PAYLOAD)
    assert r.status_code == 502 and "API key" in r.json()["detail"] and "actions" not in r.json()
