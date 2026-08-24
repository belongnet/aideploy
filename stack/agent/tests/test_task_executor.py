import socket
import sys
import unittest
from types import SimpleNamespace
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

from src.models import ActionType, Task, TriggerType
from src.task_executor import (
    TaskExecutor,
    sanitize_api_call_headers,
    validate_api_call_url,
)


def task_for_api_call(action_config: dict[str, object]) -> Task:
    return Task(
        name="Webhook",
        trigger_type=TriggerType.MANUAL,
        trigger_config={},
        action_type=ActionType.API_CALL,
        action_config=action_config,
    )


class ApiCallSecurityTest(unittest.IsolatedAsyncioTestCase):
    def test_validate_api_call_url_rejects_metadata_service_addresses(self) -> None:
        with patch(
            "src.task_executor.socket.getaddrinfo",
            return_value=[
                (socket.AF_INET, socket.SOCK_STREAM, 0, "", ("169.254.169.254", 80)),
            ],
        ):
            with self.assertRaisesRegex(ValueError, "private or reserved"):
                validate_api_call_url("http://metadata.google.internal/latest")

    def test_validate_api_call_url_accepts_public_resolved_addresses(self) -> None:
        with patch(
            "src.task_executor.socket.getaddrinfo",
            return_value=[
                (socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", 443)),
            ],
        ):
            self.assertEqual(
                validate_api_call_url("https://api.example.com/webhook"),
                "https://api.example.com/webhook",
            )

    def test_validate_api_call_url_allows_private_hosts_only_when_explicitly_allowlisted(self) -> None:
        with patch.dict(
            "os.environ",
            {"OPENCLAW_AGENT_API_CALL_ALLOWED_HOSTS": "internal.example"},
            clear=False,
        ), patch("src.task_executor.socket.getaddrinfo") as getaddrinfo:
            self.assertEqual(
                validate_api_call_url("http://internal.example/hook"),
                "http://internal.example/hook",
            )
            getaddrinfo.assert_not_called()

    def test_validate_api_call_url_rejects_embedded_credentials(self) -> None:
        with self.assertRaisesRegex(ValueError, "embedded credentials"):
            validate_api_call_url("https://user:password@example.com/webhook")

    def test_validate_api_call_url_rejects_control_characters(self) -> None:
        with self.assertRaisesRegex(ValueError, "control characters"):
            validate_api_call_url("https://api.example.com/webhook\r\nHost: internal")

    def test_sanitize_api_call_headers_removes_hop_by_hop_headers(self) -> None:
        self.assertEqual(
            sanitize_api_call_headers(
                {
                    "Host": "metadata.google.internal",
                    "Connection": "keep-alive",
                    "Bad Header": "dropped",
                    "Authorization": "Bearer token",
                    "X-Custom": 123,
                }
            ),
            {
                "Authorization": "Bearer token",
                "X-Custom": "123",
            },
        )

    def test_sanitize_api_call_headers_rejects_injected_values(self) -> None:
        with self.assertRaisesRegex(ValueError, "control characters"):
            sanitize_api_call_headers({"X-Forwarded-Host": "public\r\nHost: internal"})

    async def test_execute_api_call_rejects_disallowed_methods_before_network(self) -> None:
        executor = TaskExecutor(
            db=AsyncMock(),
            llm=AsyncMock(),
            bus=AsyncMock(),
        )
        task = task_for_api_call(
            {
                "url": "https://api.example.com/webhook",
                "method": "TRACE",
                "body": "{}",
            }
        )

        with patch(
            "src.task_executor.socket.getaddrinfo",
            return_value=[
                (socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", 443)),
            ],
        ), patch("src.task_executor.httpx.AsyncClient") as async_client:
            with self.assertRaisesRegex(ValueError, "method is not allowed"):
                await executor._execute_api_call(task, {})
            async_client.assert_not_called()


if __name__ == "__main__":
    unittest.main()
