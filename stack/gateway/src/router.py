"""
OpenClaw Gateway — Router.

FastAPI application that receives webhooks from Telegram, WhatsApp, and Slack,
normalizes the messages, forwards them to the agent, and dispatches responses.
"""
from __future__ import annotations
import asyncio
import hmac
import json
import logging
import mimetypes
import os
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import urljoin, urlparse
import httpx
import uvicorn
from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
try:
    pass
except ImportError:
    pass
from .adapters.slack import SlackAdapter
from .adapters.telegram import TelegramAdapter
from .adapters.whatsapp import WhatsAppAdapter
from .dispatcher import Dispatcher
from .normalizer import NormalizedMessage
from .supabase_storage import SupabaseStorageClient
from .telegram_setup import TelegramSetupManager
from .whatsapp_setup import WhatsAppSetupManager
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(name)s] %(levelname)s: %(message)s')
logger = logging.getLogger('openclaw.gateway')
AGENT_INDEX = int(os.environ.get('AGENT_INDEX', '0'))
GATEWAY_PORT = int(os.environ.get('GATEWAY_PORT', str(8081 + AGENT_INDEX)))
AGENT_URL = os.environ.get('AGENT_URL', f'http://agent-{AGENT_INDEX}:{8101 + AGENT_INDEX}')
DASHBOARD_INTERNAL_URL = os.environ.get('DASHBOARD_INTERNAL_URL', f'http://dashboard-{AGENT_INDEX + 1}:3001')
DEPLOY_ID = os.environ.get('DEPLOY_ID', 'local')
AGENT_SERVICE_TOKEN = os.environ.get('AGENT_SERVICE_TOKEN', '').strip()
SUPABASE_URL = os.environ.get('SUPABASE_URL', '').strip()
SUPABASE_SERVICE_ROLE_KEY = os.environ.get('SUPABASE_SERVICE_ROLE_KEY', '').strip()
SUPABASE_STORAGE_BUCKET = os.environ.get('SUPABASE_STORAGE_BUCKET', 'agent-files').strip() or 'agent-files'
try:
    SUPABASE_STORAGE_MAX_BYTES = int(os.environ.get('SUPABASE_STORAGE_MAX_BYTES', str(25 * 1024 * 1024)))
except ValueError:
    SUPABASE_STORAGE_MAX_BYTES = 25 * 1024 * 1024
OPENCLAW_ALLOWED_ORIGINS = [origin.strip() for origin in os.environ.get('OPENCLAW_ALLOWED_ORIGINS', '').split(',') if origin.strip()]
DEFAULT_MAX_REQUEST_BODY_BYTES = 1024 * 1024
WHATSAPP_MEDIA_ALLOWED_HOSTS = {'lookaside.fbsbx.com', 'lookaside.facebook.com'}
WHATSAPP_MEDIA_ALLOWED_SUFFIXES = ('.whatsapp.net',)
SLACK_FILE_ALLOWED_HOSTS = {'files.slack.com'}
REDIRECT_STATUS_CODES = {301, 302, 303, 307, 308}

def _int_env(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError:
        return default
    return value if value > 0 else default
MAX_REQUEST_BODY_BYTES = _int_env('OPENCLAW_GATEWAY_MAX_REQUEST_BODY_BYTES', DEFAULT_MAX_REQUEST_BODY_BYTES)
TELEGRAM_BOT_TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN', '')
TELEGRAM_WEBHOOK_SECRET = os.environ.get('TELEGRAM_WEBHOOK_SECRET', '')
WHATSAPP_ACCESS_TOKEN = os.environ.get('WHATSAPP_ACCESS_TOKEN', '')
WHATSAPP_VERIFY_TOKEN = os.environ.get('WHATSAPP_VERIFY_TOKEN', '').strip()
WHATSAPP_PHONE_NUMBER_ID = os.environ.get('WHATSAPP_PHONE_NUMBER_ID', '')
WHATSAPP_APP_SECRET = os.environ.get('WHATSAPP_APP_SECRET', '')
SLACK_BOT_TOKEN = os.environ.get('SLACK_BOT_TOKEN', '')
SLACK_SIGNING_SECRET = os.environ.get('SLACK_SIGNING_SECRET', '')
telegram_adapter = TelegramAdapter(TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET) if TELEGRAM_BOT_TOKEN else None
whatsapp_adapter = WhatsAppAdapter(WHATSAPP_ACCESS_TOKEN, WHATSAPP_VERIFY_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET) if WHATSAPP_ACCESS_TOKEN else None
slack_adapter = SlackAdapter(SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET) if SLACK_BOT_TOKEN else None

def _adapter_secret(adapter: Any, attr: str) -> str:
    return str(getattr(adapter, attr, '') or '').strip()

def _require_webhook_secret(adapter: Any, attr: str, channel: str, env_name: str) -> None:
    if not _adapter_secret(adapter, attr):
        logger.error('%s webhook token is configured but %s is missing', channel, env_name)
        raise HTTPException(status_code=503, detail=f'{channel} webhook verification is not configured')

def _request_header(request: Request, name: str) -> str:
    value = request.headers.get(name)
    if value is not None:
        return value
    for key, candidate in getattr(request, 'headers', {}).items():
        if str(key).lower() == name.lower():
            return str(candidate)
    return ''

async def _read_limited_body(request: Request) -> bytes:
    content_length = _request_header(request, 'content-length').strip()
    if content_length:
        try:
            length = int(content_length)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail='Invalid Content-Length') from exc
        if length > MAX_REQUEST_BODY_BYTES:
            raise HTTPException(status_code=413, detail='Request body too large')
    body = await request.body()
    if len(body) > MAX_REQUEST_BODY_BYTES:
        raise HTTPException(status_code=413, detail='Request body too large')
    return body

def _json_from_body(body: bytes) -> dict[str, Any]:
    try:
        payload = json.loads(body.decode('utf-8') or '{}')
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail='Invalid JSON body') from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail='JSON body must be an object')
    return payload

async def _read_limited_json(request: Request) -> dict[str, Any]:
    return _json_from_body(await _read_limited_body(request))
channel_configs: dict[str, dict[str, Any]] = {}
if TELEGRAM_BOT_TOKEN:
    channel_configs['telegram'] = {'bot_token': TELEGRAM_BOT_TOKEN}
if WHATSAPP_ACCESS_TOKEN:
    channel_configs['whatsapp'] = {'access_token': WHATSAPP_ACCESS_TOKEN, 'phone_number_id': WHATSAPP_PHONE_NUMBER_ID}
if SLACK_BOT_TOKEN:
    channel_configs['slack'] = {'bot_token': SLACK_BOT_TOKEN}
dispatcher = Dispatcher(channel_configs)
storage_client = SupabaseStorageClient(url=SUPABASE_URL, service_role_key=SUPABASE_SERVICE_ROLE_KEY, bucket=SUPABASE_STORAGE_BUCKET, deploy_id=DEPLOY_ID)
telegram_setup = TelegramSetupManager(dispatcher=dispatcher, telegram_bot_token=TELEGRAM_BOT_TOKEN, agent_url=AGENT_URL, dashboard_internal_url=DASHBOARD_INTERNAL_URL, service_token=AGENT_SERVICE_TOKEN) if telegram_adapter else None
whatsapp_setup = WhatsAppSetupManager(dispatcher=dispatcher, agent_url=AGENT_URL, dashboard_internal_url=DASHBOARD_INTERNAL_URL, service_token=AGENT_SERVICE_TOKEN) if whatsapp_adapter else None

async def _setup_telegram_bot() -> None:
    """Configure bot commands, description, and short description at startup."""
    if not dispatcher.configs.get('telegram'):
        return
    await dispatcher.telegram_api_call('setMyCommands', {'commands': [{'command': 'start', 'description': 'Start the bot'}, {'command': 'connectai', 'description': 'Connect an AI provider'}, {'command': 'help', 'description': 'Show available commands'}], 'scope': {'type': 'all_private_chats'}})
    await dispatcher.telegram_api_call('setMyCommands', {'commands': [{'command': 'help', 'description': 'Show available commands'}], 'scope': {'type': 'all_group_chats'}})
    await dispatcher.telegram_api_call('setMyDescription', {'description': 'Your personal AI assistant powered by OpenClaw. Send a message to get started, or use /connectai to set up your AI provider.'})
    await dispatcher.telegram_api_call('setMyShortDescription', {'short_description': 'AI assistant powered by OpenClaw'})
    logger.info('Telegram bot commands and description configured')

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(f'Gateway starting (port: {GATEWAY_PORT}, agent: {AGENT_URL})')
    configured = [k for k in channel_configs.keys()]
    logger.info(f"Configured channels: {configured or 'none'}")
    startup_task: asyncio.Task[None] | None = None
    whatsapp_startup_task: asyncio.Task[None] | None = None
    if storage_client.enabled:
        try:
            await storage_client.ensure_bucket()
            logger.info('Supabase Storage enabled (bucket=%s)', storage_client.bucket)
        except Exception as exc:
            logger.warning('Supabase Storage init failed: %s', exc)
    else:
        logger.info('Supabase Storage not configured for gateway uploads')
    if dispatcher.configs.get('telegram'):
        await _setup_telegram_bot()
    if telegram_setup:
        startup_task = asyncio.create_task(telegram_setup.run_startup_prompt())
    if whatsapp_setup:
        whatsapp_startup_task = asyncio.create_task(whatsapp_setup.run_startup_prompt())
    yield
    for task in (startup_task, whatsapp_startup_task):
        if task and (not task.done()):
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
    logger.info('Gateway shutting down')
app = FastAPI(title='OpenClaw Gateway', lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=OPENCLAW_ALLOWED_ORIGINS, allow_methods=['*'], allow_headers=['*'])

@app.post('/webhook/telegram/{deploy_id}')
async def telegram_webhook(deploy_id: str, request: Request):
    """Receive Telegram webhook updates."""
    if not telegram_adapter:
        raise HTTPException(status_code=503, detail='Telegram not configured')
    _require_webhook_secret(telegram_adapter, 'webhook_secret', 'Telegram', 'TELEGRAM_WEBHOOK_SECRET')
    if not hmac.compare_digest(deploy_id, DEPLOY_ID):
        raise HTTPException(status_code=404, detail='Unknown deployment')
    secret_token = request.headers.get('X-Telegram-Bot-Api-Secret-Token', '')
    if not telegram_adapter.verify_secret_token(secret_token):
        raise HTTPException(status_code=401, detail='Invalid Telegram secret token')
    payload = await _read_limited_json(request)
    if not telegram_adapter.validate_update(payload):
        return {'ok': True}
    chat_member = payload.get('my_chat_member')
    if chat_member:
        new_status = chat_member.get('new_chat_member', {}).get('status', 'unknown')
        chat = chat_member.get('chat', {})
        logger.info('Telegram my_chat_member: status=%s chat_id=%s chat_type=%s', new_status, chat.get('id'), chat.get('type'))
        return {'ok': True}
    normalized = telegram_adapter.normalize(payload)
    if not normalized:
        return {'ok': True}
    if telegram_setup and await telegram_setup.handle_message(normalized):
        return {'ok': True}
    message_id = normalized.metadata.get('message_id')
    if message_id:
        asyncio.create_task(dispatcher.set_telegram_reaction(normalized.chat_id, message_id))
    asyncio.create_task(dispatcher.send_telegram_chat_action(normalized.chat_id))
    response_text = await forward_to_agent(await prepare_incoming_message(normalized))
    if response_text:
        await dispatcher.send('telegram', normalized.chat_id, response_text, normalized.metadata)
    return {'ok': True}

@app.post('/webhook/whatsapp/{deploy_id}')
async def whatsapp_webhook(deploy_id: str, request: Request):
    """Receive WhatsApp Cloud API webhook events."""
    if not whatsapp_adapter:
        raise HTTPException(status_code=503, detail='WhatsApp not configured')
    _require_webhook_secret(whatsapp_adapter, 'app_secret', 'WhatsApp', 'WHATSAPP_APP_SECRET')
    if not hmac.compare_digest(deploy_id, DEPLOY_ID):
        raise HTTPException(status_code=404, detail='Unknown deployment')
    body = await _read_limited_body(request)
    signature = request.headers.get('X-Hub-Signature-256', '')
    if not whatsapp_adapter.verify_signature(body, signature):
        raise HTTPException(status_code=401, detail='Invalid WhatsApp signature')
    payload = _json_from_body(body)
    if not whatsapp_adapter.validate_payload(payload):
        return {'status': 'ok'}
    normalized = whatsapp_adapter.normalize(payload)
    if not normalized:
        return {'status': 'ok'}
    if whatsapp_setup and await whatsapp_setup.handle_message(normalized):
        return {'status': 'ok'}
    response_text = await forward_to_agent(await prepare_incoming_message(normalized))
    if response_text:
        await dispatcher.send('whatsapp', normalized.chat_id, response_text, normalized.metadata)
    return {'status': 'ok'}

@app.get('/webhook/whatsapp/{deploy_id}')
async def whatsapp_verify(deploy_id: str, hub_mode: str=Query(None, alias='hub.mode'), hub_token: str=Query(None, alias='hub.verify_token'), hub_challenge: str=Query(None, alias='hub.challenge')):
    """WhatsApp webhook verification (GET request)."""
    if not whatsapp_adapter:
        raise HTTPException(status_code=503, detail='WhatsApp not configured')
    if not hmac.compare_digest(deploy_id, DEPLOY_ID):
        raise HTTPException(status_code=404, detail='Unknown deployment')
    if not hub_mode or not hub_token or (not hub_challenge):
        raise HTTPException(status_code=400, detail='Missing verification params')
    result = whatsapp_adapter.verify_webhook(hub_mode, hub_token, hub_challenge)
    if result is not None:
        return Response(content=result, media_type='text/plain')
    raise HTTPException(status_code=403, detail='Verification failed')

@app.post('/webhook/slack/{deploy_id}')
async def slack_webhook(deploy_id: str, request: Request):
    """Receive Slack Events API webhook events."""
    if not slack_adapter:
        raise HTTPException(status_code=503, detail='Slack not configured')
    _require_webhook_secret(slack_adapter, 'signing_secret', 'Slack', 'SLACK_SIGNING_SECRET')
    if not hmac.compare_digest(deploy_id, DEPLOY_ID):
        raise HTTPException(status_code=404, detail='Unknown deployment')
    body = await _read_limited_body(request)
    timestamp = request.headers.get('X-Slack-Request-Timestamp', '')
    signature = request.headers.get('X-Slack-Signature', '')
    if not slack_adapter.verify_signature(body, timestamp, signature):
        raise HTTPException(status_code=401, detail='Invalid signature')
    payload = _json_from_body(body)
    challenge = slack_adapter.handle_url_verification(payload)
    if challenge is not None:
        return {'challenge': challenge}
    if not slack_adapter.validate_event(payload):
        return {'ok': True}
    normalized = slack_adapter.normalize(payload)
    if not normalized:
        return {'ok': True}
    response_text = await forward_to_agent(await prepare_incoming_message(normalized))
    if response_text:
        await dispatcher.send('slack', normalized.chat_id, response_text, normalized.metadata)
    return {'ok': True}

async def prepare_incoming_message(normalized: NormalizedMessage) -> dict[str, Any]:
    metadata = await _upload_provider_attachments(normalized.channel_type, normalized.chat_id, normalized.metadata)
    return normalized.model_copy(update={'metadata': metadata}).model_dump()

async def _upload_provider_attachments(channel_type: str, chat_id: str, metadata: dict[str, Any]) -> dict[str, Any]:
    attachments = metadata.get('attachments')
    if not isinstance(attachments, list) or not attachments:
        return metadata
    if not storage_client.enabled:
        return metadata
    uploaded: list[dict[str, Any]] = []
    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=20.0), follow_redirects=True) as client:
        for raw_attachment in attachments:
            if not isinstance(raw_attachment, dict):
                continue
            attachment = dict(raw_attachment)
            size_hint = attachment.get('size_bytes')
            if isinstance(size_hint, int) and size_hint > SUPABASE_STORAGE_MAX_BYTES:
                attachment['upload_skipped'] = 'attachment_too_large'
                uploaded.append(attachment)
                continue
            try:
                content, content_type, filename = await _download_provider_attachment(client, channel_type, attachment)
                if len(content) > SUPABASE_STORAGE_MAX_BYTES:
                    attachment['upload_skipped'] = 'attachment_too_large'
                    uploaded.append(attachment)
                    continue
                storage_meta = await storage_client.upload_bytes(channel_type=channel_type, chat_id=chat_id, filename=filename, content=content, content_type=content_type, metadata={'provider': attachment.get('provider'), 'kind': attachment.get('kind'), 'original_name': attachment.get('original_name')})
                uploaded.append({**attachment, **storage_meta, 'original_name': attachment.get('original_name') or filename, 'content_type': content_type or storage_meta['content_type'], 'size_bytes': storage_meta['size_bytes']})
            except Exception as exc:
                logger.warning('Attachment upload failed for %s/%s (%s)', channel_type, attachment.get('kind') or 'file', exc.__class__.__name__)
                attachment['upload_error'] = 'attachment_upload_failed'
                uploaded.append(attachment)
    enriched = dict(metadata)
    enriched['attachments'] = uploaded
    return enriched

async def _download_provider_attachment(client: httpx.AsyncClient, channel_type: str, attachment: dict[str, Any]) -> tuple[bytes, str | None, str]:
    if channel_type == 'telegram':
        return await _download_telegram_attachment(client, attachment)
    if channel_type == 'whatsapp':
        return await _download_whatsapp_attachment(client, attachment)
    if channel_type == 'slack':
        return await _download_slack_attachment(client, attachment)
    raise RuntimeError(f'Unsupported attachment channel: {channel_type}')

async def _download_telegram_attachment(client: httpx.AsyncClient, attachment: dict[str, Any]) -> tuple[bytes, str | None, str]:
    file_id = str(attachment.get('file_id') or '').strip()
    if not file_id or not TELEGRAM_BOT_TOKEN:
        raise RuntimeError('Telegram attachment missing file_id or bot token')
    meta_response = await client.get(f'https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/getFile', params={'file_id': file_id})
    meta_response.raise_for_status()
    file_path = meta_response.json().get('result', {}).get('file_path')
    if not file_path:
        raise RuntimeError('Telegram file_path missing from getFile')
    response = await client.get(f'https://api.telegram.org/file/bot{TELEGRAM_BOT_TOKEN}/{file_path}')
    response.raise_for_status()
    filename = attachment.get('original_name') or os.path.basename(file_path) or _fallback_filename(attachment)
    content_type = attachment.get('content_type') or response.headers.get('content-type')
    return (response.content, content_type, str(filename))

async def _download_whatsapp_attachment(client: httpx.AsyncClient, attachment: dict[str, Any]) -> tuple[bytes, str | None, str]:
    media_id = str(attachment.get('media_id') or '').strip()
    if not media_id or not WHATSAPP_ACCESS_TOKEN:
        raise RuntimeError('WhatsApp attachment missing media_id or access token')
    headers = {'Authorization': f'Bearer {WHATSAPP_ACCESS_TOKEN}'}
    meta_response = await client.get(f'https://graph.facebook.com/v18.0/{media_id}', headers=headers, follow_redirects=False)
    meta_response.raise_for_status()
    meta = meta_response.json()
    media_url = str(meta.get('url') or '').strip()
    if not media_url:
        raise RuntimeError('WhatsApp media URL missing')
    if not _is_allowed_whatsapp_media_url(media_url):
        raise RuntimeError('Refusing to send WhatsApp token to non-Meta media URL')
    response = await _get_provider_attachment_with_bearer(client, media_url, token=WHATSAPP_ACCESS_TOKEN, is_allowed_url=_is_allowed_whatsapp_media_url, provider_name='WhatsApp')
    response.raise_for_status()
    content_type = attachment.get('content_type') or meta.get('mime_type') or response.headers.get('content-type')
    filename = attachment.get('original_name') or _fallback_filename(attachment, content_type=content_type)
    return (response.content, content_type, str(filename))

def _is_allowed_whatsapp_media_url(media_url: str) -> bool:
    try:
        parsed = urlparse(media_url)
    except Exception:
        return False
    hostname = (parsed.hostname or '').rstrip('.').lower()
    if parsed.scheme != 'https' or not hostname or parsed.username or parsed.password:
        return False
    return hostname in WHATSAPP_MEDIA_ALLOWED_HOSTS or any((hostname.endswith(suffix) for suffix in WHATSAPP_MEDIA_ALLOWED_SUFFIXES))

def _is_allowed_slack_file_url(download_url: str) -> bool:
    try:
        parsed = urlparse(download_url)
    except Exception:
        return False
    hostname = (parsed.hostname or '').rstrip('.').lower()
    if parsed.scheme != 'https' or not hostname or parsed.username or parsed.password:
        return False
    return hostname in SLACK_FILE_ALLOWED_HOSTS

async def _download_slack_attachment(client: httpx.AsyncClient, attachment: dict[str, Any]) -> tuple[bytes, str | None, str]:
    download_url = str(attachment.get('download_url') or '').strip()
    if not download_url or not SLACK_BOT_TOKEN:
        raise RuntimeError('Slack attachment missing download_url or bot token')
    if not _is_allowed_slack_file_url(download_url):
        raise RuntimeError(f'Refusing to send Slack token to non-Slack URL: {download_url}')
    response = await _get_provider_attachment_with_bearer(client, download_url, token=SLACK_BOT_TOKEN, is_allowed_url=_is_allowed_slack_file_url, provider_name='Slack')
    response.raise_for_status()
    content_type = attachment.get('content_type') or response.headers.get('content-type')
    filename = attachment.get('original_name') or _fallback_filename(attachment, content_type=content_type)
    return (response.content, content_type, str(filename))

async def _get_provider_attachment_with_bearer(client: httpx.AsyncClient, url: str, *, token: str, is_allowed_url: Any, provider_name: str, max_redirects: int=3) -> httpx.Response:
    current_url = url
    for _ in range(max_redirects + 1):
        if not is_allowed_url(current_url):
            raise RuntimeError(f'Refusing to send {provider_name} token to untrusted media URL')
        response = await client.get(current_url, headers={'Authorization': f'Bearer {token}'}, follow_redirects=False)
        if response.status_code not in REDIRECT_STATUS_CODES:
            return response
        location = response.headers.get('location', '').strip()
        if not location:
            raise RuntimeError(f'{provider_name} media redirect missing location')
        next_url = urljoin(current_url, location)
        if not is_allowed_url(next_url):
            raise RuntimeError(f'Refusing to follow {provider_name} media redirect to untrusted URL')
        current_url = next_url
    raise RuntimeError(f'{provider_name} media redirect limit exceeded')

def _fallback_filename(attachment: dict[str, Any], *, content_type: str | None=None) -> str:
    name = str(attachment.get('original_name') or '').strip()
    if name:
        return name
    kind = str(attachment.get('kind') or 'file').strip() or 'file'
    ext = mimetypes.guess_extension(content_type or '') or ''
    return f'{kind}{ext}'

def _service_headers() -> dict[str, str]:
    headers: dict[str, str] = {}
    if AGENT_SERVICE_TOKEN:
        headers['X-OpenClaw-Service-Token'] = AGENT_SERVICE_TOKEN
    return headers

def _require_internal_auth(request: Request) -> None:
    if not AGENT_SERVICE_TOKEN:
        raise HTTPException(status_code=503, detail='Internal service token is not configured')
    provided_service_token = request.headers.get('X-OpenClaw-Service-Token', '').strip()
    if provided_service_token and hmac.compare_digest(AGENT_SERVICE_TOKEN, provided_service_token):
        return
    raise HTTPException(status_code=401, detail='Invalid service token')

async def forward_to_agent(message: dict[str, Any]) -> str | None:
    """Forward a normalized message to the agent and return the response."""
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(f'{AGENT_URL}/message', json=message, headers=_service_headers())
            resp.raise_for_status()
            data = resp.json()
            return data.get('response')
    except httpx.TimeoutException:
        logger.error('Agent request timed out')
        return "I'm taking longer than expected. Please try again."
    except httpx.HTTPError as e:
        logger.error(f'Agent communication error: {e}')
        return None

@app.post('/internal/telegram/setup-prompt')
async def internal_telegram_setup_prompt(request: Request):
    _require_internal_auth(request)
    if not telegram_setup:
        raise HTTPException(status_code=503, detail='Telegram not configured')
    body = await _read_limited_json(request)
    trigger = str(body.get('trigger') or '').strip().lower() or 'owner_verified'
    if trigger not in {'startup', 'owner_verified'}:
        raise HTTPException(status_code=400, detail='Unsupported trigger')
    result = await telegram_setup.trigger_owner_prompt(trigger)
    return {'ok': True, **result}

@app.post('/internal/whatsapp/setup-prompt')
async def internal_whatsapp_setup_prompt(request: Request):
    _require_internal_auth(request)
    if not whatsapp_setup:
        raise HTTPException(status_code=503, detail='WhatsApp not configured')
    body = await _read_limited_json(request)
    trigger = str(body.get('trigger') or '').strip().lower() or 'owner_verified'
    if trigger not in {'startup', 'owner_verified'}:
        raise HTTPException(status_code=400, detail='Unsupported trigger')
    result = await whatsapp_setup.trigger_owner_prompt(trigger)
    return {'ok': True, **result}

@app.get('/health')
async def health():
    return {'status': 'healthy', 'gateway_port': GATEWAY_PORT, 'agent_url': AGENT_URL, 'channels': list(channel_configs.keys())}
if __name__ == '__main__':
    uvicorn.run('src.router:app', host='0.0.0.0', port=GATEWAY_PORT, log_level='info')
