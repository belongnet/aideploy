import json
import sys
import unittest
from types import SimpleNamespace
from typing import Any

from starlette.responses import JSONResponse

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

from src.main import RequestBodyLimitMiddleware


class RequestBodyLimitMiddlewareTest(unittest.IsolatedAsyncioTestCase):
    async def _call(
        self,
        chunks: list[bytes],
        *,
        headers: list[tuple[bytes, bytes]] | None = None,
        limit: int = 8,
    ) -> tuple[int, dict[str, Any]]:
        async def app(scope: dict[str, Any], receive: Any, send: Any) -> None:
            body = bytearray()
            while True:
                message = await receive()
                if message["type"] != "http.request":
                    break
                body.extend(message.get("body", b""))
                if not message.get("more_body", False):
                    break
            response = JSONResponse({"bytes": len(body)})
            await response(scope, receive, send)

        middleware = RequestBodyLimitMiddleware(app, max_body_bytes=limit)
        messages = [
            {
                "type": "http.request",
                "body": chunk,
                "more_body": index < len(chunks) - 1,
            }
            for index, chunk in enumerate(chunks or [b""])
        ]
        sent: list[dict[str, Any]] = []

        async def receive() -> dict[str, Any]:
            if messages:
                return messages.pop(0)
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(message: dict[str, Any]) -> None:
            sent.append(message)

        await middleware(
            {
                "type": "http",
                "method": "POST",
                "path": "/message",
                "headers": headers or [],
            },
            receive,
            send,
        )

        status = next(message["status"] for message in sent if message["type"] == "http.response.start")
        raw_body = b"".join(
            message.get("body", b"")
            for message in sent
            if message["type"] == "http.response.body"
        )
        return status, json.loads(raw_body.decode("utf-8"))

    async def test_allows_bodies_within_limit(self) -> None:
        status, payload = await self._call([b"abc", b"def"], limit=8)

        self.assertEqual(status, 200)
        self.assertEqual(payload, {"bytes": 6})

    async def test_rejects_oversized_content_length_before_reading(self) -> None:
        status, payload = await self._call(
            [b"small"],
            headers=[(b"content-length", b"9")],
            limit=8,
        )

        self.assertEqual(status, 413)
        self.assertEqual(payload, {"detail": "Request body is too large."})

    async def test_rejects_invalid_content_length(self) -> None:
        status, payload = await self._call(
            [b"small"],
            headers=[(b"content-length", b"nope")],
            limit=8,
        )

        self.assertEqual(status, 400)
        self.assertEqual(payload, {"detail": "Invalid Content-Length header."})

    async def test_rejects_chunked_body_when_it_crosses_limit(self) -> None:
        status, payload = await self._call([b"1234", b"5678", b"9"], limit=8)

        self.assertEqual(status, 413)
        self.assertEqual(payload, {"detail": "Request body is too large."})


if __name__ == "__main__":
    unittest.main()
