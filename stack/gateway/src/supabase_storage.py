"""
Minimal Supabase Storage client for uploading inbound media.
"""

from __future__ import annotations

import json
import os
import re
import uuid
from typing import Any
from urllib.parse import quote

import httpx


def _safe_filename(filename: str, fallback_ext: str = "") -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", filename).strip("-")
    if not cleaned:
        cleaned = f"file{fallback_ext}"
    return cleaned


class SupabaseStorageClient:
    def __init__(
        self,
        *,
        url: str,
        service_role_key: str,
        bucket: str = "agent-files",
        deploy_id: str = "local",
    ) -> None:
        self.url = url.rstrip("/")
        self.service_role_key = service_role_key.strip()
        self.bucket = bucket
        self.deploy_id = deploy_id
        self._bucket_ready = False

    @property
    def enabled(self) -> bool:
        return bool(self.url and self.service_role_key)

    async def ensure_bucket(self) -> None:
        if not self.enabled or self._bucket_ready:
            return

        headers = {
            "Authorization": f"Bearer {self.service_role_key}",
            "apikey": self.service_role_key,
            "Content-Type": "application/json",
        }
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"{self.url}/storage/v1/bucket",
                headers=headers,
                json={
                    "id": self.bucket,
                    "name": self.bucket,
                    "public": False,
                },
            )
        if response.status_code not in (200, 201, 409):
            response.raise_for_status()
        self._bucket_ready = True

    async def upload_bytes(
        self,
        *,
        channel_type: str,
        chat_id: str,
        filename: str,
        content: bytes,
        content_type: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if not self.enabled:
            raise RuntimeError("Supabase Storage is not configured")

        await self.ensure_bucket()

        _, ext = os.path.splitext(filename)
        safe_name = _safe_filename(filename, ext)
        object_path = (
            f"{self.deploy_id}/{channel_type}/{chat_id}/"
            f"{uuid.uuid4()}-{safe_name}"
        )
        headers = {
            "Authorization": f"Bearer {self.service_role_key}",
            "apikey": self.service_role_key,
            "x-upsert": "true",
            "Content-Type": content_type or "application/octet-stream",
        }
        if metadata:
            headers["x-metadata"] = json.dumps(metadata)

        async with httpx.AsyncClient(timeout=120) as client:
            response = await client.post(
                f"{self.url}/storage/v1/object/{self.bucket}/{quote(object_path, safe='/')}",
                headers=headers,
                content=content,
            )
        response.raise_for_status()

        return {
            "bucket": self.bucket,
            "storage_path": object_path,
            "content_type": content_type or "application/octet-stream",
            "size_bytes": len(content),
        }
