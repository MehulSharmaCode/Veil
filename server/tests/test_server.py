"""Server tests. `ScriptedTestProvider` is a TEST-ONLY stub; it is never reachable from the runtime path
(create_app only builds AnthropicProvider unless a provider is injected by a test)."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.planner import PlanningFailed, plan
from app.prompt import RESPONSE_SCHEMA, SYSTEM_PROMPT, build_user_message
from app.providers import ChatTurn, ProviderError
from app.schemas import PlannerPayload

VALID_PAYLOAD: dict[str, Any] = {
    "schema_version": "veil.v0.1",
    "session_id": "abcdefghijklmnop",
    "step": 1,
    "task": "Fill my email [EMAIL_1] and my address [ADDRESS_1]. Do not submit.",
    "page": {"origin": "http://localhost:8080", "path": "/", "title": "Edit profile", "viewport": {"w": 1280, "h": 800}, "scroll": {"x": 0, "y": 0, "max_y": 400}},
    "elements": [
        {
            "id": "e4", "kind": "interactive", "role": "textbox", "tag": "input", "input_type": "email", "name": "Email", "text": "",
            "state": {"editable": True, "has_value": False, "value_category": "email"},
            "bbox": {"x": 10, "y": 100, "w": 300, "h": 30}, "visible": True, "in_viewport": True, "occluded": False,
            "context": {"section": "Contact details", "form": "Edit profile"},
        }
    ],
    "regions": [{"id": "e2", "kind": "img", "bbox": {"x": 0, "y": 0, "w": 64, "h": 64}, "label": "Profile photo", "in_viewport": True, "status": "unperceived"}],
    "placeholders": [{"id": "[EMAIL_1]", "category": "EMAIL"}, {"id": "[ADDRESS_1]", "category": "ADDRESS"}],
    "history": [],
}


class ScriptedTestProvider:
    """TEST-ONLY provider stub: returns canned outputs in order and records the turns it saw."""

    name = "test-stub"
    model = "test-stub"

    def __init__(self, outputs: list[str | Exception]) -> None:
        self.outputs = list(outputs)
        self.calls: list[list[ChatTurn]] = []

    def complete_json(self, system: str, turns: list[ChatTurn], schema: dict[str, Any]) -> str:
        assert system == SYSTEM_PROMPT and schema == RESPONSE_SCHEMA
        self.calls.append(list(turns))
        out = self.outputs.pop(0)
        if isinstance(out, Exception):
            raise out
        return out


def settings(tmp_path: Path, log: bool = True) -> Settings:
    return Settings("", "test", "low", log, tmp_path / "received_payloads.jsonl", ["http://localhost:8090"])


GOOD = json.dumps({"status": "continue", "actions": [{"type": "type", "target": "e4", "text": "[EMAIL_1]"}], "message": "fill email"})


# ---- payload validation -----------------------------------------------------------------------


def test_valid_payload_accepted() -> None:
    PlannerPayload.model_validate(VALID_PAYLOAD)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda p: p.update(extra="x"),  # unexpected top-level field
        lambda p: p["elements"][0].update(value="rahul@example.com"),  # a raw value field
        lambda p: p["elements"][0]["state"].update(value="x"),
        lambda p: p.update(schema_version="v2"),
        lambda p: p.update(session_id="ABC123"),
        lambda p: p["elements"][0].update(id="button-1"),
        lambda p: p["placeholders"][0].update(id="EMAIL_1"),
        lambda p: p["regions"][0].update(status="perceived"),
        lambda p: p["elements"][0].update(name="x" * 500),
    ],
)
def test_invalid_payload_rejected(mutate: Any, tmp_path: Path) -> None:
    p = copy.deepcopy(VALID_PAYLOAD)
    mutate(p)
    client = TestClient(create_app(settings(tmp_path), ScriptedTestProvider([GOOD])))
    r = client.post("/plan", json=p)
    assert r.status_code == 422
    assert not (tmp_path / "received_payloads.jsonl").exists()


# ---- /plan, response validation, repair path ----------------------------------------------------


def test_plan_endpoint_returns_validated_action_and_logs_payload(tmp_path: Path) -> None:
    stub = ScriptedTestProvider([GOOD])
    client = TestClient(create_app(settings(tmp_path), stub))
    r = client.post("/plan", json=VALID_PAYLOAD)
    assert r.status_code == 200
    assert r.json()["actions"] == [{"type": "type", "target": "e4", "text": "[EMAIL_1]"}]
    logged = [json.loads(line) for line in (tmp_path / "received_payloads.jsonl").read_text().splitlines()]
    assert logged[0]["payload"]["task"] == VALID_PAYLOAD["task"]
    # prompt delimits page content as untrusted data
    msg = stub.calls[0][0].content
    assert "<untrusted_page_data>" in msg and "<task>" in msg and "[EMAIL_1]" in msg


def test_repair_once_then_success() -> None:
    bad = json.dumps({"status": "continue", "actions": [{"type": "wait", "ms": 99999}], "message": "x"})
    stub = ScriptedTestProvider([bad, GOOD])
    result = plan(PlannerPayload.model_validate(VALID_PAYLOAD), stub)
    assert result.actions[0].type == "type"
    assert len(stub.calls) == 2
    repair_turns = stub.calls[1]
    assert [t.role for t in repair_turns] == ["user", "assistant", "user"]
    assert "invalid" in repair_turns[2].content


def test_repair_fails_twice_raises() -> None:
    stub = ScriptedTestProvider(["not json", json.dumps({"status": "continue", "actions": [{"type": "navigate", "url": "x"}], "message": ""})])
    with pytest.raises(PlanningFailed):
        plan(PlannerPayload.model_validate(VALID_PAYLOAD), stub)


def test_unknown_or_extra_action_fields_rejected() -> None:
    for out in [
        {"status": "continue", "actions": [{"type": "eval", "code": "x"}], "message": ""},
        {"status": "continue", "actions": [{"type": "click", "target": "e4", "js": "x"}], "message": ""},
        {"status": "continue", "actions": [{"type": "scroll", "direction": "down", "amount_px": 5000}], "message": ""},
        {"status": "maybe", "actions": [], "message": ""},
    ]:
        stub = ScriptedTestProvider([json.dumps(out), json.dumps(out)])
        with pytest.raises(PlanningFailed):
            plan(PlannerPayload.model_validate(VALID_PAYLOAD), stub)


def test_provider_error_becomes_502(tmp_path: Path) -> None:
    client = TestClient(create_app(settings(tmp_path), ScriptedTestProvider([ProviderError("Could not reach the LLM provider")])))
    r = client.post("/plan", json=VALID_PAYLOAD)
    assert r.status_code == 502
    assert "LLM provider" in r.json()["detail"]


def test_no_provider_configured_is_503(tmp_path: Path) -> None:
    client = TestClient(create_app(settings(tmp_path), None))
    assert client.get("/health").json()["planner_configured"] is False
    assert client.post("/plan", json=VALID_PAYLOAD).status_code == 503


def test_user_message_omits_nothing_needed() -> None:
    msg = build_user_message(PlannerPayload.model_validate(VALID_PAYLOAD))
    assert '"value_category":"email"' in msg and '"id":"e4"' in msg and "unperceived" in msg


# ---- telemetry relay --------------------------------------------------------------------------


def event(i: int, session: str = "abcdefghijklmnop", **kw: Any) -> dict[str, Any]:
    return {"event_id": f"evt{i:08d}", "ts": 1_700_000_000_000 + i, "session_id": session, "step": 0, "type": "TASK_STARTED", "stage": "task", "data": {"task": "Fill [EMAIL_1]"}, **kw}


def test_telemetry_post_and_state(tmp_path: Path) -> None:
    client = TestClient(create_app(settings(tmp_path), None))
    assert client.post("/telemetry/events", json=event(1, session="aaaaaaaaaaaaaaaa")).status_code == 204
    assert client.post("/telemetry/events", json=event(2)).status_code == 204
    assert client.post("/telemetry/events", json=event(3)).status_code == 204
    st = client.get("/telemetry/state").json()
    assert st["session_id"] == "abcdefghijklmnop"
    assert [e["event_id"] for e in st["events"]] == ["evt00000002", "evt00000003"]


def test_telemetry_rejects_malformed_events(tmp_path: Path) -> None:
    client = TestClient(create_app(settings(tmp_path), None))
    assert client.post("/telemetry/events", json={**event(1), "extra": 1}).status_code == 422
    assert client.post("/telemetry/events", json=event(1, type="lowercase")).status_code == 422
    assert client.get("/telemetry/state").json()["events"] == []


def test_telemetry_stream_delivers_published_events(tmp_path: Path) -> None:
    import asyncio

    from app.telemetry import Relay

    relay = Relay()

    async def run() -> dict[str, Any]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        relay.subscribers.add(q)
        relay.publish(event(7))
        return await asyncio.wait_for(q.get(), 1)

    assert asyncio.run(run())["event_id"] == "evt00000007"


def test_cors_allows_dashboard_get_only(tmp_path: Path) -> None:
    client = TestClient(create_app(settings(tmp_path), None))
    r = client.get("/telemetry/state", headers={"Origin": "http://localhost:8090"})
    assert r.headers.get("access-control-allow-origin") == "http://localhost:8090"
    r2 = client.get("/telemetry/state", headers={"Origin": "http://evil.test"})
    assert "access-control-allow-origin" not in r2.headers
