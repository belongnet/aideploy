-- ──────────────────────────────────────────────────────────────
-- OpenClaw Agent Launcher — Memory Migration
-- Aligns fresh databases with the runtime memory schema.
-- ──────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS vector;

DO $$
DECLARE
    schema_record RECORD;
BEGIN
    FOR schema_record IN
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name LIKE 'agent_%'
    LOOP
        EXECUTE format('
            ALTER TABLE %I.agent_config
                ADD COLUMN IF NOT EXISTS memory_enabled BOOLEAN NOT NULL DEFAULT true,
                ADD COLUMN IF NOT EXISTS memory_provider TEXT NOT NULL DEFAULT ''supabase'',
                ADD COLUMN IF NOT EXISTS memory_capture_mode TEXT NOT NULL DEFAULT ''async'',
                ADD COLUMN IF NOT EXISTS memory_recall_top_k INT NOT NULL DEFAULT 5,
                ADD COLUMN IF NOT EXISTS memory_similarity_threshold REAL NOT NULL DEFAULT 0.25,
                ADD COLUMN IF NOT EXISTS knowledge_provider TEXT NOT NULL DEFAULT ''none'',
                ADD COLUMN IF NOT EXISTS knowledge_collections TEXT[] NOT NULL DEFAULT ''{}''
        ', schema_record.schema_name);

        EXECUTE format('
            CREATE TABLE IF NOT EXISTS %I.memory_items (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                user_key TEXT NOT NULL,
                scope TEXT NOT NULL DEFAULT ''long_term''
                    CHECK (scope IN (''long_term'', ''session'')),
                conversation_id UUID,
                source_message_id UUID,
                content TEXT NOT NULL,
                summary TEXT NOT NULL,
                content_sha256 TEXT NOT NULL,
                metadata JSONB NOT NULL DEFAULT ''{}'',
                forgotten_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        ', schema_record.schema_name);

        EXECUTE format('
            CREATE TABLE IF NOT EXISTS %I.memory_embeddings (
                memory_id UUID PRIMARY KEY REFERENCES %I.memory_items(id) ON DELETE CASCADE,
                embedding vector(256) NOT NULL,
                embedding_model TEXT NOT NULL DEFAULT ''hash-v1'',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        ', schema_record.schema_name, schema_record.schema_name);

        EXECUTE format('
            CREATE TABLE IF NOT EXISTS %I.memory_capture_jobs (
                id BIGSERIAL PRIMARY KEY,
                user_key TEXT NOT NULL,
                conversation_id UUID,
                status TEXT NOT NULL DEFAULT ''pending''
                    CHECK (status IN (''pending'', ''running'', ''completed'', ''skipped'', ''failed'')),
                payload JSONB NOT NULL DEFAULT ''{}'',
                memory_id UUID,
                last_error TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        ', schema_record.schema_name);

        EXECUTE format('
            CREATE TABLE IF NOT EXISTS %I.memory_audit_log (
                id BIGSERIAL PRIMARY KEY,
                memory_id UUID,
                action TEXT NOT NULL,
                metadata JSONB NOT NULL DEFAULT ''{}'',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        ', schema_record.schema_name);

        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS idx_%s_memory_user ON %I.memory_items(user_key, scope, created_at DESC)',
            schema_record.schema_name,
            schema_record.schema_name
        );
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS idx_%s_memory_conversation ON %I.memory_items(conversation_id, created_at DESC)',
            schema_record.schema_name,
            schema_record.schema_name
        );
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS idx_%s_memory_jobs_status ON %I.memory_capture_jobs(status, created_at DESC)',
            schema_record.schema_name,
            schema_record.schema_name
        );

        EXECUTE format(
            'UPDATE %I.agent_config SET memory_provider = ''supabase'' WHERE memory_provider = ''postgres''',
            schema_record.schema_name
        );
    END LOOP;
END;
$$;
