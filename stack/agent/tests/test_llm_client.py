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

from src.llm_client import _extract_system_instruction


class PromptExtractionTest(unittest.TestCase):
    def test_preserves_all_system_messages_in_order(self) -> None:
        instructions, chat_messages = _extract_system_instruction(
            [
                {"role": "system", "content": "Base prompt"},
                {"role": "system", "content": "Infrastructure rules"},
                {"role": "user", "content": "hello"},
                {"role": "system", "content": "Memory facts"},
            ]
        )

        self.assertEqual(
            instructions,
            "Base prompt\n\nInfrastructure rules\n\nMemory facts",
        )
        self.assertEqual(chat_messages, [{"role": "user", "content": "hello"}])

    def test_ignores_blank_system_messages(self) -> None:
        instructions, chat_messages = _extract_system_instruction(
            [
                {"role": "system", "content": "   "},
                {"role": "assistant", "content": "prior reply"},
            ]
        )

        self.assertIsNone(instructions)
        self.assertEqual(
            chat_messages,
            [{"role": "assistant", "content": "prior reply"}],
        )


if __name__ == "__main__":
    unittest.main()
