import sys
from types import SimpleNamespace
import unittest

sys.modules.setdefault(
    "asyncpg",
    SimpleNamespace(
        Pool=object,
        Connection=object,
        create_pool=None,
        connect=None,
    ),
)
sys.modules.setdefault("apscheduler", SimpleNamespace())
sys.modules.setdefault("apscheduler.schedulers", SimpleNamespace())
sys.modules.setdefault(
    "apscheduler.schedulers.asyncio",
    SimpleNamespace(AsyncIOScheduler=object),
)

from src.main import (
    _filter_transient_setup_history,
    _is_provider_switch_intent,
    _is_transient_setup_message,
    _looks_like_localhost_redirect,
)
from src.models import Message, MessageRole


class ProviderSwitchIntentTest(unittest.TestCase):
    def test_detects_explicit_switch_command(self) -> None:
        self.assertEqual(
            _is_provider_switch_intent("switch to claude", "openai"),
            "anthropic",
        )
        self.assertEqual(
            _is_provider_switch_intent("please use claude instead", "openai"),
            "anthropic",
        )

    def test_ignores_comparison_questions(self) -> None:
        self.assertIsNone(
            _is_provider_switch_intent(
                "Should I use Claude or ChatGPT for coding?",
                "openai",
            )
        )
        self.assertIsNone(
            _is_provider_switch_intent(
                "Can you compare Gemini and Claude for long context?",
                "openai",
            )
        )


class SetupArtifactFilterTest(unittest.TestCase):
    def test_detects_localhost_redirects(self) -> None:
        self.assertTrue(
            _looks_like_localhost_redirect(
                "http://localhost:1455/auth/callback?code=abc&state=xyz"
            )
        )
        self.assertFalse(
            _looks_like_localhost_redirect(
                "Should I use ChatGPT or Claude?"
            )
        )

    def test_marks_only_setup_artifacts_as_transient(self) -> None:
        self.assertTrue(
            _is_transient_setup_message(
                MessageRole.USER,
                "connect chatgpt",
            )
        )
        self.assertTrue(
            _is_transient_setup_message(
                MessageRole.ASSISTANT,
                "ChatGPT is now connected. Send a message to start chatting.",
            )
        )
        self.assertFalse(
            _is_transient_setup_message(
                MessageRole.USER,
                "Can you explain what OAuth state is?",
            )
        )

    def test_filters_setup_messages_out_of_history(self) -> None:
        history = _filter_transient_setup_history(
            [
                Message(
                    conversation_id="00000000-0000-0000-0000-000000000001",
                    role=MessageRole.USER,
                    content="connect chatgpt",
                ),
                Message(
                    conversation_id="00000000-0000-0000-0000-000000000001",
                    role=MessageRole.ASSISTANT,
                    content="Open this link to sign in to ChatGPT, then paste the final redirect URL back here:",
                ),
                Message(
                    conversation_id="00000000-0000-0000-0000-000000000001",
                    role=MessageRole.USER,
                    content="yoyo",
                ),
            ]
        )

        self.assertEqual(len(history), 1)
        self.assertEqual(history[0].content, "yoyo")


if __name__ == "__main__":
    unittest.main()
