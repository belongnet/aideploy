"""
OpenClaw Gateway — Telegram Adapter.

Handles incoming Telegram webhooks, normalizes messages,
and sends responses back via the Telegram Bot API.
"""

from __future__ import annotations

import logging
from typing import Any

from ..normalizer import NormalizedMessage, normalize_telegram

logger = logging.getLogger(__name__)


class TelegramAdapter:
    """Processes Telegram webhook updates."""

    def __init__(self, bot_token: str):
        self.bot_token = bot_token

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
            )
        )
