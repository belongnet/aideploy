import asyncio
import unittest
from unittest.mock import AsyncMock, Mock, patch

from src.normalizer import NormalizedMessage
from src.router import _upload_provider_attachments, telegram_webhook


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


class _FakeRequest:
    def __init__(self, payload: dict[str, object], headers: dict[str, str] | None = None) -> None:
        self._payload = payload
        self.headers = headers or {"X-Telegram-Bot-Api-Secret-Token": ""}

    async def json(self) -> dict[str, object]:
        return self._payload


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


class TelegramWebhookTest(unittest.IsolatedAsyncioTestCase):
    async def test_acknowledges_my_chat_member_updates_without_forwarding(self) -> None:
        fake_adapter = Mock()
        fake_adapter.verify_secret_token.return_value = True
        fake_adapter.validate_update.return_value = True

        payload = {
            "update_id": 1,
            "my_chat_member": {
                "new_chat_member": {"status": "member"},
                "chat": {"id": 123, "type": "private"},
            },
        }

        with (
            patch("src.router.DEPLOY_ID", "local"),
            patch("src.router.telegram_adapter", fake_adapter),
            patch("src.router.forward_to_agent", new=AsyncMock()) as forward_to_agent,
        ):
            response = await telegram_webhook("local", _FakeRequest(payload))

        self.assertEqual(response, {"ok": True})
        fake_adapter.normalize.assert_not_called()
        forward_to_agent.assert_not_awaited()

    async def test_schedules_telegram_acknowledgements_before_sending_reply(self) -> None:
        normalized = NormalizedMessage(
            channel_type="telegram",
            channel_id="chat-1",
            chat_id="chat-1",
            sender_name="Alice",
            text="Hello",
            metadata={"message_id": "99", "attachments": []},
        )

        fake_adapter = Mock()
        fake_adapter.verify_secret_token.return_value = True
        fake_adapter.validate_update.return_value = True
        fake_adapter.normalize.return_value = normalized

        fake_dispatcher = Mock()
        fake_dispatcher.set_telegram_reaction = AsyncMock(return_value=True)
        fake_dispatcher.send_telegram_chat_action = AsyncMock(return_value=True)
        fake_dispatcher.send = AsyncMock(return_value=123)

        payload = {
            "update_id": 1,
            "message": {
                "message_id": 99,
                "chat": {"id": 123, "type": "private"},
                "from": {"id": 77, "first_name": "Alice"},
                "text": "Hello",
            },
        }

        with (
            patch("src.router.DEPLOY_ID", "local"),
            patch("src.router.telegram_adapter", fake_adapter),
            patch("src.router.telegram_setup", None),
            patch("src.router.dispatcher", fake_dispatcher),
            patch(
                "src.router.prepare_incoming_message",
                new=AsyncMock(return_value={"prepared": True}),
            ) as prepare_incoming_message,
            patch(
                "src.router.forward_to_agent",
                new=AsyncMock(return_value="Done"),
            ) as forward_to_agent,
        ):
            response = await telegram_webhook("local", _FakeRequest(payload))
            await asyncio.sleep(0)

        self.assertEqual(response, {"ok": True})
        prepare_incoming_message.assert_awaited_once_with(normalized)
        forward_to_agent.assert_awaited_once_with({"prepared": True})
        fake_dispatcher.set_telegram_reaction.assert_awaited_once_with("chat-1", "99")
        fake_dispatcher.send_telegram_chat_action.assert_awaited_once_with("chat-1")
        fake_dispatcher.send.assert_awaited_once_with(
            "telegram",
            "chat-1",
            "Done",
            normalized.metadata,
        )


if __name__ == "__main__":
    unittest.main()
