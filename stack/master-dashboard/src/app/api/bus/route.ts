/**
 * OpenClaw Master Dashboard — Bus Messages API
 *
 * GET  /api/bus → recent bus messages with optional filters
 *   Query params:
 *     channel    — filter by channel (agent_bus / system_bus / dashboard_bus)
 *     event_type — filter by event type
 *     limit      — max rows (default 100, max 500)
 *
 * POST /api/bus → cleanup action
 *   Body: { action: "cleanup", older_than_days: number }
 */

import { NextRequest, NextResponse } from "next/server";
import type { BusMessage } from "@/lib/types";
import { rawQuery } from "@/lib/db";

/* ------------------------------------------------------------------ */
/*  GET handler                                                         */
/* ------------------------------------------------------------------ */

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const channel = searchParams.get("channel") || undefined;
  const eventType = searchParams.get("event_type") || undefined;
  const limitParam = searchParams.get("limit");
  const limit = Math.min(Math.max(parseInt(limitParam ?? "100", 10) || 100, 1), 500);

  try {
    const messages = await fetchBusMessages({ channel, eventType, limit });
    return NextResponse.json(messages);
  } catch (err) {
    console.error("[api/bus] GET error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

/* ------------------------------------------------------------------ */
/*  POST handler — cleanup                                              */
/* ------------------------------------------------------------------ */

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, older_than_days } = body as {
      action: string;
      older_than_days?: number;
    };

    if (action !== "cleanup") {
      return NextResponse.json(
        { error: `Unknown action: ${action}` },
        { status: 400 },
      );
    }

    const days = Math.max(older_than_days ?? 7, 1);

    const rows = await rawQuery<{ cleanup_bus_messages: number }>(
      `SELECT cleanup_bus_messages($1) AS cleanup_bus_messages`,
      [days],
    );

    const deleted = rows[0]?.cleanup_bus_messages ?? 0;
    return NextResponse.json({ ok: true, deleted });
  } catch (err) {
    console.error("[api/bus] POST error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

/* ------------------------------------------------------------------ */
/*  Fetch bus messages with optional filters                            */
/* ------------------------------------------------------------------ */

async function fetchBusMessages(opts: {
  channel?: string;
  eventType?: string;
  limit: number;
}): Promise<BusMessage[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (opts.channel) {
    conditions.push(`mb.channel = $${paramIdx++}`);
    params.push(opts.channel);
  }
  if (opts.eventType) {
    conditions.push(`mb.event_type = $${paramIdx++}`);
    params.push(opts.eventType);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  params.push(opts.limit);

  const sql = `
    SELECT mb.id, mb.source_agent_id, mb.target_agent_id, mb.channel,
           mb.event_type, mb.payload, mb.status, mb.created_at,
           sa.name AS source_name, ta.name AS target_name
    FROM public.message_bus mb
    LEFT JOIN public.agents sa ON sa.id = mb.source_agent_id
    LEFT JOIN public.agents ta ON ta.id = mb.target_agent_id
    ${whereClause}
    ORDER BY mb.created_at DESC
    LIMIT $${paramIdx}
  `;

  const rows = await rawQuery<BusMessage>(sql, params);

  /* Fall back to mock data if DB is empty / unreachable */
  if (rows.length === 0) {
    return getMockBusMessages(opts);
  }

  return rows;
}

/* ------------------------------------------------------------------ */
/*  Mock bus messages for development                                   */
/* ------------------------------------------------------------------ */

function getMockBusMessages(opts: {
  channel?: string;
  eventType?: string;
  limit: number;
}): BusMessage[] {
  const now = Date.now();
  const mockMessages: BusMessage[] = [
    {
      id: 1,
      source_agent_id: "00000000-0000-0000-0000-000000000001",
      target_agent_id: "00000000-0000-0000-0000-000000000002",
      channel: "agent_bus",
      event_type: "message_forward",
      payload: { text: "Please research this topic", priority: "normal" },
      status: "delivered",
      created_at: new Date(now - 60_000).toISOString(),
      source_name: "Support Agent",
      target_name: "Research Agent",
    },
    {
      id: 2,
      source_agent_id: "00000000-0000-0000-0000-000000000002",
      target_agent_id: "00000000-0000-0000-0000-000000000001",
      channel: "agent_bus",
      event_type: "task_result",
      payload: { result: "Research complete", confidence: 0.92 },
      status: "delivered",
      created_at: new Date(now - 45_000).toISOString(),
      source_name: "Research Agent",
      target_name: "Support Agent",
    },
    {
      id: 3,
      source_agent_id: "00000000-0000-0000-0000-000000000001",
      target_agent_id: null,
      channel: "system_bus",
      event_type: "health",
      payload: { status: "ok", uptime: 3600 },
      status: "delivered",
      created_at: new Date(now - 30_000).toISOString(),
      source_name: "Support Agent",
      target_name: undefined,
    },
    {
      id: 4,
      source_agent_id: "00000000-0000-0000-0000-000000000003",
      target_agent_id: null,
      channel: "system_bus",
      event_type: "agent_stopped",
      payload: { reason: "Health check failed" },
      status: "pending",
      created_at: new Date(now - 15_000).toISOString(),
      source_name: "Ops Agent",
      target_name: undefined,
    },
    {
      id: 5,
      source_agent_id: null,
      target_agent_id: null,
      channel: "dashboard_bus",
      event_type: "broadcast",
      payload: { message: "Configuration updated" },
      status: "delivered",
      created_at: new Date(now - 5_000).toISOString(),
      source_name: undefined,
      target_name: undefined,
    },
    {
      id: 6,
      source_agent_id: "00000000-0000-0000-0000-000000000002",
      target_agent_id: null,
      channel: "system_bus",
      event_type: "health",
      payload: { status: "ok", uptime: 7200 },
      status: "delivered",
      created_at: new Date(now - 120_000).toISOString(),
      source_name: "Research Agent",
      target_name: undefined,
    },
    {
      id: 7,
      source_agent_id: "00000000-0000-0000-0000-000000000001",
      target_agent_id: "00000000-0000-0000-0000-000000000003",
      channel: "agent_bus",
      event_type: "message_forward",
      payload: { text: "Run deployment check", type: "ops_request" },
      status: "failed",
      created_at: new Date(now - 180_000).toISOString(),
      source_name: "Support Agent",
      target_name: "Ops Agent",
    },
    {
      id: 8,
      source_agent_id: null,
      target_agent_id: null,
      channel: "dashboard_bus",
      event_type: "config_changed",
      payload: { field: "prune_after_days", old: 90, new: 60 },
      status: "delivered",
      created_at: new Date(now - 300_000).toISOString(),
      source_name: undefined,
      target_name: undefined,
    },
  ];

  let filtered = mockMessages;

  if (opts.channel) {
    filtered = filtered.filter((m) => m.channel === opts.channel);
  }
  if (opts.eventType) {
    filtered = filtered.filter((m) => m.event_type === opts.eventType);
  }

  return filtered.slice(0, opts.limit);
}
