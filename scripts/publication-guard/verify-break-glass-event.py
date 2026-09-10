#!/usr/bin/env python3
"""Verify that a break-glass label was freshly applied to the current PR head."""

from __future__ import annotations

import re
import sys


SHA_RE = re.compile(r"^[0-9a-f]{40}$")
LABEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$")
LOGIN_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$")
MAINTAINER_PERMISSIONS = frozenset({"write", "maintain", "admin"})


def main() -> int:
    if len(sys.argv) != 10:
        print(
            "usage: verify-break-glass-event.py EXPECTED_LABEL HEAD_SHA ACTION EVENT_LABEL ACTOR PR_AUTHOR PERMISSION APPROVER APPROVER_PERMISSION",
            file=sys.stderr,
        )
        return 2

    (
        expected_label,
        head_sha,
        action,
        event_label,
        actor,
        author,
        permission,
        approver,
        approver_permission,
    ) = sys.argv[1:]
    if (
        not LABEL_RE.fullmatch(expected_label)
        or not SHA_RE.fullmatch(head_sha)
        or not LOGIN_RE.fullmatch(actor)
        or not LOGIN_RE.fullmatch(author)
        or not LOGIN_RE.fullmatch(approver)
    ):
        print("break-glass event metadata is invalid", file=sys.stderr)
        return 2

    if action != "labeled" or event_label != expected_label:
        print(
            "break-glass approval must be reapplied after the final head commit",
            file=sys.stderr,
        )
        return 1
    if actor.casefold() == author.casefold():
        print("the pull-request author cannot self-approve break glass", file=sys.stderr)
        return 1
    if permission not in MAINTAINER_PERMISSIONS:
        print("break-glass approval requires repository write permission", file=sys.stderr)
        return 1
    if approver.casefold() in {actor.casefold(), author.casefold()}:
        print("break-glass requires a second independent current-head reviewer", file=sys.stderr)
        return 1
    if approver_permission not in MAINTAINER_PERMISSIONS:
        print("break-glass review requires repository write permission", file=sys.stderr)
        return 1

    print(f"break-glass label and independent review are bound to PR head {head_sha[:12]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
