#!/usr/bin/env python3
"""Private, read-only bootstrap status endpoint for Tailscale Serve."""

from __future__ import annotations

import json
import os
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Final
from urllib.parse import urlsplit

STATUS_PATH: Final = Path(os.environ.get("AIDEPLOY_STATUS_FILE", "/run/aideploy/status.json"))
LISTEN_HOST: Final = os.environ.get("AIDEPLOY_STATUS_HOST", "127.0.0.1")
LISTEN_PORT: Final = int(os.environ.get("AIDEPLOY_STATUS_PORT", "18791"))
PUBLIC_FIELDS: Final = ("state", "step", "message", "updatedAt")
MAX_STATUS_BYTES: Final = 64 * 1024


def sanitized_status() -> bytes | None:
    try:
        raw = STATUS_PATH.read_bytes()
        if len(raw) > MAX_STATUS_BYTES:
            return None
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            return None
        public = {key: parsed[key] for key in PUBLIC_FIELDS if isinstance(parsed.get(key), str)}
        if "state" not in public or "step" not in public:
            return None
        return json.dumps(public, separators=(",", ":")).encode()
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None


class StatusHandler(BaseHTTPRequestHandler):
    server_version = "aideploy-status"
    sys_version = ""

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        self._respond(include_body=True)

    def do_HEAD(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        self._respond(include_body=False)

    def _respond(self, *, include_body: bool) -> None:
        is_status = urlsplit(self.path).path == "/_aideploy/status"
        body = sanitized_status()
        status = HTTPStatus.OK if is_status and body is not None else HTTPStatus.SERVICE_UNAVAILABLE
        if body is None:
            body = b'{"state":"running","message":"Setup is still in progress."}'

        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Aideploy-Bootstrap-Status", "1")
        self.send_header("Connection", "close")
        self.end_headers()
        if include_body:
            self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        return


def main() -> None:
    if not 1 <= LISTEN_PORT <= 65535:
        raise SystemExit("AIDEPLOY_STATUS_PORT must be between 1 and 65535")
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), StatusHandler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
