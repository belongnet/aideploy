"""
OpenClaw Agent — Supabase Realtime message bus adapter.

Agents use the runtime Postgres bus for delivery, and this adapter mirrors
those events into the shared `agent_messages` table so Supabase Realtime
subscribers can observe them.

Mirroring is enabled by default because the runtime database is already the
Supabase Postgres instance. Set `SUPABASE_BUS_ENABLED=false` to disable it.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

import asyncpg

logger = logging.getLogger(__name__)


def _env_flag_enabled(name: str, *, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off"}


class SupabaseBusAdapter:
    """Writes agent messages to the Supabase agent_messages table.

    This makes messages visible to Supabase Realtime subscribers
    (e.g. the Command Center frontend) while keeping compatibility
    with the existing Postgres LISTEN/NOTIFY bus.
    """

    def __init__(self, dsn: str, agent_id: uuid.UUID):
        self.dsn = dsn
        self.agent_id = agent_id
        self._pool: Optional[asyncpg.Pool] = None
        self._enabled = _env_flag_enabled("SUPABASE_BUS_ENABLED", default=True)

    @property
    def enabled(self) -> bool:
        return self._enabled

    async def start(self) -> None:
        """Connect to the database for Realtime table inserts."""
        if not self._enabled:
            logger.info("Supabase bus adapter disabled (SUPABASE_BUS_ENABLED=false)")
            return

        self._pool = await asyncpg.create_pool(self.dsn, min_size=1, max_size=2)
        logger.info(f"Supabase bus adapter started for agent {self.agent_id}")

        # Ensure the shared chat tables are published to Realtime
        async with self._pool.acquire() as conn:
            await conn.execute("""
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
            """)
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS public.agent_messages (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    user_id TEXT,
                    channel TEXT NOT NULL DEFAULT 'agent_bus',
                    sender_agent TEXT NOT NULL DEFAULT '',
                    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                    created_at TIMESTAMPTZ DEFAULT now()
                )
            """)
            await conn.execute(
                "ALTER TABLE public.agent_messages REPLICA IDENTITY FULL"
            )
            await conn.execute(
                "ALTER TABLE public.agent_conversations REPLICA IDENTITY FULL"
            )
            await conn.execute("""
                DO $$
                BEGIN
                  ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_messages;
                EXCEPTION
                  WHEN duplicate_object THEN
                    NULL;
                  WHEN undefined_object THEN
                    CREATE PUBLICATION supabase_realtime FOR TABLE public.agent_messages;
                END;
                $$;
            """)
            await conn.execute("""
                DO $$
                BEGIN
                  ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_conversations;
                EXCEPTION
                  WHEN duplicate_object THEN
                    NULL;
                  WHEN undefined_object THEN
                    CREATE PUBLICATION supabase_realtime FOR TABLE public.agent_conversations;
                END;
                $$;
            """)

    async def stop(self) -> None:
        """Disconnect."""
        if self._pool:
            await self._pool.close()
            self._pool = None

    async def publish(
        self,
        channel: str,
        payload: dict[str, Any],
        user_id: Optional[str] = None,
    ) -> Optional[str]:
        """Insert a message into agent_messages for Realtime broadcast."""
        if not self._enabled or not self._pool:
            return None

        try:
            row_id = await self._pool.fetchval(
                """
                INSERT INTO agent_messages (user_id, channel, sender_agent, payload)
                VALUES ($1, $2, $3, $4::jsonb)
                RETURNING id::text
                """,
                user_id,
                channel,
                str(self.agent_id),
                json.dumps({
                    **payload,
                    "sender_agent": str(self.agent_id),
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }),
            )
            logger.debug(f"Published to Supabase Realtime: {channel} -> {row_id}")
            return row_id
        except Exception as e:
            logger.warning(f"Failed to publish to Supabase Realtime: {e}")
            return None

    async def get_recent(
        self, channel: Optional[str] = None, limit: int = 50
    ) -> list[dict[str, Any]]:
        """Fetch recent messages from the agent_messages table."""
        if not self._pool:
            return []

        if channel:
            rows = await self._pool.fetch(
                """
                SELECT id, user_id, channel, sender_agent, payload, created_at
                FROM agent_messages
                WHERE channel = $1
                ORDER BY created_at DESC
                LIMIT $2
                """,
                channel,
                limit,
            )
        else:
            rows = await self._pool.fetch(
                """
                SELECT id, user_id, channel, sender_agent, payload, created_at
                FROM agent_messages
                ORDER BY created_at DESC
                LIMIT $1
                """,
                limit,
            )

        return [
            {
                "id": str(row["id"]),
                "user_id": row["user_id"],
                "channel": row["channel"],
                "sender_agent": row["sender_agent"],
                "payload": row["payload"],
                "created_at": row["created_at"].isoformat(),
            }
            for row in rows
        ]
