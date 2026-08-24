"""
OpenClaw Agent — Knowledge providers.

QMD is treated as an optional local knowledge source for docs and notes.
It is never the canonical user-memory system.
"""

from __future__ import annotations

import asyncio
import logging
import os
from abc import ABC, abstractmethod
from pathlib import Path

from .models import AgentConfig, KnowledgeHit, KnowledgeProviderKind

logger = logging.getLogger(__name__)


def build_knowledge_prompt(hits: list[KnowledgeHit]) -> str | None:
    if not hits:
        return None
    lines = [
        "Supplemental local knowledge search results. Use them only if they help answer accurately.",
    ]
    for hit in hits:
        lines.append(f"- [{hit.source}] {hit.title}: {hit.snippet}")
    return "\n".join(lines)


class KnowledgeProvider(ABC):
    def __init__(self, config: AgentConfig):
        self.config = config

    @abstractmethod
    async def search(self, query: str, scope: str, limit: int) -> list[KnowledgeHit]:
        ...


class NullKnowledgeProvider(KnowledgeProvider):
    async def search(self, query: str, scope: str, limit: int) -> list[KnowledgeHit]:
        return []


class QmdKnowledgeProvider(KnowledgeProvider):
    def __init__(self, config: AgentConfig):
        super().__init__(config)
        self.qmd_command = os.environ.get("OPENCLAW_QMD_COMMAND", "qmd")
        self.qmd_base_url = os.environ.get("OPENCLAW_QMD_BASE_URL", "").rstrip("/")
        self._indexed = False
        self._lock = asyncio.Lock()

    async def _run_qmd(self, *args: str) -> tuple[int, str, str]:
        process = await asyncio.create_subprocess_exec(
            self.qmd_command,
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate()
        return process.returncode, stdout.decode("utf-8"), stderr.decode("utf-8")

    async def _ensure_index(self) -> None:
        if self._indexed:
            return
        async with self._lock:
            if self._indexed:
                return

            repo_root = Path(os.environ.get("OPENCLAW_QMD_REPO_ROOT", os.getcwd()))
            candidate_paths = [
                ("repo", repo_root),
                ("docs", repo_root / "docs"),
            ]
            extra_paths = [
                Path(value).expanduser()
                for value in os.environ.get("OPENCLAW_QMD_EXTRA_PATHS", "").split(",")
                if value.strip()
            ]
            for index, extra_path in enumerate(extra_paths, start=1):
                candidate_paths.append((f"extra-{index}", extra_path))

            for name, path in candidate_paths:
                if not path.exists():
                    continue
                code, _, stderr = await self._run_qmd(
                    "collection",
                    "add",
                    str(path),
                    "--name",
                    name,
                )
                if code != 0 and "already" not in stderr.lower():
                    logger.warning("QMD collection add failed for %s: %s", path, stderr.strip())

            code, _, stderr = await self._run_qmd("embed")
            if code != 0 and "nothing to embed" not in stderr.lower():
                logger.warning("QMD embed failed: %s", stderr.strip())
            self._indexed = True

    async def search(self, query: str, scope: str, limit: int) -> list[KnowledgeHit]:
        if not query.strip():
            return []
        if self.qmd_base_url:
            try:
                import httpx

                async with httpx.AsyncClient(timeout=15) as client:
                    response = await client.get(
                        f"{self.qmd_base_url}/query",
                        params={"q": query, "limit": limit},
                    )
                    response.raise_for_status()
                    payload = response.json()
            except Exception as exc:
                logger.warning("QMD sidecar query failed: %s", exc)
                return []
            if not isinstance(payload, dict):
                return []
            items = payload.get("items")
            if not isinstance(items, list):
                return []
            hits: list[KnowledgeHit] = []
            for item in items[:limit]:
                if not isinstance(item, dict):
                    continue
                hits.append(
                    KnowledgeHit(
                        source="qmd",
                        title=str(item.get("title") or "Local knowledge query"),
                        snippet=str(item.get("snippet") or ""),
                        metadata=dict(item.get("metadata") or {}),
                    )
                )
            return hits

        await self._ensure_index()

        # QMD's plain-text query mode is stable enough for local operator use.
        code, stdout, stderr = await self._run_qmd("query", query)
        if code != 0:
            logger.warning("QMD query failed: %s", stderr.strip())
            return []

        lines = [line.strip() for line in stdout.splitlines() if line.strip()]
        if not lines:
            return []
        snippet = " ".join(lines[: min(len(lines), 8)])
        return [
            KnowledgeHit(
                source="qmd",
                title="Local knowledge query",
                snippet=snippet[:1000],
                metadata={
                    "scope": scope,
                    "configured_collections": self.config.knowledge_collections,
                },
            )
        ]


def create_knowledge_provider(config: AgentConfig) -> KnowledgeProvider:
    if config.knowledge_provider == KnowledgeProviderKind.QMD:
        return QmdKnowledgeProvider(config)
    return NullKnowledgeProvider(config)
