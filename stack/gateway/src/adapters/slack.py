"""
OpenClaw Gateway — Slack Adapter.

Handles Slack Events API webhooks, URL verification, and message normalization.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import time
from typing import Any

from ..normalizer import NormalizedMessage, normalize_slack

logger = logging.getLogger(__name__)


class SlackAdapter:
    """Processes Slack Events API webhooks."""

    def __init__(self, bot_token: str, signing_secret: str):
        self.bot_token = bot_token
        self.signing_secret = signing_secret

    def normalize(self, payload: dict[str, Any]) -> NormalizedMessage | None:
        """Convert Slack event to normalized message."""
        return normalize_slack(payload)

    def handle_url_verification(self, payload: dict[str, Any]) -> str | None:
        """Handle Slack URL verification challenge.
        Returns challenge string if this is a verification request."""
        if payload.get("type") == "url_verification":
            return payload.get("challenge", "")
        return None

    def verify_signature(
        self, body: bytes, timestamp: str, signature: str
    ) -> bool:
        """Verify Slack request signature for security."""
        # Reject requests older than 5 minutes
        try:
            ts = int(timestamp)
        except (ValueError, TypeError):
            return False

        if abs(time.time() - ts) > 300:
            logger.warning("Slack request timestamp too old")
            return False

        sig_basestring = f"v0:{timestamp}:{body.decode('utf-8')}"
        computed = (
            "v0="
            + hmac.new(
                self.signing_secret.encode("utf-8"),
                sig_basestring.encode("utf-8"),
                hashlib.sha256,
            ).hexdigest()
        )

        return hmac.compare_digest(computed, signature)

    def validate_event(self, payload: dict[str, Any]) -> bool:
        """Check if the event should be processed."""
        event = payload.get("event", {})
        event_type = event.get("type")

        # Process messages and app mentions
        if event_type not in ("message", "app_mention"):
            return False

        # Skip bot messages to avoid loops
        if event.get("bot_id") or event.get("subtype") == "bot_message":
            return False

        return True
