"""
OpenClaw Gateway — WhatsApp Adapter.

Handles WhatsApp Cloud API webhooks and verification challenges.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
from typing import Any

from ..normalizer import NormalizedMessage, normalize_whatsapp

logger = logging.getLogger(__name__)


class WhatsAppAdapter:
    """Processes WhatsApp Cloud API webhooks."""

    def __init__(
        self,
        access_token: str,
        verify_token: str,
        phone_number_id: str,
        app_secret: str = "",
    ):
        self.access_token = access_token
        self.verify_token = verify_token
        self.phone_number_id = phone_number_id
        self.app_secret = app_secret.strip()

    def normalize(self, payload: dict[str, Any]) -> NormalizedMessage | None:
        """Convert WhatsApp webhook to normalized message."""
        return normalize_whatsapp(payload)

    def verify_webhook(self, mode: str, token: str, challenge: str) -> str | None:
        """Handle WhatsApp webhook verification (GET request).
        Returns the challenge string if valid, None otherwise."""
        if mode == "subscribe" and token == self.verify_token:
            logger.info("WhatsApp webhook verified")
            return challenge
        logger.warning("WhatsApp webhook verification failed")
        return None

    def validate_payload(self, payload: dict[str, Any]) -> bool:
        """Check if the webhook payload contains messages."""
        entries = payload.get("entry", [])
        if not entries:
            return False
        changes = entries[0].get("changes", [])
        if not changes:
            return False
        value = changes[0].get("value", {})
        return bool(value.get("messages"))

    def verify_signature(self, body: bytes, signature_header: str) -> bool:
        """Validate WhatsApp's X-Hub-Signature-256 header when configured."""
        if not self.app_secret:
            return True
        if not signature_header.startswith("sha256="):
            return False
        expected = hmac.new(
            self.app_secret.encode("utf-8"),
            body,
            hashlib.sha256,
        ).hexdigest()
        provided = signature_header.split("=", 1)[1].strip()
        return hmac.compare_digest(expected, provided)
