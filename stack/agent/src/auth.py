"""
OpenClaw Agent — runtime auth helpers.

Supports two auth paths:
- internal service-to-service auth via a shared token
- operator/browser auth via Supabase-compatible HS256 JWTs
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Any

from fastapi import Request


def _b64url_decode(value: str) -> bytes:
    padding = "=" * ((4 - len(value) % 4) % 4)
    return base64.urlsafe_b64decode(value + padding)


def _decode_json_segment(value: str) -> dict[str, Any]:
    raw = _b64url_decode(value)
    parsed = json.loads(raw.decode("utf-8"))
    if not isinstance(parsed, dict):
        raise ValueError("JWT segment must decode to an object")
    return parsed


def _jwt_signature(message: str, secret: str) -> str:
    digest = hmac.new(
        secret.encode("utf-8"),
        message.encode("utf-8"),
        hashlib.sha256,
    ).digest()
    return base64.urlsafe_b64encode(digest).decode("utf-8").rstrip("=")


def verify_supabase_jwt(
    token: str,
    secret: str,
    *,
    allowed_roles: set[str] | None = None,
) -> dict[str, Any]:
    if not token or not secret:
        raise ValueError("JWT token and secret are required")

    parts = token.split(".")
    if len(parts) != 3:
        raise ValueError("JWT must have three segments")

    header_segment, payload_segment, signature_segment = parts
    try:
        header = _decode_json_segment(header_segment)
        payload = _decode_json_segment(payload_segment)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("JWT payload is invalid") from exc

    if header.get("alg") != "HS256":
        raise ValueError("Only HS256 JWTs are supported")

    expected = _jwt_signature(
        f"{header_segment}.{payload_segment}",
        secret,
    )
    if not hmac.compare_digest(expected, signature_segment):
        raise ValueError("JWT signature mismatch")

    now = int(time.time())
    exp = payload.get("exp")
    if exp is not None and int(exp) < now:
        raise ValueError("JWT expired")

    nbf = payload.get("nbf")
    if nbf is not None and int(nbf) > now:
        raise ValueError("JWT not active yet")

    if allowed_roles:
        role = str(payload.get("role") or "")
        if role not in allowed_roles:
            raise ValueError("JWT role is not authorized")

    return payload


def parse_allowed_origins(raw_value: str | None) -> list[str]:
    if not raw_value:
        return []
    return [origin.strip() for origin in raw_value.split(",") if origin.strip()]


def get_service_token() -> str:
    return os.environ.get("AGENT_SERVICE_TOKEN", "").strip()


def get_supabase_jwt_secret() -> str:
    return os.environ.get("SUPABASE_JWT_SECRET", "").strip()


def get_allowed_roles() -> set[str]:
    raw = os.environ.get(
        "SUPABASE_ALLOWED_ROLES",
        "authenticated,service_role,supabase_admin",
    )
    return {value.strip() for value in raw.split(",") if value.strip()}


def authenticate_request(request: Request) -> tuple[bool, str]:
    service_token = get_service_token()
    provided_service_token = request.headers.get(
        "X-OpenClaw-Service-Token", ""
    ).strip()
    if service_token and provided_service_token:
        if hmac.compare_digest(service_token, provided_service_token):
            return True, "service"
        return False, "Invalid service token"

    auth_header = request.headers.get("Authorization", "").strip()
    if auth_header.startswith("Bearer "):
        jwt_secret = get_supabase_jwt_secret()
        if not jwt_secret:
            return False, "Supabase JWT auth is not configured"
        token = auth_header[7:].strip()
        try:
            verify_supabase_jwt(
                token,
                jwt_secret,
                allowed_roles=get_allowed_roles(),
            )
            return True, "supabase_jwt"
        except ValueError as exc:
            return False, str(exc)

    return False, "Authentication required"
