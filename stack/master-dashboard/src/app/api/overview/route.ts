/**
 * OpenClaw Master Dashboard — Overview API
 *
 * GET /api/overview → aggregate stats + deploy info
 *
 * Returns:
 * {
 *   stats: { total_agents, healthy_agents, unhealthy_agents, total_messages_today, total_bus_messages },
 *   deploy: { deploy_id, cloud_provider, region, server_size, server_ip, tailscale_ip, agent_count, created_at } | null
 * }
 */

import { NextResponse } from "next/server";
import type { OverviewStats, DeployInfo } from "@/lib/types";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://openclaw:openclaw@localhost:5432/openclaw";

/* ------------------------------------------------------------------ */
/*  Database helper (same pattern as agents route)                      */
/* ------------------------------------------------------------------ */

async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  try {
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
    console.warn("[api/overview] Database unavailable, returning mock data");
    return [];
  }
}

/* ------------------------------------------------------------------ */
/*  GET handler                                                         */
/* ------------------------------------------------------------------ */

export async function GET() {
  try {
    const [stats, deploy] = await Promise.all([
      fetchStats(),
      fetchDeployInfo(),
    ]);
    return NextResponse.json({ stats, deploy });
  } catch (err) {
    console.error("[api/overview] GET error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

/* ------------------------------------------------------------------ */
/*  Aggregate stats                                                     */
/* ------------------------------------------------------------------ */

async function fetchStats(): Promise<OverviewStats> {
  /* Total + status counts */
  const agentRows = await query<{
    total: string;
    running: string;
  }>(
    `SELECT
       COUNT(*)::text AS total,
       COUNT(*) FILTER (WHERE status = 'running')::text AS running
     FROM public.agents`,
  );

  const total = parseInt(agentRows[0]?.total ?? "0", 10);
  const running = parseInt(agentRows[0]?.running ?? "0", 10);

  /* Message count today across all agent schemas */
  let totalMessagesToday = 0;
  try {
    const schemaRows = await query<{ schema_name: string }>(
      `SELECT schema_name FROM public.agents`,
    );
    const counts = await Promise.all(
      schemaRows.map(async ({ schema_name }) => {
        try {
          const rows = await query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM "${schema_name}".messages
             WHERE created_at >= CURRENT_DATE`,
          );
          return parseInt(rows[0]?.count ?? "0", 10);
        } catch {
          return 0;
        }
      }),
    );
    totalMessagesToday = counts.reduce((sum, c) => sum + c, 0);
  } catch {
    /* Ignore — schemas might not exist yet */
  }

  /* Bus message count */
  const busRows = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM public.message_bus`,
  );
  const totalBus = parseInt(busRows[0]?.count ?? "0", 10);

  /* If DB returned nothing, use mock values */
  if (total === 0) {
    return getMockStats();
  }

  /* For health check, probe each running agent */
  let healthyCount = 0;
  try {
    const portRows = await query<{ agent_port: number }>(
      `SELECT agent_port FROM public.agents WHERE status = 'running'`,
    );
    const checks = await Promise.all(
      portRows.map(async ({ agent_port }) => {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 2000);
          const res = await fetch(`http://localhost:${agent_port}/health`, {
            signal: controller.signal,
          });
          clearTimeout(timeout);
          return res.ok;
        } catch {
          return false;
        }
      }),
    );
    healthyCount = checks.filter(Boolean).length;
  } catch {
    healthyCount = running;
  }

  return {
    total_agents: total,
    healthy_agents: healthyCount,
    unhealthy_agents: total - healthyCount,
    total_messages_today: totalMessagesToday,
    total_bus_messages: totalBus,
  };
}

/* ------------------------------------------------------------------ */
/*  Deploy info                                                         */
/* ------------------------------------------------------------------ */

async function fetchDeployInfo(): Promise<DeployInfo | null> {
  const rows = await query<DeployInfo>(
    `SELECT id, deploy_id, cloud_provider, region, server_size,
            server_ip, tailscale_ip, agent_count, created_at
     FROM public.deploy_info
     ORDER BY created_at DESC
     LIMIT 1`,
  );

  if (rows.length === 0) {
    return getMockDeployInfo();
  }

  return rows[0];
}

/* ------------------------------------------------------------------ */
/*  Mock data for development                                           */
/* ------------------------------------------------------------------ */

function getMockStats(): OverviewStats {
  return {
    total_agents: 3,
    healthy_agents: 2,
    unhealthy_agents: 1,
    total_messages_today: 63,
    total_bus_messages: 128,
  };
}

function getMockDeployInfo(): DeployInfo {
  return {
    id: "00000000-0000-0000-0000-000000000099",
    deploy_id: "deploy-demo-001",
    cloud_provider: "digitalocean",
    region: "nyc3",
    server_size: "s-2vcpu-4gb",
    server_ip: "203.0.113.10",
    tailscale_ip: "100.64.0.1",
    agent_count: 3,
    created_at: new Date().toISOString(),
  };
}
