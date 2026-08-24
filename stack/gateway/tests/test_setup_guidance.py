import unittest
from unittest.mock import Mock

from src.telegram_setup import TelegramSetupManager
from src.whatsapp_setup import WhatsAppSetupManager


class TelegramSetupGuidanceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.manager = TelegramSetupManager(
            dispatcher=Mock(),
            telegram_bot_token="bot-token",
            agent_url="http://agent",
            dashboard_internal_url="http://dashboard",
            service_token="service-token",
        )

    def test_provider_prompt_warns_against_messenger_browser(self) -> None:
        prompt = self.manager._provider_prompt_text(
            "openai",
            {"url": "https://auth.example/login"},
            {"dashboardSetupUrl": "https://dashboard.example/setup"},
        )

        self.assertIn("Safari, Chrome, or your normal desktop browser", prompt)
        self.assertIn("Do not open it inside Telegram", prompt)
        self.assertIn("Messenger browsers cannot finish this login", prompt)
        self.assertIn("ChatGPT's final localhost URL will not appear there", prompt)
        self.assertIn("copy the full localhost URL or code from that browser", prompt)
        self.assertNotIn("Open Login", prompt)
    def test_provider_keyboard_does_not_include_oauth_url_button(self) -> None:
        keyboard = self.manager._provider_keyboard(
            "https://dashboard.example/setup",
            oauth_url="https://auth.example/login",
        )
        rows = keyboard["inline_keyboard"]

        self.assertEqual(rows[0], [{"text": "Cancel", "callback_data": "ocai:cancel"}])
        self.assertEqual(
            rows[1],
            [{"text": "Open Dashboard", "url": "https://dashboard.example/setup"}],
        )
        self.assertNotIn("https://auth.example/login", str(keyboard))
        self.assertNotIn("Open Login", str(keyboard))


class WhatsAppSetupGuidanceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.manager = WhatsAppSetupManager(
            dispatcher=Mock(),
            agent_url="http://agent",
            dashboard_internal_url="http://dashboard",
            service_token="service-token",
        )

    def test_provider_prompt_warns_against_messenger_browser(self) -> None:
        prompt = self.manager._provider_prompt_text(
            "openai",
            {"url": "https://auth.example/login"},
            {"dashboardSetupUrl": "https://dashboard.example/setup"},
        )

        self.assertIn("Safari, Chrome, or your normal desktop browser", prompt)
        self.assertIn("Do not open it inside WhatsApp", prompt)
        self.assertIn("Messenger browsers cannot finish this login", prompt)
        self.assertIn("ChatGPT's final localhost URL will not appear there", prompt)
        self.assertIn("copy the full localhost URL or code from that browser", prompt)
        self.assertNotIn("Open Login", prompt)
