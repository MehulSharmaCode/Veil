"""Server settings, loaded from server/.env."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

PROVIDERS = ("groq", "gemini")
DEFAULT_PROVIDER = "groq"
# Used when VEIL_MODEL is unset, so switching VEIL_PROVIDER alone picks a model that provider serves.
DEFAULT_MODELS = {"groq": "openai/gpt-oss-20b", "gemini": "gemini-3.8-flash"}
DEFAULT_MODEL = DEFAULT_MODELS[DEFAULT_PROVIDER]
KEY_VARS = {"groq": "GROQ_API_KEY", "gemini": "GEMINI_API_KEY"}

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
    provider: str = DEFAULT_PROVIDER
    gemini_api_key: str = ""

    @property
    def api_key(self) -> str:
        """The key of the selected provider (empty when unset or when the provider is unknown)."""
        return {"groq": self.groq_api_key, "gemini": self.gemini_api_key}.get(self.provider, "")

    @property
    def key_var(self) -> str:
        return KEY_VARS.get(self.provider, "the provider API key")

    @property
    def planner_configured(self) -> bool:
        return bool(self.api_key)


def load_settings() -> Settings:
    provider = os.getenv("VEIL_PROVIDER", DEFAULT_PROVIDER).strip().lower() or DEFAULT_PROVIDER
    default_model = DEFAULT_MODELS.get(provider, DEFAULT_MODEL)
    return Settings(
        groq_api_key=os.getenv("GROQ_API_KEY", "").strip(),
        model=os.getenv("VEIL_MODEL", default_model).strip() or default_model,
        effort=os.getenv("VEIL_EFFORT", "medium").strip() or "medium",
        log_payloads=os.getenv("VEIL_DEV_LOG_PAYLOADS", "1") == "1",
        payload_log_path=SERVER_DIR / "logs" / "received_payloads.jsonl",
        dashboard_origins=[o.strip() for o in os.getenv("VEIL_DASHBOARD_ORIGIN", "http://localhost:8090,http://127.0.0.1:8090").split(",") if o.strip()],
        provider=provider,
        gemini_api_key=os.getenv("GEMINI_API_KEY", "").strip(),
    )
