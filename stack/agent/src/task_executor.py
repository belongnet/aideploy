"""
OpenClaw Agent — Task Executor.

Executes task actions: reply, api_call, agent_forward, run_prompt, notify,
file_write, serve_website.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from pathlib import Path
from typing import Any, Optional

import httpx

from .bus_client import BusClient
from .db import Database
from .llm_client import LLMAdapter
from .models import ActionType, BusChannel, BusEventType, Task

logger = logging.getLogger(__name__)

WORKSPACE_DIR = Path(os.environ.get("AGENT_WORKSPACE_DIR", "/workspace")).resolve()
SITES_DIR = WORKSPACE_DIR / "sites"


def _resolve_site_path(site: str, rel_path: str) -> Path:
    """Resolve a file path inside SITES_DIR, rejecting path traversal."""
    if not site or "/" in site or site.startswith("."):
        raise ValueError(f"invalid site name: {site!r}")
    if not rel_path:
        raise ValueError("path is required")
    site_root = (SITES_DIR / site).resolve()
    target = (site_root / rel_path).resolve()
    try:
        target.relative_to(site_root)
    except ValueError as exc:
        raise ValueError(
            f"path {rel_path!r} escapes site root"
        ) from exc
    return target


class TaskExecutor:
    """Executes task actions based on their configuration."""

    def __init__(
        self,
        db: Database,
        llm: LLMAdapter,
        bus: BusClient,
        reply_callback: Any = None,
    ):
        self.db = db
        self.llm = llm
        self.bus = bus
        # Callback to send replies back to the originating channel
        self.reply_callback = reply_callback

    async def execute(
        self, task: Task, context: dict[str, Any]
    ) -> dict[str, Any]:
        """Execute a task action with the given context."""
        logger.info(f"Executing task '{task.name}' (action: {task.action_type.value})")

        match task.action_type:
            case ActionType.REPLY:
                return await self._execute_reply(task, context)
            case ActionType.API_CALL:
                return await self._execute_api_call(task, context)
            case ActionType.AGENT_FORWARD:
                return await self._execute_agent_forward(task, context)
            case ActionType.RUN_PROMPT:
                return await self._execute_run_prompt(task, context)
            case ActionType.NOTIFY:
                return await self._execute_notify(task, context)
            case ActionType.FILE_WRITE:
                return await self._execute_file_write(task, context)
            case ActionType.SERVE_WEBSITE:
                return await self._execute_serve_website(task, context)
            case _:
                raise ValueError(f"Unknown action type: {task.action_type}")

    async def _execute_reply(
        self, task: Task, context: dict[str, Any]
    ) -> dict[str, Any]:
        """Generate an LLM reply using the task's prompt template."""
        prompt_template = task.action_config.get("prompt", "")
        temperature = task.action_config.get("temperature")
        max_tokens = task.action_config.get("max_tokens")

        # Interpolate context into the prompt
        prompt = self._interpolate(prompt_template, context)

        config = await self.db.get_config()
        messages = [
            {"role": "system", "content": config.system_prompt},
            {"role": "user", "content": prompt},
        ]

        result = await self.llm.chat(
            messages, temperature=temperature, max_tokens=max_tokens
        )

        # Send reply back if we have a callback and conversation context
        if self.reply_callback and "conversation_id" in context:
            await self.reply_callback(
                conversation_id=uuid.UUID(context["conversation_id"]),
                text=result["content"],
            )

        return {
            "action": "reply",
            "content": result["content"],
            "tokens_used": result.get("tokens_used", 0),
        }

    async def _execute_api_call(
        self, task: Task, context: dict[str, Any]
    ) -> dict[str, Any]:
        """Make an HTTP API call."""
        url = task.action_config.get("url", "")
        method = task.action_config.get("method", "POST").upper()
        headers = task.action_config.get("headers", {})
        body_template = task.action_config.get("body", "{}")

        # Interpolate context
        url = self._interpolate(url, context)
        body_str = self._interpolate(body_template, context)

        try:
            body = json.loads(body_str) if body_str else None
        except json.JSONDecodeError:
            body = body_str

        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.request(
                method=method,
                url=url,
                headers=headers,
                json=body if isinstance(body, dict) else None,
                content=body if isinstance(body, str) else None,
            )

            return {
                "action": "api_call",
                "status_code": resp.status_code,
                "response": resp.text[:2000],  # Limit response size
            }

    async def _execute_agent_forward(
        self, task: Task, context: dict[str, Any]
    ) -> dict[str, Any]:
        """Forward message to another agent via the bus."""
        target_agent_id = task.action_config.get("target_agent_id")
        if not target_agent_id:
            raise ValueError("agent_forward requires target_agent_id")

        message_text = context.get("message", "")
        forward_prompt = task.action_config.get("prompt", "")
        if forward_prompt:
            message_text = self._interpolate(forward_prompt, context)

        message_id = await self.bus.forward_message(
            target_agent_id=uuid.UUID(target_agent_id),
            conversation_text=message_text,
            metadata={
                "task_id": str(task.id),
                "task_name": task.name,
                "original_sender": context.get("sender", "unknown"),
                "channel_type": context.get("channel_type", ""),
            },
        )

        return {
            "action": "agent_forward",
            "message_id": message_id,
            "target_agent_id": target_agent_id,
        }

    async def _execute_run_prompt(
        self, task: Task, context: dict[str, Any]
    ) -> dict[str, Any]:
        """Run a specific prompt through the LLM (no conversation context)."""
        prompt = task.action_config.get("prompt", "")
        system_prompt = task.action_config.get(
            "system_prompt", "You are a helpful assistant."
        )
        temperature = task.action_config.get("temperature")
        max_tokens = task.action_config.get("max_tokens")

        prompt = self._interpolate(prompt, context)

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ]

        result = await self.llm.chat(
            messages, temperature=temperature, max_tokens=max_tokens
        )

        # Optionally store result or forward it
        store_result = task.action_config.get("store_result", False)
        if store_result:
            await self.bus.send(
                target_agent_id=None,
                channel=BusChannel.DASHBOARD_BUS,
                event_type=BusEventType.TASK_RESULT,
                payload={
                    "task_id": str(task.id),
                    "task_name": task.name,
                    "result": result["content"][:5000],
                },
            )

        return {
            "action": "run_prompt",
            "content": result["content"],
            "tokens_used": result.get("tokens_used", 0),
        }

    async def _execute_notify(
        self, task: Task, context: dict[str, Any]
    ) -> dict[str, Any]:
        """Send a notification via a channel."""
        channel_id = task.action_config.get("channel_id")
        message_template = task.action_config.get("message", "")
        message = self._interpolate(message_template, context)

        if not channel_id:
            raise ValueError("notify requires channel_id")

        # The actual sending is handled by the gateway via bus
        await self.bus.send(
            target_agent_id=None,
            channel=BusChannel.AGENT_BUS,
            event_type=BusEventType.CHANNEL_EVENT,
            payload={
                "action": "send_message",
                "channel_id": channel_id,
                "text": message,
            },
        )

        return {
            "action": "notify",
            "channel_id": channel_id,
            "message": message,
        }

    async def _execute_file_write(
        self, task: Task, context: dict[str, Any]
    ) -> dict[str, Any]:
        """Write a file into /workspace/sites/{site}/{path} for agent-built portals."""
        site = self._interpolate(task.action_config.get("site", ""), context).strip()
        rel_path = self._interpolate(
            task.action_config.get("path", ""), context
        ).strip()
        content_template = task.action_config.get("content", "")
        content = self._interpolate(content_template, context)

        target = _resolve_site_path(site, rel_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")

        return {
            "action": "file_write",
            "site": site,
            "path": rel_path,
            "bytes": len(content.encode("utf-8")),
        }

    async def _execute_serve_website(
        self, task: Task, context: dict[str, Any]
    ) -> dict[str, Any]:
        """Confirm a site is live. Static serving is handled by FastAPI mount;
        this action verifies an index.html exists and returns the public URL."""
        site = self._interpolate(task.action_config.get("site", ""), context).strip()
        if not site:
            raise ValueError("serve_website requires site")

        index = _resolve_site_path(site, "index.html")
        if not index.exists():
            raise FileNotFoundError(
                f"site '{site}' has no index.html at {index}"
            )

        public_base = task.action_config.get("public_base_url", "").rstrip("/")
        url = f"{public_base}/sites/{site}/" if public_base else f"/sites/{site}/"
        return {
            "action": "serve_website",
            "site": site,
            "url": url,
        }

    def _interpolate(self, template: str, context: dict[str, Any]) -> str:
        """Simple template interpolation with {key} syntax."""
        result = template
        for key, value in context.items():
            if isinstance(value, str):
                result = result.replace(f"{{{key}}}", value)
            elif isinstance(value, (dict, list)):
                result = result.replace(f"{{{key}}}", json.dumps(value))
            else:
                result = result.replace(f"{{{key}}}", str(value))
        return result
