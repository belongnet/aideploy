/**
 * OpenClaw Master Dashboard — Agents API
 *
 * GET  /api/agents          → list all agents with config, channels, health
 * GET  /api/agents?id=<uuid> → single agent detail (with conversations + bus msgs)
 * POST /api/agents          → perform actions (restart, stop, start, restart_all)
 *
 * Connects to the shared Postgres database (same DB as agents use).
 * Falls back to mock data when the database is not available so the
 * dashboard can still render during development.
 */

import { NextRequest, NextResponse } from "next/server";
import type {
  Agent,
  AgentConfig,
  ChannelSummary,
  ConversationPreview,
  BusMessage,
} from "@/lib/types";

/* ------------------------------------------------------------------ */
/*  Database connection helper                                          */
/* ------------------------------------------------------------------ */

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://openclaw:openclaw@localhost:5432/openclaw";

/**
 * Execute a SQL query against Postgres.
 * In production this would use pg or a pooler; here we shell out to psql
 * if pg is not installed, or use the pg module when available.
 *
 * For portability we attempt a dynamic import of 'pg'. If unavailable,
 * we return mock data so the UI remains functional.
 */
async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  try {
    /* Dynamic import — pg may or may not be installed */
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      const result = await client.query(sql, params);
      return result.rows as T[];
    } finally {
      await client.end();
    }
  } catch {
    /* pg module not available or DB unreachable — return empty */
    console.warn("[api/agents] Database unavailable, returning mock data");
    return [];
  }
}

/* ------------------------------------------------------------------ */
/*  GET handler                                                         */
/* ------------------------------------------------------------------ */

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get("id");

  try {
    if (agentId) {
      return await getAgentDetail(agentId);
    }
    return await listAgents();
  } catch (err) {
    console.error("[api/agents] GET error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

/* ------------------------------------------------------------------ */
/*  POST handler — actions                                              */
/* ------------------------------------------------------------------ */

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { agent_id, action } = body as {
      agent_id?: string;
      action: string;
    };

    switch (action) {
      case "restart_all": {
        /* Mark all agents as running (the docker-compose watcher handles actual restart) */
        await query(
          `UPDATE public.agents SET status = 'running', updated_at = NOW()`,
        );
        /* Insert system bus event so agents pick it up */
        await query(
          `INSERT INTO public.message_bus (channel, event_type, payload)
           VALUES ('system_bus', 'broadcast', $1::jsonb)`,
          [JSON.stringify({ action: "restart_all" })],
        );
        return NextResponse.json({ ok: true, action: "restart_all" });
      }

      case "restart":
      case "stop":
      case "start": {
        if (!agent_id) {
          return NextResponse.json(
            { error: "agent_id is required" },
            { status: 400 },
          );
        }
        const newStatus = action === "stop" ? "stopped" : "running";
        await query(
          `UPDATE public.agents SET status = $1, updated_at = NOW() WHERE id = $2`,
          [newStatus, agent_id],
        );
        /* Broadcast the event on system_bus */
        const eventType =
          action === "stop" ? "agent_stopped" : "agent_started";
        await query(
          `INSERT INTO public.message_bus (source_agent_id, channel, event_type, payload)
           VALUES ($1, 'system_bus', $2, $3::jsonb)`,
          [
            agent_id,
            eventType,
            JSON.stringify({ action, agent_id }),
          ],
        );
        return NextResponse.json({ ok: true, action, agent_id });
      }

      case "shutdown": {
        /* Stop all agents, broadcast shutdown */
        await query(
          `UPDATE public.agents SET status = 'stopped', updated_at = NOW()`,
        );
        await query(
          `INSERT INTO public.message_bus (channel, event_type, payload)
           VALUES ('system_bus', 'broadcast', $1::jsonb)`,
          [JSON.stringify({ action: "shutdown" })],
        );
        return NextResponse.json({ ok: true, action: "shutdown" });
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 },
        );
    }
  } catch (err) {
    console.error("[api/agents] POST error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

/* ------------------------------------------------------------------ */
/*  List all agents                                                     */
/* ------------------------------------------------------------------ */

async function listAgents(): Promise<NextResponse> {
  /* Base agent rows */
  const rows = await query<Agent>(
    `SELECT id, name, schema_name, dashboard_port, gateway_port, agent_port,
            status, created_at, updated_at
     FROM public.agents
     ORDER BY created_at ASC`,
  );

  /* If DB returned nothing, serve demo data so the UI is not blank */
  if (rows.length === 0) {
    return NextResponse.json(getMockAgents());
  }

  /* Enrich each agent with config, channels, message count, health */
  const enriched: Agent[] = await Promise.all(
    rows.map(async (agent) => {
      const [config, channels, countRow, healthy] = await Promise.all([
        fetchAgentConfig(agent.schema_name),
        fetchAgentChannels(agent.schema_name),
        fetchMessageCount(agent.schema_name),
        checkHealth(agent.agent_port),
      ]);
      return {
        ...agent,
        config: config ?? undefined,
        channels,
        messages_today: countRow,
        healthy,
      };
    }),
  );

  return NextResponse.json(enriched);
}

/* ------------------------------------------------------------------ */
/*  Single agent detail                                                  */
/* ------------------------------------------------------------------ */

async function getAgentDetail(agentId: string): Promise<NextResponse> {
  const rows = await query<Agent>(
    `SELECT id, name, schema_name, dashboard_port, gateway_port, agent_port,
            status, created_at, updated_at
     FROM public.agents WHERE id = $1`,
    [agentId],
  );

  if (rows.length === 0) {
    /* Try mock data */
    const mock = getMockAgents().find((a) => a.id === agentId);
    if (mock) return NextResponse.json(mock);
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const agent = rows[0];
  const [config, channels, msgCount, healthy, conversations, busMessages] =
    await Promise.all([
      fetchAgentConfig(agent.schema_name),
      fetchAgentChannels(agent.schema_name),
      fetchMessageCount(agent.schema_name),
      checkHealth(agent.agent_port),
      fetchRecentConversations(agent.schema_name),
      fetchAgentBusMessages(agentId),
    ]);

  return NextResponse.json({
    ...agent,
    config: config ?? undefined,
    channels,
    messages_today: msgCount,
    healthy,
    conversations,
    bus_messages: busMessages,
  });
}

/* ------------------------------------------------------------------ */
/*  DB helper queries                                                    */
/* ------------------------------------------------------------------ */

async function fetchAgentConfig(
  schema: string,
): Promise<AgentConfig | null> {
  try {
    const rows = await query<AgentConfig>(
      `SELECT model_provider, auth_method, model, system_prompt, agent_name,
              temperature, max_tokens, prune_enabled, prune_after_days, prune_keep_starred
       FROM "${schema}".agent_config LIMIT 1`,
    );
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

async function fetchAgentChannels(
  schema: string,
): Promise<ChannelSummary[]> {
  try {
    return await query<ChannelSummary>(
      `SELECT id, type, name, status FROM "${schema}".channels ORDER BY created_at ASC`,
    );
  } catch {
    return [];
  }
}

async function fetchMessageCount(schema: string): Promise<number> {
  try {
    const rows = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "${schema}".messages
       WHERE created_at >= CURRENT_DATE`,
    );
    return parseInt(rows[0]?.count ?? "0", 10);
  } catch {
    return 0;
  }
}

async function fetchRecentConversations(
  schema: string,
): Promise<ConversationPreview[]> {
  try {
    return await query<ConversationPreview>(
      `SELECT id, title, participant_name, message_count, last_message_at, starred
       FROM "${schema}".conversations
       ORDER BY last_message_at DESC NULLS LAST
       LIMIT 10`,
    );
  } catch {
    return [];
  }
}

async function fetchAgentBusMessages(
  agentId: string,
): Promise<BusMessage[]> {
  try {
    const rows = await query<BusMessage>(
      `SELECT mb.id, mb.source_agent_id, mb.target_agent_id, mb.channel,
              mb.event_type, mb.payload, mb.status, mb.created_at,
              sa.name AS source_name, ta.name AS target_name
       FROM public.message_bus mb
       LEFT JOIN public.agents sa ON sa.id = mb.source_agent_id
       LEFT JOIN public.agents ta ON ta.id = mb.target_agent_id
       WHERE mb.source_agent_id = $1 OR mb.target_agent_id = $1
       ORDER BY mb.created_at DESC
       LIMIT 15`,
      [agentId],
    );
    return rows;
  } catch {
    return [];
  }
}

/** Probe the agent's /health endpoint (runs on port 810N) */
async function checkHealth(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://localhost:${port}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Mock data for development / when DB is unreachable                  */
/* ------------------------------------------------------------------ */

function getMockAgents(): Agent[] {
  return [
    {
      id: "00000000-0000-0000-0000-000000000001",
      name: "Support Agent",
      schema_name: "agent_1",
      dashboard_port: 3001,
      gateway_port: 8081,
      agent_port: 8101,
      status: "running",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      config: {
        model_provider: "openai",
        auth_method: "oauth",
        model: "gpt-5.3-codex",
        system_prompt: "You are a helpful support agent.",
        agent_name: "Support Agent",
        temperature: 0.7,
        max_tokens: 4096,
        prune_enabled: true,
        prune_after_days: 90,
        prune_keep_starred: true,
      },
      channels: [
        { id: "ch-1", type: "telegram", name: "Support Bot", status: "active" },
      ],
      messages_today: 42,
      healthy: true,
    },
    {
      id: "00000000-0000-0000-0000-000000000002",
      name: "Research Agent",
      schema_name: "agent_2",
      dashboard_port: 3002,
      gateway_port: 8082,
      agent_port: 8102,
      status: "running",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      config: {
        model_provider: "anthropic",
        auth_method: "oauth",
        model: "claude-opus-4.6",
        system_prompt: "You are a research assistant.",
        agent_name: "Research Agent",
        temperature: 0.5,
        max_tokens: 8192,
        prune_enabled: true,
        prune_after_days: 180,
        prune_keep_starred: true,
      },
      channels: [
        { id: "ch-2", type: "slack", name: "#research", status: "active" },
        { id: "ch-3", type: "telegram", name: "Research Bot", status: "active" },
      ],
      messages_today: 18,
      healthy: true,
    },
    {
      id: "00000000-0000-0000-0000-000000000003",
      name: "Ops Agent",
      schema_name: "agent_3",
      dashboard_port: 3003,
      gateway_port: 8083,
      agent_port: 8103,
      status: "error",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      config: {
        model_provider: "gemini",
        auth_method: "api_key",
        model: "gemini-3-deep-think",
        system_prompt: "You handle operational tasks.",
        agent_name: "Ops Agent",
        temperature: 0.3,
        max_tokens: 4096,
        prune_enabled: false,
        prune_after_days: 90,
        prune_keep_starred: true,
      },
      channels: [
        { id: "ch-4", type: "whatsapp", name: "Ops Group", status: "error" },
      ],
      messages_today: 3,
      healthy: false,
    },
  ];
}
