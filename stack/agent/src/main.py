"""
OpenClaw Agent — Main entry point.

Starts the agent: loads config, connects to DB, initializes LLM client,
bus client, task engine, prune job, and the FastAPI HTTP server for
receiving messages from the gateway and serving the dashboard API.
"""

from __future__ import annotations

import json
import logging
import os
import signal
import sys
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from .bus_client import BusClient
from .db import Database
from .llm_client import LLMAdapter, create_llm_adapter
from .models import (
    ActionType,
    AnalyticsEvent,
    AuthMethod,
    BusEventType,
    BusMessage,
    Channel,
    ChannelType,
    Conversation,
    IncomingMessage,
    Message,
    MessageRole,
    Task,
    TriggerType,
)
from .prune_job import BusCleanupJob, PruneJob
from .task_engine import TaskEngine
from .task_executor import TaskExecutor

# ── Configuration ─────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("openclaw.agent")

AGENT_INDEX = int(os.environ.get("AGENT_INDEX", "0"))
AGENT_SCHEMA = os.environ.get("AGENT_SCHEMA", f"agent_{AGENT_INDEX + 1}")
AGENT_PORT = int(os.environ.get("AGENT_PORT", str(8101 + AGENT_INDEX)))
DB_DSN = os.environ.get(
    "DATABASE_URL",
    f"postgresql://openclaw:{os.environ.get('DB_PASSWORD', 'openclaw')}@db:5432/openclaw",
)

# ── Global State ──────────────────────────────────────────────

db: Database
llm: LLMAdapter
bus: BusClient
task_engine: TaskEngine
prune_job: PruneJob
agent_id: uuid.UUID


# ── Lifespan ──────────────────────────────────────────────────


@asynccontextmanager
async def lifespan(app: FastAPI):
    global db, llm, bus, task_engine, prune_job, agent_id

    logger.info(f"Starting agent (schema: {AGENT_SCHEMA}, port: {AGENT_PORT})")

    # Database
    db = await Database.create(DB_DSN, AGENT_SCHEMA)
    config = await db.get_config()
    logger.info(
        f"Config loaded: provider={config.model_provider.value}, "
        f"model={config.model}, auth={config.auth_method.value}"
    )

    # Get agent ID from registry
    import asyncpg

    pool = await asyncpg.create_pool(DB_DSN, min_size=1, max_size=2)
    row = await pool.fetchrow(
        "SELECT id FROM public.agents WHERE schema_name = $1", AGENT_SCHEMA
    )
    agent_id = row["id"] if row else uuid.uuid4()
    await pool.close()

    # LLM client
    llm = create_llm_adapter(db, config)

    # Bus client
    bus = BusClient(DB_DSN, agent_id)
    await bus.start()

    # Task executor and engine
    executor = TaskExecutor(db, llm, bus, reply_callback=send_reply)
    task_engine = TaskEngine(db, executor)
    await task_engine.start()

    # Register bus handlers
    bus.on("message_forward", handle_bus_forward)
    bus.on("config_changed", handle_config_changed)

    # Prune job
    prune_job = PruneJob(db)
    await prune_job.start()

    # Update status to running
    async with (await asyncpg.create_pool(DB_DSN, min_size=1, max_size=2)) as p:
        await p.execute(
            "UPDATE public.agents SET status = 'running', updated_at = NOW() WHERE id = $1",
            agent_id,
        )

    logger.info(f"Agent {agent_id} is running on port {AGENT_PORT}")

    yield

    # Shutdown
    logger.info("Shutting down agent...")
    await prune_job.stop()
    await task_engine.stop()
    await bus.stop()
    await db.close()
    logger.info("Agent shut down complete")


# ── FastAPI App ───────────────────────────────────────────────

app = FastAPI(title="OpenClaw Agent", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Message Processing Pipeline ──────────────────────────────


async def process_message(incoming: IncomingMessage) -> str:
    """
    9-step agent processing pipeline:
    1. Receive message from gateway
    2. Find or create conversation
    3. Store incoming message
    4. Evaluate task triggers
    5. Build conversation context
    6. Call LLM
    7. Store response
    8. Log analytics
    9. Return response text
    """
    # Step 1: Find channel
    channels = await db.get_channels()
    channel = next(
        (c for c in channels if c.type.value == incoming.channel_type.value),
        None,
    )
    if not channel:
        logger.warning(f"No channel found for type {incoming.channel_type}")
        # Create a default channel entry
        channel = Channel(
            type=incoming.channel_type,
            name=f"{incoming.channel_type.value} channel",
            config={"chat_id": incoming.chat_id},
        )
        channel = await db.create_channel(channel)

    # Step 2: Find or create conversation
    is_new = False
    existing = await db.get_conversations(limit=1)
    conv = await db.get_or_create_conversation(
        channel_id=channel.id,
        chat_id=incoming.chat_id,
        participant_name=incoming.sender_name,
    )
    if conv.message_count == 0:
        is_new = True

    # Step 3: Store incoming message
    user_msg = Message(
        conversation_id=conv.id,
        role=MessageRole.USER,
        content=incoming.text,
        metadata={
            "sender_name": incoming.sender_name,
            "channel_type": incoming.channel_type.value,
        },
    )
    await db.add_message(user_msg)

    # Step 4: Evaluate task triggers
    matched_tasks = await task_engine.evaluate_message(incoming, conv.id)
    if is_new:
        await task_engine.evaluate_conversation_start(conv.id, incoming.sender_name)

    # If a task generated a reply, use that instead of calling LLM again
    # (task_executor sends replies via the reply_callback)

    # Step 5: Build conversation context
    config = await db.get_config()
    history = await db.get_messages(conv.id, limit=20)
    messages: list[dict[str, str]] = [
        {"role": "system", "content": config.system_prompt}
    ]
    for msg in history:
        messages.append({"role": msg.role.value, "content": msg.content})

    # Step 6: Call LLM
    try:
        result = await llm.chat(messages)
        response_text = result["content"]
        tokens_used = result.get("tokens_used", 0)
    except Exception as e:
        logger.error(f"LLM call failed: {e}")
        response_text = "I'm having trouble responding right now. Please try again."
        tokens_used = 0

    # Step 7: Store response
    assistant_msg = Message(
        conversation_id=conv.id,
        role=MessageRole.ASSISTANT,
        content=response_text,
        tokens_used=tokens_used,
    )
    await db.add_message(assistant_msg)

    # Step 8: Log analytics
    await db.log_event(
        AnalyticsEvent(
            event_type="message_processed",
            metadata={
                "channel_type": incoming.channel_type.value,
                "tokens_used": tokens_used,
                "task_matches": len(matched_tasks),
                "is_new_conversation": is_new,
            },
        )
    )

    # Step 9: Return response
    return response_text


async def send_reply(conversation_id: uuid.UUID, text: str) -> None:
    """Callback for task executor to send replies."""
    msg = Message(
        conversation_id=conversation_id,
        role=MessageRole.ASSISTANT,
        content=text,
    )
    await db.add_message(msg)


async def handle_bus_forward(bus_message: BusMessage) -> None:
    """Handle a forwarded message from another agent."""
    payload = bus_message.payload
    text = payload.get("text", "")
    if not text:
        return

    # Process as an internal message
    incoming = IncomingMessage(
        channel_type=ChannelType.TELEGRAM,  # Default for inter-agent
        channel_id="bus",
        chat_id=f"agent_{bus_message.source_agent_id}",
        sender_name=f"Agent {bus_message.source_agent_id}",
        text=text,
        metadata={"source": "bus", "original_payload": payload},
    )
    response = await process_message(incoming)

    # Send response back via bus
    if bus_message.source_agent_id:
        await bus.send(
            target_agent_id=bus_message.source_agent_id,
            event_type=BusEventType.TASK_RESULT,
            payload={"response": response, "original_message": text},
        )


async def handle_config_changed(bus_message: BusMessage) -> None:
    """Handle config change notification — reload LLM and tasks."""
    global llm
    config = await db.get_config()
    llm = create_llm_adapter(db, config)
    await task_engine.reload_tasks()
    logger.info("Config reloaded")


# ── API Routes: Message Handling ──────────────────────────────


@app.post("/message")
async def receive_message(request: Request) -> dict[str, Any]:
    """Receive a message from the gateway."""
    body = await request.json()
    incoming = IncomingMessage(**body)
    response = await process_message(incoming)
    return {"response": response}


# ── API Routes: Dashboard ────────────────────────────────────


@app.get("/api/config")
async def get_config():
    config = await db.get_config()
    return config.model_dump()


@app.put("/api/config")
async def update_config(request: Request):
    body = await request.json()
    config = await db.update_config(**body)
    # Notify other components
    await bus.send(
        target_agent_id=agent_id,
        event_type=BusEventType.CONFIG_CHANGED,
        payload=body,
    )
    return config.model_dump()


@app.get("/api/channels")
async def list_channels():
    channels = await db.get_channels()
    return [c.model_dump() for c in channels]


@app.post("/api/channels")
async def create_channel(request: Request):
    body = await request.json()
    channel = Channel(**body)
    created = await db.create_channel(channel)
    return created.model_dump()


@app.put("/api/channels/{channel_id}")
async def update_channel(channel_id: uuid.UUID, request: Request):
    body = await request.json()
    updated = await db.update_channel(channel_id, **body)
    if not updated:
        raise HTTPException(status_code=404, detail="Channel not found")
    return updated.model_dump()


@app.delete("/api/channels/{channel_id}")
async def delete_channel(channel_id: uuid.UUID):
    await db.delete_channel(channel_id)
    return {"success": True}


@app.get("/api/conversations")
async def list_conversations(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    starred: bool = Query(False),
    search: str = Query(None),
):
    convs = await db.get_conversations(
        limit=limit, offset=offset, starred_only=starred, search=search
    )
    return [c.model_dump() for c in convs]


@app.get("/api/conversations/{conversation_id}")
async def get_conversation(conversation_id: uuid.UUID):
    conv = await db.get_conversation(conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conv.model_dump()


@app.get("/api/conversations/{conversation_id}/messages")
async def get_messages(
    conversation_id: uuid.UUID,
    limit: int = Query(100, ge=1, le=500),
):
    messages = await db.get_messages(conversation_id, limit=limit)
    return [m.model_dump() for m in messages]


@app.put("/api/conversations/{conversation_id}/star")
async def star_conversation(conversation_id: uuid.UUID, request: Request):
    body = await request.json()
    await db.star_conversation(conversation_id, body.get("starred", True))
    return {"success": True}


@app.delete("/api/conversations/{conversation_id}")
async def delete_conversation(conversation_id: uuid.UUID):
    await db.delete_conversation(conversation_id)
    return {"success": True}


@app.post("/api/conversations/prune")
async def prune_conversations(request: Request):
    body = await request.json()
    count = await prune_job.run_prune_now(
        older_than_days=body.get("older_than_days"),
        keep_starred=body.get("keep_starred"),
    )
    return {"pruned": count}


@app.get("/api/tasks")
async def list_tasks():
    tasks = await db.get_tasks()
    return [t.model_dump() for t in tasks]


@app.post("/api/tasks")
async def create_task(request: Request):
    body = await request.json()
    task = Task(**body)
    created = await db.create_task(task)
    await task_engine.reload_tasks()
    return created.model_dump()


@app.put("/api/tasks/{task_id}")
async def update_task(task_id: uuid.UUID, request: Request):
    body = await request.json()
    updated = await db.update_task(task_id, **body)
    if not updated:
        raise HTTPException(status_code=404, detail="Task not found")
    await task_engine.reload_tasks()
    return updated.model_dump()


@app.delete("/api/tasks/{task_id}")
async def delete_task(task_id: uuid.UUID):
    await db.delete_task(task_id)
    await task_engine.reload_tasks()
    return {"success": True}


@app.post("/api/tasks/{task_id}/run")
async def run_task(task_id: uuid.UUID):
    result = await task_engine.run_manual_task(task_id)
    return result


@app.post("/api/tasks/generate")
async def generate_task(request: Request):
    """AI-generate a task from a natural language description."""
    body = await request.json()
    description = body.get("description", "")
    if not description:
        raise HTTPException(status_code=400, detail="Description required")

    prompt = f"""Create an automation task based on this description: "{description}"

Return a JSON object with these fields:
- name: short task name
- description: what it does
- trigger_type: one of keyword, schedule, agent_message, webhook, conversation_start, manual
- trigger_config: configuration for the trigger
- action_type: one of reply, api_call, agent_forward, run_prompt, notify
- action_config: configuration for the action

Return ONLY valid JSON, no explanation."""

    config = await db.get_config()
    result = await llm.chat(
        [
            {"role": "system", "content": "You generate automation task configurations."},
            {"role": "user", "content": prompt},
        ]
    )

    try:
        task_data = json.loads(result["content"])
        return task_data
    except json.JSONDecodeError:
        return {"error": "Could not generate task", "raw": result["content"]}


@app.get("/api/analytics")
async def get_analytics(
    event_type: str = Query(None),
    days: int = Query(30, ge=1, le=365),
):
    events = await db.get_analytics(event_type=event_type, days=days)
    return events


@app.get("/api/system/status")
async def system_status():
    config = await db.get_config()
    stats = await db.get_stats()
    return {
        "agent_id": str(agent_id),
        "schema": AGENT_SCHEMA,
        "status": "running",
        "config": {
            "model_provider": config.model_provider.value,
            "model": config.model,
            "auth_method": config.auth_method.value,
            "agent_name": config.agent_name,
        },
        "stats": stats,
    }


@app.get("/api/system/logs")
async def system_logs():
    """SSE stream of real-time log events."""

    async def event_stream():
        # Stream recent bus messages as log events
        messages = await bus.get_recent_messages(limit=20)
        for msg in messages:
            yield f"data: {json.dumps(msg)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/api/system/restart")
async def system_restart():
    """Signal the container orchestrator to restart this agent."""
    logger.info("Restart requested via dashboard")
    # In Docker, exiting causes a restart via restart_policy
    os.kill(os.getpid(), signal.SIGTERM)
    return {"success": True}


@app.get("/health")
async def health():
    return {
        "status": "healthy",
        "agent_id": str(agent_id),
        "schema": AGENT_SCHEMA,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


# ── Entry Point ───────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run(
        "src.main:app",
        host="0.0.0.0",
        port=AGENT_PORT,
        log_level="info",
    )
