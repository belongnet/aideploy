"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  providerLabel,
  channelLabel,
  statusColor,
  formatTime,
  eventTypeLabel,
  truncate,
} from "@/lib/helpers";
import type { Agent, BusMessage, ConversationPreview } from "@/lib/types";

/* ------------------------------------------------------------------ */
/*  Single agent detail page                                            */
/*  Shows config summary, health, recent conversations, bus messages.   */
/* ------------------------------------------------------------------ */

interface AgentDetail extends Agent {
  conversations?: ConversationPreview[];
  bus_messages?: BusMessage[];
}

export default function AgentDetailPage() {
  const params = useParams();
  const agentId = params.id as string;

  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAgent = useCallback(async () => {
    try {
      const res = await fetch(`/api/agents?id=${agentId}`);
      if (!res.ok) throw new Error(`Agent not found (${res.status})`);
      const data: AgentDetail = await res.json();
      setAgent(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load agent");
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    fetchAgent();
    const interval = setInterval(fetchAgent, 15_000);
    return () => clearInterval(interval);
  }, [fetchAgent]);

  /** Perform an action on this agent */
  const doAction = async (action: "restart" | "stop" | "start") => {
    try {
      await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: agentId, action }),
      });
      setTimeout(fetchAgent, 1500);
    } catch (err) {
      console.error(`Action ${action} failed:`, err);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-200 border-t-brand-600" />
        <span className="ml-3 text-sm text-gray-500">Loading agent...</span>
      </div>
    );
  }

  if (error || !agent) {
    return (
      <div className="card flex flex-col items-center justify-center px-6 py-16 text-center">
        <h2 className="text-lg font-semibold text-red-700">
          {error ?? "Agent not found"}
        </h2>
        <Link href="/agents" className="btn-secondary mt-4">
          Back to Agents
        </Link>
      </div>
    );
  }

  const config = agent.config;
  const isHealthy = agent.status === "running" && agent.healthy !== false;
  const conversations = agent.conversations ?? [];
  const busMessages = agent.bus_messages ?? [];
  const channels = agent.channels ?? [];

  return (
    <div className="space-y-6">
      {/* Breadcrumb + header */}
      <div>
        <Link
          href="/agents"
          className="text-sm text-gray-500 hover:text-brand-600"
        >
          Agents
        </Link>
        <span className="mx-1.5 text-sm text-gray-400">/</span>
        <span className="text-sm font-medium text-gray-700">{agent.name}</span>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span
            className={`h-3.5 w-3.5 rounded-full ${
              isHealthy ? "bg-green-500" : agent.status === "stopped" ? "bg-gray-400" : "bg-red-500"
            }`}
          />
          <h1 className="text-2xl font-bold text-gray-900">{agent.name}</h1>
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statusColor(agent.status)}`}>
            {agent.status}
          </span>
        </div>
        <div className="flex gap-2">
          {agent.status === "running" ? (
            <>
              <button className="btn-secondary" onClick={() => doAction("restart")}>
                Restart
              </button>
              <button className="btn-danger" onClick={() => doAction("stop")}>
                Stop
              </button>
            </>
          ) : (
            <button className="btn-primary" onClick={() => doAction("start")}>
              Start
            </button>
          )}
          <a
            href={`http://localhost:${agent.dashboard_port}`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-primary"
          >
            Open Dashboard
          </a>
        </div>
      </div>

      {/* ── Config summary + Health ── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {/* Config card */}
        <div className="card p-5 space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500">
            Configuration
          </h2>
          <dl className="space-y-2 text-sm">
            <Row label="AI Provider" value={providerLabel(config?.model_provider ?? "openai")} />
            <Row label="Model" value={config?.model ?? "-"} mono />
            <Row label="Auth Method" value={config?.auth_method === "oauth" ? "Sign-in (OAuth)" : "API Key"} />
            <Row label="Temperature" value={String(config?.temperature ?? 0.7)} />
            <Row label="Max Tokens" value={String(config?.max_tokens ?? 4096)} />
            <Row
              label="Memory"
              value={
                config?.memory_enabled
                  ? `${config.memory_provider === "supabase" ? "Supabase pgvector" : config.memory_provider === "mem0" ? "Mem0 Cloud" : config.memory_provider}, ${config.memory_capture_mode === "async" ? "background" : "off"}`
                  : "Disabled"
              }
            />
            <Row
              label="Recall"
              value={
                config?.memory_enabled
                  ? `Top ${config.memory_recall_top_k} results (threshold ${config.memory_similarity_threshold})`
                  : "-"
              }
            />
            <Row
              label="Knowledge"
              value={
                config?.knowledge_provider === "qmd"
                  ? `Local documents${config.knowledge_collections.length ? ` (${config.knowledge_collections.join(", ")})` : ""}`
                  : "Off"
              }
            />
          </dl>
        </div>

        {/* Health card */}
        <div className="card p-5 space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500">
            Health
          </h2>
          <dl className="space-y-2 text-sm">
            <Row label="Status" value={agent.status} />
            <Row label="Process Healthy" value={isHealthy ? "Yes" : "No"} />
            <Row label="Dashboard Port" value={String(agent.dashboard_port)} />
            <Row label="Gateway Port" value={String(agent.gateway_port)} />
            <Row label="Agent Port" value={String(agent.agent_port)} />
            <Row label="Messages Today" value={String(agent.messages_today ?? 0)} />
          </dl>
        </div>

        {/* Channels card */}
        <div className="card p-5 space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500">
            Connected Channels
          </h2>
          {channels.length === 0 ? (
            <p className="text-sm text-gray-400">No channels connected.</p>
          ) : (
            <ul className="space-y-2">
              {channels.map((ch) => (
                <li
                  key={ch.id}
                  className="flex items-center justify-between rounded-lg border border-gray-100 px-3 py-2"
                >
                  <div>
                    <span className="text-sm font-medium text-gray-800">
                      {ch.name}
                    </span>
                    <span className="ml-2 text-xs text-gray-500">
                      {channelLabel(ch.type)}
                    </span>
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColor(ch.status)}`}>
                    {ch.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* ── Prune settings summary ── */}
      {config && (
        <div className="card p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-500">
            Conversation Cleanup
          </h2>
          <div className="flex flex-wrap gap-4 text-sm">
            <span className={`rounded-full px-3 py-1 text-xs font-medium ${config.prune_enabled ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-600"}`}>
              {config.prune_enabled ? "Auto-cleanup on" : "Auto-cleanup off"}
            </span>
            {config.prune_enabled && (
              <>
                <span className="text-gray-600">
                  Keep for <strong>{config.prune_after_days} days</strong>
                </span>
                <span className="text-gray-600">
                  Keep starred: <strong>{config.prune_keep_starred ? "Yes" : "No"}</strong>
                </span>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Recent conversations ── */}
      <div className="card overflow-hidden">
        <div className="border-b border-gray-100 px-5 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500">
            Recent Conversations
          </h2>
        </div>
        {conversations.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-gray-400">
            No conversations yet.
          </p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {conversations.slice(0, 10).map((conv) => (
              <li
                key={conv.id}
                className="flex items-center justify-between px-5 py-3 hover:bg-gray-50 transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-gray-800">
                    {conv.title || conv.participant_name || "Untitled"}
                    {conv.starred && (
                      <span className="ml-1.5 text-yellow-500" title="Starred">
                        *
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-gray-500">
                    {conv.message_count} messages
                    {conv.last_message_at &&
                      ` \u00B7 ${formatTime(conv.last_message_at)}`}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Recent bus messages ── */}
      <div className="card overflow-hidden">
        <div className="border-b border-gray-100 px-5 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500">
            Recent Bus Messages
          </h2>
        </div>
        {busMessages.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-gray-400">
            No bus messages involving this agent.
          </p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {busMessages.slice(0, 15).map((msg) => (
              <li key={msg.id} className="px-5 py-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColor(msg.status)}`}>
                    {eventTypeLabel(msg.event_type)}
                  </span>
                  <span className="text-xs text-gray-400">
                    {formatTime(msg.created_at)}
                  </span>
                </div>
                <p className="mt-1 text-xs text-gray-600">
                  <span className="font-medium">{msg.source_name ?? "system"}</span>
                  {" -> "}
                  <span className="font-medium">{msg.target_name ?? "broadcast"}</span>
                </p>
                <p className="mt-0.5 text-xs text-gray-400 font-mono break-all">
                  {truncate(JSON.stringify(msg.payload), 120)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Reusable detail row                                                  */
/* ------------------------------------------------------------------ */

function Row({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex justify-between">
      <dt className="text-gray-500">{label}</dt>
      <dd className={`font-medium text-gray-800 ${mono ? "font-mono text-xs" : ""}`}>
        {value}
      </dd>
    </div>
  );
}
