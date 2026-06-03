"""
OpenClaw Gateway — Telegram AI setup orchestration.

Intercepts missing-AI setup in Telegram private chats, reuses the dashboard's
browser-link OAuth flow, and can proactively DM the verified Telegram owner
when Telegram is connected but AI is still missing.
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
PROMPT_KEY = "telegram_ai_setup_missing"
PROMPT_COOLDOWN_SECONDS = 12 * 60 * 60
PROVIDER_LABELS = {
    "openai": "ChatGPT",
    "anthropic": "Claude",
}
PROVIDER_CALLBACK_PREFIX = "ocai:provider:"
CANCEL_CALLBACK = "ocai:cancel"
DEFAULT_MODELS = {
    "openai": "gpt-5.5",
    "anthropic": "claude-opus-4-8",
}


@dataclass
class TelegramSetupSession:
    chat_id: str
    phase: str
    provider: str | None = None
    dashboard_setup_url: str = ""
    current_provider_before_flow: str = ""
    current_model_before_flow: str = ""
    current_auth_method_before_flow: str = ""
    dashboard_session: dict[str, Any] | None = None
    started_at: float = field(default_factory=time.time)


class TelegramSetupManager:
    def __init__(
        self,
        *,
        dispatcher: Dispatcher,
        telegram_bot_token: str,
        agent_url: str,
        dashboard_internal_url: str,
        service_token: str,
    ):
        self.dispatcher = dispatcher
        self.telegram_bot_token = telegram_bot_token.strip()
        self.agent_url = agent_url.rstrip("/")
        self.dashboard_internal_url = dashboard_internal_url.rstrip("/")
        self.service_token = service_token.strip()
        self._sessions: dict[str, TelegramSetupSession] = {}

    async def handle_message(self, incoming: Any) -> bool:
        if not self.telegram_bot_token:
            return False

        chat_id = str(incoming.chat_id)
        metadata = incoming.metadata or {}
        chat_type = str(metadata.get("chat_type") or "private")
        text = str(incoming.text or "")
        callback_query_id = str(metadata.get("callback_query_id") or "").strip()

        if callback_query_id:
            return await self._handle_callback(incoming)

        command = self._detect_connect_command(text)
        session = await self._get_session(chat_id)

        if chat_type != "private":
            if command:
                setup_status = await self._fetch_setup_status()
                if setup_status:
                    await self._send_dashboard_only(
                        chat_id,
                        setup_status,
                        reply_to_message_id=metadata.get("message_id"),
                    )
                return True

            setup_status = await self._fetch_setup_status()
            if setup_status and setup_status.get("setupRequired"):
                await self._send_dashboard_only(
                    chat_id,
                    setup_status,
                    reply_to_message_id=metadata.get("message_id"),
                )
                return True
            if not setup_status:
                return True  # Suppress message until agent is ready
            return False

        if command == "selector":
            setup_status = await self._fetch_setup_status()
            if not setup_status:
                await self.dispatcher.send_telegram(
                    chat_id,
                    "Your bot is still starting up. Give it a moment and try again.",
                    {"reply_to_message_id": metadata.get("message_id")} if metadata.get("message_id") else None,
                )
                return True
            await self._show_selector(
                chat_id,
                setup_status,
                reply_to_message_id=metadata.get("message_id"),
                trigger="message",
            )
            return True

        if command in PROVIDER_LABELS:
            setup_status = await self._fetch_setup_status()
            if not setup_status:
                label = self._provider_label(command)
                await self.dispatcher.send_telegram(
                    chat_id,
                    f"Your bot is still starting up and cannot begin {label} setup yet. Give it a moment and try again.",
                    {"reply_to_message_id": metadata.get("message_id")} if metadata.get("message_id") else None,
                )
                return True
            await self._start_provider_flow(
                chat_id,
                command,
                setup_status,
                reply_to_message_id=metadata.get("message_id"),
            )
            return True

        if session and session.phase == "submitting":
            await self.dispatcher.send_telegram(
                chat_id,
                "I am still finishing that AI connection. Give it a few seconds, then try again if needed.",
                {"reply_to_message_id": metadata.get("message_id")},
                reply_markup=self._provider_keyboard(session.dashboard_setup_url),
            )
            return True

        if session and session.phase == "awaiting_input" and session.provider:
            await self._submit_provider_input(incoming, session)
            return True

        setup_status = await self._fetch_setup_status()
        if setup_status and setup_status.get("setupRequired"):
            await self._show_selector(
                chat_id,
                setup_status,
                reply_to_message_id=metadata.get("message_id"),
                trigger="message",
            )
            return True

        # Dashboard not ready yet — intercept the message to avoid raw errors
        if not setup_status:
            await self.dispatcher.send_telegram(
                chat_id,
                "Your bot is still starting up. Give it a moment and try again.",
                {"reply_to_message_id": metadata.get("message_id")} if metadata.get("message_id") else None,
            )
            return True

        return False

    async def trigger_owner_prompt(self, trigger: str) -> dict[str, Any]:
        if not self.telegram_bot_token:
            return {"sent": False, "skipped": "telegram_not_configured"}

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
                    "channelType": "telegram",
                    "recipientChatId": owner_chat_id,
                    "cooldownSeconds": PROMPT_COOLDOWN_SECONDS,
                    "metadata": {"trigger": trigger},
                },
            )
        except (ValueError, httpx.HTTPError) as exc:
            logger.warning("Could not claim Telegram setup prompt: %s", exc)
            return {"sent": False, "skipped": "claim_failed"}
        if not claim:
            return {"sent": False, "skipped": "claim_failed"}
        if not claim.get("shouldSend"):
            return {"sent": False, "skipped": "cooldown_active", "lastSentAt": claim.get("lastSentAt")}

        sent = await self._show_selector(
            owner_chat_id,
            setup_status,
            trigger=trigger,
        )
        return {"sent": sent, "ownerChatId": owner_chat_id}

    async def run_startup_prompt(self) -> None:
        if not self.telegram_bot_token:
            return

        for attempt in range(10):
            if attempt:
                await asyncio.sleep(3)

            if not await self._telegram_bot_is_live():
                logger.warning("Skipping Telegram startup setup prompt: bot token is not live")
                return

            try:
                result = await self.trigger_owner_prompt("startup")
            except Exception as exc:
                logger.warning("Telegram startup prompt attempt %s failed: %s", attempt + 1, exc)
                continue

            if result.get("skipped") == "agent_unavailable":
                continue

            logger.info("Telegram startup prompt result: %s", result)
            return

    async def _handle_callback(self, incoming: Any) -> bool:
        metadata = incoming.metadata or {}
        callback_query_id = str(metadata.get("callback_query_id") or "").strip()
        if not callback_query_id:
            return False

        text = str(incoming.text or "")
        chat_id = str(incoming.chat_id)
        chat_type = str(metadata.get("chat_type") or "private")

        if text == CANCEL_CALLBACK:
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
            await self.dispatcher.answer_telegram_callback(callback_query_id, "Setup cancelled.")

            setup_status = await self._fetch_setup_status()
            if setup_status:
                callback_message_id = metadata.get("message_id")
                if callback_message_id:
                    await self.dispatcher.edit_telegram_message(
                        chat_id,
                        callback_message_id,
                        self._selector_text("cancelled"),
                        reply_markup=self._selector_keyboard(str(setup_status.get("dashboardSetupUrl") or "")),
                        parse_mode="HTML",
                    )
                else:
                    await self._show_selector(chat_id, setup_status, trigger="cancelled")
            return True

        if not text.startswith(PROVIDER_CALLBACK_PREFIX):
            await self.dispatcher.answer_telegram_callback(callback_query_id)
            return True

        provider = text[len(PROVIDER_CALLBACK_PREFIX) :].strip().lower()
        if provider not in PROVIDER_LABELS:
            await self.dispatcher.answer_telegram_callback(
                callback_query_id,
                "That AI option is not supported here.",
                show_alert=True,
            )
            return True

        if chat_type != "private":
            await self.dispatcher.answer_telegram_callback(
                callback_query_id,
                "Finish AI setup in a private Telegram chat or in the dashboard.",
                show_alert=True,
            )
            setup_status = await self._fetch_setup_status()
            if setup_status:
                await self._send_dashboard_only(chat_id, setup_status)
            return True

        setup_status = await self._fetch_setup_status()
        if not setup_status:
            await self.dispatcher.answer_telegram_callback(
                callback_query_id,
                "The setup service is not ready yet.",
                show_alert=True,
            )
            return True

        await self.dispatcher.answer_telegram_callback(
            callback_query_id,
            f"Starting {self._provider_label(provider)} setup...",
        )
        # Edit the selector message to remove buttons while flow starts
        callback_message_id = metadata.get("message_id")
        if callback_message_id:
            await self.dispatcher.edit_telegram_message(
                chat_id,
                callback_message_id,
                f"Setting up {self._provider_label(provider)}...",
                parse_mode="HTML",
            )
        await self._start_provider_flow(chat_id, provider, setup_status)
        return True

    async def _start_provider_flow(
        self,
        chat_id: str,
        provider: str,
        setup_status: dict[str, Any],
        *,
        reply_to_message_id: Any = None,
    ) -> bool:
        if not self.dashboard_internal_url:
            await self._send_dashboard_only(
                chat_id,
                setup_status,
                reply_to_message_id=reply_to_message_id,
            )
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
            await self._send_dashboard_only(
                chat_id,
                setup_status,
                reply_to_message_id=reply_to_message_id,
            )
            return True
        snapshot = result.get("session") if isinstance(result, dict) else None
        if not snapshot or not snapshot.get("url"):
            await self.dispatcher.send_telegram(
                chat_id,
                f"I could not start the {self._provider_label(provider)} browser link here. Use Open Dashboard instead.",
                {"reply_to_message_id": reply_to_message_id} if reply_to_message_id else None,
                reply_markup=self._selector_keyboard(setup_status.get("dashboardSetupUrl", "")),
            )
            return True

        self._sessions[chat_id] = TelegramSetupSession(
            chat_id=chat_id,
            phase="awaiting_input",
            provider=provider,
            dashboard_setup_url=str(setup_status.get("dashboardSetupUrl") or ""),
            current_provider_before_flow=str(setup_status.get("currentProvider") or ""),
            current_model_before_flow=str(setup_status.get("currentModel") or ""),
            current_auth_method_before_flow=str(setup_status.get("currentAuthMethod") or ""),
            dashboard_session=snapshot,
        )
        oauth_url = str(snapshot.get("url") or "")
        await self.dispatcher.send_telegram(
            chat_id,
            self._provider_prompt_text(provider, snapshot, setup_status),
            {"reply_to_message_id": reply_to_message_id} if reply_to_message_id else None,
            reply_markup=self._provider_keyboard(
                str(setup_status.get("dashboardSetupUrl") or ""),
                oauth_url=oauth_url,
            ),
            disable_web_page_preview=True,
        )
        return True

    async def _submit_provider_input(
        self,
        incoming: Any,
        session: TelegramSetupSession,
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
                await self._send_dashboard_only(
                    chat_id,
                    setup_status,
                    reply_to_message_id=metadata.get("message_id"),
                )
            return
        snapshot = result.get("session") if isinstance(result, dict) else None
        if snapshot and snapshot.get("status") == "running":
            snapshot = await self._wait_for_completion(provider) or snapshot

        if snapshot and snapshot.get("status") == "completed":
            await self.dispatcher.delete_telegram_message(chat_id, metadata.get("message_id"))
            try:
                await self._apply_provider_selection(provider, session)
            except (ValueError, httpx.HTTPError) as exc:
                logger.warning("Connected %s but could not update agent config: %s", provider, exc)
                self._sessions.pop(chat_id, None)
                setup_status = await self._fetch_setup_status()
                setup_url = str(
                    (setup_status or {}).get("dashboardSetupUrl")
                    or session.dashboard_setup_url
                )
                await self.dispatcher.send_telegram(
                    chat_id,
                    f"{self._provider_label(provider)} is connected, but I could not switch the bot to it automatically. Finish that step in Open Dashboard.",
                    reply_markup=self._selector_keyboard(setup_url),
                    disable_web_page_preview=True,
                )
                return
            self._sessions.pop(chat_id, None)
            await self.dispatcher.send_telegram(
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
            await self.dispatcher.send_telegram(
                chat_id,
                self._provider_error_text(provider, snapshot),
                {"reply_to_message_id": metadata.get("message_id")},
                reply_markup=self._selector_keyboard(setup_url),
                disable_web_page_preview=True,
            )
            return

        session.dashboard_session = snapshot or session.dashboard_session
        session.phase = "awaiting_input"
        await self.dispatcher.send_telegram(
            chat_id,
            self._still_waiting_text(provider, snapshot),
            {"reply_to_message_id": metadata.get("message_id")},
            reply_markup=self._provider_keyboard(session.dashboard_setup_url),
        )

    async def _show_selector(
        self,
        chat_id: str,
        setup_status: dict[str, Any],
        *,
        reply_to_message_id: Any = None,
        trigger: str,
    ) -> int | None:
        self._sessions[chat_id] = TelegramSetupSession(
            chat_id=chat_id,
            phase="selecting_provider",
            dashboard_setup_url=str(setup_status.get("dashboardSetupUrl") or ""),
            current_provider_before_flow=str(setup_status.get("currentProvider") or ""),
            current_model_before_flow=str(setup_status.get("currentModel") or ""),
            current_auth_method_before_flow=str(setup_status.get("currentAuthMethod") or ""),
        )
        return await self.dispatcher.send_telegram(
            chat_id,
            self._selector_text(trigger),
            {"reply_to_message_id": reply_to_message_id} if reply_to_message_id else None,
            reply_markup=self._selector_keyboard(str(setup_status.get("dashboardSetupUrl") or "")),
            disable_web_page_preview=True,
        )

    async def _send_dashboard_only(
        self,
        chat_id: str,
        setup_status: dict[str, Any],
        *,
        reply_to_message_id: Any = None,
    ) -> int | None:
        return await self.dispatcher.send_telegram(
            chat_id,
            self._dashboard_only_text(setup_status),
            {"reply_to_message_id": reply_to_message_id} if reply_to_message_id else None,
            reply_markup=self._dashboard_keyboard(str(setup_status.get("dashboardSetupUrl") or "")),
            disable_web_page_preview=True,
        )

    async def _apply_provider_selection(
        self,
        provider: str,
        session: TelegramSetupSession,
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
            logger.warning("Could not load channels for Telegram setup prompt: %s", exc)
            return ""
        if not isinstance(channels, list):
            return ""

        for channel in channels:
            if str(channel.get("type") or "").lower() != "telegram":
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

    async def _get_session(self, chat_id: str) -> TelegramSetupSession | None:
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

    async def _telegram_bot_is_live(self) -> bool:
        if not self.telegram_bot_token:
            return False
        url = f"https://api.telegram.org/bot{self.telegram_bot_token}/getMe"
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                response = await client.get(url)
                response.raise_for_status()
                data = response.json()
                return bool(data.get("ok"))
        except (ValueError, httpx.HTTPError) as exc:
            logger.warning("Telegram getMe failed: %s", exc)
            return False

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

        # Slash commands: /connectclaude, /connectchatgpt, /connectai
        slash_match = re.match(r"^/connect(claude|chatgpt|ai)\b", normalized)
        if slash_match:
            tag = slash_match.group(1)
            if tag == "claude":
                return "anthropic"
            if tag == "chatgpt":
                return "openai"
            return "selector"

        # Deep-link: /start connectclaude or /start connectchatgpt
        start_match = re.match(r"^/start\s+(connect(?:claude|chatgpt|ai))\b", normalized)
        if start_match:
            return self._detect_connect_command(f"/{start_match.group(1)}")

        if not any(term in normalized for term in ("connect", "setup", "link", "oauth", "auth")):
            return None
        if any(term in normalized for term in ("chatgpt", "openai", "gpt")):
            return "openai"
        if any(term in normalized for term in ("claude", "anthropic")):
            return "anthropic"
        if "ai" in normalized:
            return "selector"
        return None

    def _selector_text(self, trigger: str) -> str:
        if trigger == "startup":
            return (
                "Your bot is live! Let's connect an AI to power it.\n\n"
                "Choose ChatGPT or Claude below.\n"
                "You can also connect Gemini, Kimi, or DeepSeek from the dashboard."
            )
        return (
            "No AI provider is connected yet.\n\n"
            "Choose ChatGPT or Claude below.\n"
            "You can also connect Gemini, Kimi, or DeepSeek from the dashboard."
        )

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
            f"Tap \"Open Login\" below to open in your browser. "
            f"On mobile, if login doesn\u2019t load, tap \u22ee \u2192 Open in Safari/Chrome.\n\n"
            f"{paste_help}\n\n"
            f"If you want another provider, open {setup_status.get('dashboardSetupUrl', '')}."
        )

    def _provider_error_text(self, provider: str, snapshot: dict[str, Any]) -> str:
        detail = self._session_error(snapshot)
        return (
            f"{self._provider_label(provider)} setup did not finish.\n"
            f"{detail}\n\n"
            "Try again here or use Open Dashboard."
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

    def _dashboard_only_text(self, setup_status: dict[str, Any]) -> str:
        setup_url = str(setup_status.get("dashboardSetupUrl") or "")
        return (
            "This Telegram chat cannot finish AI setup directly.\n"
            f"Open {setup_url} to connect ChatGPT, Claude, Gemini, Kimi, or DeepSeek."
        )

    def _selector_keyboard(self, setup_url: str) -> dict[str, Any]:
        keyboard = [
            [
                {"text": "ChatGPT", "callback_data": f"{PROVIDER_CALLBACK_PREFIX}openai"},
                {"text": "Claude", "callback_data": f"{PROVIDER_CALLBACK_PREFIX}anthropic"},
            ]
        ]
        if setup_url:
            keyboard.append([{"text": "Open Dashboard", "url": setup_url}])
        return {"inline_keyboard": keyboard}

    def _provider_keyboard(self, setup_url: str, oauth_url: str = "") -> dict[str, Any]:
        keyboard: list[list[dict[str, Any]]] = []
        if oauth_url:
            keyboard.append([{"text": "Open Login \u2197", "url": oauth_url}])
        keyboard.append([{"text": "Cancel", "callback_data": CANCEL_CALLBACK}])
        if setup_url:
            keyboard.append([{"text": "Open Dashboard", "url": setup_url}])
        return {"inline_keyboard": keyboard}

    def _dashboard_keyboard(self, setup_url: str) -> dict[str, Any] | None:
        if not setup_url:
            return None
        return {"inline_keyboard": [[{"text": "Open Dashboard", "url": setup_url}]]}

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
