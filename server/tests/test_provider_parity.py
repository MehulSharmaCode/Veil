"""Provider parity and leak tests: the same sanitized /plan request goes through the real GroqProvider and the
real GeminiProvider (each against an in-process mock of its API, no network) and must come out as the same
provider-neutral result. The seeded canary values of scripts/check_leaks.py are reused for the leak checks."""

from __future__ import annotations

import importlib.util
import json
import logging
from pathlib import Path
from typing import Any, Callable

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.planner import PlanningFailed, plan
from app.prompt import SYSTEM_PROMPT, build_user_message
from app.providers import GeminiProvider, GroqProvider, PlannerProvider, ProviderError
from app.schemas import PlannerPayload

from test_server import VALID_PAYLOAD

_spec = importlib.util.spec_from_file_location("check_leaks", Path(__file__).resolve().parents[2] / "scripts" / "check_leaks.py")
assert _spec and _spec.loader
check_leaks = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check_leaks)
SEEDS: dict[str, str] = check_leaks.SEEDS

GROQ_KEY = "groq-test-key-NOT-REAL-19c2"
GEMINI_KEY = "gemini-test-key-NOT-REAL-7f3a"
KEYS = {"groq-key": GROQ_KEY, "gemini-key": GEMINI_KEY}


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t

    def sleep(self, s: float) -> None:
        self.t += s


# ---- the two providers against mocks of their own wire formats --------------------------------------


def groq_ok(content: str) -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": content}}]})


def gemini_ok(content: str) -> httpx.Response:
    return httpx.Response(200, json={"candidates": [{"content": {"role": "model", "parts": [{"text": content}]}, "finishReason": "STOP"}]})


def to_groq_wire(out: dict[str, Any]) -> dict[str, Any]:
    """The same logical answer as Groq emits it under its merged-scroll wire schema (nulls for the
    other scroll form); GroqProvider maps it back to the canonical shape."""
    wire = json.loads(json.dumps(out))
    for a in wire["actions"]:
        if a["type"] == "scroll":
            for k in ("direction", "amount_px", "target"):
                a.setdefault(k, None)
    return wire


def make_groq(handler: Callable[[httpx.Request], httpx.Response]) -> tuple[GroqProvider, list[httpx.Request]]:
    seen: list[httpx.Request] = []
    clock = Clock()
    p = GroqProvider(GROQ_KEY, "openai/gpt-oss-20b", "medium", transport=httpx.MockTransport(lambda r: (seen.append(r), handler(r))[1]), clock=clock, sleep=clock.sleep)
    return p, seen


def make_gemini(handler: Callable[[httpx.Request], httpx.Response]) -> tuple[GeminiProvider, list[httpx.Request]]:
    seen: list[httpx.Request] = []
    clock = Clock()
    p = GeminiProvider(GEMINI_KEY, "gemini-3.8-flash", "medium", transport=httpx.MockTransport(lambda r: (seen.append(r), handler(r))[1]), clock=clock, sleep=clock.sleep)
    return p, seen


def sent_texts(provider: str, req: httpx.Request) -> tuple[str, list[tuple[str, str]]]:
    """(system text, [(neutral role, text), ...]) exactly as the provider put them on the wire."""
    body = json.loads(req.content)
    if provider == "groq":
        msgs = body["messages"]
        assert msgs[0]["role"] == "system"
        return msgs[0]["content"], [(m["role"], m["content"]) for m in msgs[1:]]
    system = "".join(p["text"] for p in body["systemInstruction"]["parts"])
    role = {"user": "user", "model": "assistant"}
    return system, [(role[c["role"]], "".join(p["text"] for p in c["parts"])) for c in body["contents"]]


ACTIONS: list[dict[str, Any]] = [
    {"status": "continue", "actions": [{"type": "type", "target": "e4", "text": "[EMAIL_1]"}], "message": "fill email"},
    {"status": "continue", "actions": [{"type": "click", "target": "e4"}], "message": "focus"},
    {"status": "continue", "actions": [{"type": "select", "target": "e4", "option": "India"}], "message": "pick"},
    {"status": "continue", "actions": [{"type": "scroll", "direction": "down", "amount_px": 600}], "message": "scroll by"},
    {"status": "continue", "actions": [{"type": "scroll", "target": "e4"}], "message": "scroll to"},
    {"status": "continue", "actions": [{"type": "wait", "ms": 500}], "message": "wait"},
    {"status": "need_user", "actions": [{"type": "ask_user", "question": "Which address should I use?"}], "message": "ask"},
    {"status": "done", "actions": [{"type": "done", "summary": "Filled [EMAIL_1]"}], "message": "done"},
]


@pytest.mark.parametrize("out", ACTIONS, ids=lambda o: f"{o['actions'][0]['type']}-{len(o['actions'][0])}")
def test_same_request_same_neutral_result(out: dict[str, Any]) -> None:
    payload = PlannerPayload.model_validate(VALID_PAYLOAD)
    groq, gseen = make_groq(lambda r: groq_ok(json.dumps(to_groq_wire(out))))
    gemini, mseen = make_gemini(lambda r: gemini_ok(json.dumps(out)))
    a, b = plan(payload, groq), plan(payload, gemini)
    assert type(a) is type(b)  # the same pydantic PlanResponse: no SDK object leaks out of a provider
    assert a.model_dump() == b.model_dump()
    assert a.model_dump(exclude_none=True) == out
    assert len(gseen) == len(mseen) == 1


def test_both_providers_send_exactly_the_same_prompt_text() -> None:
    # Gemini receives the same sanitized payload class Groq did: the system prompt and the user message
    # built from the gate-checked payload, nothing added. Including the repair turn.
    payload = PlannerPayload.model_validate(VALID_PAYLOAD)
    bad = json.dumps({"status": "continue", "actions": [{"type": "wait", "ms": 99999}], "message": "x"})
    good = json.dumps(ACTIONS[0])
    g_out, m_out = [bad, good], [bad, good]
    groq, gseen = make_groq(lambda r: groq_ok(g_out.pop(0)))
    gemini, mseen = make_gemini(lambda r: gemini_ok(m_out.pop(0)))
    plan(payload, groq)
    plan(payload, gemini)
    assert len(gseen) == len(mseen) == 2
    for i in range(2):
        assert sent_texts("groq", gseen[i]) == sent_texts("gemini", mseen[i])
    system, turns = sent_texts("gemini", mseen[0])
    assert system == SYSTEM_PROMPT and turns == [("user", build_user_message(payload))]


@pytest.mark.parametrize(
    "groq_resp, gemini_resp, msg",
    [
        (lambda: httpx.Response(503), lambda: httpx.Response(503, json={"error": {"code": 503, "status": "UNAVAILABLE"}}), r"^LLM provider error \(HTTP 503\) \(gave up within 25 s\)$"),
        (lambda: httpx.Response(429, headers={"retry-after": "40"}), lambda: httpx.Response(429, json={"error": {"code": 429, "status": "RESOURCE_EXHAUSTED"}}, headers={"retry-after": "40"}), r"^LLM provider rate limit reached; retry in ~40 s$"),
        (lambda: httpx.Response(200, json={"choices": [{"finish_reason": "length", "message": {"content": "{"}}]}), lambda: httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": "{"}]}, "finishReason": "MAX_TOKENS"}]}), r"^The model's response was truncated$"),
    ],
)
def test_same_failure_class_same_error(groq_resp: Callable[[], httpx.Response], gemini_resp: Callable[[], httpx.Response], msg: str) -> None:
    payload = PlannerPayload.model_validate(VALID_PAYLOAD)
    for p in (make_groq(lambda r: groq_resp())[0], make_gemini(lambda r: gemini_resp())[0]):
        with pytest.raises(PlanningFailed, match=msg):
            plan(payload, p)


# ---- seeded leak checks ------------------------------------------------------------------------------------


def leaks(name: str, text: str) -> list[str]:
    """check_leaks.py's own matcher (exact, lowercase, digits-only) plus the test API keys."""
    return check_leaks.scan(name, text, {**SEEDS, **KEYS})


def seeded_blob() -> str:
    return " | ".join(SEEDS.values())


def gemini_failures() -> list[Callable[[httpx.Request], httpx.Response]]:
    blob = seeded_blob()
    details = [{"@type": "type.googleapis.com/google.rpc.BadRequest", "fieldViolations": [{"description": blob}]}]

    def err(code: int, status: str) -> Callable[[httpx.Request], httpx.Response]:
        return lambda r: httpx.Response(code, json={"error": {"code": code, "message": blob, "status": status, "details": details}})

    def candidate(finish: str) -> Callable[[httpx.Request], httpx.Response]:
        return lambda r: httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": blob}]}, "finishReason": finish}]})

    def raise_(exc: type[httpx.HTTPError]) -> Callable[[httpx.Request], httpx.Response]:
        def h(r: httpx.Request) -> httpx.Response:
            raise exc(blob, request=r)

        return h

    return [
        err(400, "INVALID_ARGUMENT"), err(403, "PERMISSION_DENIED"), err(404, "NOT_FOUND"), err(429, "RESOURCE_EXHAUSTED"),
        err(500, "INTERNAL"), err(503, "UNAVAILABLE"), candidate("SAFETY"), candidate("MAX_TOKENS"), candidate("RECITATION"),
        lambda r: httpx.Response(200, text=blob), raise_(httpx.ReadTimeout), raise_(httpx.ConnectError),
    ]


@pytest.mark.parametrize("handler", gemini_failures())
def test_gemini_failures_never_echo_seeds_or_key(handler: Callable[[httpx.Request], httpx.Response], caplog: pytest.LogCaptureFixture, tmp_path: Path) -> None:
    # Every failure body is stuffed with every seeded value. None may reach the exception, the /plan
    # response, or any log record, even with the SDK and httpx loggers at DEBUG.
    p, seen = make_gemini(handler)
    s = Settings("", "gemini-3.8-flash", "medium", False, tmp_path / "p.jsonl", [], provider="gemini", gemini_api_key=GEMINI_KEY)
    app = create_app(s, p)
    with caplog.at_level(logging.DEBUG):
        r = TestClient(app).post("/plan", json=VALID_PAYLOAD)
        with pytest.raises(ProviderError) as e:
            p.complete_json(SYSTEM_PROMPT, [], {})
    assert r.status_code == 502 and "actions" not in r.json()
    assert seen, "the mock API was reached"
    assert leaks("502 detail", r.text) == []
    assert leaks("exception", str(e.value)) == [] and leaks("exception repr", repr(e.value)) == []
    # `raise … from None`: the SDK error (whose text embeds the body) is not chained into tracebacks.
    assert e.value.__cause__ is None and e.value.__suppress_context__
    assert leaks("logs", caplog.text) == []
    assert app.state.relay.state()["events"] == []  # the provider never touches telemetry


def test_gemini_request_carries_only_the_sanitized_prompt(tmp_path: Path) -> None:
    # The /plan request body (already gate-checked in the extension) is the only data source: the wire
    # request holds the system prompt, the user message built from that payload and the schema, and
    # none of the seeded raw values, and the API key only in its header.
    p, seen = make_gemini(lambda r: gemini_ok(json.dumps(ACTIONS[0])))
    s = Settings("", "gemini-3.8-flash", "medium", False, tmp_path / "p.jsonl", [], provider="gemini", gemini_api_key=GEMINI_KEY)
    r = TestClient(create_app(s, p)).post("/plan", json=VALID_PAYLOAD)
    assert r.status_code == 200
    body = seen[0].content.decode()
    assert leaks("gemini request body", body) == []
    assert leaks("gemini request url", str(seen[0].url)) == []
    assert seen[0].headers["x-goog-api-key"] == GEMINI_KEY
    system, turns = sent_texts("gemini", seen[0])
    assert system == SYSTEM_PROMPT and turns == [("user", build_user_message(PlannerPayload.model_validate(VALID_PAYLOAD)))]


def test_raw_values_in_a_payload_are_rejected_before_any_provider(tmp_path: Path) -> None:
    # A payload field that could carry a raw value is refused by the closed schema (422) before the
    # provider is called, whichever provider is configured.
    p, calls = make_gemini(lambda r: gemini_ok(json.dumps(ACTIONS[0])))
    s = Settings("", "gemini-3.8-flash", "medium", False, tmp_path / "p.jsonl", [], provider="gemini", gemini_api_key=GEMINI_KEY)
    bad = json.loads(json.dumps(VALID_PAYLOAD))
    bad["elements"][0]["value"] = SEEDS["task:email"]
    r = TestClient(create_app(s, p)).post("/plan", json=bad)
    assert r.status_code == 422 and calls == []


def test_providers_are_interchangeable_behind_the_protocol() -> None:
    for p in (make_groq(lambda r: groq_ok("{}"))[0], make_gemini(lambda r: gemini_ok("{}"))[0]):
        assert isinstance(p.name, str) and isinstance(p.model, str) and callable(p.complete_json)
        _: PlannerProvider = p  # structural typing: both satisfy the seam
