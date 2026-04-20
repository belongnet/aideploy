"""
OpenClaw Agent — Main entry point.

Starts the agent: loads config, connects to DB, initializes LLM client,
bus client, task engine, prune job, and the FastAPI HTTP server for
receiving messages from the gateway and serving the dashboard API.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import signal
import sys
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

from .auth import authenticate_request, parse_allowed_origins
from .bus_client import BusClient
from .db import Database
from .knowledge import build_knowledge_prompt, create_knowledge_provider
from .llm_client import LLMAdapter, create_llm_adapter
from .memory import (
    build_memory_prompt,
    build_memory_summary,
    create_memory_provider,
    embed_text,
    resolve_user_key,
    vector_literal,
)
from .models import (
    ActionType,
    AnalyticsEvent,
    AuthMethod,
    BusEventType,
    BusMessage,
    Channel,
    ChannelType,
    Conversation,
    IncomingMessage,
    KnowledgeHit,
    Message,
    MessageRole,
    MemoryHit,
    MemoryItem,
    MemoryScope,
    OAuthTokens,
    Task,
    TurnContext,
    TriggerType,
)
from .prune_job import BusCleanupJob, PruneJob
from .shared_context import build_shared_context_prompt
from .supabase_bus import SupabaseBusAdapter
from .task_engine import TaskEngine
from .task_executor import TaskExecutor

# ── Configuration ─────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("openclaw.agent")

AGENT_INDEX = int(os.environ.get("AGENT_INDEX", "0"))
AGENT_SCHEMA = os.environ.get("AGENT_SCHEMA", f"agent_{AGENT_INDEX + 1}")
AGENT_PORT = int(os.environ.get("AGENT_PORT", str(8101 + AGENT_INDEX)))
AGENT_WORKSPACE_DIR = os.environ.get("AGENT_WORKSPACE_DIR", "/workspace")
AGENT_SITES_DIR = os.path.join(AGENT_WORKSPACE_DIR, "sites")
DB_DSN = os.environ.get(
    "DATABASE_URL",
    f"postgresql://postgres:{os.environ.get('DB_PASSWORD', 'openclaw')}@{os.environ.get('DB_HOST', 'supabase-db')}:{os.environ.get('DB_PORT', '5432')}/postgres",
)
ALLOWED_ORIGINS = parse_allowed_origins(
    os.environ.get("OPENCLAW_ALLOWED_ORIGINS")
)

# ── Global State ──────────────────────────────────────────────

db: Database
llm: LLMAdapter
bus: BusClient
task_engine: TaskEngine
prune_job: PruneJob
agent_id: uuid.UUID
memory_provider: Any
knowledge_provider: Any

PROVIDER_LABELS = {
    "openai": "ChatGPT",
    "anthropic": "Claude",
    "gemini": "Gemini",
    "kimi": "Kimi",
}
CHAT_CONNECT_DEFAULT_MODELS = {
    "openai": "gpt-5.3-codex",
    "anthropic": "claude-opus-4-6",
}
SETUP_COMMANDS = {
    "connect chatgpt",
    "connect claude",
    "/start connectchatgpt",
    "/start connectclaude",
}
ASSISTANT_SETUP_PHRASES = (
    "open this link to sign in to chatgpt",
    "paste the final redirect url back here",
    "paste the localhost redirect url or code",
    "paste the claude redirect url or one-time code",
    "chatgpt is now connected.",
    "claude is now connected.",
    "no ai provider is connected yet.",
    "reply one of these to get started:",
    "here is the fastest chatgpt setup path:",
    "here is the fastest claude setup path:",
)


# ── Lifespan ──────────────────────────────────────────────────


@asynccontextmanager
async def lifespan(app: FastAPI):
    global db, llm, bus, task_engine, prune_job, agent_id, memory_provider, knowledge_provider

    logger.info(f"Starting agent (schema: {AGENT_SCHEMA}, port: {AGENT_PORT})")

    # Database
    db = await Database.create(DB_DSN, AGENT_SCHEMA)
    config = await db.get_config()
    logger.info(
        f"Config loaded: provider={config.model_provider.value}, "
        f"model={config.model}, auth={config.auth_method.value}"
    )

    # Get agent ID from registry
    import asyncpg

    pool = await asyncpg.create_pool(DB_DSN, min_size=1, max_size=2)
    row = await pool.fetchrow(
        "SELECT id FROM public.agents WHERE schema_name = $1", AGENT_SCHEMA
    )
    agent_id = row["id"] if row else uuid.uuid4()
    await pool.close()

    # LLM client
    llm = create_llm_adapter(db, config)
    memory_provider = create_memory_provider(db, config)
    knowledge_provider = create_knowledge_provider(config)

    # Seed system memories (dashboard URL, capabilities) — idempotent
    try:
        await _seed_system_memories()
    except Exception as exc:
        logger.warning("Could not seed system memories: %s", exc)

    # Bus client
    bus = BusClient(
        DB_DSN,
        agent_id,
        realtime_adapter=SupabaseBusAdapter(DB_DSN, agent_id),
    )
    await bus.start()

    # Task executor and engine
    executor = TaskExecutor(db, llm, bus, reply_callback=send_reply)
    task_engine = TaskEngine(db, executor)
    await task_engine.start()

    # Register bus handlers
    bus.on("message_forward", handle_bus_forward)
    bus.on("config_changed", handle_config_changed)

    # Prune job
    prune_job = PruneJob(db)
    await prune_job.start()

    # Update status to running
    async with (await asyncpg.create_pool(DB_DSN, min_size=1, max_size=2)) as p:
        await p.execute(
            "UPDATE public.agents SET status = 'running', updated_at = NOW() WHERE id = $1",
            agent_id,
        )

    logger.info(f"Agent {agent_id} is running on port {AGENT_PORT}")

    yield

    # Shutdown
    logger.info("Shutting down agent...")
    await prune_job.stop()
    await task_engine.stop()
    await bus.stop()
    await db.close()
    logger.info("Agent shut down complete")


# ── FastAPI App ───────────────────────────────────────────────

app = FastAPI(title="OpenClaw Agent", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def require_agent_auth(request: Request, call_next):
    path = request.url.path
    if request.method == "OPTIONS" or path == "/health":
        return await call_next(request)
    # /sites/** is intentionally public: it serves agent-built portals and
    # landing pages that need to work for anonymous visitors.
    if path.startswith("/sites/") or path == "/sites":
        return await call_next(request)
    if path == "/message" or path.startswith("/api/"):
        authorized, reason = authenticate_request(request)
        if not authorized:
            return JSONResponse(
                status_code=401,
                content={"detail": reason},
            )
    return await call_next(request)


# ── Static portals served from the agent's workspace volume ──
try:
    os.makedirs(AGENT_SITES_DIR, exist_ok=True)
except OSError as exc:
    logger.warning("Could not create sites dir %s: %s", AGENT_SITES_DIR, exc)
app.mount(
    "/sites",
    StaticFiles(directory=AGENT_SITES_DIR, html=True, check_dir=False),
    name="agent-sites",
)


# ── Message Processing Pipeline ──────────────────────────────


def _log_task_result(task: asyncio.Task[Any], label: str) -> None:
    try:
        task.result()
    except Exception as exc:
        logger.warning("%s failed in background: %s", label, exc)


async def _recall_memory(
    config: Any, user_key: str, incoming: IncomingMessage
) -> list[MemoryHit]:
    if not config.memory_enabled:
        return []
    return await memory_provider.recall(
        user_key=user_key,
        agent_id=agent_id,
        query=incoming.text,
        limit=config.memory_recall_top_k,
    )


async def _search_knowledge(config: Any, query: str) -> list[KnowledgeHit]:
    if not query.strip():
        return []
    return await knowledge_provider.search(
        query=query,
        scope="local",
        limit=max(1, min(config.memory_recall_top_k, 5)),
    )


def _should_sync_shared_chat(incoming: IncomingMessage) -> bool:
    return incoming.metadata.get("source") != "bus" and incoming.channel_id != "bus"


def _incoming_external_message_id(metadata: dict[str, Any]) -> str | None:
    value = metadata.get("message_id") or metadata.get("ts")
    if not value:
        return None
    return str(value)


def _incoming_attachments(metadata: dict[str, Any]) -> list[dict[str, Any]]:
    attachments = metadata.get("attachments")
    return attachments if isinstance(attachments, list) else []


def _sanitize_attachment_for_browser(raw_attachment: Any) -> dict[str, Any] | None:
    if not isinstance(raw_attachment, dict):
        return None

    allowed_fields = {
        "provider",
        "kind",
        "display_name",
        "original_name",
        "content_type",
        "size_bytes",
        "width",
        "height",
        "duration_seconds",
        "emoji",
        "caption",
        "upload_error",
        "upload_skipped",
        "permalink",
    }
    return {
        key: value for key, value in raw_attachment.items() if key in allowed_fields
    }


def _sanitize_message_metadata_for_browser(metadata: Any) -> dict[str, Any]:
    if not isinstance(metadata, dict):
        return {}

    sanitized = dict(metadata)
    attachments = sanitized.get("attachments")
    if isinstance(attachments, list):
        sanitized["attachments"] = [
            attachment
            for raw_attachment in attachments
            for attachment in [_sanitize_attachment_for_browser(raw_attachment)]
            if attachment
        ]
    return sanitized


def _message_payload_for_browser(message: Message) -> dict[str, Any]:
    payload = message.model_dump()
    payload["metadata"] = _sanitize_message_metadata_for_browser(
        payload.get("metadata")
    )
    return payload


async def _record_shared_outgoing_for_conversation(
    conversation_id: uuid.UUID,
    text: str,
    *,
    metadata: dict[str, Any] | None = None,
    dedupe_key: str | None = None,
) -> None:
    conv = await db.get_conversation(conversation_id)
    if not conv:
        return
    if conv.external_chat_id.startswith("agent_"):
        return

    channel = await db.get_channel(conv.channel_id)
    if not channel:
        return

    config = await db.get_config()
    shared_conversation_id = await db.upsert_shared_conversation(
        channel_type=channel.type.value,
        channel_id=None,
        chat_id=conv.external_chat_id,
        participant_name=conv.participant_name,
        title=conv.title,
        metadata=metadata or {},
    )
    await db.add_shared_message(
        kind="chat",
        direction="outgoing",
        channel=channel.type.value,
        channel_type=channel.type.value,
        channel_id=None,
        chat_id=conv.external_chat_id,
        message_role=MessageRole.ASSISTANT.value,
        content=text,
        agent_id=agent_id,
        agent_name=config.agent_name,
        conversation_ref=shared_conversation_id,
        local_conversation_id=conv.id,
        sender_name=config.agent_name,
        dedupe_key=dedupe_key,
        metadata=metadata or {},
    )


async def _resolve_dashboard_setup_url() -> str:
    dashboard_port = int(os.environ.get("DASHBOARD_PORT", "3001"))
    try:
        row = await db.pool.fetchrow(
            """
            SELECT NULLIF(tailscale_ip, '') AS tailscale_ip,
                   NULLIF(server_ip, '') AS server_ip
            FROM public.deploy_info
            ORDER BY created_at DESC
            LIMIT 1
            """
        )
        host = (
            row["tailscale_ip"]
            if row and row["tailscale_ip"]
            else row["server_ip"]
            if row and row["server_ip"]
            else None
        )
        if host:
            return f"http://{host}:{dashboard_port}/setup"
    except Exception as exc:
        logger.debug("Could not resolve dashboard setup URL: %s", exc)
    return f"http://localhost:{dashboard_port}/setup"


def _setup_auth_method_label(config: Any) -> str:
    return "consumer" if config.auth_method == AuthMethod.OAUTH else "api_key"


async def _is_provider_connected(config: Any, provider: str) -> bool:
    if config.auth_method == AuthMethod.OAUTH:
        return await db.get_oauth_tokens(provider) is not None
    return await db.get_api_key(provider) is not None


def _supported_chat_connect_providers() -> list[dict[str, str]]:
    return [
        {
            "id": provider,
            "name": PROVIDER_LABELS.get(provider, provider.title()),
            "defaultModel": model,
        }
        for provider, model in CHAT_CONNECT_DEFAULT_MODELS.items()
    ]


def _requested_provider_from_text(text: str, default_provider: str) -> str:
    normalized = text.lower()
    if any(term in normalized for term in ("chatgpt", "openai", "gpt")):
        return "openai"
    if any(term in normalized for term in ("claude", "anthropic")):
        return "anthropic"
    return default_provider


def _is_setup_help_intent(text: str) -> bool:
    normalized = text.strip().lower()
    if not normalized:
        return False
    setup_patterns = (
        r"\bconnect\b",
        r"\bsetup\b",
        r"\blink\b",
        r"\boauth\b",
        r"\bsign[ -]?in\b",
        r"\bauth\b",
        r"\bconfigure\b",
    )
    if not any(re.search(pattern, normalized) for pattern in setup_patterns):
        return False
    return any(
        term in normalized
        for term in ("ai", "chatgpt", "openai", "claude", "anthropic")
    )


async def _build_ai_connect_instructions(provider: str) -> str:
    setup_url = await _resolve_dashboard_setup_url()
    label = PROVIDER_LABELS.get(provider, provider.title())

    if provider == "openai":
        return "\n".join(
            [
                "Here is the fastest ChatGPT setup path:",
                f"1. Open {setup_url}",
                '2. Press "New Browser Link" under ChatGPT',
                "3. Sign in in your browser on your own device",
                "4. Paste the localhost redirect URL or code back into the setup card",
                "5. Return here and send your message again",
            ]
        )

    if provider == "anthropic":
        return "\n".join(
            [
                "Here is the fastest Claude setup path:",
                f"1. Open {setup_url}",
                '2. Press "New Browser Link" under Claude',
                "3. Sign in in your browser on your own device",
                "4. Paste the Claude redirect URL or one-time code back into the setup card",
                "5. AiDeploy will route Claude traffic through the gateway's local Anthropic billing proxy",
                "6. Return here and send your message again",
            ]
        )

    return "\n".join(
        [
            f"{label} is not ready yet.",
            f"Open {setup_url} to finish the setup, then message me again.",
        ]
    )


async def _build_missing_ai_reply(config: Any, error_text: str = "") -> str:
    provider = config.model_provider.value
    label = PROVIDER_LABELS.get(provider, provider.title())
    setup_url = await _resolve_dashboard_setup_url()
    reason = (
        f"Your {label} connection expired."
        if "expired" in error_text.lower()
        else "No AI provider is connected yet."
    )

    lines = [
        reason,
        "I cannot reply normally until an AI provider is set up.",
        "",
        "Reply one of these to get started:",
        "\u2022 connect chatgpt",
        "\u2022 connect claude",
        "",
        f"You can also connect Gemini, Kimi, or DeepSeek from the dashboard:",
        setup_url,
    ]

    return "\n".join(lines)


async def _build_infrastructure_context(config: Any) -> str:
    """Build a system-prompt supplement with dashboard URL and capability boundaries."""
    dashboard_url = await _resolve_dashboard_setup_url()
    dashboard_base = dashboard_url.rsplit("/setup", 1)[0]
    provider_label = PROVIDER_LABELS.get(
        config.model_provider.value, config.model_provider.value.title()
    )

    return "\n".join(
        [
            f"Your name is {config.agent_name}.",
            f"You are powered by {provider_label} ({config.model}).",
            "",
            "SETUP FACTS (do not invent alternatives):",
            "- Claude on this deployment is connected from the dashboard browser flow, not ACP or Claude Code plugins",
            "- After Claude browser sign-in, requests run through the gateway's local Anthropic billing proxy",
            "- Never tell users to enable ACP, install acpx/runtime plugins, or paste Anthropic API keys in chat",
            "",
            "CAPABILITIES (what you CAN do in this conversation):",
            "- Answer questions and have conversations",
            "- Help with tasks and provide information",
            "- Remember facts the user shares (long-term memory)",
            "",
            "LIMITATIONS (what you CANNOT do — direct users to the dashboard instead):",
            f"- Change AI provider or switch models → {dashboard_base}",
            f"- Configure agent settings (temperature, tokens, system prompt) → {dashboard_base}",
            f"- Manage API keys or OAuth credentials → {dashboard_base}",
            f"- Add or remove messaging channels → {dashboard_base}",
            "",
            f"Dashboard URL: {dashboard_base}",
            "If a user asks to connect a different AI, switch providers, or change any setting listed above,",
            "tell them to open the dashboard and provide the URL. Never invent features, plugins, or error",
            "messages about capabilities you do not have.",
            "",
            "CREDENTIAL SECURITY (CRITICAL — always follow these rules):",
            "- NEVER ask for or accept passwords, API keys, tokens (GitHub PAT, OAuth, etc.),",
            "  private keys, or any other secrets directly in chat.",
            "- If a workflow requires credentials (e.g. cloning a private repo, connecting a service),",
            "  direct the user to handle secrets through one of these secure methods:",
            "  1. The dashboard settings page (for AI provider keys and OAuth connections)",
            "  2. A secrets manager (Doppler, Azure Key Vault, AWS KMS/Secrets Manager)",
            "  3. Their password manager (1Password, Bitwarden, etc.)",
            "  4. Environment variables on their own machine",
            "- If a user offers to paste a token or secret, politely decline and explain that sharing",
            "  secrets in chat is a security risk — messages may be logged, stored, or visible to others.",
            "- For GitHub repos: suggest adding an SSH deploy key or using a GitHub App installation",
            f"  instead of personal access tokens. Point them to the dashboard: {dashboard_base}",
        ]
    )


def _is_provider_switch_intent(text: str, current_provider: str) -> str | None:
    """Return target provider ID if the user wants to switch providers, else None."""
    normalized = text.strip().lower()
    if not normalized:
        return None

    provider_map = {
        "openai": "openai",
        "chatgpt": "openai",
        "gpt": "openai",
        "claude": "anthropic",
        "anthropic": "anthropic",
        "gemini": "gemini",
        "kimi": "kimi",
        "deepseek": "deepseek",
    }
    for keyword, provider_id in provider_map.items():
        if provider_id == current_provider or keyword not in normalized:
            continue
        explicit_patterns = (
            rf"^\s*(?:please\s+)?connect\s+(?:me\s+to\s+)?{keyword}\b",
            rf"^\s*(?:please\s+)?switch\s+(?:me\s+)?to\s+{keyword}\b",
            rf"^\s*(?:please\s+)?change\s+(?:me\s+)?to\s+{keyword}\b",
            rf"^\s*(?:please\s+)?set\s*up\s+{keyword}\b",
            rf"^\s*(?:please\s+)?link\s+{keyword}\b",
            rf"^\s*(?:please\s+)?use\s+{keyword}\s+instead\b",
        )
        if any(re.search(pattern, normalized) for pattern in explicit_patterns):
            return provider_id
    return None


def _looks_like_localhost_redirect(text: str) -> bool:
    normalized = text.strip().lower()
    if not normalized:
        return False
    return bool(
        re.match(r"^https?://(?:localhost|127\.0\.0\.1)[:/]", normalized)
        and any(marker in normalized for marker in ("code=", "state=", "/auth/callback"))
    )


def _is_transient_setup_message(role: MessageRole, text: str) -> bool:
    normalized = text.strip().lower()
    if not normalized:
        return False
    if _looks_like_localhost_redirect(normalized):
        return True
    if role == MessageRole.USER:
        return normalized in SETUP_COMMANDS
    if role == MessageRole.ASSISTANT:
        return any(phrase in normalized for phrase in ASSISTANT_SETUP_PHRASES)
    return False


def _filter_transient_setup_history(history: list[Message]) -> list[Message]:
    return [
        msg
        for msg in history
        if not _is_transient_setup_message(msg.role, msg.content)
    ]


async def _build_provider_switch_reply(target_provider: str, config: Any) -> str:
    """Build a response directing the user to the dashboard to switch providers."""
    setup_url = await _resolve_dashboard_setup_url()
    target_label = PROVIDER_LABELS.get(target_provider, target_provider.title())
    current_label = PROVIDER_LABELS.get(
        config.model_provider.value, config.model_provider.value.title()
    )

    if target_provider == "anthropic":
        return "\n".join(
            [
                f"I'm currently using {current_label}. Switching to Claude uses the dashboard browser flow.",
                "",
                f"1. Open {setup_url}",
                '2. Press "New Browser Link" under Claude',
                "3. Sign in in your browser on your own device",
                "4. Paste the Claude redirect URL or one-time code back into the setup card",
                "5. Come back here — Claude will run through the gateway's local billing proxy",
                "Do not use ACP, acpx plugins, or Anthropic API keys in chat for this deployment.",
            ]
        )

    return "\n".join(
        [
            f"I'm currently using {current_label}. Switching to {target_label} requires the dashboard.",
            "",
            f"1. Open {setup_url}",
            f"2. Select {target_label} as your AI provider",
            "3. Complete the authentication setup",
            "4. Come back here — your messages will use the new provider",
        ]
    )


async def _seed_system_memories() -> None:
    """Seed infrastructure-awareness memories on first boot. Idempotent."""
    dashboard_url = await _resolve_dashboard_setup_url()
    dashboard_base = dashboard_url.rsplit("/setup", 1)[0]

    seed_contents = [
        (
            f"The agent dashboard is at {dashboard_base}. Users should visit "
            "it to manage settings, connect AI providers, configure channels, "
            "and adjust model parameters."
        ),
        (
            "Switching AI providers (e.g. from ChatGPT to Claude or vice versa) "
            f"requires the dashboard at {dashboard_base}. This cannot be done "
            "through chat."
        ),
        (
            "Claude on this deployment is connected from the dashboard browser "
            "flow and then routed through the gateway's local Anthropic billing "
            "proxy. It does not use ACP, acpx runtime plugins, or Anthropic "
            "API keys pasted into chat."
        ),
        (
            f"Dashboard configuration options at {dashboard_base}: AI provider "
            "and model selection, temperature and max-token settings, system "
            "prompt editing, OAuth and API key management, messaging channel "
            "setup (Telegram, WhatsApp, Slack, Discord)."
        ),
    ]

    for content in seed_contents:
        digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
        existing = await db.find_memory_by_hash(
            "__system__", MemoryScope.LONG_TERM, digest
        )
        if existing:
            continue

        item = MemoryItem(
            user_key="__system__",
            scope=MemoryScope.LONG_TERM,
            content=content,
            summary=build_memory_summary(content),
            content_sha256=digest,
            metadata={"source": "seed", "version": "1"},
        )
        embedding = vector_literal(embed_text(content))
        await db.insert_memory(item, embedding)
        logger.info("Seeded system memory: %s", item.summary[:60])


def _is_auth_configuration_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return any(
        marker in text
        for marker in (
            "no oauth tokens found",
            "no api key found",
            "please reconnect your account",
            "please add your api key",
            "expired",
        )
    )


async def process_message(incoming: IncomingMessage) -> str:
    """
    9-step agent processing pipeline:
    1. Receive message from gateway
    2. Find or create conversation
    3. Store incoming message
    4. Evaluate task triggers
    5. Build conversation context
    6. Call LLM
    7. Store response
    8. Log analytics
    9. Return response text
    """
    config = await db.get_config()

    # Ignore stale localhost redirect URLs that can be replayed after setup finishes.
    if _looks_like_localhost_redirect(incoming.text) and await _is_provider_connected(
        config, config.model_provider.value
    ):
        logger.info("Ignoring stale setup redirect after provider connected")
        return ""

    # Step 1: Find channel
    channels = await db.get_channels()
    channel = next(
        (c for c in channels if c.type.value == incoming.channel_type.value),
        None,
    )
    if not channel:
        logger.warning(f"No channel found for type {incoming.channel_type}")
        # Create a default channel entry
        channel = Channel(
            type=incoming.channel_type,
            name=f"{incoming.channel_type.value} channel",
            config={"chat_id": incoming.chat_id},
        )
        channel = await db.create_channel(channel)

    # Step 2: Find or create conversation
    is_new = False
    conv = await db.get_or_create_conversation(
        channel_id=channel.id,
        chat_id=incoming.chat_id,
        participant_name=incoming.sender_name,
    )
    if conv.message_count == 0:
        is_new = True

    user_key = resolve_user_key(
        incoming.metadata,
        incoming.channel_type.value,
        incoming.chat_id,
    )
    shared_sync_enabled = _should_sync_shared_chat(incoming)
    incoming_attachments = _incoming_attachments(incoming.metadata)

    if shared_sync_enabled:
        shared_conversation_id = await db.upsert_shared_conversation(
            channel_type=incoming.channel_type.value,
            channel_id=incoming.channel_id,
            chat_id=incoming.chat_id,
            participant_name=incoming.sender_name,
            title=str(
                incoming.metadata.get("chat_title")
                or conv.title
                or incoming.sender_name
                or incoming.chat_id
            ),
            metadata={
                "chat_type": incoming.metadata.get("chat_type"),
                "chat_title": incoming.metadata.get("chat_title"),
            },
        )
        await db.add_shared_message(
            kind="chat",
            direction="incoming",
            channel=incoming.channel_type.value,
            channel_type=incoming.channel_type.value,
            channel_id=incoming.channel_id,
            chat_id=incoming.chat_id,
            message_role=MessageRole.USER.value,
            content=incoming.text,
            user_id=user_key,
            agent_id=agent_id,
            agent_name=config.agent_name,
            conversation_ref=shared_conversation_id,
            local_conversation_id=conv.id,
            sender_name=incoming.sender_name,
            sender_id=str(incoming.metadata.get("sender_id") or ""),
            external_message_id=_incoming_external_message_id(incoming.metadata),
            dedupe_key=(
                f"incoming:{incoming.channel_type.value}:{incoming.chat_id}:{_incoming_external_message_id(incoming.metadata)}"
                if _incoming_external_message_id(incoming.metadata)
                else None
            ),
            attachments=incoming_attachments,
            metadata={
                "source": "gateway",
                **incoming.metadata,
            },
        )

    # Step 3: Store incoming message
    user_msg = Message(
        conversation_id=conv.id,
        role=MessageRole.USER,
        content=incoming.text,
        metadata={
            "sender_name": incoming.sender_name,
            "channel_type": incoming.channel_type.value,
            **incoming.metadata,
        },
    )
    await db.add_message(user_msg)

    # Step 4: Evaluate task triggers
    matched_tasks = await task_engine.evaluate_message(incoming, conv.id)
    if is_new:
        await task_engine.evaluate_conversation_start(conv.id, incoming.sender_name)

    # If a task generated a reply, use that instead of calling LLM again
    # (task_executor sends replies via the reply_callback)

    # Step 5: Build conversation context
    setup_help_response: str | None = None

    # Case 1: User wants to switch to a different provider
    switch_target = _is_provider_switch_intent(
        incoming.text, config.model_provider.value
    )
    if switch_target:
        setup_help_response = await _build_provider_switch_reply(
            switch_target, config
        )

    # Case 2: Setup help when current provider is disconnected
    elif _is_setup_help_intent(incoming.text) and not await _is_provider_connected(
        config, config.model_provider.value
    ):
        setup_help_response = await _build_ai_connect_instructions(
            _requested_provider_from_text(
                incoming.text,
                config.model_provider.value,
            )
        )

    memory_hits: list[MemoryHit] = []
    knowledge_hits: list[KnowledgeHit] = []

    if setup_help_response is not None:
        response_text = setup_help_response
        tokens_used = 0
    else:
        history = _filter_transient_setup_history(
            await db.get_messages(conv.id, limit=20)
        )
        infra_context = await _build_infrastructure_context(config)
        full_system = config.system_prompt + "\n\n" + infra_context
        messages: list[dict[str, str]] = [
            {"role": "system", "content": full_system}
        ]

        memory_hits = await _recall_memory(config, user_key, incoming)
        memory_prompt = build_memory_prompt(memory_hits)
        if memory_prompt:
            messages.append({"role": "system", "content": memory_prompt})

        knowledge_hits = await _search_knowledge(config, incoming.text)
        knowledge_prompt = build_knowledge_prompt(knowledge_hits)
        if knowledge_prompt:
            messages.append({"role": "system", "content": knowledge_prompt})

        if shared_sync_enabled:
            shared_context = build_shared_context_prompt(
                await db.get_shared_chat_messages(
                    channel_type=incoming.channel_type.value,
                    chat_id=incoming.chat_id,
                    limit=12,
                    exclude_agent_id=agent_id,
                    exclude_local_conversation_id=conv.id,
                )
            )
            if shared_context:
                messages.append({"role": "system", "content": shared_context})

        for msg in history:
            messages.append({"role": msg.role.value, "content": msg.content})

        # Step 6: Call LLM (pre-flight credential check to avoid noisy errors)
        if not await llm.has_credentials():
            provider = config.model_provider.value
            response_text = await _build_missing_ai_reply(
                config, f"No credentials configured for {provider}."
            )
            tokens_used = 0
        else:
            try:
                result = await llm.chat(messages)
                response_text = result["content"]
                tokens_used = result.get("tokens_used", 0)
            except Exception as e:
                logger.error(f"LLM call failed: {e}")
                if _is_auth_configuration_error(e):
                    response_text = await _build_missing_ai_reply(config, str(e))
                else:
                    response_text = "I'm having trouble responding right now. Please try again."
                tokens_used = 0

    # Step 7: Store response
    assistant_msg = Message(
        conversation_id=conv.id,
        role=MessageRole.ASSISTANT,
        content=response_text,
        tokens_used=tokens_used,
        metadata={
            "user_key": user_key,
            "memory_hits": len(memory_hits),
            "knowledge_hits": len(knowledge_hits),
        },
    )
    await db.add_message(assistant_msg)

    if shared_sync_enabled:
        await _record_shared_outgoing_for_conversation(
            conv.id,
            response_text,
            metadata={
                "source": "agent",
                "user_key": user_key,
                "knowledge_hits": len(knowledge_hits),
                "memory_hits": len(memory_hits),
            },
            dedupe_key=f"outgoing:{agent_id}:{assistant_msg.id}",
        )

    if (
        config.memory_enabled
        and config.memory_capture_mode.value == "async"
    ):
        capture_task = asyncio.create_task(
            memory_provider.capture(
                TurnContext(
                    user_key=user_key,
                    agent_id=agent_id,
                    conversation_id=conv.id,
                    user_message_id=user_msg.id,
                    assistant_message_id=assistant_msg.id,
                    user_text=incoming.text,
                    assistant_text=response_text,
                    metadata={
                        "channel_type": incoming.channel_type.value,
                        "chat_id": incoming.chat_id,
                        "sender_name": incoming.sender_name,
                        "memory_hits": len(memory_hits),
                        "knowledge_hits": len(knowledge_hits),
                    },
                )
            )
        )
        capture_task.add_done_callback(
            lambda task: _log_task_result(task, "memory_capture")
        )

    # Step 8: Log analytics
    await db.log_event(
        AnalyticsEvent(
            event_type="message_processed",
            metadata={
                "channel_type": incoming.channel_type.value,
                "tokens_used": tokens_used,
                "task_matches": len(matched_tasks),
                "is_new_conversation": is_new,
                "user_key": user_key,
                "memory_hits": len(memory_hits),
                "knowledge_hits": len(knowledge_hits),
            },
        )
    )

    # Step 9: Return response
    return response_text


async def send_reply(conversation_id: uuid.UUID, text: str) -> None:
    """Callback for task executor to send replies."""
    msg = Message(
        conversation_id=conversation_id,
        role=MessageRole.ASSISTANT,
        content=text,
    )
    await db.add_message(msg)
    await _record_shared_outgoing_for_conversation(
        conversation_id,
        text,
        metadata={"source": "task"},
        dedupe_key=f"outgoing:{agent_id}:{msg.id}",
    )


async def handle_bus_forward(bus_message: BusMessage) -> None:
    """Handle a forwarded message from another agent."""
    payload = bus_message.payload
    text = payload.get("text", "")
    if not text:
        return

    # Process as an internal message
    incoming = IncomingMessage(
        channel_type=ChannelType.TELEGRAM,  # Default for inter-agent
        channel_id="bus",
        chat_id=f"agent_{bus_message.source_agent_id}",
        sender_name=f"Agent {bus_message.source_agent_id}",
        text=text,
        metadata={"source": "bus", "original_payload": payload},
    )
    response = await process_message(incoming)

    # Send response back via bus
    if bus_message.source_agent_id:
        await bus.send(
            target_agent_id=bus_message.source_agent_id,
            event_type=BusEventType.TASK_RESULT,
            payload={"response": response, "original_message": text},
        )


async def handle_config_changed(bus_message: BusMessage) -> None:
    """Handle config change notification — reload LLM and tasks."""
    global llm, memory_provider, knowledge_provider
    config = await db.get_config()
    llm = create_llm_adapter(db, config)
    memory_provider = create_memory_provider(db, config)
    knowledge_provider = create_knowledge_provider(config)
    await task_engine.reload_tasks()
    logger.info("Config reloaded")


# ── API Routes: Message Handling ──────────────────────────────


@app.post("/message")
async def receive_message(request: Request) -> dict[str, Any]:
    """Receive a message from the gateway."""
    body = await request.json()
    incoming = IncomingMessage(**body)
    response = await process_message(incoming)
    return {"response": response}


# ── API Routes: Dashboard ────────────────────────────────────


@app.get("/api/config")
async def get_config():
    config = await db.get_config()
    return config.model_dump()


@app.get("/api/setup/status")
async def get_setup_status():
    config = await db.get_config()
    provider = config.model_provider.value
    label = PROVIDER_LABELS.get(provider, provider.title())
    connected = await _is_provider_connected(config, provider)
    auth_method = _setup_auth_method_label(config)
    dashboard_setup_url = await _resolve_dashboard_setup_url()

    return {
        "setupRequired": not connected,
        "currentProvider": provider,
        "currentModel": config.model,
        "currentAuthMethod": auth_method,
        "dashboardSetupUrl": dashboard_setup_url,
        "supportedChatConnectProviders": _supported_chat_connect_providers(),
        "providers": [
            {
                "id": provider,
                "name": label,
                "authMethod": auth_method,
                "connected": connected,
            }
        ],
    }


@app.post("/api/setup/prompts/claim")
async def claim_setup_prompt_route(request: Request):
    body = await request.json()
    prompt_key = str(body.get("promptKey") or "").strip()
    channel_type = str(body.get("channelType") or "").strip().lower()
    recipient_chat_id = str(body.get("recipientChatId") or "").strip()
    try:
        cooldown_seconds = int(body.get("cooldownSeconds") or 0)
    except (TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=400,
            detail="cooldownSeconds must be an integer",
        ) from exc
    metadata = body.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}

    if not prompt_key:
        raise HTTPException(status_code=400, detail="promptKey is required")
    if not channel_type:
        raise HTTPException(status_code=400, detail="channelType is required")
    if not recipient_chat_id:
        raise HTTPException(status_code=400, detail="recipientChatId is required")

    should_send, last_sent_at = await db.claim_setup_prompt(
        prompt_key=prompt_key,
        channel_type=channel_type,
        recipient_chat_id=recipient_chat_id,
        cooldown_seconds=max(0, cooldown_seconds),
        metadata=metadata,
    )
    return {
        "shouldSend": should_send,
        "lastSentAt": last_sent_at.isoformat() if last_sent_at else None,
    }


@app.post("/api/setup/oauth")
async def save_setup_oauth(request: Request):
    body = await request.json()
    provider = str(body.get("provider") or "").strip().lower()
    if provider not in ("openai", "anthropic"):
        raise HTTPException(status_code=400, detail="Unsupported provider")

    access_token = str(body.get("accessToken") or "").strip()
    refresh_token = str(body.get("refreshToken") or "").strip()
    expires_at_raw = str(body.get("expiresAt") or "").strip()
    if not access_token:
        raise HTTPException(status_code=400, detail="accessToken is required")

    if expires_at_raw:
        expires_at = datetime.fromisoformat(expires_at_raw.replace("Z", "+00:00"))
    else:
        expires_at = datetime.now(timezone.utc) + timedelta(hours=1)

    await db.save_oauth_tokens(
        OAuthTokens(
            provider=provider,
            access_token=access_token,
            refresh_token=refresh_token,
            expires_at=expires_at,
        )
    )

    return {"ok": True}


@app.post("/api/setup/complete")
async def complete_setup_route():
    return {"ok": True}


@app.put("/api/config")
async def update_config(request: Request):
    body = await request.json()
    config = await db.update_config(**body)
    # Notify other components
    await bus.send(
        target_agent_id=agent_id,
        event_type=BusEventType.CONFIG_CHANGED,
        payload=body,
    )
    return config.model_dump()


@app.get("/api/channels")
async def list_channels():
    channels = await db.get_channels()
    return [c.model_dump() for c in channels]


@app.post("/api/channels")
async def create_channel(request: Request):
    body = await request.json()
    channel = Channel(**body)
    created = await db.create_channel(channel)
    return created.model_dump()


@app.put("/api/channels/{channel_id}")
async def update_channel(channel_id: uuid.UUID, request: Request):
    body = await request.json()
    updated = await db.update_channel(channel_id, **body)
    if not updated:
        raise HTTPException(status_code=404, detail="Channel not found")
    return updated.model_dump()


@app.delete("/api/channels/{channel_id}")
async def delete_channel(channel_id: uuid.UUID):
    await db.delete_channel(channel_id)
    return {"success": True}


@app.get("/api/conversations")
async def list_conversations(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    starred: bool = Query(False),
    search: str = Query(None),
):
    convs = await db.get_conversations(
        limit=limit, offset=offset, starred_only=starred, search=search
    )
    return [c.model_dump() for c in convs]


@app.get("/api/conversations/{conversation_id}")
async def get_conversation(conversation_id: uuid.UUID):
    conv = await db.get_conversation(conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conv.model_dump()


@app.get("/api/conversations/{conversation_id}/messages")
async def get_messages(
    conversation_id: uuid.UUID,
    limit: int = Query(100, ge=1, le=500),
):
    messages = await db.get_messages(conversation_id, limit=limit)
    return [_message_payload_for_browser(m) for m in messages]


@app.put("/api/conversations/{conversation_id}/star")
async def star_conversation(conversation_id: uuid.UUID, request: Request):
    body = await request.json()
    await db.star_conversation(conversation_id, body.get("starred", True))
    return {"success": True}


@app.delete("/api/conversations/{conversation_id}")
async def delete_conversation(conversation_id: uuid.UUID):
    await db.delete_conversation(conversation_id)
    return {"success": True}


@app.post("/api/conversations/prune")
async def prune_conversations(request: Request):
    body = await request.json()
    count = await prune_job.run_prune_now(
        older_than_days=body.get("older_than_days"),
        keep_starred=body.get("keep_starred"),
    )
    return {"pruned": count}


@app.get("/api/tasks")
async def list_tasks():
    tasks = await db.get_tasks()
    return [t.model_dump() for t in tasks]


@app.post("/api/tasks")
async def create_task(request: Request):
    body = await request.json()
    task = Task(**body)
    created = await db.create_task(task)
    await task_engine.reload_tasks()
    return created.model_dump()


@app.put("/api/tasks/{task_id}")
async def update_task(task_id: uuid.UUID, request: Request):
    body = await request.json()
    updated = await db.update_task(task_id, **body)
    if not updated:
        raise HTTPException(status_code=404, detail="Task not found")
    await task_engine.reload_tasks()
    return updated.model_dump()


@app.delete("/api/tasks/{task_id}")
async def delete_task(task_id: uuid.UUID):
    await db.delete_task(task_id)
    await task_engine.reload_tasks()
    return {"success": True}


@app.post("/api/tasks/{task_id}/run")
async def run_task(task_id: uuid.UUID):
    result = await task_engine.run_manual_task(task_id)
    return result


@app.post("/api/tasks/generate")
async def generate_task(request: Request):
    """AI-generate a task from a natural language description."""
    body = await request.json()
    description = body.get("description", "")
    if not description:
        raise HTTPException(status_code=400, detail="Description required")

    prompt = f"""Create an automation task based on this description: "{description}"

Return a JSON object with these fields:
- name: short task name
- description: what it does
- trigger_type: one of keyword, schedule, agent_message, webhook, conversation_start, manual
- trigger_config: configuration for the trigger
- action_type: one of reply, api_call, agent_forward, run_prompt, notify, file_write, serve_website
- action_config: configuration for the action. For file_write use site, path, and content. For serve_website use site and optional public_base_url.

Return ONLY valid JSON, no explanation."""

    config = await db.get_config()
    result = await llm.chat(
        [
            {"role": "system", "content": "You generate automation task configurations."},
            {"role": "user", "content": prompt},
        ]
    )

    try:
        task_data = json.loads(result["content"])
        return task_data
    except json.JSONDecodeError:
        return {"error": "Could not generate task", "raw": result["content"]}


@app.get("/api/analytics")
async def get_analytics(
    event_type: str = Query(None),
    days: int = Query(30, ge=1, le=365),
):
    events = await db.get_analytics(event_type=event_type, days=days)
    return events


@app.get("/api/memory")
async def list_memory(
    user_key: str = Query(..., min_length=1),
    scope: str = Query("all"),
    limit: int = Query(50, ge=1, le=200),
):
    items = await memory_provider.list(user_key=user_key, scope=scope, limit=limit)
    return [item.model_dump() for item in items]


@app.post("/api/memory/search")
async def search_memory(request: Request):
    body = await request.json()
    user_key = str(body.get("user_key") or "").strip()
    query = str(body.get("query") or "").strip()
    if not user_key or not query:
        raise HTTPException(status_code=400, detail="user_key and query are required")
    limit = int(body.get("limit") or 5)
    hits = await memory_provider.recall(
        user_key=user_key,
        agent_id=agent_id,
        query=query,
        limit=max(1, min(limit, 20)),
    )
    return [hit.model_dump() for hit in hits]


@app.delete("/api/memory")
async def forget_memory(request: Request):
    body = await request.json()
    user_key = str(body.get("user_key") or "").strip()
    if not user_key:
        raise HTTPException(status_code=400, detail="user_key is required")
    forgotten = await memory_provider.forget(user_key, body)
    return {"forgotten": forgotten}


@app.get("/api/system/status")
async def system_status():
    config = await db.get_config()
    stats = await db.get_stats()
    return {
        "agent_id": str(agent_id),
        "schema": AGENT_SCHEMA,
        "status": "running",
        "config": {
            "model_provider": config.model_provider.value,
            "model": config.model,
            "auth_method": config.auth_method.value,
            "agent_name": config.agent_name,
            "memory_enabled": config.memory_enabled,
            "memory_provider": config.memory_provider.value,
            "memory_capture_mode": config.memory_capture_mode.value,
            "knowledge_provider": config.knowledge_provider.value,
            "knowledge_collections": config.knowledge_collections,
        },
        "stats": stats,
    }


@app.get("/api/system/logs")
async def system_logs():
    """SSE stream of real-time log events."""

    async def event_stream():
        # Stream recent bus messages as log events
        messages = await bus.get_recent_messages(limit=20)
        for msg in messages:
            yield f"data: {json.dumps(msg)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/api/system/restart")
async def system_restart():
    """Signal the container orchestrator to restart this agent."""
    logger.info("Restart requested via dashboard")
    # In Docker, exiting causes a restart via restart_policy
    os.kill(os.getpid(), signal.SIGTERM)
    return {"success": True}


@app.get("/health")
async def health():
    return {
        "status": "healthy",
        "agent_id": str(agent_id),
        "schema": AGENT_SCHEMA,
        "memory_provider": (await db.get_config()).memory_provider.value,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


# ── Entry Point ───────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run(
        "src.main:app",
        host="0.0.0.0",
        port=AGENT_PORT,
        log_level="info",
    )
