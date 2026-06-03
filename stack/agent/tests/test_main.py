import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

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
    _build_infrastructure_context,
    _build_provider_switch_reply,
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
class ClaudeSetupInstructionsTest(unittest.IsolatedAsyncioTestCase):
    async def test_provider_switch_reply_uses_browser_flow_and_proxy(self) -> None:
        config = SimpleNamespace(
            agent_name="Kyle",
            model="gpt-5.5",
            model_provider=SimpleNamespace(value="openai"),
        )

        with patch(
            "src.main._resolve_dashboard_setup_url",
            AsyncMock(return_value="https://dashboard.example/setup"),
        ):
            reply = await _build_provider_switch_reply("anthropic", config)

        self.assertIn('Press "New Browser Link" under Claude', reply)
        self.assertIn("local billing proxy", reply)
        self.assertIn("Do not use ACP", reply)

    async def test_infrastructure_context_explains_claude_proxy_constraints(self) -> None:
        config = SimpleNamespace(
            agent_name="Kyle",
            model="gpt-5.5",
            model_provider=SimpleNamespace(value="openai"),
        )

        with patch(
            "src.main._resolve_dashboard_setup_url",
            AsyncMock(return_value="https://dashboard.example/setup"),
        ):
            context = await _build_infrastructure_context(config)

        self.assertIn(
            "Claude on this deployment is connected from the dashboard browser flow, not ACP or Claude Code plugins",
            context,
        )
        self.assertIn(
            "gateway's local Anthropic billing proxy",
            context,
        )
        self.assertIn(
            "Never tell users to enable ACP, install acpx/runtime plugins, or paste Anthropic API keys in chat",
            context,
        )

if __name__ == "__main__":
    unittest.main()
