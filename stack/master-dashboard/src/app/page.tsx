"use client";

import Link from "next/link";
import { useDashboardStore } from "@/lib/store";
import { useRealtimeSync } from "@/lib/use-realtime";
import {
  providerLabel,
  providerIcon,
  channelIcon,
  statusColor,
} from "@/lib/helpers";

/* ------------------------------------------------------------------ */
/*  Overview page — aggregate stats bar + agent cards grid              */
/* ------------------------------------------------------------------ */

export default function OverviewPage() {
  const {
    agents,
    overview,
    loadingAgents,
    loadingOverview,
    fetchAgents,
  } = useDashboardStore();

  /* Supabase Realtime — replaces 15s polling with live subscriptions */
  useRealtimeSync();

  const loading = loadingAgents || loadingOverview;

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            Server Overview
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            All agents running on this server at a glance.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            className="btn-secondary"
            onClick={async () => {
              await fetch("/api/agents", { method: "POST", body: JSON.stringify({ action: "restart_all" }) });
              fetchAgents();
            }}
          >
            Restart All
          </button>
          <Link href="/agents" className="btn-primary">
            View Agents
          </Link>
        </div>
      </div>

      {/* ── Aggregate stats bar ── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
        <StatPill
          label="Total Agents"
          value={overview?.total_agents ?? agents.length}
          loading={loading}
        />
        <StatPill
          label="Healthy"
          value={overview?.healthy_agents ?? 0}
          color="text-green-600"
          loading={loading}
        />
        <StatPill
          label="Unhealthy"
          value={overview?.unhealthy_agents ?? 0}
          color="text-red-600"
          loading={loading}
        />
        <StatPill
          label="Messages Today"
          value={overview?.total_messages_today ?? 0}
          loading={loading}
        />
        <StatPill
          label="Bus Messages"
          value={overview?.total_bus_messages ?? 0}
          className="col-span-2 sm:col-span-1"
          loading={loading}
        />
      </div>

      {/* ── Agent cards grid ── */}
      {loading && agents.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-200 border-t-brand-600" />
          <span className="ml-3 text-sm text-gray-500">Loading agents...</span>
        </div>
      ) : agents.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Stat pill                                                           */
/* ------------------------------------------------------------------ */

function StatPill({
  label,
  value,
  color = "text-gray-900",
  className = "",
  loading = false,
}: {
  label: string;
  value: number;
  color?: string;
  className?: string;
  loading?: boolean;
}) {
  return (
    <div className={`stat-pill ${className}`}>
      {loading ? (
        <div className="h-7 w-12 animate-pulse rounded bg-gray-200" />
      ) : (
        <span className={`text-2xl font-bold ${color}`}>{value}</span>
      )}
      <span className="mt-0.5 text-xs text-gray-500">{label}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Agent card                                                          */
/* ------------------------------------------------------------------ */

import type { Agent } from "@/lib/types";

function AgentCard({ agent }: { agent: Agent }) {
  const provider = agent.config?.model_provider ?? "openai";
  const model = agent.config?.model ?? "unknown";
  const channels = agent.channels ?? [];
  const messagesCount = agent.messages_today ?? 0;
  const isHealthy = agent.status === "running" && agent.healthy !== false;
  const needsAiSetup = agent.ai_connected === false;

  return (
    <Link
      href={`/agents/${agent.id}`}
      className="card flex flex-col gap-3 p-5 transition-shadow hover:shadow-md"
    >
      {/* Top row: name + status */}
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-gray-900 truncate">
          {agent.name}
        </h3>
        <span
          className={`${
            isHealthy ? "dot-running" : agent.status === "stopped" ? "dot-stopped" : "dot-error"
          }`}
          title={isHealthy ? "Healthy" : agent.status}
        />
      </div>

      {/* AI provider badge */}
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-md bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">
          {providerIcon(provider)}
          <span className="hidden sm:inline">{providerLabel(provider)}</span>
        </span>
        <span className="text-xs text-gray-500 truncate">{model}</span>
      </div>

      {needsAiSetup && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-700">
            Connect AI First
          </p>
          <p className="mt-1 text-sm text-amber-900">
            This agent will throw setup errors in chat until {providerLabel(provider)} is connected.
          </p>
        </div>
      )}

      {/* Channel icons + message count */}
      <div className="flex items-center justify-between border-t border-gray-100 pt-3">
        <div className="flex gap-1.5">
          {channels.length > 0 ? (
            channels.map((ch) => (
              <span
                key={ch.id}
                className={`rounded px-1.5 py-0.5 text-xs font-medium ${statusColor(ch.status)}`}
                title={`${ch.name} (${ch.type})`}
              >
                {channelIcon(ch.type)}
              </span>
            ))
          ) : (
            <span className="text-xs text-gray-400">No channels</span>
          )}
        </div>
        <span className="text-sm font-medium text-gray-700">
          {messagesCount}{" "}
          <span className="text-xs font-normal text-gray-400">today</span>
        </span>
      </div>

      {needsAiSetup && agent.setup_url && (
        <button
          type="button"
          className="btn-primary w-full"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            window.open(agent.setup_url, "_blank", "noopener,noreferrer");
          }}
        >
          Connect AI Now
        </button>
      )}
    </Link>
  );
}

/* ------------------------------------------------------------------ */
/*  Empty state                                                         */
/* ------------------------------------------------------------------ */

function EmptyState() {
  return (
    <div className="card flex flex-col items-center justify-center px-6 py-16 text-center">
      <svg
        className="mb-4 h-12 w-12 text-gray-300"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
        />
      </svg>
      <h3 className="text-lg font-semibold text-gray-900">
        No agents yet
      </h3>
      <p className="mt-1 max-w-sm text-sm text-gray-500">
        Agents will appear here once they are deployed. Use the setup wizard to
        deploy your first agent.
      </p>
    </div>
  );
}
