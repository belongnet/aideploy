-- ──────────────────────────────────────────────────────────────
-- AI Deploy — Seed Data
-- Called by the provisioner after init.sql and bus_trigger.sql.
-- Uses environment variables injected at deploy time.
-- ──────────────────────────────────────────────────────────────

-- This file is a template. The provisioner replaces placeholders
-- before execution. Placeholders use {{VARIABLE}} syntax.

-- ── Create agent schemas ──────────────────────────────────────
-- The provisioner generates one call per agent, e.g.:

-- SELECT create_agent_schema(
--     'agent_1',           -- schema name
--     'My First Agent',    -- display name
--     uuid_generate_v4(),  -- agent ID
--     3001,                -- dashboard port
--     8081,                -- gateway port
--     8101                 -- agent port
-- );

-- ── Insert deployment info ────────────────────────────────────

-- INSERT INTO public.deploy_info (
--     deploy_id, cloud_provider, region, server_size, agent_count
-- ) VALUES (
--     '{{DEPLOY_ID}}',
--     '{{CLOUD_PROVIDER}}',
--     '{{REGION}}',
--     '{{SERVER_SIZE}}',
--     {{AGENT_COUNT}}
-- );

-- ══════════════════════════════════════════════════════════════
-- SEED FUNCTION (called programmatically by provisioner)
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION seed_deployment(
    p_deploy_id       TEXT,
    p_cloud_provider  TEXT,
    p_region          TEXT,
    p_server_size     TEXT,
    p_agent_count     INT,
    p_agents          JSONB  -- Array of {name, schema_name, model_provider, auth_method, model}
) RETURNS VOID AS $$
DECLARE
    v_agent       JSONB;
    v_agent_id    UUID;
    v_index       INT := 0;
BEGIN
    -- Store deployment info
    INSERT INTO public.deploy_info (
        deploy_id, cloud_provider, region, server_size, agent_count
    ) VALUES (
        p_deploy_id, p_cloud_provider, p_region, p_server_size, p_agent_count
    ) ON CONFLICT (deploy_id) DO UPDATE SET
        agent_count = EXCLUDED.agent_count;

    -- Create each agent schema
    FOR v_agent IN SELECT * FROM jsonb_array_elements(p_agents)
    LOOP
        v_agent_id := create_agent_schema(
            v_agent->>'schema_name',
            v_agent->>'name',
            COALESCE((v_agent->>'id')::UUID, uuid_generate_v4()),
            3001 + v_index,
            8081 + v_index,
            8101 + v_index
        );

        -- Set agent config
        EXECUTE format('
            INSERT INTO %I.agent_config (
                model_provider, auth_method, model, agent_name
            ) VALUES ($1, $2, $3, $4)
            ON CONFLICT DO NOTHING
        ', v_agent->>'schema_name')
        USING
            v_agent->>'model_provider',
            v_agent->>'auth_method',
            v_agent->>'model',
            v_agent->>'name';

        v_index := v_index + 1;
    END LOOP;
END;
$$ LANGUAGE plpgsql;
