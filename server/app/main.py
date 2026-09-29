"""VEIL backend: stateless planner endpoint + telemetry relay. Run: uvicorn app.main:app --port 8000"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .config import Settings, load_settings
from .planner import PlanningFailed, plan
from .providers import GroqProvider, PlannerProvider
from .schemas import PlannerPayload, PlanResponse
from .telemetry import Relay, make_router

log = logging.getLogger("veil")


def create_app(settings: Settings | None = None, provider: PlannerProvider | None = None) -> FastAPI:
    settings = settings or load_settings()
    if provider is None and settings.planner_configured:
        provider = GroqProvider(settings.groq_api_key, settings.model, settings.effort)

    app = FastAPI(title="VEIL backend", version="0.1.0")
    # Extension pages reach us via host_permissions; CORS is for the dashboard (read-only GETs).
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.dashboard_origins,
        allow_methods=["GET"],
        allow_headers=[],
    )
    relay = Relay()
    app.state.relay = relay
    app.include_router(make_router(relay))

    @app.get("/health")
    def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "planner_configured": provider is not None,
            "provider": provider.name if provider else None,
            "model": provider.model if provider else None,
            "effort": getattr(provider, "effort", None) if provider else None,
        }

    @app.post("/plan", response_model=PlanResponse)
    def post_plan(payload: PlannerPayload) -> PlanResponse:
        if settings.log_payloads:
            settings.payload_log_path.parent.mkdir(parents=True, exist_ok=True)
            with settings.payload_log_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps({"received_at": time.time(), "payload": payload.model_dump(exclude_none=True)}, ensure_ascii=False) + "\n")
        if provider is None:
            raise HTTPException(status_code=503, detail="No LLM provider configured: set GROQ_API_KEY in server/.env")
        t0 = time.perf_counter()
        try:
            result = plan(payload, provider)
        except PlanningFailed as e:
            raise HTTPException(status_code=502, detail=str(e)) from e
        log.info("plan step=%s actions=%s in %.0f ms", payload.step, [a.type for a in result.actions], (time.perf_counter() - t0) * 1000)
        return result

    return app


app = create_app()
