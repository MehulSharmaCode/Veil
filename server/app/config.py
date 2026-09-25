"""Server settings, loaded from server/.env."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

DEFAULT_MODEL = "openai/gpt-oss-20b"

SERVER_DIR = Path(__file__).resolve().parent.parent
load_dotenv(SERVER_DIR / ".env")


@dataclass(frozen=True)
class Settings:
    groq_api_key: str
    model: str
    effort: str
    log_payloads: bool
    payload_log_path: Path
    dashboard_origins: list[str]

    @property
    def planner_configured(self) -> bool:
        return bool(self.groq_api_key)


def load_settings() -> Settings:
    return Settings(
        groq_api_key=os.getenv("GROQ_API_KEY", "").strip(),
        model=os.getenv("VEIL_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL,
        effort=os.getenv("VEIL_EFFORT", "medium").strip() or "medium",
        log_payloads=os.getenv("VEIL_DEV_LOG_PAYLOADS", "1") == "1",
        payload_log_path=SERVER_DIR / "logs" / "received_payloads.jsonl",
        dashboard_origins=[o.strip() for o in os.getenv("VEIL_DASHBOARD_ORIGIN", "http://localhost:8090,http://127.0.0.1:8090").split(",") if o.strip()],
    )
