import unittest
from unittest.mock import AsyncMock, patch

from src.router import _upload_provider_attachments


class _FakeStorageClient:
    def __init__(self) -> None:
        self.enabled = True
        self.bucket = "agent-files"
        self.calls: list[dict[str, object]] = []

    async def upload_bytes(self, **kwargs):
        self.calls.append(kwargs)
        return {
            "bucket": self.bucket,
            "storage_path": "local/telegram/chat/file.jpg",
            "content_type": kwargs.get("content_type") or "application/octet-stream",
            "size_bytes": len(kwargs["content"]),
        }


class RouterAttachmentUploadTest(unittest.IsolatedAsyncioTestCase):
    async def test_uploads_downloaded_attachment_to_supabase_storage(self) -> None:
        fake_storage = _FakeStorageClient()
        metadata = {
            "attachments": [
                {
                    "provider": "telegram",
                    "kind": "photo",
                    "file_id": "tg-1",
                    "original_name": "photo.jpg",
                }
            ]
        }

        with (
            patch("src.router.storage_client", fake_storage),
            patch(
                "src.router._download_provider_attachment",
                new=AsyncMock(return_value=(b"abc", "image/jpeg", "photo.jpg")),
            ),
        ):
            enriched = await _upload_provider_attachments(
                "telegram",
                "chat-1",
                metadata,
            )

        self.assertEqual(fake_storage.calls[0]["channel_type"], "telegram")
        self.assertEqual(fake_storage.calls[0]["chat_id"], "chat-1")
        self.assertEqual(enriched["attachments"][0]["bucket"], "agent-files")
        self.assertEqual(
            enriched["attachments"][0]["storage_path"],
            "local/telegram/chat/file.jpg",
        )
        self.assertEqual(enriched["attachments"][0]["size_bytes"], 3)

    async def test_sanitizes_upload_failures(self) -> None:
        fake_storage = _FakeStorageClient()
        metadata = {
            "attachments": [
                {
                    "provider": "telegram",
                    "kind": "document",
                    "file_id": "tg-2",
                    "original_name": "notes.txt",
                }
            ]
        }

        with (
            patch("src.router.storage_client", fake_storage),
            patch(
                "src.router._download_provider_attachment",
                new=AsyncMock(side_effect=RuntimeError("sensitive bot token")),
            ),
        ):
            enriched = await _upload_provider_attachments(
                "telegram",
                "chat-1",
                metadata,
            )

        self.assertEqual(
            enriched["attachments"][0]["upload_error"],
            "attachment_upload_failed",
        )
        self.assertNotIn("sensitive bot token", str(enriched))


if __name__ == "__main__":
    unittest.main()
