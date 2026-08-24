#!/usr/bin/env python3
"""Send an E2E prompt from a real Telegram user and wait for the bot reply."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import urllib.request

from telethon import TelegramClient
from telethon.sessions import StringSession


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def bot_identity(token: str) -> tuple[int, str]:
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/getMe",
        headers={"User-Agent": "aideploy-e2e/1"},
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        payload = json.load(response)
    result = payload.get("result") if payload.get("ok") else None
    if not isinstance(result, dict) or not result.get("username") or not result.get("id"):
        raise RuntimeError("Telegram getMe did not return the E2E bot identity")
    return int(result["id"]), str(result["username"])


async def probe(deploy_id: str) -> None:
    token = required("E2E_TG_TOKEN")
    expected_user_id = int(required("E2E_TG_CHAT_ID"))
    api_id = int(required("E2E_TG_API_ID"))
    api_hash = required("E2E_TG_API_HASH")
    session = required("E2E_TG_SESSION")
    bot_id, bot_username = bot_identity(token)

    client = TelegramClient(StringSession(session), api_id, api_hash)
    await client.connect()
    try:
        if not await client.is_user_authorized():
            raise RuntimeError("E2E_TG_SESSION is not an authorized Telegram user session")
        me = await client.get_me()
        if me is None or int(me.id) != expected_user_id:
            actual = "unknown" if me is None else str(me.id)
            raise RuntimeError(
                f"E2E_TG_CHAT_ID does not match the Telegram user session (expected {expected_user_id}, got {actual})"
            )

        bot = await client.get_entity(bot_username)
        nonce = f"AIDEPLOY_READY_{deploy_id}_{int(time.time())}"
        prompt = f"Reply with this exact test id and nothing else: {nonce}"
        async with client.conversation(bot, timeout=180, exclusive=True) as conversation:
            sent = await conversation.send_message(prompt)
            while True:
                response = await conversation.get_response()
                text = (response.raw_text or "").strip()
                if response.id > sent.id and int(response.sender_id or 0) == bot_id and nonce in text:
                    print(f"Telegram E2E reply received from @{bot_username}: {text[:240]}")
                    return
    finally:
        await client.disconnect()


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: e2e-telegram-probe.py <deploy-id>", file=sys.stderr)
        return 2
    try:
        asyncio.run(probe(sys.argv[1]))
        return 0
    except Exception as exc:
        print(f"Telegram E2E probe failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
