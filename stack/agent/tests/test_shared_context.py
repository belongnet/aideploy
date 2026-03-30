from datetime import datetime, timezone
import unittest

from src.shared_context import build_shared_context_prompt


class SharedContextPromptTest(unittest.TestCase):
    def test_formats_recent_cross_agent_context(self) -> None:
        prompt = build_shared_context_prompt(
            [
                {
                    "message_role": "user",
                    "sender_name": "Alice",
                    "content": "Can someone summarize the last deploy?",
                    "created_at": datetime(2026, 3, 31, 8, 15, tzinfo=timezone.utc),
                },
                {
                    "message_role": "assistant",
                    "agent_name": "Ops Agent",
                    "content": "",
                    "attachments": [
                        {
                            "kind": "document",
                            "original_name": "deploy-report.pdf",
                        }
                    ],
                    "created_at": datetime(2026, 3, 31, 8, 16, tzinfo=timezone.utc),
                },
            ]
        )

        self.assertIn("Recent shared chat context", prompt)
        self.assertIn("08:15 Alice (user): Can someone summarize the last deploy?", prompt)
        self.assertIn("Ops Agent (agent): [Attachment]", prompt)
        self.assertIn("attachments: document:deploy-report.pdf", prompt)

    def test_returns_empty_string_when_nothing_is_renderable(self) -> None:
        prompt = build_shared_context_prompt(
            [{"message_role": "user", "content": "   ", "attachments": []}]
        )
        self.assertEqual(prompt, "")


if __name__ == "__main__":
    unittest.main()
