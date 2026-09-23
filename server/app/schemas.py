"""Pydantic mirror of the extension's closed schemas (extension/src/egress/schema.ts, shared/actions.ts).

Every model forbids extra fields: the server rejects anything the extension's egress gate would.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

SCHEMA_VERSION = "veil.v0.1"
TEXT_CAP = 200
MAX_ELEMENTS = 300

ElementId = Annotated[str, StringConstraints(pattern=r"^e\d{1,5}$")]
Placeholder = Annotated[str, StringConstraints(pattern=r"^\[(EMAIL|PHONE|ADDRESS|PERSON|PAN|AADHAAR|CARD)_\d{1,4}\]$")]
PiiCategory = Literal["EMAIL", "PHONE", "ADDRESS", "PERSON", "PAN", "AADHAAR", "CARD"]
ValueCategory = Literal[
    "email", "tel", "person_name", "address", "postal_code", "pan", "aadhaar", "dob",
    "card_number", "card_cvc", "password", "otp", "free_text", "other",
]
InputType = Literal[
    "text", "email", "tel", "password", "number", "search", "url", "date", "datetime-local", "month", "week", "time",
    "checkbox", "radio", "submit", "button", "reset", "image", "file", "range", "color",
]


def s(max_len: int) -> Any:
    return Annotated[str, StringConstraints(max_length=max_len)]


class Closed(BaseModel):
    model_config = ConfigDict(extra="forbid")


class BBox(Closed):
    x: int
    y: int
    w: int
    h: int


class ElementState(Closed):
    disabled: bool | None = None
    required: bool | None = None
    checked: bool | None = None
    selected: bool | None = None
    readonly: bool | None = None
    expanded: bool | None = None
    editable: bool | None = None
    submitter: bool | None = None
    has_value: bool | None = None
    value_category: ValueCategory | None = None


class ElementContext(Closed):
    section: s(160) | None = None
    form: s(160) | None = None


class Element(Closed):
    id: ElementId
    kind: Literal["interactive", "heading", "text"]
    role: Annotated[str, StringConstraints(pattern=r"^[a-z]{1,24}$")]
    tag: Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9-]{0,24}$")]
    input_type: InputType | None = None
    autocomplete: Annotated[str, StringConstraints(pattern=r"^[a-z0-9 -]{1,80}$")] | None = None
    name: s(TEXT_CAP + 40)
    text: s(TEXT_CAP + 40)
    level: Annotated[int, Field(ge=1, le=6)] | None = None
    options: Annotated[list[s(120)], Field(max_length=25)] | None = None
    link_path: s(240) | None = None
    state: ElementState
    bbox: BBox
    visible: bool
    in_viewport: bool
    occluded: bool
    context: ElementContext


class OcrLine(Closed):
    """Seam for the visual pipeline (sanitized structured OCR). Unused in v0.1."""

    text: s(200)
    bbox: BBox
    confidence: Annotated[float, Field(ge=0, le=1)]


class Region(Closed):
    id: ElementId
    kind: Literal["img", "canvas", "video", "svg"]
    bbox: BBox
    label: s(160)
    in_viewport: bool
    status: Literal["unperceived"]
    ocr: Annotated[list[OcrLine], Field(max_length=50)] | None = None


class Viewport(Closed):
    w: int
    h: int


class Scroll(Closed):
    x: int
    y: int
    max_y: int


class Page(Closed):
    origin: s(200)
    path: s(300)
    title: s(300)
    viewport: Viewport
    scroll: Scroll


class PlaceholderRef(Closed):
    id: Placeholder
    category: PiiCategory


class HistoryAction(Closed):
    type: Literal["click", "type", "select", "scroll", "wait", "ask_user", "done"]
    target: ElementId | None = None
    text: s(300) | None = None
    option: s(200) | None = None
    direction: Literal["up", "down"] | None = None
    amount_px: int | None = None
    ms: int | None = None


class HistoryEntry(Closed):
    step: Annotated[int, Field(ge=0)]
    action: HistoryAction
    result: Literal["ok", "verify_failed", "rejected", "stale_target", "exec_error", "user_denied", "handed_to_user", "answered"]
    rule: Annotated[str, StringConstraints(pattern=r"^[A-Z0-9_]{1,40}$")] | None = None
    user_answer: s(300) | None = None


class PlannerPayload(Closed):
    schema_version: Literal["veil.v0.1"]
    session_id: Annotated[str, StringConstraints(pattern=r"^[a-z]{16}$")]
    step: Annotated[int, Field(ge=0, le=100)]
    task: s(1000)
    page: Page
    elements: Annotated[list[Element], Field(max_length=MAX_ELEMENTS)]
    regions: Annotated[list[Region], Field(max_length=60)]
    placeholders: Annotated[list[PlaceholderRef], Field(max_length=100)]
    history: Annotated[list[HistoryEntry], Field(max_length=6)]


# ---- planner response (v0.1 action set) --------------------------------------------------------


class ClickAction(Closed):
    type: Literal["click"]
    target: ElementId


class TypeAction(Closed):
    type: Literal["type"]
    target: ElementId
    text: Annotated[str, StringConstraints(min_length=1, max_length=200)]


class SelectAction(Closed):
    type: Literal["select"]
    target: ElementId
    option: Annotated[str, StringConstraints(min_length=1, max_length=200)]


class ScrollByAction(Closed):
    type: Literal["scroll"]
    direction: Literal["up", "down"]
    amount_px: Annotated[int, Field(ge=1, le=2000)]


class ScrollToAction(Closed):
    type: Literal["scroll"]
    target: ElementId


class WaitAction(Closed):
    type: Literal["wait"]
    ms: Annotated[int, Field(ge=0, le=3000)]


class AskUserAction(Closed):
    type: Literal["ask_user"]
    question: Annotated[str, StringConstraints(min_length=1, max_length=300)]


class DoneAction(Closed):
    type: Literal["done"]
    summary: s(300)


Action = Union[ClickAction, TypeAction, SelectAction, ScrollByAction, ScrollToAction, WaitAction, AskUserAction, DoneAction]


class PlanResponse(Closed):
    status: Literal["continue", "done", "need_user"]
    actions: Annotated[list[Action], Field(max_length=5)]
    message: s(300)


# ---- telemetry envelope ------------------------------------------------------------------------


class TelemetryEvent(Closed):
    event_id: Annotated[str, StringConstraints(pattern=r"^[a-z0-9]{8,32}$")]
    ts: int
    session_id: Annotated[str, StringConstraints(pattern=r"^[a-z]{16}$")]
    step: Annotated[int, Field(ge=0)]
    type: Annotated[str, StringConstraints(pattern=r"^[A-Z][A-Z0-9_]{2,40}$")]
    stage: Annotated[str, StringConstraints(pattern=r"^[a-z_]{1,32}$")]
    data: dict[str, Any]
