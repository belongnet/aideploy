import unittest

from src.normalizer import (
    normalize_slack,
    normalize_telegram,
    normalize_whatsapp,
)


class TelegramNormalizerTest(unittest.TestCase):
    def test_preserves_sender_and_attachment_metadata(self) -> None:
        normalized = normalize_telegram(
            {
                "update_id": 10,
                "message": {
                    "message_id": 42,
                    "caption": "here is the file",
                    "chat": {"id": -1001, "type": "supergroup", "title": "Ops Room"},
                    "from": {
                        "id": 77,
                        "first_name": "Alice",
                        "last_name": "Ng",
                        "language_code": "en",
                    },
                    "document": {
                        "file_id": "tg-file",
                        "file_unique_id": "uniq-1",
                        "file_name": "incident.txt",
                        "mime_type": "text/plain",
                        "file_size": 123,
                    },
                },
            }
        )

        self.assertIsNotNone(normalized)
        self.assertEqual(normalized.text, "here is the file")
        self.assertEqual(normalized.metadata["sender_id"], "77")
        self.assertEqual(normalized.metadata["user_id"], "77")
        self.assertEqual(normalized.metadata["chat_title"], "Ops Room")
        self.assertEqual(normalized.metadata["language_code"], "en")
        self.assertEqual(normalized.metadata["attachments"][0]["file_id"], "tg-file")


class WhatsAppNormalizerTest(unittest.TestCase):
    def test_builds_media_attachment_descriptors(self) -> None:
        normalized = normalize_whatsapp(
            {
                "entry": [
                    {
                        "changes": [
                            {
                                "value": {
                                    "metadata": {"phone_number_id": "phone-1"},
                                    "contacts": [
                                        {"profile": {"name": "Pat"}}
                                    ],
                                    "messages": [
                                        {
                                            "id": "wamid-1",
                                            "from": "15551234567",
                                            "timestamp": "1710000000",
                                            "type": "image",
                                            "context": {"id": "wamid-parent"},
                                            "image": {
                                                "id": "media-1",
                                                "mime_type": "image/jpeg",
                                                "caption": "diagram",
                                            },
                                        }
                                    ],
                                }
                            }
                        ]
                    }
                ]
            }
        )

        self.assertIsNotNone(normalized)
        self.assertEqual(normalized.text, "diagram")
        self.assertEqual(normalized.metadata["sender_id"], "15551234567")
        self.assertEqual(normalized.metadata["reply_to_message_id"], "wamid-parent")
        self.assertEqual(normalized.metadata["attachments"][0]["media_id"], "media-1")


class SlackNormalizerTest(unittest.TestCase):
    def test_accepts_file_share_messages_without_text(self) -> None:
        normalized = normalize_slack(
            {
                "team_id": "T1",
                "event": {
                    "type": "message",
                    "subtype": "file_share",
                    "channel": "C1",
                    "user": "U1",
                    "ts": "1710000000.123",
                    "files": [
                        {
                            "id": "F1",
                            "name": "plan.pdf",
                            "mimetype": "application/pdf",
                            "size": 456,
                            "url_private": "https://files.slack.test/plan.pdf",
                        }
                    ],
                },
            }
        )

        self.assertIsNotNone(normalized)
        self.assertEqual(normalized.text, "[plan.pdf]")
        self.assertEqual(normalized.metadata["user_id"], "U1")
        self.assertEqual(normalized.metadata["attachments"][0]["download_url"], "https://files.slack.test/plan.pdf")


if __name__ == "__main__":
    unittest.main()
