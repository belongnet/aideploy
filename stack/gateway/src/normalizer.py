"""
OpenClaw Gateway — Message Normalizer.

Converts provider-specific message formats into a unified IncomingMessage
structure that the agent can process.
"""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel


class NormalizedMessage(BaseModel):
    """Unified message format sent to the agent."""

    channel_type: str  # telegram | whatsapp | slack
    channel_id: str
    chat_id: str
    sender_name: str
    text: str
    metadata: dict[str, Any] = {}


def normalize_telegram(payload: dict[str, Any]) -> Optional[NormalizedMessage]:
    """Normalize a Telegram update into a NormalizedMessage."""
    message = payload.get("message") or payload.get("edited_message")
    if not message:
        # Could be a callback query or other update type
        callback = payload.get("callback_query")
        if callback and callback.get("data"):
            message = callback.get("message", {})
            chat = message.get("chat", {})
            sender = callback.get("from", {})
            return NormalizedMessage(
                channel_type="telegram",
                channel_id=str(chat.get("id", "")),
                chat_id=str(chat.get("id", "")),
                sender_name=_telegram_sender_name(sender),
                text=callback["data"],
                metadata={
                    "callback_query_id": callback.get("id"),
                    "message_id": message.get("message_id"),
                    "chat_type": chat.get("type", "private"),
                    "sender_id": str(sender.get("id", "")),
                },
            )
        return None

    text = message.get("text", "")
    if not text:
        # Handle media messages
        caption = message.get("caption", "")
        if message.get("photo"):
            text = caption or "[Photo]"
        elif message.get("document"):
            text = caption or f"[Document: {message['document'].get('file_name', 'file')}]"
        elif message.get("voice"):
            text = "[Voice message]"
        elif message.get("sticker"):
            text = f"[Sticker: {message['sticker'].get('emoji', '')}]"
        else:
            return None

    chat = message.get("chat", {})
    sender = message.get("from", {})

    return NormalizedMessage(
        channel_type="telegram",
        channel_id=str(chat.get("id", "")),
        chat_id=str(chat.get("id", "")),
        sender_name=_telegram_sender_name(sender),
        text=text,
        metadata={
            "message_id": message.get("message_id"),
            "chat_type": chat.get("type", "private"),
            "update_id": payload.get("update_id"),
            "sender_id": str(sender.get("id", "")),
        },
    )


def normalize_whatsapp(payload: dict[str, Any]) -> Optional[NormalizedMessage]:
    """Normalize a WhatsApp Cloud API webhook into a NormalizedMessage."""
    entries = payload.get("entry", [])
    if not entries:
        return None

    changes = entries[0].get("changes", [])
    if not changes:
        return None

    value = changes[0].get("value", {})
    messages = value.get("messages", [])
    if not messages:
        return None

    msg = messages[0]
    contacts = value.get("contacts", [{}])
    sender_name = contacts[0].get("profile", {}).get("name", "Unknown")

    # Handle different message types
    msg_type = msg.get("type", "text")
    if msg_type == "text":
        text = msg.get("text", {}).get("body", "")
    elif msg_type == "image":
        text = msg.get("image", {}).get("caption", "[Image]")
    elif msg_type == "document":
        text = f"[Document: {msg.get('document', {}).get('filename', 'file')}]"
    elif msg_type == "audio":
        text = "[Audio message]"
    elif msg_type == "reaction":
        text = f"[Reaction: {msg.get('reaction', {}).get('emoji', '')}]"
    else:
        text = f"[{msg_type}]"

    phone_id = value.get("metadata", {}).get("phone_number_id", "")

    return NormalizedMessage(
        channel_type="whatsapp",
        channel_id=phone_id,
        chat_id=msg.get("from", ""),
        sender_name=sender_name,
        text=text,
        metadata={
            "message_id": msg.get("id"),
            "message_type": msg_type,
            "timestamp": msg.get("timestamp"),
        },
    )


def normalize_slack(payload: dict[str, Any]) -> Optional[NormalizedMessage]:
    """Normalize a Slack Events API payload into a NormalizedMessage."""
    event = payload.get("event", {})

    # Only handle message events (not bot messages)
    if event.get("type") != "message" or event.get("subtype"):
        # Handle app_mention separately
        if event.get("type") == "app_mention":
            pass
        else:
            return None

    text = event.get("text", "")
    if not text:
        return None

    # Remove bot mention from text if present
    # Slack format: <@U12345> message text
    import re

    text = re.sub(r"<@[A-Z0-9]+>\s*", "", text).strip()

    return NormalizedMessage(
        channel_type="slack",
        channel_id=event.get("channel", ""),
        chat_id=event.get("channel", ""),
        sender_name=event.get("user", "unknown"),
        text=text,
        metadata={
            "ts": event.get("ts"),
            "thread_ts": event.get("thread_ts"),
            "team_id": payload.get("team_id"),
            "event_type": event.get("type"),
        },
    )


def _telegram_sender_name(sender: dict[str, Any]) -> str:
    """Extract a display name from a Telegram user object."""
    first = sender.get("first_name", "")
    last = sender.get("last_name", "")
    username = sender.get("username", "")
    name = f"{first} {last}".strip()
    return name or username or "Unknown"
