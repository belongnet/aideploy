"""
OpenClaw Agent — Memory providers.

Provides first-party Supabase/Postgres-backed memory by default, with an
optional Mem0 adapter behind the same interface. The default implementation
uses pgvector for similarity search and a deterministic local embedding so
memory works even when the active chat model has no embeddings API.
"""
from __future__ import annotations
import hashlib
import ipaddress
import logging
import math
import os
import re
import uuid
from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any, Optional
from urllib.parse import urlparse
from .models import AgentConfig, CaptureResult, MemoryHit, MemoryItem, MemoryProviderKind, MemoryScope, TurnContext
logger = logging.getLogger(__name__)
if TYPE_CHECKING:
    from .db import Database
EMBEDDING_DIMENSIONS = 256
SECRET_PATTERNS = [re.compile('-----BEGIN [A-Z ]*PRIVATE KEY-----'), re.compile('\\b(?:api[_ -]?key|secret|token|password)\\b\\s*[:=]\\s*\\S+', re.IGNORECASE), re.compile('\\bBearer\\s+[A-Za-z0-9._-]{10,}', re.IGNORECASE), re.compile('\\b(?:sk|rk|pk)_[A-Za-z0-9]{12,}', re.IGNORECASE), re.compile('\\bxox[baprs]-[A-Za-z0-9-]{10,}', re.IGNORECASE), re.compile('\\bgh[pousr]_[A-Za-z0-9]{20,}', re.IGNORECASE), re.compile('https?://(?:localhost|127\\.0\\.0\\.1)[:/]\\S+', re.IGNORECASE), re.compile('\\b(?:code|state|code_verifier|access_token)=\\S+', re.IGNORECASE)]

def resolve_user_key(metadata: dict[str, Any], channel_type: str, chat_id: str) -> str:
    candidates: list[tuple[str, ...]] = [('supabase_user_id',), ('supabaseUserId',), ('user_id',), ('userId',), ('user', 'id')]
    for path in candidates:
        current: Any = metadata
        for segment in path:
            if not isinstance(current, dict):
                current = None
                break
            current = current.get(segment)
        if isinstance(current, str) and current.strip():
            return current.strip()
    return f'{channel_type}:{chat_id}'

def build_memory_summary(text: str, limit: int=160) -> str:
    normalized = ' '.join(text.split())
    if len(normalized) <= limit:
        return normalized
    return normalized[:limit - 3].rstrip() + '...'

def sanitize_memory_text(text: str) -> Optional[str]:
    normalized = ' '.join(str(text or '').split())
    if len(normalized) < 12:
        return None
    for pattern in SECRET_PATTERNS:
        if pattern.search(normalized):
            return None
    return normalized

def should_capture_memory(text: str) -> bool:
    lowered = text.lower()
    if len(text) < 20:
        return False
    if len(text) > 1600:
        return False
    signals = ['i prefer', 'i like', 'i dislike', 'my name is', 'remember', 'i work', 'i live', 'i am ', 'my favorite', 'always', 'never', 'please use']
    if any((signal in lowered for signal in signals)):
        return True
    return len(text.split()) >= 6

def embed_text(text: str, dimensions: int=EMBEDDING_DIMENSIONS) -> list[float]:
    values = [0.0] * dimensions
    tokens = re.findall('[a-z0-9_/-]+', text.lower())
    if not tokens:
        return values
    for token in tokens:
        digest = hashlib.sha256(token.encode('utf-8')).digest()
        for offset in range(0, 16, 4):
            bucket = int.from_bytes(digest[offset:offset + 2], 'big') % dimensions
            sign = 1.0 if digest[offset + 2] % 2 == 0 else -1.0
            weight = 1.0 + digest[offset + 3] / 255.0
            values[bucket] += sign * weight
    norm = math.sqrt(sum((value * value for value in values)))
    if norm == 0:
        return values
    return [value / norm for value in values]

def vector_literal(values: list[float]) -> str:
    return '[' + ','.join((f'{value:.8f}' for value in values)) + ']'

def _truthy_env(name: str) -> bool:
    return os.environ.get(name, '').strip().lower() in {'1', 'true', 'yes', 'on'}

def is_private_or_reserved_provider_host(hostname: str) -> bool:
    host = hostname.strip().lower().strip('[]').rstrip('.')
    if not host or host == 'localhost' or host.endswith('.localhost') or host.endswith('.local') or host.endswith('.internal') or host.endswith('.lan') or host.endswith('.home'):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return '.' not in host
    if isinstance(ip, ipaddress.IPv4Address) and ip in ipaddress.ip_network('100.64.0.0/10'):
        return True
    return bool(ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified)

def normalize_mem0_base_url(raw_url: str, *, allow_private: bool=False) -> str:
    value = str(raw_url or '').strip().rstrip('/')
    if any((char in value for char in '\r\n\x00')):
        return ''
    parsed = urlparse(value)
    if parsed.scheme not in {'http', 'https'}:
        return ''
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        return ''
    if not parsed.hostname:
        return ''
    if parsed.scheme != 'https' and (not allow_private):
        return ''
    if is_private_or_reserved_provider_host(parsed.hostname) and (not allow_private):
        return ''
    return value

def build_memory_prompt(hits: list[MemoryHit]) -> Optional[str]:
    if not hits:
        return None
    lines = ['Relevant long-term memory for this user. Use it only when it helps answer correctly.']
    for hit in hits:
        lines.append(f'- {hit.summary} (similarity={hit.similarity:.2f}, captured={hit.created_at.isoformat()})')
    return '\n'.join(lines)

class MemoryProvider(ABC):

    def __init__(self, db: 'Database', config: AgentConfig):
        self.db = db
        self.config = config

    @abstractmethod
    async def recall(self, user_key: str, agent_id: uuid.UUID, query: str, limit: int) -> list[MemoryHit]:
        ...

    @abstractmethod
    async def capture(self, turn_context: TurnContext) -> CaptureResult:
        ...

    @abstractmethod
    async def forget(self, user_key: str, selector: dict[str, Any]) -> int:
        ...

    @abstractmethod
    async def list(self, user_key: str, scope: str, limit: int) -> list[MemoryItem]:
        ...

class NullMemoryProvider(MemoryProvider):

    async def recall(self, user_key: str, agent_id: uuid.UUID, query: str, limit: int) -> list[MemoryHit]:
        return []

    async def capture(self, turn_context: TurnContext) -> CaptureResult:
        return CaptureResult(status='disabled', skipped_reason='memory_disabled')

    async def forget(self, user_key: str, selector: dict[str, Any]) -> int:
        return 0

    async def list(self, user_key: str, scope: str, limit: int) -> list[MemoryItem]:
        return []

class SupabaseMemoryProvider(MemoryProvider):

    async def recall(self, user_key: str, agent_id: uuid.UUID, query: str, limit: int) -> list[MemoryHit]:
        if not user_key or not query.strip():
            return []
        try:
            hits = await self.db.search_memories(user_key=user_key, embedding_literal=vector_literal(embed_text(query)), limit=limit, threshold=self.config.memory_similarity_threshold)
            if hits:
                await self.db.add_memory_audit('recalled', {'user_key': user_key, 'agent_id': str(agent_id), 'query': build_memory_summary(query, 120), 'count': len(hits)})
            return hits
        except Exception as exc:
            logger.warning('Memory recall failed, continuing without memory: %s', exc)
            return []

    async def capture(self, turn_context: TurnContext) -> CaptureResult:
        payload = {'agent_id': str(turn_context.agent_id), 'user_message_id': str(turn_context.user_message_id), 'assistant_message_id': str(turn_context.assistant_message_id) if turn_context.assistant_message_id else None, 'scope': turn_context.scope.value, 'metadata': turn_context.metadata}
        job_id = await self.db.create_memory_capture_job(turn_context.user_key, turn_context.conversation_id, payload)
        await self.db.update_memory_capture_job(job_id, 'running')
        try:
            sanitized = sanitize_memory_text(turn_context.user_text)
            if not sanitized:
                await self.db.update_memory_capture_job(job_id, 'skipped', last_error='sensitive_or_empty')
                await self.db.add_memory_audit('skipped_sensitive', {'user_key': turn_context.user_key, 'reason': 'sensitive_or_empty'})
                return CaptureResult(status='skipped', job_id=job_id, skipped_reason='sensitive_or_empty')
            if not should_capture_memory(sanitized):
                await self.db.update_memory_capture_job(job_id, 'skipped', last_error='not_capture_worthy')
                return CaptureResult(status='skipped', job_id=job_id, skipped_reason='not_capture_worthy')
            digest = hashlib.sha256(sanitized.encode('utf-8')).hexdigest()
            existing = await self.db.find_memory_by_hash(turn_context.user_key, turn_context.scope, digest)
            if existing:
                await self.db.update_memory_capture_job(job_id, 'skipped', memory_id=existing, last_error='duplicate')
                return CaptureResult(status='skipped', job_id=job_id, memory_id=existing, skipped_reason='duplicate')
            memory = MemoryItem(user_key=turn_context.user_key, scope=turn_context.scope, conversation_id=turn_context.conversation_id, source_message_id=turn_context.user_message_id, content=sanitized, summary=build_memory_summary(sanitized), content_sha256=digest, metadata={**turn_context.metadata, 'assistant_text': build_memory_summary(turn_context.assistant_text or '', 240) if turn_context.assistant_text else None})
            await self.db.insert_memory(memory, embedding_literal=vector_literal(embed_text(sanitized)))
            await self.db.update_memory_capture_job(job_id, 'completed', memory_id=memory.id)
            return CaptureResult(status='completed', job_id=job_id, memory_id=memory.id)
        except Exception as exc:
            logger.warning('Memory capture failed, continuing without memory: %s', exc)
            await self.db.update_memory_capture_job(job_id, 'failed', last_error=str(exc))
            await self.db.add_memory_audit('capture_failed', {'user_key': turn_context.user_key, 'error': str(exc)})
            return CaptureResult(status='failed', job_id=job_id, skipped_reason='capture_failed')

    async def forget(self, user_key: str, selector: dict[str, Any]) -> int:
        memory_ids = selector.get('memory_ids')
        query = selector.get('query')
        parsed_ids = []
        if isinstance(memory_ids, list):
            for value in memory_ids:
                try:
                    parsed_ids.append(uuid.UUID(str(value)))
                except ValueError:
                    continue
        return await self.db.forget_memories(user_key, memory_ids=parsed_ids or None, query=str(query).strip() if query else None)

    async def list(self, user_key: str, scope: str, limit: int) -> list[MemoryItem]:
        return await self.db.list_memories(user_key=user_key, scope=scope, limit=limit)

class Mem0MemoryProvider(MemoryProvider):

    def __init__(self, db: 'Database', config: AgentConfig):
        super().__init__(db, config)
        self.base_url = normalize_mem0_base_url(os.environ.get('MEM0_BASE_URL', 'https://api.mem0.ai'), allow_private=_truthy_env('OPENCLAW_AGENT_ALLOW_PRIVATE_MEM0_BASE_URL'))
        self.api_key = os.environ.get('MEM0_API_KEY', '').strip()
        self.org_id = os.environ.get('MEM0_ORG_ID', '').strip()
        self.project_id = os.environ.get('MEM0_PROJECT_ID', '').strip()

    def _headers(self) -> dict[str, str]:
        headers = {'Authorization': f'Token {self.api_key}', 'Content-Type': 'application/json'}
        if self.org_id:
            headers['X-Organization-Id'] = self.org_id
        if self.project_id:
            headers['X-Project-Id'] = self.project_id
        return headers

    async def recall(self, user_key: str, agent_id: uuid.UUID, query: str, limit: int) -> list[MemoryHit]:
        import httpx
        if not self.api_key:
            logger.warning('Mem0 provider selected but MEM0_API_KEY is not configured')
            return []
        if not self.base_url:
            logger.warning('Mem0 provider selected but MEM0_BASE_URL is not configured safely')
            return []
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                response = await client.post(f'{self.base_url}/v2/memories/search', headers=self._headers(), json={'query': query, 'limit': limit, 'filters': {'AND': [{'user_id': user_key}, {'agent_id': str(agent_id)}]}})
                response.raise_for_status()
                payload = response.json()
        except Exception as exc:
            logger.warning('Mem0 recall failed, continuing without memory: %s', exc)
            return []
        if not isinstance(payload, list):
            return []
        hits: list[MemoryHit] = []
        for item in payload:
            if not isinstance(item, dict):
                continue
            try:
                hits.append(MemoryHit(id=uuid.UUID(str(item.get('id') or uuid.uuid4())), user_key=user_key, content=str(item.get('memory') or ''), summary=build_memory_summary(str(item.get('memory') or '')), content_sha256=hashlib.sha256(str(item.get('memory') or '').encode('utf-8')).hexdigest(), metadata=dict(item.get('metadata') or {}), similarity=float(item.get('score') or 0.0)))
            except Exception:
                continue
        return hits

    async def capture(self, turn_context: TurnContext) -> CaptureResult:
        import httpx
        if not self.api_key:
            return CaptureResult(status='disabled', skipped_reason='missing_mem0_api_key')
        if not self.base_url:
            return CaptureResult(status='disabled', skipped_reason='unsafe_mem0_base_url')
        sanitized = sanitize_memory_text(turn_context.user_text)
        if not sanitized:
            return CaptureResult(status='skipped', skipped_reason='sensitive_or_empty')
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                response = await client.post(f'{self.base_url}/v1/memories/', headers=self._headers(), json={'messages': [{'role': 'user', 'content': sanitized}, {'role': 'assistant', 'content': turn_context.assistant_text or ''}], 'user_id': turn_context.user_key, 'agent_id': str(turn_context.agent_id), 'metadata': turn_context.metadata})
                response.raise_for_status()
                payload = response.json()
        except Exception as exc:
            logger.warning('Mem0 capture failed, continuing without memory: %s', exc)
            return CaptureResult(status='failed', skipped_reason='capture_failed')
        memory_id = None
        if isinstance(payload, dict) and payload.get('id'):
            try:
                memory_id = uuid.UUID(str(payload['id']))
            except ValueError:
                memory_id = None
        return CaptureResult(status='completed', memory_id=memory_id)

    async def forget(self, user_key: str, selector: dict[str, Any]) -> int:
        import httpx
        if not self.api_key:
            return 0
        if not self.base_url:
            return 0
        memory_id = selector.get('memory_id')
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                if memory_id:
                    response = await client.delete(f'{self.base_url}/v1/memories/{memory_id}', headers=self._headers())
                else:
                    response = await client.delete(f'{self.base_url}/v1/memories', headers=self._headers(), params={'user_id': user_key})
                response.raise_for_status()
        except Exception as exc:
            logger.warning('Mem0 forget failed: %s', exc)
            return 0
        return 1

    async def list(self, user_key: str, scope: str, limit: int) -> list[MemoryItem]:
        import httpx
        if not self.api_key:
            return []
        if not self.base_url:
            return []
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                response = await client.post(f'{self.base_url}/v2/memories', headers=self._headers(), json={'filters': {'user_id': user_key}, 'limit': limit})
                response.raise_for_status()
                payload = response.json()
        except Exception as exc:
            logger.warning('Mem0 list failed: %s', exc)
            return []
        if not isinstance(payload, list):
            return []
        items: list[MemoryItem] = []
        for row in payload:
            if not isinstance(row, dict):
                continue
            items.append(MemoryItem(id=uuid.UUID(str(row.get('id') or uuid.uuid4())), user_key=user_key, scope=MemoryScope.LONG_TERM, content=str(row.get('memory') or ''), summary=build_memory_summary(str(row.get('memory') or '')), content_sha256=hashlib.sha256(str(row.get('memory') or '').encode('utf-8')).hexdigest(), metadata=dict(row.get('metadata') or {})))
        return items

def create_memory_provider(db: 'Database', config: AgentConfig) -> MemoryProvider:
    if not config.memory_enabled or config.memory_provider == MemoryProviderKind.NONE:
        return NullMemoryProvider(db, config)
    if config.memory_provider == MemoryProviderKind.MEM0:
        return Mem0MemoryProvider(db, config)
    return SupabaseMemoryProvider(db, config)
