"""
OpenClaw Agent — LLM Client with 4 provider adapters + OAuth refresh.

Supports: OpenAI (gpt-5.3-codex), Anthropic (Claude Opus 4.6),
          Google Gemini (3 Deep Think), Moonshot Kimi (K2.5).

OAuth tokens are auto-refreshed before expiry.
API key flow is supported as a fallback for all providers.
"""

from __future__ import annotations

import json as _json
import logging
from abc import ABC, abstractmethod
from datetime import datetime, timedelta, timezone
from typing import Any, AsyncIterator, Optional

import httpx

from .db import Database
from .models import AgentConfig, AuthMethod, ModelProvider, OAuthTokens

logger = logging.getLogger(__name__)

# ── Token Refresh Endpoints ──────────────────────────────────

REFRESH_URLS = {
    "openai": "https://auth.openai.com/oauth/token",
    "anthropic": "https://console.anthropic.com/oauth/token",
}


# ── Base Adapter ─────────────────────────────────────────────


class LLMAdapter(ABC):
    """Base class for LLM provider adapters."""

    def __init__(self, db: Database, config: AgentConfig):
        self.db = db
        self.config = config

    @abstractmethod
    async def chat(
        self,
        messages: list[dict[str, str]],
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
    ) -> dict[str, Any]:
        """Send messages and get a response."""
        ...

    @abstractmethod
    async def chat_stream(
        self,
        messages: list[dict[str, str]],
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
    ) -> AsyncIterator[str]:
        """Stream a response token by token."""
        ...

    async def get_auth_headers(self) -> dict[str, str]:
        """Get authorization headers, refreshing OAuth tokens if needed."""
        if self.config.auth_method == AuthMethod.OAUTH:
            return await self._get_oauth_headers()
        else:
            return await self._get_api_key_headers()

    async def _get_oauth_headers(self) -> dict[str, str]:
        provider = self.config.model_provider.value
        tokens = await self.db.get_oauth_tokens(provider)

        if not tokens:
            raise RuntimeError(
                f"No OAuth tokens found for {provider}. "
                "Please reconnect your account."
            )

        # Refresh if expiring within 5 minutes
        if tokens.expires_at < datetime.now(timezone.utc) + timedelta(minutes=5):
            tokens = await self._refresh_oauth_token(provider, tokens)

        return {"Authorization": f"Bearer {tokens.access_token}"}

    async def _get_api_key_headers(self) -> dict[str, str]:
        provider = self.config.model_provider.value
        api_key = await self.db.get_api_key(provider)

        if not api_key:
            raise RuntimeError(
                f"No API key found for {provider}. "
                "Please add your API key in settings."
            )

        # Provider-specific header format
        if provider == "anthropic":
            return {
                "x-api-key": api_key,
                "anthropic-version": "2024-01-01",
            }
        else:
            return {"Authorization": f"Bearer {api_key}"}

    async def _refresh_oauth_token(
        self, provider: str, tokens: OAuthTokens
    ) -> OAuthTokens:
        refresh_url = REFRESH_URLS.get(provider)
        if not refresh_url:
            raise RuntimeError(f"OAuth refresh not supported for {provider}")

        logger.info(f"Refreshing OAuth token for {provider}")

        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                refresh_url,
                data={
                    "grant_type": "refresh_token",
                    "refresh_token": tokens.refresh_token,
                    "client_id": self._get_client_id(provider),
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            resp.raise_for_status()
            data = resp.json()

        expires_in = data.get("expires_in", 3600)
        new_tokens = OAuthTokens(
            provider=provider,
            access_token=data["access_token"],
            refresh_token=data.get("refresh_token", tokens.refresh_token),
            expires_at=datetime.now(timezone.utc) + timedelta(seconds=expires_in),
        )

        await self.db.save_oauth_tokens(new_tokens)
        logger.info(f"OAuth token refreshed for {provider}")
        return new_tokens

    def _get_client_id(self, provider: str) -> str:
        import os

        return os.environ.get(f"{provider.upper()}_CLIENT_ID", "")


# ── OpenAI Adapter ───────────────────────────────────────────


class OpenAIAdapter(LLMAdapter):
    """Adapter for OpenAI / ChatGPT models (default: gpt-5.3-codex).

    OAuth (ChatGPT subscription) → Responses API at chatgpt.com/backend-api
    API key                      → Chat Completions API at api.openai.com/v1
    """

    COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions"
    RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses"

    @property
    def _use_responses_api(self) -> bool:
        return self.config.auth_method == AuthMethod.OAUTH

    # ── Non-streaming ────────────────────────────────────────

    async def chat(
        self,
        messages: list[dict[str, str]],
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
    ) -> dict[str, Any]:
        headers = await self.get_auth_headers()
        headers["Content-Type"] = "application/json"

        if self._use_responses_api:
            return await self._chat_responses(headers, messages, temperature, max_tokens)
        return await self._chat_completions(headers, messages, temperature, max_tokens)

    async def _chat_responses(
        self,
        headers: dict[str, str],
        messages: list[dict[str, str]],
        temperature: Optional[float],
        max_tokens: Optional[int],
    ) -> dict[str, Any]:
        """Call the Responses API (OAuth / ChatGPT subscription)."""
        payload: dict[str, Any] = {
            "model": self.config.model,
            "input": messages,
            "store": False,
        }
        if temperature is not None or self.config.temperature:
            payload["temperature"] = temperature or self.config.temperature
        if max_tokens is not None or self.config.max_tokens:
            payload["max_output_tokens"] = max_tokens or self.config.max_tokens

        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(self.RESPONSES_URL, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()

        # Extract text from Responses API output format
        text = ""
        for output_item in data.get("output", []):
            if output_item.get("type") == "message":
                for block in output_item.get("content", []):
                    if block.get("type") == "output_text":
                        text += block.get("text", "")

        usage = data.get("usage", {})
        return {
            "content": text,
            "finish_reason": data.get("status", "completed"),
            "tokens_used": usage.get("total_tokens", 0),
            "model": data.get("model", self.config.model),
        }

    async def _chat_completions(
        self,
        headers: dict[str, str],
        messages: list[dict[str, str]],
        temperature: Optional[float],
        max_tokens: Optional[int],
    ) -> dict[str, Any]:
        """Call the Chat Completions API (API key)."""
        payload = {
            "model": self.config.model,
            "messages": messages,
            "temperature": temperature or self.config.temperature,
            "max_tokens": max_tokens or self.config.max_tokens,
        }

        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(self.COMPLETIONS_URL, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()

        choice = data["choices"][0]
        usage = data.get("usage", {})
        return {
            "content": choice["message"]["content"],
            "finish_reason": choice.get("finish_reason", "stop"),
            "tokens_used": usage.get("total_tokens", 0),
            "model": data.get("model", self.config.model),
        }

    # ── Streaming ────────────────────────────────────────────

    async def chat_stream(
        self,
        messages: list[dict[str, str]],
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
    ) -> AsyncIterator[str]:
        headers = await self.get_auth_headers()
        headers["Content-Type"] = "application/json"

        if self._use_responses_api:
            async for token in self._stream_responses(headers, messages, temperature, max_tokens):
                yield token
        else:
            async for token in self._stream_completions(headers, messages, temperature, max_tokens):
                yield token

    async def _stream_responses(
        self,
        headers: dict[str, str],
        messages: list[dict[str, str]],
        temperature: Optional[float],
        max_tokens: Optional[int],
    ) -> AsyncIterator[str]:
        """Stream from the Responses API (OAuth / ChatGPT subscription)."""
        payload: dict[str, Any] = {
            "model": self.config.model,
            "input": messages,
            "store": False,
            "stream": True,
        }
        if temperature is not None or self.config.temperature:
            payload["temperature"] = temperature or self.config.temperature
        if max_tokens is not None or self.config.max_tokens:
            payload["max_output_tokens"] = max_tokens or self.config.max_tokens

        async with httpx.AsyncClient(timeout=120) as client:
            async with client.stream(
                "POST", self.RESPONSES_URL, json=payload, headers=headers
            ) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    raw = line[6:]
                    if raw == "[DONE]":
                        break
                    event = _json.loads(raw)
                    if event.get("type") == "response.output_text.delta":
                        delta = event.get("delta", "")
                        if delta:
                            yield delta

    async def _stream_completions(
        self,
        headers: dict[str, str],
        messages: list[dict[str, str]],
        temperature: Optional[float],
        max_tokens: Optional[int],
    ) -> AsyncIterator[str]:
        """Stream from the Chat Completions API (API key)."""
        payload = {
            "model": self.config.model,
            "messages": messages,
            "temperature": temperature or self.config.temperature,
            "max_tokens": max_tokens or self.config.max_tokens,
            "stream": True,
        }

        async with httpx.AsyncClient(timeout=120) as client:
            async with client.stream(
                "POST", self.COMPLETIONS_URL, json=payload, headers=headers
            ) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if line.startswith("data: ") and line != "data: [DONE]":
                        chunk = _json.loads(line[6:])
                        delta = chunk["choices"][0].get("delta", {})
                        if "content" in delta and delta["content"]:
                            yield delta["content"]


# ── Anthropic Adapter ────────────────────────────────────────


class AnthropicAdapter(LLMAdapter):
    """Adapter for Anthropic / Claude models (default: Opus 4.6)."""

    BASE_URL = "https://api.anthropic.com/v1"

    async def chat(
        self,
        messages: list[dict[str, str]],
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
    ) -> dict[str, Any]:
        headers = await self.get_auth_headers()
        headers["Content-Type"] = "application/json"
        if "anthropic-version" not in headers:
            headers["anthropic-version"] = "2024-01-01"

        # Anthropic separates system message
        system_msg = None
        chat_messages = []
        for msg in messages:
            if msg["role"] == "system":
                system_msg = msg["content"]
            else:
                chat_messages.append(msg)

        payload: dict[str, Any] = {
            "model": self.config.model,
            "messages": chat_messages,
            "temperature": temperature or self.config.temperature,
            "max_tokens": max_tokens or self.config.max_tokens,
        }
        if system_msg:
            payload["system"] = system_msg

        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                f"{self.BASE_URL}/messages",
                json=payload,
                headers=headers,
            )
            resp.raise_for_status()
            data = resp.json()

        content_blocks = data.get("content", [])
        text = "".join(
            block["text"] for block in content_blocks if block["type"] == "text"
        )
        usage = data.get("usage", {})

        return {
            "content": text,
            "finish_reason": data.get("stop_reason", "end_turn"),
            "tokens_used": usage.get("input_tokens", 0)
            + usage.get("output_tokens", 0),
            "model": data.get("model", self.config.model),
        }

    async def chat_stream(
        self,
        messages: list[dict[str, str]],
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
    ) -> AsyncIterator[str]:
        headers = await self.get_auth_headers()
        headers["Content-Type"] = "application/json"
        if "anthropic-version" not in headers:
            headers["anthropic-version"] = "2024-01-01"

        system_msg = None
        chat_messages = []
        for msg in messages:
            if msg["role"] == "system":
                system_msg = msg["content"]
            else:
                chat_messages.append(msg)

        payload: dict[str, Any] = {
            "model": self.config.model,
            "messages": chat_messages,
            "temperature": temperature or self.config.temperature,
            "max_tokens": max_tokens or self.config.max_tokens,
            "stream": True,
        }
        if system_msg:
            payload["system"] = system_msg

        async with httpx.AsyncClient(timeout=120) as client:
            async with client.stream(
                "POST",
                f"{self.BASE_URL}/messages",
                json=payload,
                headers=headers,
            ) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if line.startswith("data: "):
                        import json

                        event = json.loads(line[6:])
                        if event.get("type") == "content_block_delta":
                            delta = event.get("delta", {})
                            if delta.get("type") == "text_delta":
                                yield delta.get("text", "")


# ── Gemini Adapter ───────────────────────────────────────────


class GeminiAdapter(LLMAdapter):
    """Adapter for Google Gemini (default: Gemini 3 Deep Think). API key only."""

    BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

    async def chat(
        self,
        messages: list[dict[str, str]],
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
    ) -> dict[str, Any]:
        api_key = await self.db.get_api_key("gemini")
        if not api_key:
            raise RuntimeError("No Gemini API key configured.")

        # Convert to Gemini format
        contents = []
        system_instruction = None
        for msg in messages:
            if msg["role"] == "system":
                system_instruction = msg["content"]
            else:
                role = "user" if msg["role"] == "user" else "model"
                contents.append(
                    {"role": role, "parts": [{"text": msg["content"]}]}
                )

        payload: dict[str, Any] = {
            "contents": contents,
            "generationConfig": {
                "temperature": temperature or self.config.temperature,
                "maxOutputTokens": max_tokens or self.config.max_tokens,
            },
        }
        if system_instruction:
            payload["systemInstruction"] = {
                "parts": [{"text": system_instruction}]
            }

        model = self.config.model
        url = f"{self.BASE_URL}/models/{model}:generateContent?key={api_key}"

        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(url, json=payload)
            resp.raise_for_status()
            data = resp.json()

        candidates = data.get("candidates", [])
        if not candidates:
            return {"content": "", "finish_reason": "error", "tokens_used": 0}

        parts = candidates[0].get("content", {}).get("parts", [])
        text = "".join(p.get("text", "") for p in parts)
        usage = data.get("usageMetadata", {})

        return {
            "content": text,
            "finish_reason": candidates[0].get("finishReason", "STOP"),
            "tokens_used": usage.get("totalTokenCount", 0),
            "model": model,
        }

    async def chat_stream(
        self,
        messages: list[dict[str, str]],
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
    ) -> AsyncIterator[str]:
        api_key = await self.db.get_api_key("gemini")
        if not api_key:
            raise RuntimeError("No Gemini API key configured.")

        contents = []
        system_instruction = None
        for msg in messages:
            if msg["role"] == "system":
                system_instruction = msg["content"]
            else:
                role = "user" if msg["role"] == "user" else "model"
                contents.append(
                    {"role": role, "parts": [{"text": msg["content"]}]}
                )

        payload: dict[str, Any] = {
            "contents": contents,
            "generationConfig": {
                "temperature": temperature or self.config.temperature,
                "maxOutputTokens": max_tokens or self.config.max_tokens,
            },
        }
        if system_instruction:
            payload["systemInstruction"] = {
                "parts": [{"text": system_instruction}]
            }

        model = self.config.model
        url = f"{self.BASE_URL}/models/{model}:streamGenerateContent?key={api_key}&alt=sse"

        async with httpx.AsyncClient(timeout=120) as client:
            async with client.stream("POST", url, json=payload) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if line.startswith("data: "):
                        import json

                        chunk = json.loads(line[6:])
                        candidates = chunk.get("candidates", [])
                        if candidates:
                            parts = (
                                candidates[0]
                                .get("content", {})
                                .get("parts", [])
                            )
                            for part in parts:
                                if "text" in part:
                                    yield part["text"]


# ── Kimi Adapter ─────────────────────────────────────────────


class KimiAdapter(LLMAdapter):
    """Adapter for Moonshot Kimi (default: K2.5). API key only.
    Uses OpenAI-compatible API format."""

    BASE_URL = "https://api.moonshot.cn/v1"

    async def chat(
        self,
        messages: list[dict[str, str]],
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
    ) -> dict[str, Any]:
        api_key = await self.db.get_api_key("kimi")
        if not api_key:
            raise RuntimeError("No Kimi API key configured.")

        payload = {
            "model": self.config.model,
            "messages": messages,
            "temperature": temperature or self.config.temperature,
            "max_tokens": max_tokens or self.config.max_tokens,
        }

        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                f"{self.BASE_URL}/chat/completions",
                json=payload,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
            )
            resp.raise_for_status()
            data = resp.json()

        choice = data["choices"][0]
        usage = data.get("usage", {})

        return {
            "content": choice["message"]["content"],
            "finish_reason": choice.get("finish_reason", "stop"),
            "tokens_used": usage.get("total_tokens", 0),
            "model": data.get("model", self.config.model),
        }

    async def chat_stream(
        self,
        messages: list[dict[str, str]],
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
    ) -> AsyncIterator[str]:
        api_key = await self.db.get_api_key("kimi")
        if not api_key:
            raise RuntimeError("No Kimi API key configured.")

        payload = {
            "model": self.config.model,
            "messages": messages,
            "temperature": temperature or self.config.temperature,
            "max_tokens": max_tokens or self.config.max_tokens,
            "stream": True,
        }

        async with httpx.AsyncClient(timeout=120) as client:
            async with client.stream(
                "POST",
                f"{self.BASE_URL}/chat/completions",
                json=payload,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
            ) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if line.startswith("data: ") and line != "data: [DONE]":
                        import json

                        chunk = json.loads(line[6:])
                        delta = chunk["choices"][0].get("delta", {})
                        if "content" in delta and delta["content"]:
                            yield delta["content"]


# ── Factory ──────────────────────────────────────────────────


def create_llm_adapter(db: Database, config: AgentConfig) -> LLMAdapter:
    """Create the appropriate LLM adapter based on agent config."""
    adapters = {
        ModelProvider.OPENAI: OpenAIAdapter,
        ModelProvider.ANTHROPIC: AnthropicAdapter,
        ModelProvider.GEMINI: GeminiAdapter,
        ModelProvider.KIMI: KimiAdapter,
    }

    adapter_class = adapters.get(config.model_provider)
    if not adapter_class:
        raise ValueError(f"Unknown model provider: {config.model_provider}")

    return adapter_class(db, config)
