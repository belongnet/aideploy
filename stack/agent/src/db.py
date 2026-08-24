"""
OpenClaw Agent — Database layer.
Async Postgres access via asyncpg with per-agent schema isolation.
"""

from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import asyncpg

from .models import (
    AgentConfig,
    AnalyticsEvent,
    Channel,
    Conversation,
    MemoryHit,
    MemoryItem,
    MemoryScope,
    Message,
    MessageRole,
    OAuthTokens,
    Task,
)


class Database:
    """Async database interface scoped to a single agent's schema."""

    def __init__(self, schema: str, pool: asyncpg.Pool):
        self.schema = schema
        self.pool = pool

    @classmethod
    async def create(cls, dsn: str, schema: str) -> "Database":
        pool = await asyncpg.create_pool(dsn, min_size=2, max_size=10)
        db = cls(schema, pool)
        await db.ensure_agent_schema()
        await db.ensure_runtime_schema()
        return db

    async def close(self) -> None:
        await self.pool.close()

    def _t(self, table: str) -> str:
        """Qualify table name with agent schema."""
        return f"{self.schema}.{table}"

    async def ensure_agent_schema(self) -> None:
        agent_name = os.environ.get("AGENT_NAME", f"Agent {self.schema}")
        dashboard_port = int(os.environ.get("DASHBOARD_PORT", "3001"))
        gateway_port = int(os.environ.get("GATEWAY_PORT", "8081"))
        agent_port = int(os.environ.get("AGENT_PORT", "8101"))
        await self.pool.execute(
            """
            SELECT create_agent_schema($1, $2, uuid_generate_v4(), $3, $4, $5)
            """,
            self.schema,
            agent_name,
            dashboard_port,
            gateway_port,
            agent_port,
        )

    async def ensure_runtime_schema(self) -> None:
        await self.pool.execute('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')
        await self.pool.execute('CREATE EXTENSION IF NOT EXISTS "pgcrypto"')
        await self.pool.execute("CREATE EXTENSION IF NOT EXISTS vector")
        await self._ensure_shared_chat_tables()

        await self.pool.execute(
            f"""
            ALTER TABLE {self._t('agent_config')}
                ADD COLUMN IF NOT EXISTS memory_enabled BOOLEAN NOT NULL DEFAULT true,
                ADD COLUMN IF NOT EXISTS memory_provider TEXT NOT NULL DEFAULT 'supabase',
                ADD COLUMN IF NOT EXISTS memory_capture_mode TEXT NOT NULL DEFAULT 'async',
                ADD COLUMN IF NOT EXISTS memory_recall_top_k INT NOT NULL DEFAULT 5,
                ADD COLUMN IF NOT EXISTS memory_similarity_threshold REAL NOT NULL DEFAULT 0.25,
                ADD COLUMN IF NOT EXISTS knowledge_provider TEXT NOT NULL DEFAULT 'none',
                ADD COLUMN IF NOT EXISTS knowledge_collections TEXT[] NOT NULL DEFAULT '{{}}',
                ADD COLUMN IF NOT EXISTS autonomous_mode BOOLEAN NOT NULL DEFAULT true
            """
        )
        await self.pool.execute(
            f"""
            ALTER TABLE {self._t('tasks')}
                ADD COLUMN IF NOT EXISTS auto_approve BOOLEAN NOT NULL DEFAULT true,
                ADD COLUMN IF NOT EXISTS consecutive_errors INT NOT NULL DEFAULT 0,
                ADD COLUMN IF NOT EXISTS last_error TEXT,
                ADD COLUMN IF NOT EXISTS auto_disable_threshold INT NOT NULL DEFAULT 5,
                ADD COLUMN IF NOT EXISTS auto_disabled_at TIMESTAMPTZ,
                ADD COLUMN IF NOT EXISTS auto_disabled_reason TEXT
            """
        )
        await self.pool.execute(
            f"""
            ALTER TABLE {self._t('tasks')}
                DROP CONSTRAINT IF EXISTS tasks_action_type_check
            """
        )
        await self.pool.execute(
            f"""
            ALTER TABLE {self._t('tasks')}
                ADD CONSTRAINT tasks_action_type_check
                CHECK (action_type IN (
                    'reply', 'api_call', 'agent_forward',
                    'run_prompt', 'notify',
                    'file_write', 'serve_website'
                ))
            """
        )
        await self.pool.execute(
            f"""
            UPDATE {self._t('agent_config')}
            SET memory_provider = 'supabase'
            WHERE memory_provider = 'postgres'
            """
        )
        await self.pool.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {self._t('memory_items')} (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                user_key TEXT NOT NULL,
                scope TEXT NOT NULL DEFAULT 'long_term'
                    CHECK (scope IN ('long_term', 'session')),
                conversation_id UUID,
                source_message_id UUID,
                content TEXT NOT NULL,
                summary TEXT NOT NULL,
                content_sha256 TEXT NOT NULL,
                metadata JSONB NOT NULL DEFAULT '{{}}',
                forgotten_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        await self.pool.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {self._t('memory_embeddings')} (
                memory_id UUID PRIMARY KEY REFERENCES {self._t('memory_items')}(id) ON DELETE CASCADE,
                embedding vector(256) NOT NULL,
                embedding_model TEXT NOT NULL DEFAULT 'hash-v1',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        await self.pool.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {self._t('memory_capture_jobs')} (
                id BIGSERIAL PRIMARY KEY,
                user_key TEXT NOT NULL,
                conversation_id UUID,
                status TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'running', 'completed', 'skipped', 'failed')),
                payload JSONB NOT NULL DEFAULT '{{}}',
                memory_id UUID,
                last_error TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        await self.pool.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {self._t('memory_audit_log')} (
                id BIGSERIAL PRIMARY KEY,
                memory_id UUID,
                action TEXT NOT NULL,
                metadata JSONB NOT NULL DEFAULT '{{}}',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        await self.pool.execute(
            f"""
            CREATE INDEX IF NOT EXISTS idx_{self.schema}_memory_user
            ON {self._t('memory_items')}(user_key, scope, created_at DESC)
            """
        )
        await self.pool.execute(
            f"""
            CREATE INDEX IF NOT EXISTS idx_{self.schema}_memory_conversation
            ON {self._t('memory_items')}(conversation_id, created_at DESC)
            """
        )
        await self.pool.execute(
            f"""
            CREATE INDEX IF NOT EXISTS idx_{self.schema}_memory_jobs_status
            ON {self._t('memory_capture_jobs')}(status, created_at DESC)
            """
        )
        await self.pool.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {self._t('setup_prompt_state')} (
                prompt_key TEXT NOT NULL,
                channel_type TEXT NOT NULL,
                recipient_chat_id TEXT NOT NULL,
                last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                metadata JSONB NOT NULL DEFAULT '{{}}',
                PRIMARY KEY (prompt_key, channel_type, recipient_chat_id)
            )
            """
        )
        await self._ensure_config_row()

    async def _ensure_shared_chat_tables(self) -> None:
        await self.pool.execute(
            """
            CREATE TABLE IF NOT EXISTS public.agent_conversations (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                channel_type TEXT NOT NULL,
                channel_id TEXT,
                chat_id TEXT NOT NULL,
                participant_name TEXT,
                title TEXT,
                metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (channel_type, chat_id)
            )
            """
        )
        await self.pool.execute(
            """
            CREATE TABLE IF NOT EXISTS public.agent_messages (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id TEXT,
                channel TEXT NOT NULL DEFAULT 'agent_bus',
                sender_agent TEXT NOT NULL DEFAULT '',
                payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        await self.pool.execute(
            """
            ALTER TABLE public.agent_messages
                ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'bus',
                ADD COLUMN IF NOT EXISTS conversation_ref UUID REFERENCES public.agent_conversations(id) ON DELETE SET NULL,
                ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES public.agents(id) ON DELETE SET NULL,
                ADD COLUMN IF NOT EXISTS agent_name TEXT,
                ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'event',
                ADD COLUMN IF NOT EXISTS channel_type TEXT,
                ADD COLUMN IF NOT EXISTS channel_id TEXT,
                ADD COLUMN IF NOT EXISTS chat_id TEXT,
                ADD COLUMN IF NOT EXISTS local_conversation_id UUID,
                ADD COLUMN IF NOT EXISTS message_role TEXT,
                ADD COLUMN IF NOT EXISTS content TEXT,
                ADD COLUMN IF NOT EXISTS sender_name TEXT,
                ADD COLUMN IF NOT EXISTS sender_id TEXT,
                ADD COLUMN IF NOT EXISTS external_message_id TEXT,
                ADD COLUMN IF NOT EXISTS dedupe_key TEXT,
                ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
                ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb
            """
        )
        await self.pool.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_agent_messages_chat_lookup
            ON public.agent_messages(kind, channel_type, chat_id, created_at DESC)
            """
        )
        await self.pool.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_agent_messages_conversation_ref
            ON public.agent_messages(conversation_ref, created_at DESC)
            """
        )
        await self.pool.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_messages_dedupe_key
            ON public.agent_messages(dedupe_key)
            WHERE dedupe_key IS NOT NULL
            """
        )

    async def _ensure_config_row(self) -> None:
        row = await self.pool.fetchrow(
            f"SELECT id FROM {self._t('agent_config')} LIMIT 1"
        )
        if row:
            return
        await self.pool.execute(
            f"""
            INSERT INTO {self._t('agent_config')} DEFAULT VALUES
            """
        )

    # ── Agent Config ─────────────────────────────────────────

    async def get_config(self) -> AgentConfig:
        await self._ensure_config_row()
        row = await self.pool.fetchrow(
            f"SELECT * FROM {self._t('agent_config')} LIMIT 1"
        )
        if not row:
            return AgentConfig()
        return AgentConfig(**dict(row))

    async def update_config(self, **kwargs: Any) -> AgentConfig:
        await self._ensure_config_row()
        sets = ", ".join(f"{k} = ${i+1}" for i, k in enumerate(kwargs.keys()))
        values = list(kwargs.values())
        await self.pool.execute(
            f"UPDATE {self._t('agent_config')} SET {sets}, updated_at = NOW()",
            *values,
        )
        return await self.get_config()

    # ── OAuth Tokens ─────────────────────────────────────────

    async def get_oauth_tokens(self, provider: str) -> Optional[OAuthTokens]:
        row = await self.pool.fetchrow(
            f"SELECT * FROM {self._t('oauth_tokens')} WHERE provider = $1",
            provider,
        )
        if not row:
            return None
        return OAuthTokens(
            provider=row["provider"],
            access_token=row["access_token_enc"],
            refresh_token=row["refresh_token_enc"],
            expires_at=row["expires_at"],
        )

    async def save_oauth_tokens(self, tokens: OAuthTokens) -> None:
        await self.pool.execute(
            f"""
            INSERT INTO {self._t('oauth_tokens')}
                (provider, access_token_enc, refresh_token_enc, expires_at)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (provider) DO UPDATE SET
                access_token_enc = $2,
                refresh_token_enc = $3,
                expires_at = $4,
                updated_at = NOW()
            """,
            tokens.provider,
            tokens.access_token,
            tokens.refresh_token,
            tokens.expires_at,
        )

    # ── API Keys ─────────────────────────────────────────────

    async def get_api_key(self, provider: str) -> Optional[str]:
        row = await self.pool.fetchrow(
            f"SELECT api_key_enc FROM {self._t('api_keys')} WHERE provider = $1",
            provider,
        )
        return row["api_key_enc"] if row else None

    async def save_api_key(self, provider: str, api_key_enc: str) -> None:
        await self.pool.execute(
            f"""
            INSERT INTO {self._t('api_keys')} (provider, api_key_enc)
            VALUES ($1, $2)
            ON CONFLICT (provider) DO UPDATE SET api_key_enc = $2
            """,
            provider,
            api_key_enc,
        )

    # ── Channels ─────────────────────────────────────────────

    async def get_channels(self) -> list[Channel]:
        rows = await self.pool.fetch(
            f"SELECT * FROM {self._t('channels')} ORDER BY created_at"
        )
        return [Channel(**dict(r)) for r in rows]

    async def get_channel(self, channel_id: uuid.UUID) -> Optional[Channel]:
        row = await self.pool.fetchrow(
            f"SELECT * FROM {self._t('channels')} WHERE id = $1",
            channel_id,
        )
        return Channel(**dict(row)) if row else None

    async def create_channel(self, channel: Channel) -> Channel:
        await self.pool.execute(
            f"""
            INSERT INTO {self._t('channels')} (id, type, name, config, webhook_url, status)
            VALUES ($1, $2, $3, $4, $5, $6)
            """,
            channel.id,
            channel.type.value,
            channel.name,
            json.dumps(channel.config),
            channel.webhook_url,
            channel.status,
        )
        return channel

    async def update_channel(
        self, channel_id: uuid.UUID, **kwargs: Any
    ) -> Optional[Channel]:
        if "config" in kwargs:
            kwargs["config"] = json.dumps(kwargs["config"])
        if "type" in kwargs and hasattr(kwargs["type"], "value"):
            kwargs["type"] = kwargs["type"].value
        sets = ", ".join(f"{k} = ${i+2}" for i, k in enumerate(kwargs.keys()))
        values = list(kwargs.values())
        await self.pool.execute(
            f"UPDATE {self._t('channels')} SET {sets}, updated_at = NOW() WHERE id = $1",
            channel_id,
            *values,
        )
        return await self.get_channel(channel_id)

    async def delete_channel(self, channel_id: uuid.UUID) -> None:
        await self.pool.execute(
            f"DELETE FROM {self._t('channels')} WHERE id = $1", channel_id
        )

    async def claim_setup_prompt(
        self,
        prompt_key: str,
        channel_type: str,
        recipient_chat_id: str,
        cooldown_seconds: int,
        metadata: dict[str, Any],
    ) -> tuple[bool, datetime | None]:
        now = datetime.now(timezone.utc)
        table = self._t("setup_prompt_state")

        async with self.pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    f"""
                    SELECT last_sent_at
                    FROM {table}
                    WHERE prompt_key = $1
                      AND channel_type = $2
                      AND recipient_chat_id = $3
                    FOR UPDATE
                    """,
                    prompt_key,
                    channel_type,
                    recipient_chat_id,
                )

                last_sent_at = row["last_sent_at"] if row else None
                threshold = now - timedelta(seconds=max(0, cooldown_seconds))
                if last_sent_at and last_sent_at > threshold:
                    return False, last_sent_at

                if row:
                    await conn.execute(
                        f"""
                        UPDATE {table}
                        SET last_sent_at = $4,
                            metadata = $5
                        WHERE prompt_key = $1
                          AND channel_type = $2
                          AND recipient_chat_id = $3
                        """,
                        prompt_key,
                        channel_type,
                        recipient_chat_id,
                        now,
                        json.dumps(metadata),
                    )
                else:
                    await conn.execute(
                        f"""
                        INSERT INTO {table}
                            (prompt_key, channel_type, recipient_chat_id, last_sent_at, metadata)
                        VALUES ($1, $2, $3, $4, $5)
                        """,
                        prompt_key,
                        channel_type,
                        recipient_chat_id,
                        now,
                        json.dumps(metadata),
                    )

                return True, now

    # ── Conversations ────────────────────────────────────────

    async def get_conversations(
        self,
        limit: int = 50,
        offset: int = 0,
        starred_only: bool = False,
        search: Optional[str] = None,
    ) -> list[Conversation]:
        conditions = []
        params: list[Any] = []
        idx = 1

        if starred_only:
            conditions.append("starred = true")

        if search:
            conditions.append(f"(title ILIKE ${idx} OR participant_name ILIKE ${idx})")
            params.append(f"%{search}%")
            idx += 1

        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        params.extend([limit, offset])
        rows = await self.pool.fetch(
            f"""
            SELECT * FROM {self._t('conversations')}
            {where}
            ORDER BY last_message_at DESC NULLS LAST
            LIMIT ${idx} OFFSET ${idx+1}
            """,
            *params,
        )
        return [Conversation(**dict(r)) for r in rows]

    async def get_conversation(
        self, conversation_id: uuid.UUID
    ) -> Optional[Conversation]:
        row = await self.pool.fetchrow(
            f"SELECT * FROM {self._t('conversations')} WHERE id = $1",
            conversation_id,
        )
        return Conversation(**dict(row)) if row else None

    async def get_or_create_conversation(
        self, channel_id: uuid.UUID, chat_id: str, participant_name: str
    ) -> Conversation:
        row = await self.pool.fetchrow(
            f"""
            SELECT * FROM {self._t('conversations')}
            WHERE channel_id = $1 AND external_chat_id = $2
            """,
            channel_id,
            chat_id,
        )
        if row:
            return Conversation(**dict(row))

        conv = Conversation(
            channel_id=channel_id,
            external_chat_id=chat_id,
            participant_name=participant_name,
            title=f"Chat with {participant_name}",
        )
        await self.pool.execute(
            f"""
            INSERT INTO {self._t('conversations')}
                (id, channel_id, external_chat_id, title, participant_name)
            VALUES ($1, $2, $3, $4, $5)
            """,
            conv.id,
            conv.channel_id,
            conv.external_chat_id,
            conv.title,
            conv.participant_name,
        )
        return conv

    async def star_conversation(
        self, conversation_id: uuid.UUID, starred: bool
    ) -> None:
        await self.pool.execute(
            f"UPDATE {self._t('conversations')} SET starred = $2, updated_at = NOW() WHERE id = $1",
            conversation_id,
            starred,
        )

    async def delete_conversation(self, conversation_id: uuid.UUID) -> None:
        await self.pool.execute(
            f"DELETE FROM {self._t('messages')} WHERE conversation_id = $1",
            conversation_id,
        )
        await self.pool.execute(
            f"DELETE FROM {self._t('conversations')} WHERE id = $1",
            conversation_id,
        )

    # ── Shared Chat State ────────────────────────────────────

    async def upsert_shared_conversation(
        self,
        *,
        channel_type: str,
        channel_id: Optional[str],
        chat_id: str,
        participant_name: Optional[str],
        title: Optional[str],
        metadata: Optional[dict[str, Any]] = None,
    ) -> uuid.UUID:
        row = await self.pool.fetchrow(
            """
            INSERT INTO public.agent_conversations (
                channel_type,
                channel_id,
                chat_id,
                participant_name,
                title,
                metadata
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (channel_type, chat_id) DO UPDATE SET
                channel_id = COALESCE(EXCLUDED.channel_id, public.agent_conversations.channel_id),
                participant_name = COALESCE(EXCLUDED.participant_name, public.agent_conversations.participant_name),
                title = COALESCE(EXCLUDED.title, public.agent_conversations.title),
                metadata = COALESCE(EXCLUDED.metadata, public.agent_conversations.metadata),
                updated_at = NOW()
            RETURNING id
            """,
            channel_type,
            channel_id,
            chat_id,
            participant_name,
            title,
            json.dumps(metadata or {}),
        )
        return row["id"]

    async def add_shared_message(
        self,
        *,
        kind: str,
        direction: str,
        channel: str,
        channel_type: str,
        channel_id: Optional[str],
        chat_id: str,
        message_role: str,
        content: str,
        user_id: Optional[str] = None,
        agent_id: Optional[uuid.UUID] = None,
        agent_name: Optional[str] = None,
        conversation_ref: Optional[uuid.UUID] = None,
        local_conversation_id: Optional[uuid.UUID] = None,
        sender_name: Optional[str] = None,
        sender_id: Optional[str] = None,
        external_message_id: Optional[str] = None,
        dedupe_key: Optional[str] = None,
        attachments: Optional[list[dict[str, Any]]] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> str:
        payload = {
            "content": content,
            "attachments": attachments or [],
            "metadata": metadata or {},
        }
        row = await self.pool.fetchrow(
            """
            INSERT INTO public.agent_messages (
                user_id,
                channel,
                sender_agent,
                payload,
                kind,
                conversation_ref,
                agent_id,
                agent_name,
                direction,
                channel_type,
                channel_id,
                chat_id,
                local_conversation_id,
                message_role,
                content,
                sender_name,
                sender_id,
                external_message_id,
                dedupe_key,
                attachments,
                metadata
            )
            VALUES (
                $1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10,
                $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb, $21::jsonb
            )
            ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO UPDATE SET
                user_id = COALESCE(EXCLUDED.user_id, public.agent_messages.user_id),
                payload = EXCLUDED.payload,
                conversation_ref = COALESCE(EXCLUDED.conversation_ref, public.agent_messages.conversation_ref),
                agent_id = COALESCE(EXCLUDED.agent_id, public.agent_messages.agent_id),
                agent_name = COALESCE(EXCLUDED.agent_name, public.agent_messages.agent_name),
                local_conversation_id = COALESCE(EXCLUDED.local_conversation_id, public.agent_messages.local_conversation_id),
                content = COALESCE(EXCLUDED.content, public.agent_messages.content),
                sender_name = COALESCE(EXCLUDED.sender_name, public.agent_messages.sender_name),
                sender_id = COALESCE(EXCLUDED.sender_id, public.agent_messages.sender_id),
                attachments = EXCLUDED.attachments,
                metadata = EXCLUDED.metadata
            RETURNING id::text
            """,
            user_id,
            channel,
            str(agent_id) if agent_id else "",
            json.dumps(payload),
            kind,
            conversation_ref,
            agent_id,
            agent_name,
            direction,
            channel_type,
            channel_id,
            chat_id,
            local_conversation_id,
            message_role,
            content,
            sender_name,
            sender_id,
            external_message_id,
            dedupe_key,
            json.dumps(attachments or []),
            json.dumps(metadata or {}),
        )
        return row["id"]

    async def get_shared_chat_messages(
        self,
        *,
        channel_type: str,
        chat_id: str,
        limit: int = 25,
        exclude_agent_id: Optional[uuid.UUID] = None,
        exclude_local_conversation_id: Optional[uuid.UUID] = None,
    ) -> list[dict[str, Any]]:
        rows = await self.pool.fetch(
            """
            SELECT
                id,
                agent_id,
                agent_name,
                direction,
                message_role,
                content,
                sender_name,
                sender_id,
                external_message_id,
                attachments,
                metadata,
                created_at
            FROM public.agent_messages
            WHERE kind = 'chat'
              AND channel_type = $1
              AND chat_id = $2
              AND NOT (
                $4::uuid IS NOT NULL
                AND $5::uuid IS NOT NULL
                AND agent_id IS NOT DISTINCT FROM $4
                AND local_conversation_id IS NOT DISTINCT FROM $5
              )
            ORDER BY created_at DESC
            LIMIT $3
            """,
            channel_type,
            chat_id,
            limit,
            exclude_agent_id,
            exclude_local_conversation_id,
        )
        messages = [dict(row) for row in rows]
        messages.reverse()
        return messages

    # ── Messages ─────────────────────────────────────────────

    async def get_messages(
        self, conversation_id: uuid.UUID, limit: int = 100, before: Optional[datetime] = None
    ) -> list[Message]:
        if before:
            rows = await self.pool.fetch(
                f"""
                SELECT * FROM {self._t('messages')}
                WHERE conversation_id = $1 AND created_at < $2
                ORDER BY created_at DESC LIMIT $3
                """,
                conversation_id,
                before,
                limit,
            )
        else:
            rows = await self.pool.fetch(
                f"""
                SELECT * FROM {self._t('messages')}
                WHERE conversation_id = $1
                ORDER BY created_at DESC LIMIT $2
                """,
                conversation_id,
                limit,
            )
        messages = [Message(**dict(r)) for r in rows]
        messages.reverse()
        return messages

    async def add_message(self, message: Message) -> Message:
        await self.pool.execute(
            f"""
            INSERT INTO {self._t('messages')}
                (id, conversation_id, role, content, metadata, tokens_used)
            VALUES ($1, $2, $3, $4, $5, $6)
            """,
            message.id,
            message.conversation_id,
            message.role.value,
            message.content,
            json.dumps(message.metadata),
            message.tokens_used,
        )
        # Update conversation stats
        await self.pool.execute(
            f"""
            UPDATE {self._t('conversations')} SET
                message_count = message_count + 1,
                last_message_at = NOW(),
                updated_at = NOW()
            WHERE id = $1
            """,
            message.conversation_id,
        )
        return message

    # ── Tasks ────────────────────────────────────────────────

    async def get_tasks(self, enabled_only: bool = False) -> list[Task]:
        where = "WHERE enabled = true" if enabled_only else ""
        rows = await self.pool.fetch(
            f"SELECT * FROM {self._t('tasks')} {where} ORDER BY created_at"
        )
        return [Task(**dict(r)) for r in rows]

    async def get_task(self, task_id: uuid.UUID) -> Optional[Task]:
        row = await self.pool.fetchrow(
            f"SELECT * FROM {self._t('tasks')} WHERE id = $1", task_id
        )
        return Task(**dict(row)) if row else None

    async def create_task(self, task: Task) -> Task:
        await self.pool.execute(
            f"""
            INSERT INTO {self._t('tasks')}
                (id, name, description, enabled, trigger_type, trigger_config,
                 action_type, action_config, auto_approve)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            """,
            task.id,
            task.name,
            task.description,
            task.enabled,
            task.trigger_type.value,
            json.dumps(task.trigger_config),
            task.action_type.value,
            json.dumps(task.action_config),
            task.auto_approve,
        )
        return task

    async def update_task(self, task_id: uuid.UUID, **kwargs: Any) -> Optional[Task]:
        if "trigger_config" in kwargs:
            kwargs["trigger_config"] = json.dumps(kwargs["trigger_config"])
        if "action_config" in kwargs:
            kwargs["action_config"] = json.dumps(kwargs["action_config"])
        sets = ", ".join(f"{k} = ${i+2}" for i, k in enumerate(kwargs.keys()))
        values = list(kwargs.values())
        await self.pool.execute(
            f"UPDATE {self._t('tasks')} SET {sets}, updated_at = NOW() WHERE id = $1",
            task_id,
            *values,
        )
        return await self.get_task(task_id)

    async def delete_task(self, task_id: uuid.UUID) -> None:
        await self.pool.execute(
            f"DELETE FROM {self._t('tasks')} WHERE id = $1", task_id
        )

    async def increment_task_run(self, task_id: uuid.UUID) -> None:
        await self.pool.execute(
            f"""
            UPDATE {self._t('tasks')} SET
                run_count = run_count + 1,
                last_run_at = NOW(),
                consecutive_errors = 0,
                last_error = NULL,
                updated_at = NOW()
            WHERE id = $1
            """,
            task_id,
        )

    async def record_task_failure(
        self, task_id: uuid.UUID, error: str
    ) -> Optional[Task]:
        """Increment consecutive_errors and return the updated task.

        Auto-disable is left to the caller so it can emit a single
        notification when the threshold flips.
        """
        row = await self.pool.fetchrow(
            f"""
            UPDATE {self._t('tasks')} SET
                run_count = run_count + 1,
                last_run_at = NOW(),
                consecutive_errors = consecutive_errors + 1,
                last_error = $2,
                updated_at = NOW()
            WHERE id = $1
            RETURNING *
            """,
            task_id,
            error[:1000],
        )
        return Task(**dict(row)) if row else None

    async def auto_disable_task(
        self, task_id: uuid.UUID, reason: str
    ) -> None:
        await self.pool.execute(
            f"""
            UPDATE {self._t('tasks')} SET
                enabled = false,
                auto_disabled_at = NOW(),
                auto_disabled_reason = $2,
                updated_at = NOW()
            WHERE id = $1
            """,
            task_id,
            reason[:1000],
        )

    # ── Analytics ────────────────────────────────────────────

    async def log_event(self, event: AnalyticsEvent) -> None:
        await self.pool.execute(
            f"""
            INSERT INTO {self._t('analytics_events')} (event_type, metadata)
            VALUES ($1, $2)
            """,
            event.event_type,
            json.dumps(event.metadata),
        )

    async def get_analytics(
        self, event_type: Optional[str] = None, days: int = 30
    ) -> list[dict[str, Any]]:
        if event_type:
            rows = await self.pool.fetch(
                f"""
                SELECT * FROM {self._t('analytics_events')}
                WHERE event_type = $1 AND created_at > NOW() - INTERVAL '{days} days'
                ORDER BY created_at DESC LIMIT 1000
                """,
                event_type,
            )
        else:
            rows = await self.pool.fetch(
                f"""
                SELECT * FROM {self._t('analytics_events')}
                WHERE created_at > NOW() - INTERVAL '{days} days'
                ORDER BY created_at DESC LIMIT 1000
                """
            )
        return [dict(r) for r in rows]

    # ── Memory ───────────────────────────────────────────────

    async def create_memory_capture_job(
        self,
        user_key: str,
        conversation_id: Optional[uuid.UUID],
        payload: dict[str, Any],
    ) -> int:
        return int(
            await self.pool.fetchval(
                f"""
                INSERT INTO {self._t('memory_capture_jobs')}
                    (user_key, conversation_id, payload)
                VALUES ($1, $2, $3)
                RETURNING id
                """,
                user_key,
                conversation_id,
                json.dumps(payload),
            )
        )

    async def update_memory_capture_job(
        self,
        job_id: int,
        status: str,
        *,
        memory_id: Optional[uuid.UUID] = None,
        last_error: Optional[str] = None,
    ) -> None:
        await self.pool.execute(
            f"""
            UPDATE {self._t('memory_capture_jobs')}
            SET status = $2,
                memory_id = COALESCE($3, memory_id),
                last_error = $4,
                updated_at = NOW()
            WHERE id = $1
            """,
            job_id,
            status,
            memory_id,
            last_error,
        )

    async def add_memory_audit(
        self,
        action: str,
        metadata: dict[str, Any],
        memory_id: Optional[uuid.UUID] = None,
    ) -> None:
        await self.pool.execute(
            f"""
            INSERT INTO {self._t('memory_audit_log')} (memory_id, action, metadata)
            VALUES ($1, $2, $3)
            """,
            memory_id,
            action,
            json.dumps(metadata),
        )

    async def find_memory_by_hash(
        self,
        user_key: str,
        scope: MemoryScope,
        content_sha256: str,
    ) -> Optional[uuid.UUID]:
        return await self.pool.fetchval(
            f"""
            SELECT id
            FROM {self._t('memory_items')}
            WHERE user_key = $1
              AND scope = $2
              AND content_sha256 = $3
              AND forgotten_at IS NULL
            LIMIT 1
            """,
            user_key,
            scope.value,
            content_sha256,
        )

    async def insert_memory(
        self,
        item: MemoryItem,
        embedding_literal: str,
        embedding_model: str = "hash-v1",
    ) -> MemoryItem:
        await self.pool.execute(
            f"""
            INSERT INTO {self._t('memory_items')}
                (id, user_key, scope, conversation_id, source_message_id, content,
                 summary, content_sha256, metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            """,
            item.id,
            item.user_key,
            item.scope.value,
            item.conversation_id,
            item.source_message_id,
            item.content,
            item.summary,
            item.content_sha256,
            json.dumps(item.metadata),
        )
        await self.pool.execute(
            f"""
            INSERT INTO {self._t('memory_embeddings')}
                (memory_id, embedding, embedding_model)
            VALUES ($1, $2::vector, $3)
            """,
            item.id,
            embedding_literal,
            embedding_model,
        )
        await self.add_memory_audit(
            "captured",
            {
                "user_key": item.user_key,
                "scope": item.scope.value,
                "conversation_id": str(item.conversation_id)
                if item.conversation_id
                else None,
            },
            memory_id=item.id,
        )
        return item

    async def search_memories(
        self,
        user_key: str,
        embedding_literal: str,
        limit: int,
        threshold: float,
    ) -> list[MemoryHit]:
        rows = await self.pool.fetch(
            f"""
            SELECT
                mi.*,
                1 - (me.embedding <=> $2::vector) AS similarity
            FROM {self._t('memory_items')} mi
            JOIN {self._t('memory_embeddings')} me
              ON me.memory_id = mi.id
            WHERE mi.user_key IN ($1, '__system__')
              AND mi.forgotten_at IS NULL
              AND 1 - (me.embedding <=> $2::vector) >= $3
            ORDER BY me.embedding <=> $2::vector ASC
            LIMIT $4
            """,
            user_key,
            embedding_literal,
            threshold,
            limit,
        )
        return [MemoryHit(**dict(r)) for r in rows]

    async def list_memories(
        self,
        user_key: str,
        scope: Optional[str] = None,
        limit: int = 50,
    ) -> list[MemoryItem]:
        clauses = ["user_key = $1", "forgotten_at IS NULL"]
        params: list[Any] = [user_key]
        if scope and scope != "all":
            clauses.append("scope = $2")
            params.append(scope)
            limit_param = 3
        else:
            limit_param = 2
        params.append(limit)
        rows = await self.pool.fetch(
            f"""
            SELECT *
            FROM {self._t('memory_items')}
            WHERE {' AND '.join(clauses)}
            ORDER BY created_at DESC
            LIMIT ${limit_param}
            """,
            *params,
        )
        return [MemoryItem(**dict(r)) for r in rows]

    async def forget_memories(
        self,
        user_key: str,
        *,
        memory_ids: Optional[list[uuid.UUID]] = None,
        query: Optional[str] = None,
    ) -> int:
        if memory_ids:
            result = await self.pool.execute(
                f"""
                UPDATE {self._t('memory_items')}
                SET forgotten_at = NOW(), updated_at = NOW()
                WHERE user_key = $1
                  AND id = ANY($2::uuid[])
                  AND forgotten_at IS NULL
                """,
                user_key,
                memory_ids,
            )
        elif query:
            result = await self.pool.execute(
                f"""
                UPDATE {self._t('memory_items')}
                SET forgotten_at = NOW(), updated_at = NOW()
                WHERE user_key = $1
                  AND forgotten_at IS NULL
                  AND (content ILIKE $2 OR summary ILIKE $2)
                """,
                user_key,
                f"%{query}%",
            )
        else:
            return 0

        count = int(result.split()[-1]) if result.startswith("UPDATE ") else 0
        await self.add_memory_audit(
            "forgotten",
            {
                "user_key": user_key,
                "memory_ids": [str(memory_id) for memory_id in memory_ids or []],
                "query": query,
                "count": count,
            },
        )
        return count

    # ── Pruning ──────────────────────────────────────────────

    async def prune_conversations(
        self, older_than_days: int, keep_starred: bool
    ) -> int:
        starred_clause = "AND starred = false" if keep_starred else ""
        # Get conversation IDs to prune
        rows = await self.pool.fetch(
            f"""
            SELECT id FROM {self._t('conversations')}
            WHERE last_message_at < NOW() - INTERVAL '{older_than_days} days'
            {starred_clause}
            """
        )
        count = 0
        for row in rows:
            conv_id = row["id"]
            await self.pool.execute(
                f"DELETE FROM {self._t('messages')} WHERE conversation_id = $1",
                conv_id,
            )
            await self.pool.execute(
                f"DELETE FROM {self._t('conversations')} WHERE id = $1", conv_id
            )
            count += 1
        return count

    # ── Stats ────────────────────────────────────────────────

    async def get_stats(self) -> dict[str, Any]:
        conv_count = await self.pool.fetchval(
            f"SELECT COUNT(*) FROM {self._t('conversations')}"
        )
        msg_count = await self.pool.fetchval(
            f"SELECT COUNT(*) FROM {self._t('messages')}"
        )
        msg_today = await self.pool.fetchval(
            f"""
            SELECT COUNT(*) FROM {self._t('messages')}
            WHERE created_at > CURRENT_DATE
            """
        )
        channel_count = await self.pool.fetchval(
            f"SELECT COUNT(*) FROM {self._t('channels')} WHERE status = 'active'"
        )
        task_count = await self.pool.fetchval(
            f"SELECT COUNT(*) FROM {self._t('tasks')} WHERE enabled = true"
        )
        memory_count = await self.pool.fetchval(
            f"""
            SELECT COUNT(*) FROM {self._t('memory_items')}
            WHERE forgotten_at IS NULL
            """
        )
        return {
            "conversations": conv_count or 0,
            "messages": msg_count or 0,
            "messages_today": msg_today or 0,
            "active_channels": channel_count or 0,
            "active_tasks": task_count or 0,
            "memories": memory_count or 0,
        }
