"""
OpenClaw Gateway — Message Normalizer.

Converts provider-specific message formats into a unified IncomingMessage
structure that the agent can process.
"""

from __future__ import annotations

import mimetypes
import re
from typing import Any, Optional

from pydantic import BaseModel, Field


class NormalizedMessage(BaseModel):
    """Unified message format sent to the agent."""

    channel_type: str  # telegram | whatsapp | slack
    channel_id: str
    chat_id: str
    sender_name: str
    text: str
    metadata: dict[str, Any] = Field(default_factory=dict)


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
                    "chat_title": _telegram_chat_title(chat, sender),
                    "sender_id": _string_or_none(sender.get("id")),
                    "user_id": _string_or_none(sender.get("id")),
                    "reply_to_message_id": _string_or_none(
                        message.get("reply_to_message", {}).get("message_id")
                    ),
                    "attachments": [],
                },
            )
        return None

    chat = message.get("chat", {})
    sender = message.get("from", {})
    attachments = _telegram_attachments(message)
    text = (message.get("text") or "").strip()
    if not text:
        caption = (message.get("caption") or "").strip()
        text = caption or _attachment_placeholder(attachments)
    if not text:
        return None

    return NormalizedMessage(
        channel_type="telegram",
        channel_id=str(chat.get("id", "")),
        chat_id=str(chat.get("id", "")),
        sender_name=_telegram_sender_name(sender),
        text=text,
        metadata={
            "message_id": message.get("message_id"),
            "chat_type": chat.get("type", "private"),
            "chat_title": _telegram_chat_title(chat, sender),
            "update_id": payload.get("update_id"),
            "sender_id": _string_or_none(sender.get("id")),
            "user_id": _string_or_none(sender.get("id")),
            "reply_to_message_id": _string_or_none(
                message.get("reply_to_message", {}).get("message_id")
            ),
            "attachments": attachments,
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
    attachments = _whatsapp_attachments(msg)
    if msg_type == "text":
        text = (msg.get("text", {}).get("body") or "").strip()
    elif msg_type == "reaction":
        text = f"[Reaction: {msg.get('reaction', {}).get('emoji', '')}]"
    else:
        attachment_text = _attachment_placeholder(attachments)
        caption = ""
        if msg_type == "image":
            caption = (msg.get("image", {}).get("caption") or "").strip()
        text = caption or attachment_text or f"[{msg_type}]"
    if not text:
        return None

    phone_id = value.get("metadata", {}).get("phone_number_id", "")
    sender_id = _string_or_none(msg.get("from"))

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
            "chat_title": sender_name,
            "sender_id": sender_id,
            "user_id": sender_id,
            "reply_to_message_id": _string_or_none(msg.get("context", {}).get("id")),
            "attachments": attachments,
        },
    )


def normalize_slack(payload: dict[str, Any]) -> Optional[NormalizedMessage]:
    """Normalize a Slack Events API payload into a NormalizedMessage."""
    event = payload.get("event", {})

    event_type = event.get("type")
    subtype = event.get("subtype")
    if event_type == "message" and subtype not in (None, "", "file_share"):
        return None
    if event_type not in ("message", "app_mention"):
        return None

    attachments = _slack_attachments(event)
    text = re.sub(r"<@[A-Z0-9]+>\s*", "", event.get("text", "")).strip()
    if not text:
        text = _attachment_placeholder(attachments)
    if not text:
        return None

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
            "chat_title": event.get("channel"),
            "sender_id": _string_or_none(event.get("user")),
            "user_id": _string_or_none(event.get("user")),
            "reply_to_message_id": _string_or_none(event.get("thread_ts")),
            "attachments": attachments,
        },
    )


def _telegram_sender_name(sender: dict[str, Any]) -> str:
    """Extract a display name from a Telegram user object."""
    first = sender.get("first_name", "")
    last = sender.get("last_name", "")
    username = sender.get("username", "")
    name = f"{first} {last}".strip()
    return name or username or "Unknown"


def _string_or_none(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _attachment_placeholder(attachments: list[dict[str, Any]]) -> str:
    if not attachments:
        return ""
    attachment = attachments[0]
    label = str(attachment.get("display_name") or attachment.get("kind") or "File")
    return f"[{label}]"


def _filename_from_content_type(content_type: str | None, fallback: str) -> str:
    ext = mimetypes.guess_extension(content_type or "") or ""
    return f"{fallback}{ext}"


def _telegram_chat_title(chat: dict[str, Any], sender: dict[str, Any]) -> str:
    title = str(chat.get("title") or "").strip()
    if title:
        return title
    first = str(chat.get("first_name") or sender.get("first_name") or "").strip()
    last = str(chat.get("last_name") or sender.get("last_name") or "").strip()
    username = str(chat.get("username") or sender.get("username") or "").strip()
    name = f"{first} {last}".strip()
    return name or username or str(chat.get("id") or "")


def _telegram_attachments(message: dict[str, Any]) -> list[dict[str, Any]]:
    attachments: list[dict[str, Any]] = []
    message_id = str(message.get("message_id") or "message")

    if message.get("photo"):
        photo = message["photo"][-1]
        attachments.append(
            {
                "provider": "telegram",
                "kind": "photo",
                "display_name": "Photo",
                "file_id": photo.get("file_id"),
                "file_unique_id": photo.get("file_unique_id"),
                "original_name": f"telegram-photo-{message_id}.jpg",
                "size_bytes": photo.get("file_size"),
                "width": photo.get("width"),
                "height": photo.get("height"),
            }
        )

    for field, kind, display_name, default_name in (
        ("document", "document", "Document", "telegram-document"),
        ("voice", "voice", "Voice message", "telegram-voice.ogg"),
        ("audio", "audio", "Audio message", "telegram-audio"),
        ("video", "video", "Video", "telegram-video"),
        ("video_note", "video_note", "Video note", "telegram-video-note.mp4"),
        ("animation", "animation", "Animation", "telegram-animation"),
        ("sticker", "sticker", "Sticker", "telegram-sticker.webp"),
    ):
        data = message.get(field)
        if not data:
            continue
        content_type = data.get("mime_type")
        fallback_name = default_name
        if "." not in fallback_name:
            fallback_name = _filename_from_content_type(
                content_type, f"{default_name}-{message_id}"
            )
        attachments.append(
            {
                "provider": "telegram",
                "kind": kind,
                "display_name": display_name,
                "file_id": data.get("file_id"),
                "file_unique_id": data.get("file_unique_id"),
                "original_name": data.get("file_name") or fallback_name,
                "content_type": content_type,
                "size_bytes": data.get("file_size"),
                "duration_seconds": data.get("duration"),
                "width": data.get("width"),
                "height": data.get("height"),
                "emoji": data.get("emoji"),
            }
        )

    return attachments


def _whatsapp_attachments(message: dict[str, Any]) -> list[dict[str, Any]]:
    attachments: list[dict[str, Any]] = []
    msg_type = str(message.get("type") or "")
    media = message.get(msg_type)
    if msg_type not in {"image", "audio", "video", "document", "sticker"}:
        return attachments
    if not isinstance(media, dict):
        return attachments

    filename = media.get("filename")
    if not filename:
        filename = _filename_from_content_type(
            media.get("mime_type"), f"whatsapp-{msg_type}-{message.get('id') or 'file'}"
        )

    attachments.append(
        {
            "provider": "whatsapp",
            "kind": msg_type,
            "display_name": msg_type.capitalize(),
            "media_id": media.get("id"),
            "original_name": filename,
            "content_type": media.get("mime_type"),
            "sha256": media.get("sha256"),
            "caption": media.get("caption"),
        }
    )
    return attachments


def _slack_attachments(event: dict[str, Any]) -> list[dict[str, Any]]:
    attachments: list[dict[str, Any]] = []
    for file_obj in event.get("files") or []:
        name = file_obj.get("name") or f"slack-file-{file_obj.get('id', 'file')}"
        mimetype = file_obj.get("mimetype")
        kind = str(file_obj.get("filetype") or "").strip() or (
            str(mimetype).split("/", 1)[0] if mimetype else "file"
        )
        attachments.append(
            {
                "provider": "slack",
                "kind": kind,
                "display_name": name,
                "file_id": file_obj.get("id"),
                "original_name": name,
                "content_type": mimetype,
                "size_bytes": file_obj.get("size"),
                "download_url": file_obj.get("url_private_download")
                or file_obj.get("url_private"),
                "permalink": file_obj.get("permalink"),
            }
        )
    return attachments
