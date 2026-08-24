import unittest
from unittest.mock import patch
import httpx
from src.dispatcher import Dispatcher, _split_message

class _FakeResponse:

    def __init__(self, status_code: int, payload: dict[str, object]) -> None:
        self.status_code = status_code
        self._payload = payload

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            request = httpx.Request('POST', 'https://api.telegram.org/botTOKEN/sendMessage')
            response = httpx.Response(self.status_code, request=request)
            raise httpx.HTTPStatusError('request failed', request=request, response=response)

    def json(self) -> dict[str, object]:
        return self._payload

class _FakeAsyncClient:

    def __init__(self, responses: list[_FakeResponse], calls: list[dict[str, object]]) -> None:
        self._responses = responses
        self._calls = calls

    async def __aenter__(self) -> '_FakeAsyncClient':
        return self

    async def __aexit__(self, exc_type, exc, tb) -> bool:
        return False

    async def post(self, url: str, json: dict[str, object], **kwargs) -> _FakeResponse:
        self._calls.append({'url': url, 'json': dict(json), 'kwargs': kwargs})
        return self._responses.pop(0)

class DispatcherTest(unittest.IsolatedAsyncioTestCase):

    def test_split_message_prefers_natural_boundaries(self) -> None:
        chunks = _split_message('hello world from bot', limit=12)
        self.assertEqual(chunks, ['hello world ', 'from bot'])

    async def test_send_telegram_returns_last_message_id_for_split_messages(self) -> None:
        dispatcher = Dispatcher({'telegram': {'bot_token': 'TOKEN'}})
        calls: list[dict[str, object]] = []
        responses = [_FakeResponse(200, {'result': {'message_id': 41}}), _FakeResponse(200, {'result': {'message_id': 42}})]
        with patch('src.dispatcher._split_message', return_value=['first chunk', 'second chunk']), patch('src.dispatcher.httpx.AsyncClient', side_effect=lambda *args, **kwargs: _FakeAsyncClient(responses, calls)):
            result = await dispatcher.send_telegram('chat-1', 'ignored because split is patched', {'reply_to_message_id': '7'}, reply_markup={'inline_keyboard': [[{'text': 'Open', 'url': 'https://example.com'}]]}, disable_web_page_preview=True)
        self.assertEqual(result, 42)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]['json']['text'], 'first chunk')
        self.assertEqual(calls[1]['json']['text'], 'second chunk')
        self.assertEqual(calls[0]['json']['reply_to_message_id'], '7')
        self.assertEqual(calls[1]['json']['reply_to_message_id'], '7')
        self.assertEqual(calls[0]['json']['reply_markup'], {'inline_keyboard': [[{'text': 'Open', 'url': 'https://example.com'}]]})
        self.assertNotIn('reply_markup', calls[1]['json'])
        self.assertEqual(calls[0]['json']['link_preview_options'], {'is_disabled': True})
        self.assertEqual(calls[0]['json']['parse_mode'], 'MarkdownV2')

    async def test_send_telegram_retries_without_markdownv2_on_parse_failure(self) -> None:
        dispatcher = Dispatcher({'telegram': {'bot_token': 'TOKEN'}})
        calls: list[dict[str, object]] = []
        responses = [_FakeResponse(400, {'ok': False}), _FakeResponse(200, {'result': {'message_id': 99}})]
        with patch('src.dispatcher.httpx.AsyncClient', side_effect=lambda *args, **kwargs: _FakeAsyncClient(responses, calls)):
            result = await dispatcher.send_telegram('chat-1', '*hello*')
        self.assertEqual(result, 99)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]['json']['parse_mode'], 'MarkdownV2')
        self.assertNotIn('parse_mode', calls[1]['json'])

    async def test_send_whatsapp_posts_graph_payload_with_reply_context(self) -> None:
        dispatcher = Dispatcher({'whatsapp': {'access_token': 'WA_TOKEN', 'phone_number_id': 'PHONE_ID'}})
        calls: list[dict[str, object]] = []
        responses = [_FakeResponse(200, {'messages': [{'id': 'wamid-out'}]})]
        with patch('src.dispatcher.httpx.AsyncClient', side_effect=lambda *args, **kwargs: _FakeAsyncClient(responses, calls)):
            result = await dispatcher.send_whatsapp('15551234567', 'Draft received.', {'message_id': 'wamid-in'})
        self.assertTrue(result)
        self.assertEqual(calls[0]['url'], 'https://graph.facebook.com/v18.0/PHONE_ID/messages')
        self.assertEqual(calls[0]['json']['messaging_product'], 'whatsapp')
        self.assertEqual(calls[0]['json']['to'], '15551234567')
        self.assertEqual(calls[0]['json']['text'], {'body': 'Draft received.'})
        self.assertEqual(calls[0]['json']['context'], {'message_id': 'wamid-in'})
        self.assertEqual(calls[0]['kwargs']['headers']['Authorization'], 'Bearer WA_TOKEN')
if __name__ == '__main__':
    unittest.main()
