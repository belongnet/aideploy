-- ──────────────────────────────────────────────────────────────
-- AI Deploy — Database Initialization
-- Creates shared tables and per-agent schema template
-- ──────────────────────────────────────────────────────────────

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS vector;

-- ══════════════════════════════════════════════════════════════
-- SHARED TABLES (public schema)
-- ══════════════════════════════════════════════════════════════

-- Agent registry
CREATE TABLE IF NOT EXISTS public.agents (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            TEXT NOT NULL,
    schema_name     TEXT NOT NULL UNIQUE,
    dashboard_port  INT NOT NULL,
    gateway_port    INT NOT NULL,
    agent_port      INT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'stopped'
                    CHECK (status IN ('running', 'stopped', 'error')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agents_status ON public.agents(status);

-- Inter-agent message bus
CREATE TABLE IF NOT EXISTS public.message_bus (
    id              BIGSERIAL PRIMARY KEY,
    source_agent_id UUID REFERENCES public.agents(id) ON DELETE CASCADE,
    target_agent_id UUID REFERENCES public.agents(id) ON DELETE SET NULL,
    channel         TEXT NOT NULL DEFAULT 'agent_bus'
                    CHECK (channel IN ('agent_bus', 'system_bus', 'dashboard_bus')),
    event_type      TEXT NOT NULL
                    CHECK (event_type IN (
                        'message_forward', 'task_result', 'health',
                        'agent_started', 'agent_stopped', 'config_changed',
                        'channel_event', 'broadcast'
                    )),
    payload         JSONB NOT NULL DEFAULT '{}',
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'delivered', 'failed')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_message_bus_target ON public.message_bus(target_agent_id, status);
CREATE INDEX IF NOT EXISTS idx_message_bus_channel ON public.message_bus(channel, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_bus_created ON public.message_bus(created_at DESC);

-- Deployment metadata
CREATE TABLE IF NOT EXISTS public.deploy_info (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    deploy_id       TEXT NOT NULL UNIQUE,
    cloud_provider  TEXT NOT NULL,
    region          TEXT NOT NULL,
    server_size     TEXT NOT NULL,
    server_ip       TEXT,
    tailscale_ip    TEXT,
    agent_count     INT NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backup target inventory and recovery audit trail
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

-- ══════════════════════════════════════════════════════════════
-- PER-AGENT SCHEMA TEMPLATE
-- Called by provisioner for each agent: SELECT create_agent_schema('agent_1', ...);
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION create_agent_schema(
    p_schema_name   TEXT,
    p_agent_name    TEXT,
    p_agent_id      UUID DEFAULT uuid_generate_v4(),
    p_dashboard_port INT DEFAULT 3001,
    p_gateway_port   INT DEFAULT 8081,
    p_agent_port     INT DEFAULT 8101
) RETURNS UUID AS $$
DECLARE
    v_agent_id UUID := p_agent_id;
BEGIN
    -- Register agent
    INSERT INTO public.agents (id, name, schema_name, dashboard_port, gateway_port, agent_port, status)
    VALUES (v_agent_id, p_agent_name, p_schema_name, p_dashboard_port, p_gateway_port, p_agent_port, 'stopped')
    ON CONFLICT (schema_name) DO UPDATE SET
        name = EXCLUDED.name,
        dashboard_port = EXCLUDED.dashboard_port,
        gateway_port = EXCLUDED.gateway_port,
        agent_port = EXCLUDED.agent_port,
        updated_at = NOW();

    -- Create isolated schema
    EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I', p_schema_name);

    -- Agent configuration
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.agent_config (
            id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            model_provider  TEXT NOT NULL DEFAULT ''openai''
                            CHECK (model_provider IN (''openai'', ''anthropic'', ''gemini'', ''kimi'')),
            auth_method     TEXT NOT NULL DEFAULT ''oauth''
                            CHECK (auth_method IN (''oauth'', ''api_key'')),
            model           TEXT NOT NULL DEFAULT ''gpt-5.5'',
            system_prompt   TEXT NOT NULL DEFAULT ''You are a helpful AI assistant.'',
            agent_name      TEXT NOT NULL DEFAULT ''My Agent'',
            temperature     REAL NOT NULL DEFAULT 0.7,
            max_tokens      INT NOT NULL DEFAULT 4096,
            prune_enabled   BOOLEAN NOT NULL DEFAULT true,
            prune_after_days INT NOT NULL DEFAULT 90,
            prune_keep_starred BOOLEAN NOT NULL DEFAULT true,
            memory_enabled  BOOLEAN NOT NULL DEFAULT true,
            memory_provider TEXT NOT NULL DEFAULT ''supabase''
                            CHECK (memory_provider IN (''supabase'', ''mem0'', ''none'')),
            memory_capture_mode TEXT NOT NULL DEFAULT ''async''
                            CHECK (memory_capture_mode IN (''async'', ''off'')),
            memory_recall_top_k INT NOT NULL DEFAULT 5,
            memory_similarity_threshold REAL NOT NULL DEFAULT 0.25,
            knowledge_provider TEXT NOT NULL DEFAULT ''none''
                            CHECK (knowledge_provider IN (''none'', ''qmd'')),
            knowledge_collections TEXT[] NOT NULL DEFAULT ''{}'',
            autonomous_mode BOOLEAN NOT NULL DEFAULT true,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    ', p_schema_name);

    -- Backfill for existing agent schemas that predate autonomous_mode.
    EXECUTE format('
        ALTER TABLE %I.agent_config
            ADD COLUMN IF NOT EXISTS autonomous_mode BOOLEAN NOT NULL DEFAULT true
    ', p_schema_name);

    -- OAuth tokens (encrypted at rest)
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.oauth_tokens (
            id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            provider        TEXT NOT NULL
                            CHECK (provider IN (''openai'', ''anthropic'')),
            access_token_enc  TEXT NOT NULL,
            refresh_token_enc TEXT NOT NULL,
            expires_at      TIMESTAMPTZ NOT NULL,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (provider)
        )
    ', p_schema_name);

    -- API keys (encrypted at rest)
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.api_keys (
            id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            provider        TEXT NOT NULL
                            CHECK (provider IN (''openai'', ''anthropic'', ''gemini'', ''kimi'')),
            api_key_enc     TEXT NOT NULL,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (provider)
        )
    ', p_schema_name);

    -- Messaging channels
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.channels (
            id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            type            TEXT NOT NULL
                            CHECK (type IN (''telegram'', ''whatsapp'', ''slack'')),
            name            TEXT NOT NULL,
            config          JSONB NOT NULL DEFAULT ''{}'',
            webhook_url     TEXT,
            status          TEXT NOT NULL DEFAULT ''active''
                            CHECK (status IN (''active'', ''inactive'', ''error'')),
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    ', p_schema_name);

    -- Conversations
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.conversations (
            id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            channel_id      UUID NOT NULL,
            external_chat_id TEXT NOT NULL,
            title           TEXT,
            participant_name TEXT,
            starred         BOOLEAN NOT NULL DEFAULT false,
            message_count   INT NOT NULL DEFAULT 0,
            last_message_at TIMESTAMPTZ,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    ', p_schema_name);

    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_conv_channel ON %I.conversations(channel_id)', p_schema_name, p_schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_conv_starred ON %I.conversations(starred) WHERE starred = true', p_schema_name, p_schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_conv_last_msg ON %I.conversations(last_message_at DESC)', p_schema_name, p_schema_name);

    -- Messages
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.messages (
            id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            conversation_id UUID NOT NULL,
            role            TEXT NOT NULL CHECK (role IN (''user'', ''assistant'', ''system'')),
            content         TEXT NOT NULL,
            metadata        JSONB DEFAULT ''{}'',
            tokens_used     INT,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    ', p_schema_name);

    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_msg_conv ON %I.messages(conversation_id, created_at)', p_schema_name, p_schema_name);

    -- Long-term memory
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.memory_items (
            id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            user_key        TEXT NOT NULL,
            scope           TEXT NOT NULL DEFAULT ''long_term''
                            CHECK (scope IN (''long_term'', ''session'')),
            conversation_id UUID,
            source_message_id UUID,
            content         TEXT NOT NULL,
            summary         TEXT NOT NULL,
            content_sha256  TEXT NOT NULL,
            metadata        JSONB NOT NULL DEFAULT ''{}'',
            forgotten_at    TIMESTAMPTZ,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    ', p_schema_name);

    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.memory_embeddings (
            memory_id       UUID PRIMARY KEY REFERENCES %I.memory_items(id) ON DELETE CASCADE,
            embedding       vector(256) NOT NULL,
            embedding_model TEXT NOT NULL DEFAULT ''hash-v1'',
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    ', p_schema_name, p_schema_name);

    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.memory_capture_jobs (
            id              BIGSERIAL PRIMARY KEY,
            user_key        TEXT NOT NULL,
            conversation_id UUID,
            status          TEXT NOT NULL DEFAULT ''pending''
                            CHECK (status IN (''pending'', ''running'', ''completed'', ''skipped'', ''failed'')),
            payload         JSONB NOT NULL DEFAULT ''{}'',
            memory_id       UUID,
            last_error      TEXT,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    ', p_schema_name);

    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.memory_audit_log (
            id              BIGSERIAL PRIMARY KEY,
            memory_id       UUID,
            action          TEXT NOT NULL,
            metadata        JSONB NOT NULL DEFAULT ''{}'',
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    ', p_schema_name);

    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_memory_user ON %I.memory_items(user_key, scope, created_at DESC)', p_schema_name, p_schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_memory_conversation ON %I.memory_items(conversation_id, created_at DESC)', p_schema_name, p_schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_memory_jobs_status ON %I.memory_capture_jobs(status, created_at DESC)', p_schema_name, p_schema_name);

    -- Tasks (automation rules)
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.tasks (
            id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            name            TEXT NOT NULL,
            description     TEXT,
            enabled         BOOLEAN NOT NULL DEFAULT true,
            trigger_type    TEXT NOT NULL
                            CHECK (trigger_type IN (
                                ''keyword'', ''schedule'', ''agent_message'',
                                ''webhook'', ''conversation_start'', ''manual''
                            )),
            trigger_config  JSONB NOT NULL DEFAULT ''{}'',
            action_type     TEXT NOT NULL
                            CHECK (action_type IN (
                                ''reply'', ''api_call'', ''agent_forward'',
                                ''run_prompt'', ''notify'',
                                ''file_write'', ''serve_website''
                            )),
            action_config   JSONB NOT NULL DEFAULT ''{}'',
            auto_approve    BOOLEAN NOT NULL DEFAULT true,
            run_count       INT NOT NULL DEFAULT 0,
            last_run_at     TIMESTAMPTZ,
            consecutive_errors INT NOT NULL DEFAULT 0,
            last_error      TEXT,
            auto_disable_threshold INT NOT NULL DEFAULT 5,
            auto_disabled_at TIMESTAMPTZ,
            auto_disabled_reason TEXT,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    ', p_schema_name);

    -- Backfill for existing agent schemas.
    EXECUTE format('
        ALTER TABLE %I.tasks
            ADD COLUMN IF NOT EXISTS auto_approve BOOLEAN NOT NULL DEFAULT true,
            ADD COLUMN IF NOT EXISTS consecutive_errors INT NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS last_error TEXT,
            ADD COLUMN IF NOT EXISTS auto_disable_threshold INT NOT NULL DEFAULT 5,
            ADD COLUMN IF NOT EXISTS auto_disabled_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS auto_disabled_reason TEXT
    ', p_schema_name);
    -- Widen action_type CHECK constraint for older schemas.
    EXECUTE format('
        ALTER TABLE %I.tasks DROP CONSTRAINT IF EXISTS tasks_action_type_check
    ', p_schema_name);
    EXECUTE format('
        ALTER TABLE %I.tasks ADD CONSTRAINT tasks_action_type_check
            CHECK (action_type IN (
                ''reply'', ''api_call'', ''agent_forward'',
                ''run_prompt'', ''notify'',
                ''file_write'', ''serve_website''
            ))
    ', p_schema_name);

    -- Analytics events
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.analytics_events (
            id              BIGSERIAL PRIMARY KEY,
            event_type      TEXT NOT NULL,
            metadata        JSONB DEFAULT ''{}'',
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    ', p_schema_name);

    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_analytics_type ON %I.analytics_events(event_type, created_at DESC)', p_schema_name, p_schema_name);

    RETURN v_agent_id;
END;
$$ LANGUAGE plpgsql;

-- ══════════════════════════════════════════════════════════════
-- UPDATED_AT TRIGGER (reusable)
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to shared tables
CREATE TRIGGER trg_agents_updated_at
    BEFORE UPDATE ON public.agents
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ══════════════════════════════════════════════════════════════
-- SUPABASE REALTIME — publish shared tables for live subscriptions
-- ══════════════════════════════════════════════════════════════

-- Agents table: dashboard subscribes to status changes
ALTER TABLE public.agents REPLICA IDENTITY FULL;

-- Message bus: dashboard subscribes to new bus events
ALTER TABLE public.message_bus REPLICA IDENTITY FULL;

-- Deploy info: dashboard subscribes to deployment updates
ALTER TABLE public.deploy_info REPLICA IDENTITY FULL;

-- Add tables to the Supabase Realtime publication
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.agents;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN
    CREATE PUBLICATION supabase_realtime FOR TABLE public.agents;
END;
$$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.message_bus;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.message_bus;
END;
$$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.deploy_info;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.deploy_info;
END;
$$;
