"""
OpenClaw Agent — Postgres LISTEN/NOTIFY bus client.

Uses asyncpg to listen for inter-agent messages on the shared
message_bus table. Supports targeted and broadcast messaging.
"""
from __future__ import annotations
import json
import logging
import uuid
from typing import Any, Callable, Coroutine, Optional
import asyncpg
from .models import BusChannel, BusEventType, BusMessage
from .supabase_bus import SupabaseBusAdapter
logger = logging.getLogger(__name__)
MessageHandler = Callable[[BusMessage], Coroutine[Any, Any, None]]

class BusClient:
    """Client for the Postgres-based agent message bus."""

    def __init__(self, dsn: str, agent_id: uuid.UUID, realtime_adapter: Optional[SupabaseBusAdapter]=None):
        self.dsn = dsn
        self.agent_id = agent_id
        self._conn: Optional[asyncpg.Connection] = None
        self._pool: Optional[asyncpg.Pool] = None
        self._realtime_adapter = realtime_adapter
        self._handlers: dict[str, list[MessageHandler]] = {}
        self._running = False

    async def start(self) -> None:
        """Connect and start listening for messages."""
        self._pool = await asyncpg.create_pool(self.dsn, min_size=1, max_size=3)
        self._conn = await asyncpg.connect(self.dsn)
        self._running = True
        if self._realtime_adapter:
            await self._realtime_adapter.start()
        await self._conn.add_listener('agent_bus', self._on_notification)
        agent_channel = f'agent_{self.agent_id}'
        await self._conn.add_listener(agent_channel, self._on_notification)
        await self._conn.add_listener('system_bus', self._on_notification)
        logger.info(f'Bus client started for agent {self.agent_id}, listening on agent_bus, {agent_channel}, system_bus')
        await self.send(target_agent_id=None, channel=BusChannel.SYSTEM_BUS, event_type=BusEventType.AGENT_STARTED, payload={'agent_id': str(self.agent_id)})

    async def stop(self) -> None:
        """Disconnect and stop listening."""
        self._running = False
        try:
            await self.send(target_agent_id=None, channel=BusChannel.SYSTEM_BUS, event_type=BusEventType.AGENT_STOPPED, payload={'agent_id': str(self.agent_id)})
        except Exception:
            pass
        if self._conn:
            await self._conn.close()
            self._conn = None
        if self._pool:
            await self._pool.close()
            self._pool = None
        if self._realtime_adapter:
            await self._realtime_adapter.stop()
        logger.info(f'Bus client stopped for agent {self.agent_id}')

    def on(self, event_type: str, handler: MessageHandler) -> None:
        """Register a handler for a specific event type."""
        if event_type not in self._handlers:
            self._handlers[event_type] = []
        self._handlers[event_type].append(handler)

    async def send(self, target_agent_id: Optional[uuid.UUID], channel: BusChannel=BusChannel.AGENT_BUS, event_type: BusEventType=BusEventType.MESSAGE_FORWARD, payload: Optional[dict[str, Any]]=None) -> int:
        """Send a message on the bus."""
        if not self._pool:
            raise RuntimeError('Bus client not started')
        message_id = await self._pool.fetchval('\n            SELECT send_bus_message($1, $2, $3, $4, $5)\n            ', self.agent_id, target_agent_id, channel.value, event_type.value, json.dumps(payload or {}))
        if self._realtime_adapter and self._realtime_adapter.enabled:
            await self._mirror_to_supabase(message_id=message_id, target_agent_id=target_agent_id, channel=channel, event_type=event_type, payload=payload or {})
        logger.debug(f"Sent bus message {message_id}: {event_type.value} from {self.agent_id} to {target_agent_id or 'broadcast'}")
        return message_id

    async def _mirror_to_supabase(self, *, message_id: int, target_agent_id: Optional[uuid.UUID], channel: BusChannel, event_type: BusEventType, payload: dict[str, Any]) -> None:
        """Mirror bus events into Supabase Realtime without affecting delivery."""
        if not self._realtime_adapter:
            return
        user_id = None
        for key in ('user_id', 'supabase_user_id'):
            value = payload.get(key)
            if value:
                user_id = str(value)
                break
        try:
            await self._realtime_adapter.publish(channel=channel.value, user_id=user_id, payload={'bus_message_id': message_id, 'event_type': event_type.value, 'source_agent_id': str(self.agent_id), 'target_agent_id': str(target_agent_id) if target_agent_id else None, 'payload': payload})
        except Exception as exc:
            logger.warning('Failed to mirror bus message to Supabase: %s', exc)

    async def forward_message(self, target_agent_id: uuid.UUID, conversation_text: str, metadata: Optional[dict[str, Any]]=None) -> int:
        """Forward a conversation message to another agent."""
        return await self.send(target_agent_id=target_agent_id, channel=BusChannel.AGENT_BUS, event_type=BusEventType.MESSAGE_FORWARD, payload={'text': conversation_text, 'source_agent_id': str(self.agent_id), **(metadata or {})})

    async def broadcast(self, event_type: BusEventType, payload: dict[str, Any]) -> int:
        """Broadcast a message to all agents."""
        return await self.send(target_agent_id=None, channel=BusChannel.AGENT_BUS, event_type=event_type, payload=payload)

    async def send_health(self) -> int:
        """Send a health check signal."""
        return await self.send(target_agent_id=None, channel=BusChannel.SYSTEM_BUS, event_type=BusEventType.HEALTH, payload={'agent_id': str(self.agent_id), 'status': 'healthy'})

    def _on_notification(self, connection: asyncpg.Connection, pid: int, channel: str, payload: str) -> None:
        """Handle incoming Postgres notification."""
        if not self._running:
            return
        try:
            data = json.loads(payload)
        except json.JSONDecodeError:
            logger.warning(f'Invalid bus notification payload: {payload}')
            return
        source_id = data.get('source_agent_id')
        if source_id and source_id == str(self.agent_id):
            if data.get('channel') != 'system_bus':
                return
        target_id = data.get('target_agent_id')
        if target_id and target_id != str(self.agent_id):
            return
        import asyncio
        asyncio.ensure_future(self._dispatch(data))

    async def _dispatch(self, notification_data: dict[str, Any]) -> None:
        """Fetch the full message and dispatch to handlers."""
        if not self._pool:
            return
        message_id = notification_data.get('id')
        if not message_id:
            return
        row = await self._pool.fetchrow('SELECT * FROM public.message_bus WHERE id = $1', message_id)
        if not row:
            return
        message = BusMessage(id=row['id'], source_agent_id=row['source_agent_id'], target_agent_id=row['target_agent_id'], channel=BusChannel(row['channel']), event_type=BusEventType(row['event_type']), payload=json.loads(row['payload']) if isinstance(row['payload'], str) else row['payload'], status=row['status'], created_at=row['created_at'])
        await self._pool.execute('SELECT mark_bus_delivered($1)', message.id)
        event_type = message.event_type.value
        handlers = self._handlers.get(event_type, [])
        handlers.extend(self._handlers.get('*', []))
        for handler in handlers:
            try:
                await handler(message)
            except Exception as e:
                logger.error(f'Error in bus handler for {event_type}: {e}', exc_info=True)

    async def get_recent_messages(self, limit: int=50) -> list[dict[str, Any]]:
        """Get recent bus messages (for dashboard)."""
        if not self._pool:
            return []
        rows = await self._pool.fetch('\n            SELECT * FROM public.message_bus\n            WHERE target_agent_id = $1 OR target_agent_id IS NULL\n            ORDER BY created_at DESC\n            LIMIT $2\n            ', self.agent_id, limit)
        return [{'id': row['id'], 'source_agent_id': str(row['source_agent_id']) if row['source_agent_id'] else None, 'target_agent_id': str(row['target_agent_id']) if row['target_agent_id'] else None, 'channel': row['channel'], 'event_type': row['event_type'], 'payload': row['payload'], 'status': row['status'], 'created_at': row['created_at'].isoformat()} for row in rows]
