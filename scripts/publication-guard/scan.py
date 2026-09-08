#!/usr/bin/env python3
"""Scan public Git objects without checking out or executing candidate code."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


HERE = Path(__file__).resolve().parent


class ScanError(RuntimeError):
    pass


@dataclass(frozen=True, order=True)
class Finding:
    rule_id: str
    path: str
    commit: str
    line: int = 0


def safe_field(value: str, limit: int = 240) -> str:
    cleaned = "".join(ch if 32 <= ord(ch) < 127 else "?" for ch in value)
    return cleaned[:limit]


class Scanner:
    def __init__(self, repo: Path, policy_path: Path) -> None:
        self.repo = repo.resolve()
        try:
            self.policy = json.loads(policy_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ScanError("cannot load publication policy") from exc
        if self.policy.get("schema_version") != 1:
            raise ScanError("unsupported publication policy schema")
        self.allowed_top = set(self.policy["allowed_top_level"])
        self.forbidden_segments = {item.casefold() for item in self.policy["forbidden_path_segments"]}
        self.forbidden_names = {item.casefold() for item in self.policy["forbidden_basenames"]}
        self.forbidden_suffixes = tuple(item.casefold() for item in self.policy["forbidden_suffixes"])
        self.archive_suffixes = tuple(item.casefold() for item in self.policy["archive_suffixes"])
        self.max_blob_bytes = int(self.policy["max_blob_bytes"])
        self.content_patterns = [
            (item["id"], re.compile(item["regex"])) for item in self.policy["content_patterns"]
        ]
        self.credential_patterns = [
            (item["id"], re.compile(item["regex"])) for item in self.policy["credential_patterns"]
        ]
        self.assignment_pattern = re.compile(
            r"(?im)\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)\b"
            r"\s*[:=]\s*([\"'])([A-Za-z0-9_+./=-]{24,})\1"
        )
        self.allowlisted_blobs = {
            (item["rule_id"], item["path"], item["blob_oid"])
            for item in self.policy.get("exact_blob_allowlist", [])
        }
        self.findings: set[Finding] = set()
        self.scanned_blobs: set[tuple[str, str]] = set()

    def git(self, *args: str, text: bool = False) -> bytes | str:
        process = subprocess.run(
            ["git", "--literal-pathspecs", "-C", os.fspath(self.repo), *args],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if process.returncode != 0:
            raise ScanError("git command failed; candidate details suppressed")
        return process.stdout.decode("utf-8", "strict") if text else process.stdout

    def resolve_commit(self, rev: str) -> str:
        value = self.git("rev-parse", "--verify", f"{rev}^{{commit}}", text=True).strip()
        if not re.fullmatch(r"[0-9a-f]{40,64}", value):
            raise ScanError("revision did not resolve to a commit")
        return value

    def require_complete_history(self) -> None:
        shallow = self.git("rev-parse", "--is-shallow-repository", text=True).strip()
        if shallow != "false":
            raise ScanError("history scan requires a complete, non-shallow repository")

    def add(self, rule_id: str, path: str, commit: str, line: int = 0) -> None:
        display_path = safe_field(path)
        assignment = self.assignment_pattern.search(path)
        if any(pattern.search(path) for _, pattern in self.credential_patterns) or (
            assignment is not None and self.high_entropy(assignment.group(2))
        ):
            digest = hashlib.sha256(path.encode("utf-8", "surrogateescape")).hexdigest()[:12]
            display_path = f"<redacted-path:{digest}>"
        self.findings.add(Finding(rule_id, display_path, commit[:12], line))

    def allowed_match(self, rule_id: str, path: str, blob_oid: str) -> bool:
        return (rule_id, path, blob_oid) in self.allowlisted_blobs

    def scan_path(self, path: str, commit: str) -> None:
        parts = path.split("/")
        if not parts or parts[0] not in self.allowed_top:
            self.add("path-outside-public-surface", path, commit)
        if any(part.casefold() in self.forbidden_segments for part in parts):
            self.add("private-or-generated-directory", path, commit)
        basename = parts[-1].casefold()
        if basename in self.forbidden_names or (basename.startswith(".env.") and basename != ".env.example"):
            self.add("sensitive-filename", path, commit)
        if basename.endswith(self.forbidden_suffixes) or ".tfstate." in basename:
            self.add("sensitive-filename", path, commit)
        if basename.endswith(self.archive_suffixes):
            self.add("archive-file", path, commit)

    @staticmethod
    def archive_magic(data: bytes) -> bool:
        prefixes = (b"PK\x03\x04", b"PK\x05\x06", b"\x1f\x8b", b"BZh", b"\xfd7zXZ", b"7z\xbc\xaf\x27\x1c", b"Rar!")
        return data.startswith(prefixes) or (len(data) > 262 and data[257:262] == b"ustar")

    @staticmethod
    def line_number(text: str, offset: int) -> int:
        return text.count("\n", 0, offset) + 1

    @staticmethod
    def high_entropy(value: str) -> bool:
        if len(value) < 24:
            return False
        lowered = value.casefold()
        if any(word in lowered for word in ("example", "placeholder", "replace", "dummy", "changeme")):
            return False
        counts = {char: value.count(char) for char in set(value)}
        entropy = -sum((count / len(value)) * math.log2(count / len(value)) for count in counts.values())
        groups = sum(bool(re.search(pattern, value)) for pattern in (r"[a-z]", r"[A-Z]", r"[0-9]", r"[_+./=-]"))
        return entropy >= 3.5 and groups >= 3

    def scan_text(self, text: str, path: str, blob_oid: str, commit: str, include_markers: bool = True) -> None:
        patterns = self.credential_patterns + (self.content_patterns if include_markers else [])
        for rule_id, pattern in patterns:
            for match in pattern.finditer(text):
                if not self.allowed_match(rule_id, path, blob_oid):
                    self.add(rule_id, path, commit, self.line_number(text, match.start()))

        for match in self.assignment_pattern.finditer(text):
            if self.high_entropy(match.group(2)) and not self.allowed_match("credential-assignment", path, blob_oid):
                self.add("credential-assignment", path, commit, self.line_number(text, match.start()))

    def scan_blob(self, path: str, blob_oid: str, commit: str) -> None:
        cache_key = (path, blob_oid)
        if cache_key in self.scanned_blobs:
            return
        self.scanned_blobs.add(cache_key)
        size = int(self.git("cat-file", "-s", blob_oid, text=True).strip())
        if size > self.max_blob_bytes:
            self.add("oversized-unscannable-blob", path, commit)
            return
        data = self.git("cat-file", "blob", blob_oid)
        assert isinstance(data, bytes)
        if self.archive_magic(data):
            self.add("archive-content", path, commit)
        self.scan_text(data.decode("utf-8", "replace"), path, blob_oid, commit)

    def scan_entry(self, commit: str, path: str) -> None:
        self.scan_path(path, commit)
        raw = self.git("ls-tree", "-z", commit, "--", path)
        assert isinstance(raw, bytes)
        if not raw:
            return
        record = raw.split(b"\0", 1)[0]
        metadata, _, encoded_path = record.partition(b"\t")
        fields = metadata.decode("ascii", "strict").split()
        if len(fields) != 3 or not encoded_path:
            raise ScanError("unexpected git tree entry")
        mode, object_type, blob_oid = fields
        if mode == "120000":
            self.add("symbolic-link", path, commit)
            return
        if mode == "160000" or object_type == "commit":
            self.add("git-submodule", path, commit)
            return
        if object_type != "blob":
            self.add("unsupported-git-object", path, commit)
            return
        self.scan_blob(path, blob_oid, commit)

    def scan_tree(self, commit: str) -> None:
        raw = self.git("ls-tree", "-r", "-z", "--name-only", commit)
        assert isinstance(raw, bytes)
        for item in raw.split(b"\0"):
            if item:
                self.scan_entry(commit, item.decode("utf-8", "surrogateescape"))

    def scan_commit(self, commit: str) -> None:
        message = self.git("show", "-s", "--format=%B", commit, text=True)
        assert isinstance(message, str)
        self.scan_text(message, "<commit-message>", "", commit, include_markers=False)
        raw = self.git(
            "diff-tree", "--root", "-m", "--no-commit-id", "--name-only", "-r", "-z",
            "--diff-filter=ACMRT", "--no-renames", commit,
        )
        assert isinstance(raw, bytes)
        for item in raw.split(b"\0"):
            if item:
                self.scan_entry(commit, item.decode("utf-8", "surrogateescape"))

    def scan_tag_object(self, rev: str) -> None:
        object_type = self.git("cat-file", "-t", rev, text=True).strip()
        if object_type != "tag":
            return
        object_id = self.git("rev-parse", "--verify", rev, text=True).strip()
        payload = self.git("cat-file", "tag", object_id)
        assert isinstance(payload, bytes)
        self.scan_text(payload.decode("utf-8", "replace"), "<tag-message>", object_id, object_id)

    def scan_annotated_tags(self) -> None:
        rows = self.git("for-each-ref", "--format=%(objecttype) %(objectname)", "refs/tags", text=True)
        assert isinstance(rows, str)
        for row in rows.splitlines():
            fields = row.split()
            if len(fields) == 2 and fields[0] == "tag":
                self.scan_tag_object(fields[1])

    def scan_commits(self, commits: list[str]) -> None:
        for commit in commits:
            self.scan_commit(commit)

    def finish(self) -> int:
        if not self.findings:
            print("Publication guard: PASS")
            return 0
        print(f"Publication guard: FAIL ({len(self.findings)} finding(s))", file=sys.stderr)
        for finding in sorted(self.findings):
            location = f" line={finding.line}" if finding.line else ""
            print(
                f"ERROR rule={finding.rule_id} path={finding.path} commit={finding.commit}{location} content=[REDACTED]",
                file=sys.stderr,
            )
        return 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--policy", type=Path, default=HERE / "rules.json")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--all-refs", action="store_true", help="scan every commit reachable from fetched refs")
    group.add_argument("--reachable", metavar="REV", help="scan a revision and its full ancestry")
    group.add_argument("--rev", metavar="REV", help="scan one committed tree")
    group.add_argument("--head", metavar="REV", help="scan commits introduced after --base")
    parser.add_argument("--base", metavar="REV", help="trusted base for --head")
    args = parser.parse_args()
    if bool(args.head) != bool(args.base):
        parser.error("--head and --base must be supplied together")
    return args


def main() -> int:
    args = parse_args()
    try:
        scanner = Scanner(args.repo, args.policy)
        scanner.git("rev-parse", "--git-dir")
        if args.all_refs:
            scanner.require_complete_history()
            scanner.scan_annotated_tags()
            commits_text = scanner.git("rev-list", "--reverse", "--topo-order", "--all", text=True)
            scanner.scan_commits(commits_text.splitlines())
        elif args.reachable:
            scanner.require_complete_history()
            scanner.scan_tag_object(args.reachable)
            head = scanner.resolve_commit(args.reachable)
            commits_text = scanner.git("rev-list", "--reverse", "--topo-order", head, text=True)
            scanner.scan_commits(commits_text.splitlines())
            scanner.scan_tree(head)
        elif args.rev:
            scanner.scan_tag_object(args.rev)
            scanner.scan_tree(scanner.resolve_commit(args.rev))
        else:
            scanner.require_complete_history()
            scanner.scan_tag_object(args.head)
            base = scanner.resolve_commit(args.base)
            head = scanner.resolve_commit(args.head)
            commits_text = scanner.git("rev-list", "--reverse", "--topo-order", head, f"^{base}", text=True)
            scanner.scan_commits(commits_text.splitlines())
            scanner.scan_tree(head)
        return scanner.finish()
    except ScanError as exc:
        print(f"Publication guard: ERROR {safe_field(str(exc))}", file=sys.stderr)
        return 2
    except (OSError, UnicodeError, ValueError, KeyError, TypeError):
        print("Publication guard: ERROR invalid scanner input; details suppressed", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
