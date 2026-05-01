-- Backup target inventory, backup run metadata, artifacts, and restore audit trail.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS public.backup_targets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider        TEXT NOT NULL,
    native_provider TEXT,
    bucket          TEXT NOT NULL,
    prefix          TEXT NOT NULL DEFAULT '',
    region          TEXT,
    endpoint        TEXT,
    credentials_ref TEXT,
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (provider, bucket, prefix)
);

CREATE TABLE IF NOT EXISTS public.backup_runs (
    id              TEXT PRIMARY KEY,
    target_id       UUID REFERENCES public.backup_targets(id) ON DELETE SET NULL,
    mode            TEXT NOT NULL CHECK (mode IN ('full', 'incremental')),
    status          TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    provider        TEXT NOT NULL,
    native_provider TEXT,
    bucket          TEXT NOT NULL,
    prefix          TEXT NOT NULL DEFAULT '',
    archive_root    TEXT NOT NULL DEFAULT '',
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    error           TEXT NOT NULL DEFAULT '',
    manifest        JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS public.backup_artifacts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    backup_run_id   TEXT NOT NULL REFERENCES public.backup_runs(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    type            TEXT NOT NULL DEFAULT '',
    remote_path     TEXT NOT NULL,
    bytes           BIGINT NOT NULL DEFAULT 0,
    sha256          TEXT NOT NULL DEFAULT '',
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (backup_run_id, name)
);

CREATE TABLE IF NOT EXISTS public.restore_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    backup_run_id   TEXT REFERENCES public.backup_runs(id) ON DELETE SET NULL,
    restore_mode    TEXT NOT NULL DEFAULT 'full'
                    CHECK (restore_mode IN ('full', 'merge')),
    status          TEXT NOT NULL DEFAULT 'requested'
                    CHECK (status IN ('requested', 'running', 'completed', 'failed', 'cancelled')),
    requested_by    TEXT NOT NULL DEFAULT 'dashboard',
    requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    error           TEXT NOT NULL DEFAULT '',
    plan            JSONB NOT NULL DEFAULT '{}',
    diff            JSONB NOT NULL DEFAULT '{}',
    result          JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_backup_runs_status ON public.backup_runs(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_backup_runs_mode ON public.backup_runs(mode, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_backup_artifacts_run ON public.backup_artifacts(backup_run_id);
CREATE INDEX IF NOT EXISTS idx_restore_runs_status ON public.restore_runs(status, requested_at DESC);
