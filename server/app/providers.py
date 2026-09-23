"""LLM provider adapter. One real implementation (Anthropic). Test stubs live in tests/ only."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

import anthropic


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


class AnthropicProvider:
    name = "anthropic"

    def __init__(self, api_key: str, model: str, effort: str = "medium", timeout_s: float = 60.0) -> None:
        self.model = model
        self.effort = effort
        self._client = anthropic.Anthropic(api_key=api_key, timeout=timeout_s, max_retries=2)

    def complete_json(self, system: str, turns: list[ChatTurn], schema: dict[str, Any]) -> str:
        try:
            response = self._client.messages.create(
                model=self.model,
                max_tokens=16000,
                system=system,
                messages=[{"role": t.role, "content": t.content} for t in turns],
                output_config={"effort": self.effort, "format": {"type": "json_schema", "schema": schema}},
            )
        except anthropic.AuthenticationError as e:
            raise ProviderError("LLM provider rejected the API key (check server/.env)") from e
        except anthropic.RateLimitError as e:
            raise ProviderError("LLM provider rate limit reached; try again shortly") from e
        except anthropic.APIStatusError as e:
            raise ProviderError(f"LLM provider error (HTTP {e.status_code})") from e
        except anthropic.APIConnectionError as e:
            raise ProviderError("Could not reach the LLM provider") from e

        if response.stop_reason == "refusal":
            raise ProviderError("The model declined to plan this step")
        if response.stop_reason == "max_tokens":
            raise ProviderError("The model's response was truncated")
        text = next((b.text for b in response.content if b.type == "text"), None)
        if text is None:
            raise ProviderError("The model returned no text output")
        return text
