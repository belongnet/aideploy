"""
OpenClaw Agent — Data models.
Pydantic models for all agent data structures.
"""
from __future__ import annotations
import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional
from pydantic import BaseModel, Field


def utc_now() -> datetime:
    """Return an aware UTC timestamp for TIMESTAMPTZ-backed model defaults."""
    return datetime.now(timezone.utc)

class ModelProvider(str, Enum):
    OPENAI = 'openai'
    ANTHROPIC = 'anthropic'
    GEMINI = 'gemini'
    KIMI = 'kimi'

class AuthMethod(str, Enum):
    OAUTH = 'oauth'
    API_KEY = 'api_key'

class MemoryProviderKind(str, Enum):
    SUPABASE = 'supabase'
    MEM0 = 'mem0'
    NONE = 'none'

class MemoryCaptureMode(str, Enum):
    ASYNC = 'async'
    OFF = 'off'

class KnowledgeProviderKind(str, Enum):
    NONE = 'none'
    QMD = 'qmd'

class ChannelType(str, Enum):
    TELEGRAM = 'telegram'
    WHATSAPP = 'whatsapp'
    SLACK = 'slack'

class MessageRole(str, Enum):
    USER = 'user'
    ASSISTANT = 'assistant'
    SYSTEM = 'system'

class MemoryScope(str, Enum):
    LONG_TERM = 'long_term'
    SESSION = 'session'

class TriggerType(str, Enum):
    KEYWORD = 'keyword'
    SCHEDULE = 'schedule'
    AGENT_MESSAGE = 'agent_message'
    WEBHOOK = 'webhook'
    CONVERSATION_START = 'conversation_start'
    MANUAL = 'manual'

class ActionType(str, Enum):
    REPLY = 'reply'
    API_CALL = 'api_call'
    AGENT_FORWARD = 'agent_forward'
    RUN_PROMPT = 'run_prompt'
    NOTIFY = 'notify'
    FILE_WRITE = 'file_write'
    SERVE_WEBSITE = 'serve_website'

class BusChannel(str, Enum):
    AGENT_BUS = 'agent_bus'
    SYSTEM_BUS = 'system_bus'
    DASHBOARD_BUS = 'dashboard_bus'

class BusEventType(str, Enum):
    MESSAGE_FORWARD = 'message_forward'
    TASK_RESULT = 'task_result'
    HEALTH = 'health'
    AGENT_STARTED = 'agent_started'
    AGENT_STOPPED = 'agent_stopped'
    CONFIG_CHANGED = 'config_changed'
    CHANNEL_EVENT = 'channel_event'
    BROADCAST = 'broadcast'

class AgentConfig(BaseModel):
    id: uuid.UUID = Field(default_factory=uuid.uuid4)
    model_provider: ModelProvider = ModelProvider.OPENAI
    auth_method: AuthMethod = AuthMethod.OAUTH
    model: str = 'gpt-5.5'
    system_prompt: str = 'You are a helpful AI assistant.'
    agent_name: str = 'My Agent'
    temperature: float = 0.7
    max_tokens: int = 4096
    prune_enabled: bool = True
    prune_after_days: int = 90
    prune_keep_starred: bool = True
    memory_enabled: bool = True
    memory_provider: MemoryProviderKind = MemoryProviderKind.SUPABASE
    memory_capture_mode: MemoryCaptureMode = MemoryCaptureMode.ASYNC
    memory_recall_top_k: int = 5
    memory_similarity_threshold: float = 0.25
    knowledge_provider: KnowledgeProviderKind = KnowledgeProviderKind.NONE
    knowledge_collections: list[str] = Field(default_factory=list)
    autonomous_mode: bool = True

class OAuthTokens(BaseModel):
    provider: str
    access_token: str
    refresh_token: str
    expires_at: datetime

class Channel(BaseModel):
    id: uuid.UUID = Field(default_factory=uuid.uuid4)
    type: ChannelType
    name: str
    config: dict[str, Any] = Field(default_factory=dict)
    webhook_url: Optional[str] = None
    status: str = 'active'

class Conversation(BaseModel):
    id: uuid.UUID = Field(default_factory=uuid.uuid4)
    channel_id: uuid.UUID
    external_chat_id: str
    title: Optional[str] = None
    participant_name: Optional[str] = None
    starred: bool = False
    message_count: int = 0
    last_message_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=utc_now)

class Message(BaseModel):
    id: uuid.UUID = Field(default_factory=uuid.uuid4)
    conversation_id: uuid.UUID
    role: MessageRole
    content: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    tokens_used: Optional[int] = None
    created_at: datetime = Field(default_factory=utc_now)

class Task(BaseModel):
    id: uuid.UUID = Field(default_factory=uuid.uuid4)
    name: str
    description: Optional[str] = None
    enabled: bool = True
    trigger_type: TriggerType
    trigger_config: dict[str, Any] = Field(default_factory=dict)
    action_type: ActionType
    action_config: dict[str, Any] = Field(default_factory=dict)
    auto_approve: bool = True
    run_count: int = 0
    last_run_at: Optional[datetime] = None
    consecutive_errors: int = 0
    last_error: Optional[str] = None
    auto_disable_threshold: int = 5
    auto_disabled_at: Optional[datetime] = None
    auto_disabled_reason: Optional[str] = None

class BusMessage(BaseModel):
    id: int = 0
    source_agent_id: uuid.UUID
    target_agent_id: Optional[uuid.UUID] = None
    channel: BusChannel = BusChannel.AGENT_BUS
    event_type: BusEventType = BusEventType.MESSAGE_FORWARD
    payload: dict[str, Any] = Field(default_factory=dict)
    status: str = 'pending'
    created_at: datetime = Field(default_factory=utc_now)

class MemoryItem(BaseModel):
    id: uuid.UUID = Field(default_factory=uuid.uuid4)
    user_key: str
    scope: MemoryScope = MemoryScope.LONG_TERM
    conversation_id: Optional[uuid.UUID] = None
    source_message_id: Optional[uuid.UUID] = None
    content: str
    summary: str
    content_sha256: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    forgotten_at: Optional[datetime] = None

class MemoryHit(MemoryItem):
    similarity: float = 0.0

class CaptureResult(BaseModel):
    status: str
    job_id: Optional[int] = None
    memory_id: Optional[uuid.UUID] = None
    skipped_reason: Optional[str] = None

class TurnContext(BaseModel):
    user_key: str
    agent_id: uuid.UUID
    conversation_id: uuid.UUID
    user_message_id: uuid.UUID
    assistant_message_id: Optional[uuid.UUID] = None
    user_text: str
    assistant_text: Optional[str] = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    scope: MemoryScope = MemoryScope.LONG_TERM

class IncomingMessage(BaseModel):
    channel_type: ChannelType
    channel_id: str
    chat_id: str
    sender_name: str
    text: str
    metadata: dict[str, Any] = Field(default_factory=dict)

class AnalyticsEvent(BaseModel):
    event_type: str
    metadata: dict[str, Any] = Field(default_factory=dict)

class KnowledgeHit(BaseModel):
    source: str
    title: str
    snippet: str
    score: Optional[float] = None
    metadata: dict[str, Any] = Field(default_factory=dict)
