"""
Helpers for formatting shared cross-agent chat context.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any


def _format_timestamp(value: Any) -> str:
    if isinstance(value, datetime):
        return value.strftime("%H:%M")
    text = str(value or "").strip()
    if not text:
        return "recent"
    if "T" in text:
        return text.split("T", 1)[1][:5]
    return text[:5]


def _attachment_summary(attachments: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    for attachment in attachments[:3]:
        kind = str(attachment.get("kind") or "file").strip()
        name = str(
            attachment.get("original_name")
            or attachment.get("filename")
            or attachment.get("storage_path")
            or kind
        ).strip()
        parts.append(f"{kind}:{name}")
    if len(attachments) > 3:
        parts.append(f"+{len(attachments) - 3} more")
    return ", ".join(parts)


def build_shared_context_prompt(
    shared_messages: list[dict[str, Any]],
    *,
    max_items: int = 8,
) -> str:
    """Format recent shared chat activity into a compact system prompt."""
    if not shared_messages:
        return ""

    lines: list[str] = []
    for message in shared_messages[-max_items:]:
        content = str(message.get("content") or "").strip()
        attachments = list(message.get("attachments") or [])
        if not content and not attachments:
            continue

        role = str(message.get("message_role") or "system").strip()
        sender_name = str(message.get("sender_name") or "").strip()
        agent_name = str(message.get("agent_name") or "").strip()
        label = sender_name or agent_name or role
        if role == "assistant" and agent_name:
            label = f"{agent_name} (agent)"
        elif role == "user" and sender_name:
            label = f"{sender_name} (user)"

        suffix = ""
        if attachments:
            suffix = f" [attachments: {_attachment_summary(attachments)}]"

        body = content or "[Attachment]"
        lines.append(
            f"- {_format_timestamp(message.get('created_at'))} {label}: {body}{suffix}"
        )

    if not lines:
        return ""

    return (
        "Recent shared chat context from other agents in this conversation:\n"
        + "\n".join(lines)
    )
