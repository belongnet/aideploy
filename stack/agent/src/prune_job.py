"""
OpenClaw Agent — Conversation Prune Job.

Runs on a schedule (daily at 3 AM) to clean up old conversations
based on the agent's prune settings in the dashboard.

Settings:
  - prune_enabled: master toggle
  - prune_after_days: delete conversations older than N days (default 90)
  - prune_keep_starred: never delete starred conversations (default true)
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from .db import Database
from .models import AnalyticsEvent

logger = logging.getLogger(__name__)


class PruneJob:
    """Scheduled job that prunes old conversations."""

    def __init__(self, db: Database):
        self.db = db
        self.scheduler = AsyncIOScheduler()

    async def start(self) -> None:
        """Start the prune scheduler."""
        # Run daily at 3:00 AM UTC
        self.scheduler.add_job(
            self.run_prune,
            trigger="cron",
            hour=3,
            minute=0,
            id="conversation_prune",
            replace_existing=True,
        )
        self.scheduler.start()
        logger.info("Prune job scheduler started (daily at 03:00 UTC)")

    async def stop(self) -> None:
        """Stop the scheduler."""
        self.scheduler.shutdown(wait=False)
        logger.info("Prune job scheduler stopped")

    async def run_prune(self) -> int:
        """Execute the prune operation based on current config."""
        config = await self.db.get_config()

        if not config.prune_enabled:
            logger.info("Prune is disabled, skipping")
            return 0

        logger.info(
            f"Starting prune: older than {config.prune_after_days} days, "
            f"keep starred: {config.prune_keep_starred}"
        )

        pruned_count = await self.db.prune_conversations(
            older_than_days=config.prune_after_days,
            keep_starred=config.prune_keep_starred,
        )

        logger.info(f"Pruned {pruned_count} conversations")

        # Log analytics event
        await self.db.log_event(
            AnalyticsEvent(
                event_type="conversation_prune",
                metadata={
                    "pruned_count": pruned_count,
                    "older_than_days": config.prune_after_days,
                    "keep_starred": config.prune_keep_starred,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                },
            )
        )

        return pruned_count

    async def run_prune_now(
        self,
        older_than_days: int | None = None,
        keep_starred: bool | None = None,
    ) -> int:
        """Run prune immediately with optional overrides (for dashboard "Clean up now" button)."""
        config = await self.db.get_config()

        days = older_than_days if older_than_days is not None else config.prune_after_days
        keep = keep_starred if keep_starred is not None else config.prune_keep_starred

        logger.info(f"Manual prune: older than {days} days, keep starred: {keep}")

        pruned_count = await self.db.prune_conversations(
            older_than_days=days,
            keep_starred=keep,
        )

        logger.info(f"Manual prune complete: {pruned_count} conversations removed")

        await self.db.log_event(
            AnalyticsEvent(
                event_type="conversation_prune_manual",
                metadata={
                    "pruned_count": pruned_count,
                    "older_than_days": days,
                    "keep_starred": keep,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                },
            )
        )

        return pruned_count


# ── Bus Message Cleanup ──────────────────────────────────────


class BusCleanupJob:
    """Cleans up old delivered bus messages weekly."""

    def __init__(self, dsn: str):
        self.dsn = dsn
        self.scheduler = AsyncIOScheduler()

    async def start(self) -> None:
        import asyncpg

        self.pool = await asyncpg.create_pool(self.dsn, min_size=1, max_size=2)
        self.scheduler.add_job(
            self.cleanup,
            trigger="cron",
            day_of_week="sun",
            hour=4,
            minute=0,
            id="bus_cleanup",
            replace_existing=True,
        )
        self.scheduler.start()
        logger.info("Bus cleanup job started (weekly on Sundays at 04:00 UTC)")

    async def stop(self) -> None:
        self.scheduler.shutdown(wait=False)
        if hasattr(self, "pool"):
            await self.pool.close()

    async def cleanup(self) -> int:
        count = await self.pool.fetchval("SELECT cleanup_bus_messages(7)")
        logger.info(f"Bus cleanup: removed {count} old messages")
        return count or 0
