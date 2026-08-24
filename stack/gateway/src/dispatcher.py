"""
OpenClaw Gateway — Message Dispatcher.

Sends messages from the agent back to the appropriate messaging platform.
"""
from __future__ import annotations
import ipaddress
import logging
from typing import Any
import urllib.parse
import httpx
logger = logging.getLogger(__name__)
TELEGRAM_MAX_MESSAGE_LENGTH = 4096

def _split_message(text: str, limit: int=TELEGRAM_MAX_MESSAGE_LENGTH) -> list[str]:
    """Split a message at natural boundaries (paragraph, line, space) to stay within Telegram's limit."""
    if len(text) <= limit:
        return [text]
    chunks: list[str] = []
    remaining = text
    while remaining:
        if len(remaining) <= limit:
            chunks.append(remaining)
            break
        cut = limit
        for sep in ('\n\n', '\n', ' '):
            pos = remaining.rfind(sep, 0, limit)
            if pos > 0:
                cut = pos + len(sep)
                break
        chunks.append(remaining[:cut])
        remaining = remaining[cut:]
    return chunks

def _is_private_or_reserved_host(host: str) -> bool:
    normalized = host.strip().lower().rstrip('.')
    if not normalized:
        return True
    if normalized == 'localhost' or normalized.endswith('.localhost'):
        return True
    if normalized.endswith(('.local', '.internal', '.lan')):
        return True
    if '.' not in normalized:
        return True
    try:
        ip = ipaddress.ip_address(normalized.strip('[]'))
    except ValueError:
        return False
    return not ip.is_global

def _host_from_url(value: str) -> str:
    try:
        parsed = urllib.parse.urlparse(value)
    except ValueError:
        return ''
    return (parsed.hostname or '').strip().lower().rstrip('.')

class Dispatcher:
    """Dispatches outgoing messages to messaging platforms."""

    def __init__(self, channel_configs: dict[str, dict[str, Any]]):
        """
        channel_configs: mapping of channel_type to config dict.
        E.g., {"telegram": {"bot_token": "..."}, "whatsapp": {"access_token": "...", "phone_number_id": "..."}}
        """
        self.configs = channel_configs

    async def send(self, channel_type: str, chat_id: str, text: str, metadata: dict[str, Any] | None=None, reply_markup: dict[str, Any] | None=None, disable_web_page_preview: bool=False) -> int | bool | None:
        """Send a message to the appropriate channel. Returns message_id (Telegram) or bool (others)."""
        match channel_type:
            case 'telegram':
                return await self.send_telegram(chat_id, text, metadata, reply_markup=reply_markup, disable_web_page_preview=disable_web_page_preview)
            case 'whatsapp':
                return await self.send_whatsapp(chat_id, text, metadata)
            case 'slack':
                return await self.send_slack(chat_id, text, metadata)
            case _:
                logger.error(f'Unknown channel type: {channel_type}')
                return False

    def _telegram_bot_token(self) -> str:
        config = self.configs.get('telegram', {})
        return str(config.get('bot_token') or '').strip()

    def _telegram_api_url(self, method: str) -> str | None:
        bot_token = self._telegram_bot_token()
        if not bot_token:
            logger.error('Telegram bot token not configured')
            return None
        return f'https://api.telegram.org/bot{bot_token}/{method}'

    async def telegram_api_call(self, method: str, payload: dict[str, Any] | None=None) -> dict[str, Any] | None:
        """Call an arbitrary Telegram Bot API method. Returns the response JSON or None on failure."""
        url = self._telegram_api_url(method)
        if not url:
            return None
        async with httpx.AsyncClient(timeout=30) as client:
            try:
                resp = await client.post(url, json=payload or {})
                resp.raise_for_status()
                return resp.json()
            except httpx.HTTPError as exc:
                logger.warning('Telegram API call %s failed: %s', method, exc)
                return None

    async def send_telegram_chat_action(self, chat_id: str, action: str='typing') -> bool:
        """Send a chat action (e.g. 'typing' indicator) via Telegram Bot API."""
        url = self._telegram_api_url('sendChatAction')
        if not url:
            return False
        async with httpx.AsyncClient(timeout=10) as client:
            try:
                resp = await client.post(url, json={'chat_id': chat_id, 'action': action})
                resp.raise_for_status()
            except httpx.HTTPError as exc:
                logger.warning('Telegram chat action failed: %s', exc)
                return False
        return True

    async def send_telegram(self, chat_id: str, text: str, metadata: dict[str, Any] | None=None, *, reply_markup: dict[str, Any] | None=None, disable_web_page_preview: bool=False) -> int | None:
        """Send a message via Telegram Bot API. Returns the message_id of the last sent message, or None on failure."""
        url = self._telegram_api_url('sendMessage')
        if not url:
            return None
        chunks = _split_message(text)
        last_message_id: int | None = None
        async with httpx.AsyncClient(timeout=30) as client:
            for index, chunk in enumerate(chunks):
                payload: dict[str, Any] = {'chat_id': chat_id, 'text': chunk, 'parse_mode': 'MarkdownV2'}
                if disable_web_page_preview:
                    payload['link_preview_options'] = {'is_disabled': True}
                if reply_markup and index == 0:
                    payload['reply_markup'] = reply_markup
                if metadata and metadata.get('reply_to_message_id'):
                    payload['reply_to_message_id'] = metadata['reply_to_message_id']
                try:
                    resp = await client.post(url, json=payload)
                    if resp.status_code != 200:
                        payload.pop('parse_mode', None)
                        resp = await client.post(url, json=payload)
                    resp.raise_for_status()
                    data = resp.json()
                    result = data.get('result')
                    if isinstance(result, dict):
                        last_message_id = result.get('message_id')
                except httpx.HTTPError as e:
                    logger.error(f'Telegram send failed: {e}')
                    return None
        return last_message_id

    async def answer_telegram_callback(self, callback_query_id: str, text: str | None=None, *, show_alert: bool=False) -> bool:
        url = self._telegram_api_url('answerCallbackQuery')
        if not url:
            return False
        payload: dict[str, Any] = {'callback_query_id': callback_query_id, 'show_alert': show_alert}
        if text:
            payload['text'] = text
        async with httpx.AsyncClient(timeout=30) as client:
            try:
                resp = await client.post(url, json=payload)
                resp.raise_for_status()
            except httpx.HTTPError as exc:
                logger.error('Telegram callback answer failed: %s', exc)
                return False
        return True

    async def edit_telegram_message(self, chat_id: str, message_id: int | str, text: str, *, reply_markup: dict[str, Any] | None=None, parse_mode: str='MarkdownV2') -> bool:
        """Edit an existing message via Telegram Bot API."""
        url = self._telegram_api_url('editMessageText')
        if not url:
            return False
        try:
            normalized_message_id = int(message_id)
        except (TypeError, ValueError):
            return False
        payload: dict[str, Any] = {'chat_id': chat_id, 'message_id': normalized_message_id, 'text': text, 'parse_mode': parse_mode}
        if reply_markup:
            payload['reply_markup'] = reply_markup
        async with httpx.AsyncClient(timeout=30) as client:
            try:
                resp = await client.post(url, json=payload)
                if resp.status_code != 200:
                    payload.pop('parse_mode', None)
                    resp = await client.post(url, json=payload)
                resp.raise_for_status()
                return True
            except httpx.HTTPError as exc:
                logger.warning('Telegram edit message failed: %s', exc)
                return False

    async def edit_telegram_reply_markup(self, chat_id: str, message_id: int | str, reply_markup: dict[str, Any]) -> bool:
        """Edit only the reply markup of an existing message."""
        url = self._telegram_api_url('editMessageReplyMarkup')
        if not url:
            return False
        try:
            normalized_message_id = int(message_id)
        except (TypeError, ValueError):
            return False
        payload: dict[str, Any] = {'chat_id': chat_id, 'message_id': normalized_message_id, 'reply_markup': reply_markup}
        async with httpx.AsyncClient(timeout=30) as client:
            try:
                resp = await client.post(url, json=payload)
                resp.raise_for_status()
                return True
            except httpx.HTTPError as exc:
                logger.warning('Telegram edit reply markup failed: %s', exc)
                return False

    async def set_telegram_reaction(self, chat_id: str, message_id: int | str, emoji: str='👀') -> bool:
        """Set a reaction on a message via Telegram Bot API."""
        url = self._telegram_api_url('setMessageReaction')
        if not url:
            return False
        try:
            normalized_message_id = int(message_id)
        except (TypeError, ValueError):
            return False
        payload = {'chat_id': chat_id, 'message_id': normalized_message_id, 'reaction': [{'type': 'emoji', 'emoji': emoji}]}
        async with httpx.AsyncClient(timeout=10) as client:
            try:
                resp = await client.post(url, json=payload)
                resp.raise_for_status()
            except httpx.HTTPError as exc:
                logger.warning('Telegram reaction failed: %s', exc)
                return False
        return True

    async def delete_telegram_message(self, chat_id: str, message_id: int | str) -> bool:
        url = self._telegram_api_url('deleteMessage')
        if not url:
            return False
        try:
            normalized_message_id = int(message_id)
        except (TypeError, ValueError):
            return False
        payload = {'chat_id': chat_id, 'message_id': normalized_message_id}
        async with httpx.AsyncClient(timeout=30) as client:
            try:
                resp = await client.post(url, json=payload)
                resp.raise_for_status()
                data = resp.json()
                return bool(data.get('ok'))
            except (TypeError, ValueError, httpx.HTTPError) as exc:
                logger.warning('Telegram delete failed: %s', exc)
                return False

    async def send_whatsapp(self, chat_id: str, text: str, metadata: dict[str, Any] | None=None) -> bool:
        """Send a message via WhatsApp Cloud API."""
        config = self.configs.get('whatsapp', {})
        access_token = config.get('access_token')
        phone_number_id = config.get('phone_number_id')
        if not access_token or not phone_number_id:
            logger.error('WhatsApp not configured')
            return False
        url = f'https://graph.facebook.com/v18.0/{phone_number_id}/messages'
        payload = {'messaging_product': 'whatsapp', 'to': chat_id, 'type': 'text', 'text': {'body': text}}
        if metadata and metadata.get('message_id'):
            payload['context'] = {'message_id': metadata['message_id']}
        async with httpx.AsyncClient(timeout=30) as client:
            try:
                resp = await client.post(url, json=payload, headers={'Authorization': f'Bearer {access_token}'})
                resp.raise_for_status()
            except httpx.HTTPError as e:
                logger.error(f'WhatsApp send failed: {e}')
                return False
        return True

    async def send_whatsapp_interactive(self, chat_id: str, body_text: str, buttons: list[dict[str, str]], metadata: dict[str, Any] | None=None) -> bool:
        """Send an interactive button message via WhatsApp Cloud API.

        buttons: list of {"id": "callback_id", "title": "Button Label"} (max 3).
        """
        config = self.configs.get('whatsapp', {})
        access_token = config.get('access_token')
        phone_number_id = config.get('phone_number_id')
        if not access_token or not phone_number_id:
            logger.error('WhatsApp not configured')
            return False
        url = f'https://graph.facebook.com/v18.0/{phone_number_id}/messages'
        payload: dict[str, Any] = {'messaging_product': 'whatsapp', 'to': chat_id, 'type': 'interactive', 'interactive': {'type': 'button', 'body': {'text': body_text}, 'action': {'buttons': [{'type': 'reply', 'reply': {'id': btn['id'], 'title': btn['title'][:20]}} for btn in buttons[:3]]}}}
        if metadata and metadata.get('message_id'):
            payload['context'] = {'message_id': metadata['message_id']}
        async with httpx.AsyncClient(timeout=30) as client:
            try:
                resp = await client.post(url, json=payload, headers={'Authorization': f'Bearer {access_token}'})
                resp.raise_for_status()
            except httpx.HTTPError as e:
                logger.error(f'WhatsApp interactive send failed: {e}')
                return False
        return True

    async def send_slack(self, chat_id: str, text: str, metadata: dict[str, Any] | None=None) -> bool:
        """Send a message via Slack Web API."""
        config = self.configs.get('slack', {})
        bot_token = config.get('bot_token')
        if not bot_token:
            logger.error('Slack bot token not configured')
            return False
        url = 'https://slack.com/api/chat.postMessage'
        payload: dict[str, Any] = {'channel': chat_id, 'text': text}
        if metadata and metadata.get('thread_ts'):
            payload['thread_ts'] = metadata['thread_ts']
        async with httpx.AsyncClient(timeout=30) as client:
            try:
                resp = await client.post(url, json=payload, headers={'Authorization': f'Bearer {bot_token}'})
                resp.raise_for_status()
                data = resp.json()
                if not data.get('ok'):
                    logger.error(f"Slack API error: {data.get('error')}")
                    return False
            except httpx.HTTPError as e:
                logger.error(f'Slack send failed: {e}')
                return False
        return True
