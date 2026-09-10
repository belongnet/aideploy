#!/usr/bin/env python3
"""Classify GitHub pull-request file metadata using protected-base policy."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


HERE = Path(__file__).resolve().parent


def records(value: object) -> list[dict[str, object]]:
    if isinstance(value, list):
        flattened: list[dict[str, object]] = []
        for item in value:
            if isinstance(item, list):
                flattened.extend(records(item))
            elif isinstance(item, dict):
                flattened.append(item)
            else:
                raise ValueError("unexpected PR file metadata")
        return flattened
    raise ValueError("PR file metadata must be a JSON array")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("count", "policy"))
    parser.add_argument("--policy", type=Path, default=HERE / "rules.json")
    args = parser.parse_args()
    try:
        payload = records(json.load(sys.stdin))
        for item in payload:
            filename = item.get("filename")
            previous = item.get("previous_filename")
            if not isinstance(filename, str) or not filename:
                raise ValueError("missing PR filename")
            if previous is not None and (not isinstance(previous, str) or not previous):
                raise ValueError("invalid previous PR filename")
        if args.mode == "count":
            print(len(payload))
            return 0
        policy = json.loads(args.policy.read_text(encoding="utf-8"))
        protected = policy["protected_policy_paths"]
        changed = 0
        for item in payload:
            paths = (item.get("filename"), item.get("previous_filename"))
            for path in paths:
                if not isinstance(path, str):
                    continue
                if any(path == rule or (rule.endswith("/") and path.startswith(rule)) for rule in protected):
                    changed = 1
        print(changed)
        return 0
    except (OSError, ValueError, json.JSONDecodeError, KeyError, TypeError) as exc:
        print(f"publication policy metadata rejected: {type(exc).__name__}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
