import asyncio
import hashlib
import hmac
import json
import unittest
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException

from src.adapters.slack import SlackAdapter
from src.adapters.telegram import TelegramAdapter
from src.adapters.whatsapp import WhatsAppAdapter
from src.normalizer import NormalizedMessage
from src.router import (
    _download_slack_attachment,
    _download_whatsapp_attachment,
    _is_allowed_slack_file_url,
    _require_internal_auth,
    _upload_provider_attachments,
    slack_webhook,
    telegram_webhook,
    whatsapp_webhook,
    whatsapp_verify,
)


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
    def __init__(
        self,
        payload: dict[str, object],
        headers: dict[str, str] | None = None,
        raw_body: bytes | None = None,
    ) -> None:
        self._payload = payload
        self.headers = (
            headers
            if headers is not None
            else {"X-Telegram-Bot-Api-Secret-Token": ""}
        )
        self._raw_body = raw_body
        self.query_params: dict[str, str] = {}

    async def json(self) -> dict[str, object]:
        return self._payload

    async def body(self) -> bytes:
        if self._raw_body is not None:
            return self._raw_body
        return json.dumps(self._payload).encode("utf-8")


class _FakeDownloadResponse:
    def __init__(
        self,
        payload: dict[str, object] | None = None,
        *,
        content: bytes = b"",
        headers: dict[str, str] | None = None,
        status_code: int = 200,
    ) -> None:
        self._payload = payload or {}
        self.content = content
        self.headers = headers or {}
        self.status_code = status_code

    def json(self) -> dict[str, object]:
        return self._payload

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError("request failed")


class _FakeDownloadClient:
    def __init__(self, responses: list[_FakeDownloadResponse]) -> None:
        self.responses = responses
        self.calls: list[dict[str, object]] = []

    async def get(self, url: str, **kwargs):
        self.calls.append({"url": url, "kwargs": kwargs})
        return self.responses.pop(0)


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

    async def test_downloads_whatsapp_media_only_from_meta_media_hosts(self) -> None:
        client = _FakeDownloadClient(
            [
                _FakeDownloadResponse(
                    {
                        "url": "https://lookaside.fbsbx.com/whatsapp_business/attachments/file",
                        "mime_type": "image/jpeg",
                    }
                ),
                _FakeDownloadResponse(
                    content=b"image-bytes",
                    headers={"content-type": "image/jpeg"},
                ),
            ]
        )

        with patch("src.router.WHATSAPP_ACCESS_TOKEN", "wa-token"):
            content, content_type, filename = await _download_whatsapp_attachment(
                client,
                {
                    "media_id": "media-1",
                    "kind": "image",
                    "original_name": "photo.jpg",
                },
            )

        self.assertEqual(content, b"image-bytes")
        self.assertEqual(content_type, "image/jpeg")
        self.assertEqual(filename, "photo.jpg")
        self.assertEqual(
            client.calls[1]["kwargs"]["headers"]["Authorization"],
            "Bearer wa-token",
        )

    async def test_refuses_whatsapp_media_url_before_sending_token(self) -> None:
        client = _FakeDownloadClient(
            [
                _FakeDownloadResponse(
                    {
                        "url": "https://attacker.example/download",
                        "mime_type": "image/jpeg",
                    }
                )
            ]
        )

        with patch("src.router.WHATSAPP_ACCESS_TOKEN", "wa-token"):
            with self.assertRaisesRegex(RuntimeError, "non-Meta media URL"):
                await _download_whatsapp_attachment(
                    client,
                    {
                        "media_id": "media-1",
                        "kind": "image",
                    },
                )

        self.assertEqual(len(client.calls), 1)

    async def test_refuses_whatsapp_media_redirect_before_resending_token(self) -> None:
        client = _FakeDownloadClient(
            [
                _FakeDownloadResponse(
                    {
                        "url": "https://lookaside.fbsbx.com/whatsapp_business/attachments/file",
                        "mime_type": "image/jpeg",
                    }
                ),
                _FakeDownloadResponse(
                    status_code=302,
                    headers={"location": "https://attacker.example/download"},
                ),
            ]
        )

        with patch("src.router.WHATSAPP_ACCESS_TOKEN", "wa-token"):
            with self.assertRaisesRegex(RuntimeError, "untrusted URL"):
                await _download_whatsapp_attachment(
                    client,
                    {
                        "media_id": "media-1",
                        "kind": "image",
                    },
                )

        self.assertEqual(len(client.calls), 2)
        self.assertEqual(
            client.calls[1]["kwargs"]["headers"]["Authorization"],
            "Bearer wa-token",
        )
        self.assertFalse(client.responses)

    async def test_downloads_slack_file_only_from_slack_files_host(self) -> None:
        client = _FakeDownloadClient(
            [
                _FakeDownloadResponse(
                    content=b"file-bytes",
                    headers={"content-type": "text/plain"},
                )
            ]
        )

        with patch("src.router.SLACK_BOT_TOKEN", "xoxb-token"):
            content, content_type, filename = await _download_slack_attachment(
                client,
                {
                    "download_url": "https://files.slack.com/files-pri/T123-F123/download/report.txt",
                    "kind": "document",
                    "original_name": "report.txt",
                },
            )

        self.assertEqual(content, b"file-bytes")
        self.assertEqual(content_type, "text/plain")
        self.assertEqual(filename, "report.txt")
        self.assertEqual(
            client.calls[0]["kwargs"]["headers"]["Authorization"],
            "Bearer xoxb-token",
        )

    async def test_refuses_slack_lookalike_url_before_sending_token(self) -> None:
        client = _FakeDownloadClient([])

        with patch("src.router.SLACK_BOT_TOKEN", "xoxb-token"):
            with self.assertRaisesRegex(RuntimeError, "non-Slack URL"):
                await _download_slack_attachment(
                    client,
                    {
                        "download_url": "https://files.slack.com.evil.example/download",
                        "kind": "document",
                    },
                )

        self.assertEqual(client.calls, [])

    async def test_follows_slack_redirect_only_to_allowed_file_host(self) -> None:
        client = _FakeDownloadClient(
            [
                _FakeDownloadResponse(
                    status_code=302,
                    headers={"location": "/files-pri/T123-F123/download/next.txt"},
                ),
                _FakeDownloadResponse(
                    content=b"redirected-file",
                    headers={"content-type": "text/plain"},
                ),
            ]
        )

        with patch("src.router.SLACK_BOT_TOKEN", "xoxb-token"):
            content, content_type, filename = await _download_slack_attachment(
                client,
                {
                    "download_url": "https://files.slack.com/files-pri/T123-F123/download/report.txt",
                    "kind": "document",
                    "original_name": "report.txt",
                },
            )

        self.assertEqual(content, b"redirected-file")
        self.assertEqual(content_type, "text/plain")
        self.assertEqual(filename, "report.txt")
        self.assertEqual(len(client.calls), 2)
        self.assertEqual(
            client.calls[1]["url"],
            "https://files.slack.com/files-pri/T123-F123/download/next.txt",
        )
        self.assertEqual(
            client.calls[1]["kwargs"]["headers"]["Authorization"],
            "Bearer xoxb-token",
        )

    async def test_refuses_slack_redirect_before_resending_token(self) -> None:
        client = _FakeDownloadClient(
            [
                _FakeDownloadResponse(
                    status_code=302,
                    headers={"location": "https://attacker.example/download"},
                ),
            ]
        )

        with patch("src.router.SLACK_BOT_TOKEN", "xoxb-token"):
            with self.assertRaisesRegex(RuntimeError, "untrusted URL"):
                await _download_slack_attachment(
                    client,
                    {
                        "download_url": "https://files.slack.com/files-pri/T123-F123/download/report.txt",
                        "kind": "document",
                    },
                )

        self.assertEqual(len(client.calls), 1)
        self.assertFalse(client.responses)

    def test_slack_file_url_rejects_userinfo_and_non_https(self) -> None:
        self.assertTrue(
            _is_allowed_slack_file_url(
                "https://files.slack.com/files-pri/T123-F123/download/report.txt"
            )
        )
        self.assertFalse(
            _is_allowed_slack_file_url(
                "https://xoxb-token@files.slack.com/files-pri/T123-F123/download/report.txt"
            )
        )
        self.assertFalse(
            _is_allowed_slack_file_url(
                "http://files.slack.com/files-pri/T123-F123/download/report.txt"
            )
        )


class TelegramWebhookTest(unittest.IsolatedAsyncioTestCase):
    async def test_rejects_missing_telegram_webhook_secret(self) -> None:
        with (
            patch("src.router.DEPLOY_ID", "local"),
            patch("src.router.telegram_adapter", TelegramAdapter("bot-token", "")),
            self.assertRaises(HTTPException) as raised,
        ):
            await telegram_webhook(
                "local",
                _FakeRequest(
                    {},
                    headers={"X-Telegram-Bot-Api-Secret-Token": "anything"},
                ),
            )

        self.assertEqual(raised.exception.status_code, 503)

    async def test_rejects_missing_telegram_secret_header(self) -> None:
        with (
            patch("src.router.DEPLOY_ID", "local"),
            patch("src.router.telegram_adapter", TelegramAdapter("bot-token", "secret")),
            self.assertRaises(HTTPException) as raised,
        ):
            await telegram_webhook("local", _FakeRequest({}, headers={}))

        self.assertEqual(raised.exception.status_code, 401)

    async def test_rejects_oversized_telegram_webhook_body(self) -> None:
        with (
            patch("src.router.DEPLOY_ID", "local"),
            patch("src.router.MAX_REQUEST_BODY_BYTES", 2),
            patch("src.router.telegram_adapter", TelegramAdapter("bot-token", "secret")),
            self.assertRaises(HTTPException) as raised,
        ):
            await telegram_webhook(
                "local",
                _FakeRequest(
                    {},
                    headers={
                        "X-Telegram-Bot-Api-Secret-Token": "secret",
                        "Content-Length": "3",
                    },
                    raw_body=b"{}",
                ),
            )

        self.assertEqual(raised.exception.status_code, 413)

    async def test_acknowledges_my_chat_member_updates_without_forwarding(self) -> None:
        fake_adapter = Mock()
        fake_adapter.webhook_secret = "secret"
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
        fake_adapter.webhook_secret = "secret"
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


class WhatsAppWebhookTest(unittest.IsolatedAsyncioTestCase):
    async def test_get_verification_returns_challenge_for_matching_token(self) -> None:
        with (
            patch("src.router.DEPLOY_ID", "local"),
            patch(
                "src.router.whatsapp_adapter",
                WhatsAppAdapter("access-token", "verify-token", "phone-id", "app-secret"),
            ),
        ):
            response = await whatsapp_verify(
                "local",
                hub_mode="subscribe",
                hub_token="verify-token",
                hub_challenge="challenge-123",
            )

        self.assertEqual(response.body.decode("utf-8"), "challenge-123")
        self.assertEqual(response.media_type, "text/plain")

    async def test_get_verification_fails_closed_without_verify_token(self) -> None:
        with (
            patch("src.router.DEPLOY_ID", "local"),
            patch(
                "src.router.whatsapp_adapter",
                WhatsAppAdapter("access-token", "", "phone-id", "app-secret"),
            ),
            self.assertRaises(HTTPException) as raised,
        ):
            await whatsapp_verify(
                "local",
                hub_mode="subscribe",
                hub_token="openclaw-verify",
                hub_challenge="challenge-123",
            )

        self.assertEqual(raised.exception.status_code, 403)

    async def test_rejects_missing_whatsapp_app_secret(self) -> None:
        with (
            patch("src.router.DEPLOY_ID", "local"),
            patch(
                "src.router.whatsapp_adapter",
                WhatsAppAdapter("access-token", "verify-token", "phone-id", ""),
            ),
            self.assertRaises(HTTPException) as raised,
        ):
            await whatsapp_webhook(
                "local",
                _FakeRequest(
                    {"entry": [{"changes": [{"value": {"messages": [{}]}}]}]},
                    headers={"X-Hub-Signature-256": "sha256=anything"},
                ),
            )

        self.assertEqual(raised.exception.status_code, 503)

    async def test_signed_post_forwards_to_agent_and_replies(self) -> None:
        payload = {
            "entry": [
                {
                    "changes": [
                        {
                            "value": {
                                "metadata": {"phone_number_id": "phone-id"},
                                "contacts": [{"profile": {"name": "Maya"}}],
                                "messages": [
                                    {
                                        "id": "wamid-in",
                                        "from": "15551234567",
                                        "timestamp": "1710000000",
                                        "type": "text",
                                        "text": {"body": "Can you put Maya plus 2 on guestlist?"},
                                    }
                                ],
                            }
                        }
                    ]
                }
            ]
        }
        raw_body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        signature = "sha256=" + hmac.new(
            b"app-secret",
            raw_body,
            hashlib.sha256,
        ).hexdigest()
        fake_dispatcher = Mock()
        fake_dispatcher.send = AsyncMock()

        with (
            patch("src.router.DEPLOY_ID", "local"),
            patch(
                "src.router.whatsapp_adapter",
                WhatsAppAdapter("access-token", "verify-token", "phone-id", "app-secret"),
            ),
            patch("src.router.whatsapp_setup", None),
            patch("src.router.dispatcher", fake_dispatcher),
            patch(
                "src.router.prepare_incoming_message",
                new=AsyncMock(return_value={"prepared": True}),
            ) as prepare_incoming_message,
            patch(
                "src.router.forward_to_agent",
                new=AsyncMock(return_value="Review draft ready."),
            ) as forward_to_agent,
        ):
            response = await whatsapp_webhook(
                "local",
                _FakeRequest(
                    payload,
                    headers={"X-Hub-Signature-256": signature},
                    raw_body=raw_body,
                ),
            )

        self.assertEqual(response, {"status": "ok"})
        prepare_incoming_message.assert_awaited_once()
        forward_to_agent.assert_awaited_once_with({"prepared": True})
        fake_dispatcher.send.assert_awaited_once()
        self.assertEqual(fake_dispatcher.send.await_args.args[0], "whatsapp")
        self.assertEqual(fake_dispatcher.send.await_args.args[1], "15551234567")
        self.assertEqual(fake_dispatcher.send.await_args.args[2], "Review draft ready.")


class SlackWebhookTest(unittest.IsolatedAsyncioTestCase):
    async def test_rejects_url_verification_when_signing_secret_missing(self) -> None:
        with (
            patch("src.router.DEPLOY_ID", "local"),
            patch("src.router.slack_adapter", SlackAdapter("xoxb-token", "")),
            self.assertRaises(HTTPException) as raised,
        ):
            await slack_webhook(
                "local",
                _FakeRequest(
                    {"type": "url_verification", "challenge": "challenge-token"},
                    headers={
                        "X-Slack-Request-Timestamp": "123",
                        "X-Slack-Signature": "v0=anything",
                    },
                ),
            )

        self.assertEqual(raised.exception.status_code, 503)

    async def test_rejects_signed_malformed_json(self) -> None:
        fake_adapter = Mock()
        fake_adapter.signing_secret = "secret"
        fake_adapter.verify_signature.return_value = True

        with (
            patch("src.router.DEPLOY_ID", "local"),
            patch("src.router.slack_adapter", fake_adapter),
            self.assertRaises(HTTPException) as raised,
        ):
            await slack_webhook(
                "local",
                _FakeRequest(
                    {},
                    headers={
                        "X-Slack-Request-Timestamp": "123",
                        "X-Slack-Signature": "v0=anything",
                    },
                    raw_body=b"{not-json",
                ),
            )

        self.assertEqual(raised.exception.status_code, 400)


class InternalAuthTest(unittest.TestCase):
    def test_internal_auth_accepts_service_token_header(self) -> None:
        request = _FakeRequest(
            {},
            headers={"X-OpenClaw-Service-Token": "service-secret"},
        )
        with patch("src.router.AGENT_SERVICE_TOKEN", "service-secret"):
            _require_internal_auth(request)  # type: ignore[arg-type]

    def test_internal_auth_fails_closed_when_service_token_missing(self) -> None:
        request = _FakeRequest({})
        with patch("src.router.AGENT_SERVICE_TOKEN", ""):
            with self.assertRaises(HTTPException) as ctx:
                _require_internal_auth(request)  # type: ignore[arg-type]

        self.assertEqual(ctx.exception.status_code, 503)

    def test_internal_auth_rejects_service_token_query_param(self) -> None:
        request = _FakeRequest({})
        request.query_params["oc_service_token"] = "service-secret"
        with patch("src.router.AGENT_SERVICE_TOKEN", "service-secret"):
            with self.assertRaises(HTTPException) as ctx:
                _require_internal_auth(request)  # type: ignore[arg-type]

        self.assertEqual(ctx.exception.status_code, 401)


if __name__ == "__main__":
    unittest.main()
