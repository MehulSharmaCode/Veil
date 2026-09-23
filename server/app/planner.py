"""POST /plan logic: build prompt → provider (structured output) → validate → repair once → error."""

from __future__ import annotations

import json

from pydantic import ValidationError

from .prompt import RESPONSE_SCHEMA, SYSTEM_PROMPT, build_user_message
from .providers import ChatTurn, PlannerProvider, ProviderError
from .schemas import PlannerPayload, PlanResponse


class PlanningFailed(Exception):
    pass


def _parse(raw: str) -> tuple[PlanResponse | None, str]:
    try:
        return PlanResponse.model_validate(json.loads(raw)), ""
    except json.JSONDecodeError as e:
        return None, f"not valid JSON ({e.msg})"
    except ValidationError as e:
        # Field locations and messages only; never echo input values back.
        errs = "; ".join(f"{'.'.join(str(p) for p in err['loc'])}: {err['msg']}" for err in e.errors()[:8])
        return None, errs


def plan(payload: PlannerPayload, provider: PlannerProvider) -> PlanResponse:
    turns = [ChatTurn("user", build_user_message(payload))]
    try:
        raw = provider.complete_json(SYSTEM_PROMPT, turns, RESPONSE_SCHEMA)
    except ProviderError as e:
        raise PlanningFailed(str(e)) from e

    result, errors = _parse(raw)
    if result is not None:
        return result

    # One repair attempt.
    turns += [
        ChatTurn("assistant", raw),
        ChatTurn(
            "user",
            f"That response was invalid: {errors}. Reply again with corrected JSON that follows the action schema "
            "exactly (one action, ids from the snapshot, limits respected).",
        ),
    ]
    try:
        raw2 = provider.complete_json(SYSTEM_PROMPT, turns, RESPONSE_SCHEMA)
    except ProviderError as e:
        raise PlanningFailed(str(e)) from e
    result, errors = _parse(raw2)
    if result is None:
        raise PlanningFailed(f"planner output invalid after one repair attempt: {errors}"[:280])
    return result
