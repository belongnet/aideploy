-- ──────────────────────────────────────────────────────────────
-- AI Deploy — Message Bus Trigger
-- Fires pg_notify on every INSERT to public.message_bus
-- Agents listen via asyncpg: LISTEN agent_bus;
-- ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION notify_message_bus()
RETURNS TRIGGER AS $$
DECLARE
    notification JSONB;
BEGIN
    notification := jsonb_build_object(
        'id',              NEW.id,
        'source_agent_id', NEW.source_agent_id,
        'target_agent_id', NEW.target_agent_id,
        'channel',         NEW.channel,
        'event_type',      NEW.event_type,
        'created_at',      NEW.created_at
    );

    -- Notify on the channel name (agent_bus, system_bus, or dashboard_bus)
    PERFORM pg_notify(NEW.channel, notification::text);

    -- Also notify on a per-agent channel if targeted
    IF NEW.target_agent_id IS NOT NULL THEN
        PERFORM pg_notify(
            'agent_' || NEW.target_agent_id::text,
            notification::text
        );
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop and recreate to ensure latest version
DROP TRIGGER IF EXISTS trg_message_bus_notify ON public.message_bus;

CREATE TRIGGER trg_message_bus_notify
    AFTER INSERT ON public.message_bus
    FOR EACH ROW
    EXECUTE FUNCTION notify_message_bus();

-- ──────────────────────────────────────────────────────────────
-- Helper: Send a bus message (convenience function)
-- ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION send_bus_message(
    p_source_agent_id UUID,
    p_target_agent_id UUID,  -- NULL for broadcast
    p_channel         TEXT DEFAULT 'agent_bus',
    p_event_type      TEXT DEFAULT 'message_forward',
    p_payload         JSONB DEFAULT '{}'
) RETURNS BIGINT AS $$
DECLARE
    v_message_id BIGINT;
BEGIN
    INSERT INTO public.message_bus (
        source_agent_id, target_agent_id, channel, event_type, payload
    ) VALUES (
        p_source_agent_id, p_target_agent_id, p_channel, p_event_type, p_payload
    ) RETURNING id INTO v_message_id;

    RETURN v_message_id;
END;
$$ LANGUAGE plpgsql;

-- ──────────────────────────────────────────────────────────────
-- Mark message as delivered
-- ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION mark_bus_delivered(p_message_id BIGINT)
RETURNS VOID AS $$
BEGIN
    UPDATE public.message_bus
    SET status = 'delivered'
    WHERE id = p_message_id AND status = 'pending';
END;
$$ LANGUAGE plpgsql;

-- ──────────────────────────────────────────────────────────────
-- Cleanup old delivered messages (run periodically)
-- ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION cleanup_bus_messages(p_older_than_days INT DEFAULT 7)
RETURNS INT AS $$
DECLARE
    v_count INT;
BEGIN
    DELETE FROM public.message_bus
    WHERE status = 'delivered'
      AND created_at < NOW() - (p_older_than_days || ' days')::INTERVAL;

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql;
