#!/usr/bin/env python3
"""Minimal canary leak check.

Seeds known sensitive values (demo-site values + the representative task's values) and searches
everything the backend received (server/logs/received_payloads.jsonl) for exact, lowercase and
digits-only matches. Optionally also checks the telemetry relay's current state (--telemetry).

Prints 0/N or the matches (value *labels* and locations only, never the values themselves).
Exit code 1 if any leak is found.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_LOG = ROOT / "server" / "logs" / "received_payloads.jsonl"

# label -> value. Labels are what gets printed.
SEEDS: dict[str, str] = {
    "demo:name": "Rahul Sharma",
    "demo:header-email": "rahul.sharma@example.test",
    "demo:pan": "ABCPS1234K",
    "demo:phone": "98765 43210",
    "task:email": "mehul.test@example.com",
    "task:address": "12 MG Road, Shivajinagar, Pune 411005",
    "task:address-street": "12 MG Road",
    "task:address-locality": "Shivajinagar",
    "task:pincode": "411005",
}
MIN_DIGITS = 6


def forms(value: str) -> dict[str, str]:
    out = {"exact": value, "lowercase": value.lower()}
    digits = re.sub(r"\D", "", value)
    # digits-only form is meaningful only for mostly-numeric values
    if len(digits) >= MIN_DIGITS and len(digits) >= 0.6 * len(re.sub(r"\s", "", value)):
        out["digits-only"] = digits
    return out


def scan(corpus_name: str, text: str, seeds: dict[str, str]) -> list[str]:
    lower = text.lower()
    digits_text = re.sub(r"\D", "", text)
    hits = []
    for label, value in seeds.items():
        for kind, f in forms(value).items():
            hay = digits_text if kind == "digits-only" else (lower if kind == "lowercase" else text)
            if f and f in hay:
                hits.append(f"{corpus_name}: {label} ({kind})")
    return hits


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--log", type=Path, default=DEFAULT_LOG)
    ap.add_argument("--telemetry", metavar="URL", nargs="?", const="http://localhost:8000", help="also scan GET <URL>/telemetry/state")
    ap.add_argument("--seed", action="append", default=[], metavar="LABEL=VALUE", help="extra canary values")
    args = ap.parse_args()

    seeds = dict(SEEDS)
    for s in args.seed:
        label, _, value = s.partition("=")
        seeds[f"extra:{label}"] = value

    corpora: list[tuple[str, str]] = []
    if args.log.exists():
        lines = args.log.read_text(encoding="utf-8").splitlines()
        for i, line in enumerate(lines, 1):
            corpora.append((f"payload#{i}", line))
        print(f"scanning {len(lines)} received payload(s) in {args.log.relative_to(ROOT) if args.log.is_relative_to(ROOT) else args.log}")
    else:
        print(f"no payload log at {args.log} (has /plan received anything with VEIL_DEV_LOG_PAYLOADS=1?)")
    if args.telemetry:
        with urllib.request.urlopen(f"{args.telemetry}/telemetry/state", timeout=5) as r:
            state = json.loads(r.read())
        for ev in state.get("events", []):
            corpora.append((f"telemetry:{ev['type']}#{ev['event_id'][:6]}", json.dumps(ev, ensure_ascii=False)))
        print(f"scanning {len(state.get('events', []))} telemetry event(s) from {args.telemetry}")

    if not corpora:
        print("nothing to scan")
        return 2

    hits = [h for name, text in corpora for h in scan(name, text, seeds)]
    n = len(seeds)
    leaked = {h.split(": ", 1)[1].split(" (")[0] for h in hits}
    print(f"leaks: {len(leaked)}/{n} canary values found")
    for h in hits:
        print(f"  LEAK  {h}")
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main())
