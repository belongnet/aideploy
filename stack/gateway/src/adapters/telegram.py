"""
OpenClaw Gateway — Telegram Adapter.

Handles incoming Telegram webhooks, normalizes messages,
and sends responses back via the Telegram Bot API.
"""

from __future__ import annotations

import hmac
import logging
from typing import Any

from ..normalizer import NormalizedMessage, normalize_telegram

logger = logging.getLogger(__name__)


class TelegramAdapter:
    """Processes Telegram webhook updates."""

    def __init__(self, bot_token: str, webhook_secret: str = ""):
        self.bot_token = bot_token
        self.webhook_secret = webhook_secret.strip()

    def normalize(self, payload: dict[str, Any]) -> NormalizedMessage | None:
        """Convert Telegram update to normalized message."""
        return normalize_telegram(payload)

    def validate_update(self, payload: dict[str, Any]) -> bool:
        """Basic validation of a Telegram update payload."""
        return bool(
            payload.get("update_id")
            and (
                payload.get("message")
                or payload.get("edited_message")
                or payload.get("callback_query")
                or payload.get("my_chat_member")
            )
        )

    def verify_secret_token(self, secret_token: str) -> bool:
        """Validate Telegram's webhook secret token header when configured."""
        if not self.webhook_secret:
            return True
        if not secret_token:
            return False
        return hmac.compare_digest(self.webhook_secret, secret_token)
