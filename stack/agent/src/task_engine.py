"""
OpenClaw Agent — Task Engine.

Evaluates triggers against incoming messages and events,
and dispatches matching tasks to the executor.

Trigger types:
  - keyword: matches words/phrases in message text
  - schedule: cron-based execution
  - agent_message: triggered by bus messages from other agents
  - webhook: triggered by external webhook calls
  - conversation_start: fires on new conversations
  - manual: triggered via dashboard

Action types:
  - reply: send an LLM-generated reply
  - api_call: make an HTTP request
  - agent_forward: forward to another agent via bus
  - run_prompt: run a specific prompt through the LLM
  - notify: send a notification via channel
  - file_write: write a site file in the agent workspace
  - serve_website: return the public URL for a workspace site
"""

from __future__ import annotations

import logging
import re
import uuid
from typing import Any, Optional

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from .db import Database
from .models import (
    ActionType,
    BusMessage,
    IncomingMessage,
    Task,
    TriggerType,
)
from .task_executor import TaskExecutor

logger = logging.getLogger(__name__)


class TaskEngine:
    """Evaluates incoming events against task triggers and dispatches actions."""

    def __init__(self, db: Database, executor: TaskExecutor):
        self.db = db
        self.executor = executor
        self.scheduler = AsyncIOScheduler()
        self._tasks: list[Task] = []

    async def start(self) -> None:
        """Load tasks and start scheduled triggers."""
        await self.reload_tasks()
        self.scheduler.start()
        logger.info(f"Task engine started with {len(self._tasks)} active tasks")

    async def stop(self) -> None:
        """Stop the task engine."""
        self.scheduler.shutdown(wait=False)
        logger.info("Task engine stopped")

    async def reload_tasks(self) -> None:
        """Reload all tasks from the database and update schedules."""
        self._tasks = await self.db.get_tasks(enabled_only=True)

        # Clear and re-register scheduled tasks
        for job in self.scheduler.get_jobs():
            if job.id.startswith("task_schedule_"):
                job.remove()

        for task in self._tasks:
            if task.trigger_type == TriggerType.SCHEDULE:
                self._register_schedule(task)

    def _register_schedule(self, task: Task) -> None:
        """Register a cron-scheduled task."""
        cron_config = task.trigger_config.get("cron", {})
        if not cron_config:
            return

        self.scheduler.add_job(
            self._execute_scheduled_task,
            trigger="cron",
            id=f"task_schedule_{task.id}",
            replace_existing=True,
            kwargs={"task_id": task.id},
            **cron_config,
        )
        logger.debug(f"Registered schedule for task '{task.name}': {cron_config}")

    async def _execute_scheduled_task(self, task_id: uuid.UUID) -> None:
        """Execute a scheduled task."""
        task = await self.db.get_task(task_id)
        if not task or not task.enabled:
            return
        await self._run_with_circuit_breaker(
            task, context={"trigger": "schedule"}
        )

    async def _run_with_circuit_breaker(
        self, task: Task, context: dict[str, Any]
    ) -> Optional[dict[str, Any]]:
        """Execute a task, tracking consecutive errors and auto-disabling
        after `auto_disable_threshold` consecutive failures.

        A runaway task (LLM timeouts, dead upstream API) would otherwise keep
        announcing errors every cron tick. Pausing it gives the operator time
        to fix the root cause instead of spamming the delivery channel.
        """
        try:
            result = await self.executor.execute(task, context=context)
        except Exception as exc:
            await self._record_failure(task, repr(exc))
            logger.error("Task '%s' failed: %s", task.name, exc)
            raise

        await self.db.increment_task_run(task.id)
        return result

    async def _record_failure(self, task: Task, error: str) -> None:
        updated = await self.db.record_task_failure(task.id, error)
        if not updated:
            return
        threshold = updated.auto_disable_threshold or 0
        if threshold > 0 and updated.consecutive_errors >= threshold:
            reason = (
                f"Auto-disabled after {updated.consecutive_errors} consecutive "
                f"errors. Last error: {error}"
            )
            await self.db.auto_disable_task(task.id, reason)
            logger.warning(
                "Task '%s' auto-disabled after %d consecutive errors",
                task.name,
                updated.consecutive_errors,
            )
            await self._reload_after_disable(task.id)

    async def _reload_after_disable(self, task_id: uuid.UUID) -> None:
        """Drop the disabled task's scheduler job so the next tick doesn't
        retry. reload_tasks would also work but rebuilding every schedule on
        each failure is overkill."""
        job_id = f"task_schedule_{task_id}"
        job = self.scheduler.get_job(job_id)
        if job:
            job.remove()
        self._tasks = [t for t in self._tasks if t.id != task_id]

    async def evaluate_message(
        self, message: IncomingMessage, conversation_id: uuid.UUID
    ) -> list[Task]:
        """Evaluate an incoming message against all active task triggers.
        Returns list of tasks that matched."""
        matched: list[Task] = []

        for task in self._tasks:
            if await self._matches_trigger(task, message, conversation_id):
                matched.append(task)

        # Execute matched tasks
        for task in matched:
            context = {
                "trigger": "message",
                "message": message.text,
                "sender": message.sender_name,
                "channel_type": message.channel_type.value,
                "conversation_id": str(conversation_id),
            }
            try:
                await self._run_with_circuit_breaker(task, context=context)
            except Exception:
                pass  # logged inside _run_with_circuit_breaker

        return matched

    async def evaluate_bus_message(self, bus_message: BusMessage) -> list[Task]:
        """Evaluate a bus message against agent_message triggers."""
        matched: list[Task] = []

        for task in self._tasks:
            if task.trigger_type != TriggerType.AGENT_MESSAGE:
                continue

            # Check if the bus message matches the trigger config
            source_filter = task.trigger_config.get("source_agent_id")
            event_filter = task.trigger_config.get("event_type")

            if source_filter and str(bus_message.source_agent_id) != source_filter:
                continue
            if event_filter and bus_message.event_type.value != event_filter:
                continue

            matched.append(task)

        for task in matched:
            context = {
                "trigger": "agent_message",
                "source_agent_id": str(bus_message.source_agent_id),
                "event_type": bus_message.event_type.value,
                "payload": bus_message.payload,
            }
            try:
                await self._run_with_circuit_breaker(task, context=context)
            except Exception:
                pass

        return matched

    async def evaluate_conversation_start(
        self, conversation_id: uuid.UUID, participant_name: str
    ) -> list[Task]:
        """Evaluate conversation_start triggers."""
        matched: list[Task] = []

        for task in self._tasks:
            if task.trigger_type != TriggerType.CONVERSATION_START:
                continue
            matched.append(task)

        for task in matched:
            context = {
                "trigger": "conversation_start",
                "conversation_id": str(conversation_id),
                "participant_name": participant_name,
            }
            try:
                await self._run_with_circuit_breaker(task, context=context)
            except Exception:
                pass

        return matched

    async def run_manual_task(self, task_id: uuid.UUID) -> dict[str, Any]:
        """Manually trigger a task from the dashboard."""
        task = await self.db.get_task(task_id)
        if not task:
            raise ValueError(f"Task {task_id} not found")

        result = await self._run_with_circuit_breaker(
            task, context={"trigger": "manual"}
        )
        return result or {}

    async def _matches_trigger(
        self,
        task: Task,
        message: IncomingMessage,
        conversation_id: uuid.UUID,
    ) -> bool:
        """Check if a message matches a task's trigger."""
        match task.trigger_type:
            case TriggerType.KEYWORD:
                return self._matches_keyword(task, message.text)
            case TriggerType.CONVERSATION_START:
                # Handled separately
                return False
            case TriggerType.AGENT_MESSAGE:
                # Handled separately
                return False
            case TriggerType.SCHEDULE:
                # Handled by scheduler
                return False
            case TriggerType.WEBHOOK:
                # Handled by webhook endpoint
                return False
            case TriggerType.MANUAL:
                # Only triggered manually
                return False
            case _:
                return False

    def _matches_keyword(self, task: Task, text: str) -> bool:
        """Check if message text matches keyword trigger config."""
        keywords = task.trigger_config.get("keywords", [])
        match_mode = task.trigger_config.get("match", "any")  # any | all | regex
        case_sensitive = task.trigger_config.get("case_sensitive", False)

        if not keywords:
            return False

        check_text = text if case_sensitive else text.lower()

        if match_mode == "regex":
            pattern = keywords[0]
            flags = 0 if case_sensitive else re.IGNORECASE
            return bool(re.search(pattern, text, flags))

        normalized_keywords = (
            keywords if case_sensitive else [k.lower() for k in keywords]
        )

        if match_mode == "all":
            return all(kw in check_text for kw in normalized_keywords)
        else:  # "any"
            return any(kw in check_text for kw in normalized_keywords)
