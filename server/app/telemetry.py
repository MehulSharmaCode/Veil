"""Telemetry relay (separate router). Receives gate-checked events from the extension and fans them out
to the read-only dashboard over SSE. In-memory only. In the final system this relay must stay local
even if the planner is remote, so its URL is configured separately in the extension.
"""

from __future__ import annotations

import asyncio
import json
from collections import deque
from typing import Any, AsyncIterator

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from .schemas import TelemetryEvent

MAX_EVENTS = 1000


class Relay:
    def __init__(self) -> None:
        self.events: deque[dict[str, Any]] = deque(maxlen=MAX_EVENTS)
        self.subscribers: set[asyncio.Queue[dict[str, Any]]] = set()

    def publish(self, event: dict[str, Any]) -> None:
        self.events.append(event)
        for q in list(self.subscribers):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass  # slow consumer: it can resync from /telemetry/state

    def state(self) -> dict[str, Any]:
        """Latest session's events, so a reloaded dashboard can rebuild its views."""
        if not self.events:
            return {"session_id": None, "events": []}
        latest = self.events[-1]["session_id"]
        return {"session_id": latest, "events": [e for e in self.events if e["session_id"] == latest]}


def make_router(relay: Relay) -> APIRouter:
    router = APIRouter(prefix="/telemetry")

    @router.post("/events", status_code=204)
    def post_event(event: TelemetryEvent) -> None:
        relay.publish(event.model_dump())

    @router.get("/state")
    def get_state() -> dict[str, Any]:
        return relay.state()

    @router.get("/stream")
    async def stream(request: Request) -> StreamingResponse:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=500)
        relay.subscribers.add(q)

        async def gen() -> AsyncIterator[str]:
            try:
                yield "retry: 2000\n\n"
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        ev = await asyncio.wait_for(q.get(), timeout=15)
                        yield f"id: {ev['event_id']}\nevent: veil\ndata: {json.dumps(ev, ensure_ascii=False)}\n\n"
                    except asyncio.TimeoutError:
                        yield ": keepalive\n\n"
            finally:
                relay.subscribers.discard(q)

        return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})

    return router
