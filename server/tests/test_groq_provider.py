"""GroqProvider tests. All HTTP goes to an in-process httpx.MockTransport: no network, no real key."""

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
from app.main import create_app
from app.planner import PlanningFailed, plan
from app.prompt import RESPONSE_SCHEMA, SYSTEM_PROMPT
from app.providers import CALL_BUDGET_S, GROQ_CHAT_URL, ChatTurn, GroqProvider, ProviderError, adapt_schema_for_groq
from app.schemas import PlannerPayload

from test_server import GOOD, VALID_PAYLOAD

FAKE_KEY = "test-key-not-real"


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.t

    def sleep(self, s: float) -> None:
        self.sleeps.append(s)
        self.t += s


def completion(content: str | None, finish: str = "stop", **message: Any) -> dict[str, Any]:
    return {"choices": [{"index": 0, "finish_reason": finish, "message": {"role": "assistant", "content": content, **message}}]}


def make(handler: Callable[[httpx.Request], httpx.Response], clock: Clock | None = None, **kw: Any) -> tuple[GroqProvider, list[httpx.Request], Clock]:
    clock = clock or Clock()
    seen: list[httpx.Request] = []

    def record(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        return handler(req)

    p = GroqProvider(FAKE_KEY, "openai/gpt-oss-20b", "medium", transport=httpx.MockTransport(record), clock=clock, sleep=clock.sleep, **kw)
    return p, seen, clock


def call(p: GroqProvider) -> str:
    return p.complete_json(SYSTEM_PROMPT, [ChatTurn("user", "hello")], RESPONSE_SCHEMA)


# ---- initialization / configuration -------------------------------------------------------------


def test_invalid_effort_rejected() -> None:
    with pytest.raises(ValueError):
        GroqProvider(FAKE_KEY, "openai/gpt-oss-20b", "max")


def test_settings_read_groq_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GROQ_API_KEY", " k ")
    monkeypatch.delenv("VEIL_MODEL", raising=False)
    monkeypatch.delenv("VEIL_EFFORT", raising=False)
    s = config.load_settings()
    assert s.groq_api_key == "k" and s.planner_configured
    assert s.model == "openai/gpt-oss-20b" and s.effort == "medium"
    monkeypatch.setenv("GROQ_API_KEY", "")
    assert not config.load_settings().planner_configured


def test_create_app_builds_groq_provider(tmp_path: Path) -> None:
    s = Settings(FAKE_KEY, "openai/gpt-oss-20b", "medium", False, tmp_path / "p.jsonl", [])
    health = TestClient(create_app(s)).get("/health").json()
    assert health == {"status": "ok", "planner_configured": True, "provider": "groq", "model": "openai/gpt-oss-20b", "effort": "medium"}


def test_budget_fits_extension_deadline() -> None:
    # planner.plan() makes at most two provider calls (one repair); the extension aborts /plan at 60 s.
    assert 2 * CALL_BUDGET_S < 60


# ---- request shape / valid response ------------------------------------------------------------


def test_request_uses_strict_json_schema_and_effort() -> None:
    p, seen, _ = make(lambda r: httpx.Response(200, json=completion(GOOD)))
    assert call(p) == GOOD
    req = seen[0]
    assert str(req.url) == GROQ_CHAT_URL and req.method == "POST"
    assert req.headers["authorization"] == f"Bearer {FAKE_KEY}"
    body = json.loads(req.content)
    assert body["model"] == "openai/gpt-oss-20b"
    assert body["reasoning_effort"] == "medium"
    assert body["stream"] is False
    wire_schema, _ = adapt_schema_for_groq(RESPONSE_SCHEMA)
    assert body["response_format"] == {"type": "json_schema", "json_schema": {"name": "veil_plan", "strict": True, "schema": wire_schema}}
    assert body["messages"] == [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": "hello"}]


def test_wire_schema_meets_strict_mode_rules() -> None:
    # Groq strict mode: every object lists all properties as required and sets additionalProperties false,
    # and anyOf object variants must have distinct discriminator values (a real API 400 otherwise).
    wire_schema, _ = adapt_schema_for_groq(RESPONSE_SCHEMA)

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            if node.get("type") == "object":
                assert node["additionalProperties"] is False
                assert sorted(node["required"]) == sorted(node["properties"])
            if "anyOf" in node:
                tags = [v["properties"]["type"]["enum"][0] for v in node["anyOf"] if v.get("type") == "object"]
                assert len(tags) == len(set(tags)), tags
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(wire_schema)


def test_adaptation_merges_only_overlapping_variants_and_keeps_canonical_schema() -> None:
    before = copy.deepcopy(RESPONSE_SCHEMA)
    wire_schema, merged = adapt_schema_for_groq(RESPONSE_SCHEMA)
    assert RESPONSE_SCHEMA == before  # canonical contract untouched
    assert merged == {"scroll": {"direction", "amount_px", "target"}}
    variants = wire_schema["properties"]["actions"]["items"]["anyOf"]
    canonical = RESPONSE_SCHEMA["properties"]["actions"]["items"]["anyOf"]
    assert [v["properties"]["type"]["enum"][0] for v in variants] == ["click", "type", "select", "scroll", "wait", "ask_user", "done"]
    assert [v for v in variants if v["properties"]["type"]["enum"] != ["scroll"]] == [v for v in canonical if v["properties"]["type"]["enum"] != ["scroll"]]
    scroll = variants[3]["properties"]
    assert scroll["target"] == {"type": ["string", "null"]}
    assert scroll["amount_px"] == {"type": ["integer", "null"]}
    assert scroll["direction"] == {"type": ["string", "null"], "enum": ["up", "down", None]}


def plan_with_output(action: dict[str, Any], then: str | None = None) -> Any:
    outputs = [json.dumps({"status": "continue", "actions": [action], "message": "m"})] + ([then] if then else [])
    p, seen, _ = make(lambda r: httpx.Response(200, json=completion(outputs.pop(0))))
    return plan(PlannerPayload.model_validate(VALID_PAYLOAD), p), seen


@pytest.mark.parametrize(
    "wire, canonical",
    [
        ({"type": "scroll", "direction": None, "amount_px": None, "target": "e4"}, {"type": "scroll", "target": "e4"}),
        ({"type": "scroll", "direction": "down", "amount_px": 600, "target": None}, {"type": "scroll", "direction": "down", "amount_px": 600}),
    ],
)
def test_merged_scroll_output_maps_back_to_canonical_action(wire: dict[str, Any], canonical: dict[str, Any]) -> None:
    result, seen = plan_with_output(wire)
    assert len(seen) == 1
    assert result.actions[0].model_dump() == canonical


@pytest.mark.parametrize(
    "wire",
    [
        {"type": "scroll", "direction": None, "amount_px": None, "target": None},  # neither form
        {"type": "scroll", "direction": "down", "amount_px": 600, "target": "e4"},  # both forms
        {"type": "scroll", "direction": "down", "amount_px": None, "target": None},  # incomplete scroll-by
        {"type": "click", "target": None},  # nulls are only dropped for merged variants
    ],
)
def test_invalid_merged_outputs_still_rejected_by_canonical_validation(wire: dict[str, Any]) -> None:
    result, seen = plan_with_output(wire, then=GOOD)
    assert len(seen) == 2  # rejected -> one repair attempt
    assert result.actions[0].type == "type"


def test_plan_through_groq_returns_validated_action() -> None:
    p, _, _ = make(lambda r: httpx.Response(200, json=completion(GOOD)))
    result = plan(PlannerPayload.model_validate(VALID_PAYLOAD), p)
    assert result.actions[0].model_dump() == {"type": "type", "target": "e4", "text": "[EMAIL_1]"}


def test_malformed_output_goes_through_planner_repair() -> None:
    outputs = [json.dumps({"status": "continue", "actions": [{"type": "wait", "ms": 99999}], "message": ""}), GOOD]
    p, seen, _ = make(lambda r: httpx.Response(200, json=completion(outputs.pop(0))))
    result = plan(PlannerPayload.model_validate(VALID_PAYLOAD), p)
    assert result.actions[0].type == "type"
    roles = [m["role"] for m in json.loads(seen[1].content)["messages"]]
    assert roles == ["system", "user", "assistant", "user"]


def test_malformed_output_twice_fails() -> None:
    p, _, _ = make(lambda r: httpx.Response(200, json=completion('{"status":"continue","actions":[{"type":"eval"}]')))
    with pytest.raises(PlanningFailed):
        plan(PlannerPayload.model_validate(VALID_PAYLOAD), p)


@pytest.mark.parametrize(
    "body, msg",
    [
        (completion(GOOD, finish="length"), "truncated"),
        (completion(GOOD, finish="content_filter"), "declined"),
        (completion(None, refusal="no"), "declined"),
        (completion(""), "no text output"),
        ({"unexpected": True}, "unexpected response"),
    ],
)
def test_unusable_completions(body: dict[str, Any], msg: str) -> None:
    p, seen, _ = make(lambda r: httpx.Response(200, json=body))
    with pytest.raises(ProviderError, match=msg):
        call(p)
    assert len(seen) == 1


def test_non_json_200_body() -> None:
    p, _, _ = make(lambda r: httpx.Response(200, text="<html>"))
    with pytest.raises(ProviderError, match="unexpected response"):
        call(p)


# ---- API errors, retries, timeouts -----------------------------------------------------------------


def test_auth_error_not_retried() -> None:
    p, seen, _ = make(lambda r: httpx.Response(401, json={"error": {"message": "Invalid API Key"}}))
    with pytest.raises(ProviderError, match="API key"):
        call(p)
    assert len(seen) == 1


def test_error_messages_never_echo_response_body() -> None:
    body = {"error": {"message": "schema mismatch", "failed_generation": "SECRET-ECHO [EMAIL_1]"}}
    p, seen, _ = make(lambda r: httpx.Response(400, json=body))
    with pytest.raises(ProviderError) as e:
        call(p)
    assert str(e.value) == "LLM provider error (HTTP 400)"
    assert len(seen) == 1


def test_schema_validation_400_is_retried_within_budget() -> None:
    # Groq answers 400 json_validate_failed when the model's output misses the strict schema: a
    # generation glitch (found live 2026-09-28), retried instead of failing the whole task.
    bad = httpx.Response(400, json={"error": {"code": "json_validate_failed", "message": "x", "failed_generation": "SECRET-ECHO"}})
    responses = [bad, httpx.Response(200, json=completion(GOOD))]
    p, seen, _ = make(lambda r: responses.pop(0))
    assert call(p) == GOOD and len(seen) == 2


def test_schema_validation_400_every_time_fails_without_echo(caplog: pytest.LogCaptureFixture) -> None:
    body = {"error": {"code": "json_validate_failed", "message": "schema", "failed_generation": "SECRET-ECHO [EMAIL_1]"}}
    p, seen, clock = make(lambda r: httpx.Response(400, json=body))
    with caplog.at_level("WARNING"), pytest.raises(ProviderError) as e:
        call(p)
    assert str(e.value).startswith("LLM output failed the response schema (gave up")
    assert len(seen) == 3 and clock.t - 1000.0 <= CALL_BUDGET_S
    assert "SECRET-ECHO" not in str(e.value) and "SECRET-ECHO" not in caplog.text
    assert "(json_validate_failed)" in caplog.text


def test_other_400_codes_are_not_retried() -> None:
    p, seen, _ = make(lambda r: httpx.Response(400, json={"error": {"code": "invalid_request_error Robert'); DROP", "message": "m"}}))
    with pytest.raises(ProviderError, match=r"^LLM provider error \(HTTP 400\)$"):
        call(p)
    assert len(seen) == 1


def test_rate_limit_waits_retry_after_then_succeeds() -> None:
    responses = [httpx.Response(429, headers={"retry-after": "3"}), httpx.Response(200, json=completion(GOOD))]
    p, seen, clock = make(lambda r: responses.pop(0))
    assert call(p) == GOOD
    assert clock.sleeps == [3.0] and len(seen) == 2


def test_rate_limit_beyond_budget_fails_fast() -> None:
    p, seen, clock = make(lambda r: httpx.Response(429, headers={"retry-after": "40"}))
    with pytest.raises(ProviderError, match=r"rate limit reached; retry in ~40 s"):
        call(p)
    assert clock.sleeps == [] and len(seen) == 1


def test_rate_limit_without_retry_after_fails() -> None:
    p, seen, _ = make(lambda r: httpx.Response(429))
    with pytest.raises(ProviderError, match="rate limit"):
        call(p)
    assert len(seen) == 1


def test_server_errors_retried_with_bounded_attempts() -> None:
    p, seen, clock = make(lambda r: httpx.Response(503))
    with pytest.raises(ProviderError, match=r"HTTP 503.*gave up"):
        call(p)
    assert len(seen) == 3
    assert clock.t - 1000.0 <= CALL_BUDGET_S


def test_server_error_then_success() -> None:
    responses = [httpx.Response(500), httpx.Response(200, json=completion(GOOD))]
    p, seen, _ = make(lambda r: responses.pop(0))
    assert call(p) == GOOD and len(seen) == 2


def test_timeouts_respect_call_budget() -> None:
    clock = Clock()
    timeouts: list[float] = []

    def handler(req: httpx.Request) -> httpx.Response:
        t = req.extensions["timeout"]["read"]
        timeouts.append(t)
        clock.t += t  # the attempt consumes its whole timeout
        raise httpx.ReadTimeout("timeout", request=req)

    p, seen, clock = make(handler, clock)
    with pytest.raises(ProviderError, match="timed out"):
        call(p)
    assert timeouts == [20.0, 5.0]  # second attempt gets only what is left of the 25 s budget
    assert clock.t - 1000.0 <= CALL_BUDGET_S


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
    # A provider failure is not repaired, so this is one call; the bound for two calls is asserted above.
    assert clock.t - 1000.0 <= CALL_BUDGET_S


def test_502_from_api_via_endpoint(tmp_path: Path) -> None:
    p, _, _ = make(lambda r: httpx.Response(401))
    s = Settings(FAKE_KEY, "openai/gpt-oss-20b", "medium", False, tmp_path / "p.jsonl", [])
    r = TestClient(create_app(s, p)).post("/plan", json=VALID_PAYLOAD)
    assert r.status_code == 502 and "API key" in r.json()["detail"]
