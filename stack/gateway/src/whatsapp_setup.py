"""
OpenClaw Gateway — WhatsApp AI setup orchestration.

Intercepts missing-AI setup in WhatsApp chats, sends interactive button menus
for provider selection, and reuses the dashboard's browser-link OAuth flow.
Mirrors the Telegram setup flow in telegram_setup.py.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from .dispatcher import Dispatcher

logger = logging.getLogger(__name__)

SESSION_TTL_SECONDS = 15 * 60
PROMPT_KEY = "whatsapp_ai_setup_missing"
PROMPT_COOLDOWN_SECONDS = 12 * 60 * 60
PROVIDER_LABELS = {
    "openai": "ChatGPT",
    "anthropic": "Claude",
}
PROVIDER_BUTTON_PREFIX = "ocai:provider:"
CANCEL_BUTTON = "ocai:cancel"
DEFAULT_MODELS = {
    "openai": "gpt-5.3-codex",
    "anthropic": "claude-opus-4-6",
}


@dataclass
class WhatsAppSetupSession:
    chat_id: str
    phase: str
    provider: str | None = None
    dashboard_setup_url: str = ""
    current_provider_before_flow: str = ""
    current_model_before_flow: str = ""
    current_auth_method_before_flow: str = ""
    dashboard_session: dict[str, Any] | None = None
    started_at: float = field(default_factory=time.time)


class WhatsAppSetupManager:
    def __init__(
        self,
        *,
        dispatcher: Dispatcher,
        agent_url: str,
        dashboard_internal_url: str,
        service_token: str,
    ):
        self.dispatcher = dispatcher
        self.agent_url = agent_url.rstrip("/")
        self.dashboard_internal_url = dashboard_internal_url.rstrip("/")
        self.service_token = service_token.strip()
        self._sessions: dict[str, WhatsAppSetupSession] = {}

    async def handle_message(self, incoming: Any) -> bool:
        chat_id = str(incoming.chat_id)
        text = str(incoming.text or "")
        metadata = incoming.metadata or {}

        # Handle interactive button replies (id comes as the text after normalization)
        if text == CANCEL_BUTTON:
            session = await self._get_session(chat_id)
            if session and session.provider and self.dashboard_internal_url:
                try:
                    await self._dashboard_request(
                        "POST",
                        f"/dashboard-api/providers/{session.provider}/connect/cancel",
                    )
                except (ValueError, httpx.HTTPError) as exc:
                    logger.info("Could not cancel %s setup session: %s", session.provider, exc)
            self._sessions.pop(chat_id, None)
            await self.dispatcher.send_whatsapp(
                chat_id, "Setup cancelled.", metadata
            )
            setup_status = await self._fetch_setup_status()
            if setup_status:
                await self._show_selector(chat_id, setup_status, trigger="cancelled")
            return True

        if text.startswith(PROVIDER_BUTTON_PREFIX):
            provider = text[len(PROVIDER_BUTTON_PREFIX):].strip().lower()
            if provider in PROVIDER_LABELS:
                setup_status = await self._fetch_setup_status()
                if setup_status:
                    await self._start_provider_flow(chat_id, provider, setup_status)
                return True

        command = self._detect_connect_command(text)
        session = await self._get_session(chat_id)

        if command == "selector":
            setup_status = await self._fetch_setup_status()
            if not setup_status:
                await self.dispatcher.send_whatsapp(
                    chat_id,
                    "Your bot is still starting up. Give it a moment and try again.",
                )
                return True
            await self._show_selector(chat_id, setup_status, trigger="message")
            return True

        if command in PROVIDER_LABELS:
            setup_status = await self._fetch_setup_status()
            if not setup_status:
                label = self._provider_label(command)
                await self.dispatcher.send_whatsapp(
                    chat_id,
                    f"Your bot is still starting up and cannot begin {label} setup yet. Give it a moment and try again.",
                )
                return True
            await self._start_provider_flow(chat_id, command, setup_status)
            return True

        if session and session.phase == "submitting":
            await self.dispatcher.send_whatsapp(
                chat_id,
                "I am still finishing that AI connection. Give it a few seconds, then try again if needed.",
                metadata,
            )
            return True

        if session and session.phase == "awaiting_input" and session.provider:
            await self._submit_provider_input(incoming, session)
            return True

        setup_status = await self._fetch_setup_status()
        if setup_status and setup_status.get("setupRequired"):
            await self._show_selector(chat_id, setup_status, trigger="message")
            return True

        if not setup_status:
            await self.dispatcher.send_whatsapp(
                chat_id,
                "Your bot is still starting up. Give it a moment and try again.",
            )
            return True

        return False

    async def trigger_owner_prompt(self, trigger: str) -> dict[str, Any]:
        setup_status = await self._fetch_setup_status()
        if not setup_status:
            return {"sent": False, "skipped": "agent_unavailable"}
        if not setup_status.get("setupRequired"):
            return {"sent": False, "skipped": "ai_already_connected"}

        owner_chat_id = await self._fetch_owner_chat_id()
        if not owner_chat_id:
            return {"sent": False, "skipped": "owner_chat_missing"}

        try:
            claim = await self._agent_request(
                "POST",
                "/api/setup/prompts/claim",
                {
                    "promptKey": PROMPT_KEY,
                    "channelType": "whatsapp",
                    "recipientChatId": owner_chat_id,
                    "cooldownSeconds": PROMPT_COOLDOWN_SECONDS,
                    "metadata": {"trigger": trigger},
                },
            )
        except (ValueError, httpx.HTTPError) as exc:
            logger.warning("Could not claim WhatsApp setup prompt: %s", exc)
            return {"sent": False, "skipped": "claim_failed"}
        if not claim:
            return {"sent": False, "skipped": "claim_failed"}
        if not claim.get("shouldSend"):
            return {"sent": False, "skipped": "cooldown_active", "lastSentAt": claim.get("lastSentAt")}

        sent = await self._show_selector(owner_chat_id, setup_status, trigger=trigger)
        return {"sent": sent, "ownerChatId": owner_chat_id}

    async def run_startup_prompt(self) -> None:
        for attempt in range(10):
            if attempt:
                await asyncio.sleep(3)

            try:
                result = await self.trigger_owner_prompt("startup")
            except Exception as exc:
                logger.warning("WhatsApp startup prompt attempt %s failed: %s", attempt + 1, exc)
                continue

            if result.get("skipped") == "agent_unavailable":
                continue

            logger.info("WhatsApp startup prompt result: %s", result)
            return

    async def _start_provider_flow(
        self,
        chat_id: str,
        provider: str,
        setup_status: dict[str, Any],
    ) -> bool:
        if not self.dashboard_internal_url:
            await self._send_dashboard_only(chat_id, setup_status)
            return True

        session = await self._get_session(chat_id)
        if session and session.provider and session.provider != provider:
            try:
                await self._dashboard_request(
                    "POST",
                    f"/dashboard-api/providers/{session.provider}/connect/cancel",
                )
            except (ValueError, httpx.HTTPError) as exc:
                logger.info("Could not cancel stale %s setup session: %s", session.provider, exc)

        try:
            result = await self._dashboard_request(
                "POST",
                f"/dashboard-api/providers/{provider}/connect/start",
            )
        except (ValueError, httpx.HTTPError) as exc:
            logger.warning("Could not start %s connect flow: %s", provider, exc)
            await self._send_dashboard_only(chat_id, setup_status)
            return True

        snapshot = result.get("session") if isinstance(result, dict) else None
        if not snapshot or not snapshot.get("url"):
            await self.dispatcher.send_whatsapp(
                chat_id,
                f"I could not start the {self._provider_label(provider)} browser link here. Use your dashboard instead: {setup_status.get('dashboardSetupUrl', '')}",
            )
            return True

        self._sessions[chat_id] = WhatsAppSetupSession(
            chat_id=chat_id,
            phase="awaiting_input",
            provider=provider,
            dashboard_setup_url=str(setup_status.get("dashboardSetupUrl") or ""),
            current_provider_before_flow=str(setup_status.get("currentProvider") or ""),
            current_model_before_flow=str(setup_status.get("currentModel") or ""),
            current_auth_method_before_flow=str(setup_status.get("currentAuthMethod") or ""),
            dashboard_session=snapshot,
        )
        await self.dispatcher.send_whatsapp(
            chat_id,
            self._provider_prompt_text(provider, snapshot, setup_status),
        )
        return True

    async def _submit_provider_input(
        self,
        incoming: Any,
        session: WhatsAppSetupSession,
    ) -> None:
        provider = session.provider
        if not provider:
            return

        chat_id = str(incoming.chat_id)
        metadata = incoming.metadata or {}
        session.phase = "submitting"

        try:
            result = await self._dashboard_request(
                "POST",
                f"/dashboard-api/providers/{provider}/connect/submit",
                {"input": str(incoming.text or "")},
            )
        except (ValueError, httpx.HTTPError) as exc:
            logger.warning("Could not submit %s connect input: %s", provider, exc)
            self._sessions.pop(chat_id, None)
            setup_status = await self._fetch_setup_status()
            if setup_status:
                await self._send_dashboard_only(chat_id, setup_status)
            return

        snapshot = result.get("session") if isinstance(result, dict) else None
        if snapshot and snapshot.get("status") == "running":
            snapshot = await self._wait_for_completion(provider) or snapshot

        if snapshot and snapshot.get("status") == "completed":
            try:
                await self._apply_provider_selection(provider, session)
            except (ValueError, httpx.HTTPError) as exc:
                logger.warning("Connected %s but could not update agent config: %s", provider, exc)
                self._sessions.pop(chat_id, None)
                setup_url = str(
                    (await self._fetch_setup_status() or {}).get("dashboardSetupUrl")
                    or session.dashboard_setup_url
                )
                await self.dispatcher.send_whatsapp(
                    chat_id,
                    f"{self._provider_label(provider)} is connected, but I could not switch the bot to it automatically. Finish in dashboard: {setup_url}",
                )
                return
            self._sessions.pop(chat_id, None)
            await self.dispatcher.send_whatsapp(
                chat_id,
                f"{self._provider_label(provider)} is connected. Send your message again.",
            )
            return

        if snapshot and snapshot.get("status") == "error":
            self._sessions.pop(chat_id, None)
            setup_status = await self._fetch_setup_status()
            setup_url = str(
                (setup_status or {}).get("dashboardSetupUrl")
                or session.dashboard_setup_url
            )
            await self.dispatcher.send_whatsapp(
                chat_id,
                self._provider_error_text(provider, snapshot, setup_url),
            )
            return

        session.dashboard_session = snapshot or session.dashboard_session
        session.phase = "awaiting_input"
        await self.dispatcher.send_whatsapp(
            chat_id,
            self._still_waiting_text(provider, snapshot),
        )

    async def _show_selector(
        self,
        chat_id: str,
        setup_status: dict[str, Any],
        *,
        trigger: str,
    ) -> bool:
        self._sessions[chat_id] = WhatsAppSetupSession(
            chat_id=chat_id,
            phase="selecting_provider",
            dashboard_setup_url=str(setup_status.get("dashboardSetupUrl") or ""),
            current_provider_before_flow=str(setup_status.get("currentProvider") or ""),
            current_model_before_flow=str(setup_status.get("currentModel") or ""),
            current_auth_method_before_flow=str(setup_status.get("currentAuthMethod") or ""),
        )
        buttons = [
            {"id": f"{PROVIDER_BUTTON_PREFIX}openai", "title": "ChatGPT"},
            {"id": f"{PROVIDER_BUTTON_PREFIX}anthropic", "title": "Claude"},
        ]
        return await self.dispatcher.send_whatsapp_interactive(
            chat_id,
            self._selector_text(trigger, setup_status),
            buttons,
        )

    async def _send_dashboard_only(
        self,
        chat_id: str,
        setup_status: dict[str, Any],
    ) -> bool:
        setup_url = str(setup_status.get("dashboardSetupUrl") or "")
        return await self.dispatcher.send_whatsapp(
            chat_id,
            f"Open your dashboard to connect an AI provider: {setup_url}",
        )

    async def _apply_provider_selection(
        self,
        provider: str,
        session: WhatsAppSetupSession,
    ) -> None:
        setup_status = await self._fetch_setup_status()
        current_provider = str(
            (setup_status or {}).get("currentProvider")
            or session.current_provider_before_flow
        )
        current_model = str(
            (setup_status or {}).get("currentModel")
            or session.current_model_before_flow
        )
        current_auth_method = str(
            (setup_status or {}).get("currentAuthMethod")
            or session.current_auth_method_before_flow
        )
        default_model = self._default_model(provider, setup_status)

        updates: dict[str, Any] = {}
        if current_provider != provider:
            updates["model_provider"] = provider
            updates["model"] = default_model
        elif not self._model_matches_provider(provider, current_model):
            updates["model_provider"] = provider
            updates["model"] = default_model

        if current_auth_method != "consumer":
            updates["auth_method"] = "oauth"

        if not updates:
            return

        await self._agent_request("PUT", "/api/config", updates)

    async def _fetch_owner_chat_id(self) -> str:
        try:
            channels = await self._agent_request("GET", "/api/channels")
        except (ValueError, httpx.HTTPError) as exc:
            logger.warning("Could not load channels for WhatsApp setup prompt: %s", exc)
            return ""
        if not isinstance(channels, list):
            return ""

        for channel in channels:
            if str(channel.get("type") or "").lower() != "whatsapp":
                continue
            config = channel.get("config") if isinstance(channel.get("config"), dict) else {}
            owner_chat_id = str(config.get("ownerChatId") or "").strip()
            if owner_chat_id:
                return owner_chat_id
        return ""

    async def _fetch_setup_status(self) -> dict[str, Any] | None:
        try:
            data = await self._agent_request("GET", "/api/setup/status")
        except (ValueError, httpx.HTTPError) as exc:
            logger.warning("Could not load setup status: %s", exc)
            return None
        return data if isinstance(data, dict) else None

    async def _wait_for_completion(self, provider: str) -> dict[str, Any] | None:
        for _ in range(3):
            await asyncio.sleep(1)
            try:
                result = await self._dashboard_request(
                    "GET",
                    f"/dashboard-api/providers/{provider}/connect/session",
                )
            except (ValueError, httpx.HTTPError) as exc:
                logger.info("Could not poll %s connect session: %s", provider, exc)
                return None
            snapshot = result.get("session") if isinstance(result, dict) else None
            if snapshot and snapshot.get("status") in {"completed", "error", "awaiting_input"}:
                return snapshot
        return None

    async def _get_session(self, chat_id: str) -> WhatsAppSetupSession | None:
        session = self._sessions.get(chat_id)
        if not session:
            return None
        if time.time() - session.started_at <= SESSION_TTL_SECONDS:
            return session

        if session.provider and self.dashboard_internal_url:
            try:
                await self._dashboard_request(
                    "POST",
                    f"/dashboard-api/providers/{session.provider}/connect/cancel",
                )
            except (ValueError, httpx.HTTPError) as exc:
                logger.info("Could not cancel expired %s setup session: %s", session.provider, exc)
        self._sessions.pop(chat_id, None)
        return None

    async def _agent_request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
    ) -> Any:
        headers = self._service_headers()
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.request(
                method,
                f"{self.agent_url}{path}",
                json=payload,
                headers=headers,
            )
            response.raise_for_status()
            return response.json()

    async def _dashboard_request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
    ) -> Any:
        if not self.dashboard_internal_url:
            return None

        headers = self._service_headers()
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.request(
                method,
                f"{self.dashboard_internal_url}{path}",
                json=payload,
                headers=headers,
            )
            response.raise_for_status()
            return response.json()

    def _service_headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.service_token:
            headers["X-OpenClaw-Service-Token"] = self.service_token
        return headers

    def _detect_connect_command(self, text: str) -> str | None:
        normalized = re.sub(r"\s+", " ", text.strip().lower())
        if not normalized:
            return None

        if not any(term in normalized for term in ("connect", "setup", "link", "oauth", "auth")):
            return None
        if any(term in normalized for term in ("chatgpt", "openai", "gpt")):
            return "openai"
        if any(term in normalized for term in ("claude", "anthropic")):
            return "anthropic"
        if "ai" in normalized:
            return "selector"
        return None

    def _selector_text(self, trigger: str, setup_status: dict[str, Any]) -> str:
        setup_url = str(setup_status.get("dashboardSetupUrl") or "")
        if trigger == "startup":
            base = "Your bot is live! Let's connect an AI to power it."
        else:
            base = "This bot needs an AI account before it can reply."
        dashboard_hint = f"\n\nYou can also connect Gemini, Kimi, or DeepSeek from the dashboard: {setup_url}" if setup_url else ""
        return f"{base}\n\nChoose ChatGPT or Claude below.{dashboard_hint}"

    def _provider_prompt_text(
        self,
        provider: str,
        snapshot: dict[str, Any],
        setup_status: dict[str, Any],
    ) -> str:
        label = self._provider_label(provider)
        url = str(snapshot.get("url") or "")
        if provider == "openai":
            paste_help = "After ChatGPT redirects to localhost, copy the full localhost URL or code and paste it back in this chat."
        else:
            paste_help = "After Claude finishes, copy the code or redirect URL and paste it back in this chat."

        return (
            f"Connect {label} in your browser:\n{url}\n\n"
            f"{paste_help}"
        )

    def _provider_error_text(self, provider: str, snapshot: dict[str, Any], setup_url: str) -> str:
        detail = self._session_error(snapshot)
        return (
            f"{self._provider_label(provider)} setup did not finish.\n"
            f"{detail}\n\n"
            f"Try again by typing 'connect {self._provider_label(provider).lower()}' or open: {setup_url}"
        )

    def _still_waiting_text(self, provider: str, snapshot: dict[str, Any] | None) -> str:
        if snapshot and snapshot.get("status") == "awaiting_input":
            return (
                f"I still need the final {self._provider_label(provider)} redirect URL or code. "
                "Paste it in this chat."
            )
        return (
            f"I am still finishing {self._provider_label(provider)} setup. "
            "If nothing happens, paste the final URL or code again."
        )

    def _provider_label(self, provider: str) -> str:
        return PROVIDER_LABELS.get(provider, provider.title())

    def _default_model(self, provider: str, setup_status: dict[str, Any] | None) -> str:
        providers = setup_status.get("supportedChatConnectProviders") if isinstance(setup_status, dict) else None
        if isinstance(providers, list):
            for item in providers:
                if str(item.get("id") or "") == provider:
                    model = str(item.get("defaultModel") or "").strip()
                    if model:
                        return model
        return DEFAULT_MODELS.get(provider, "")

    def _model_matches_provider(self, provider: str, model: str) -> bool:
        normalized = model.strip().lower()
        if not normalized:
            return False
        if provider == "anthropic":
            return "claude" in normalized
        return not any(term in normalized for term in ("claude", "gemini", "kimi"))

    def _session_error(self, snapshot: dict[str, Any]) -> str:
        logs = str(snapshot.get("logs") or "")
        lines = [line.strip() for line in logs.splitlines() if line.strip()]
        return lines[-1] if lines else "The browser link expired or token exchange failed."
