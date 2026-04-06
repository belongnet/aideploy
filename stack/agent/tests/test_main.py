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

from src.main import _is_provider_switch_intent


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


if __name__ == "__main__":
    unittest.main()
