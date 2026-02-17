"use client";

import { useEffect, useCallback } from "react";
import Link from "next/link";
import { useDashboardStore } from "@/lib/store";
import {
  providerLabel,
  channelLabel,
  statusColor,
  formatTime,
} from "@/lib/helpers";
import type { Agent } from "@/lib/types";

/* ------------------------------------------------------------------ */
/*  Agents list page — detailed table (desktop) / card stack (mobile)   */
/* ------------------------------------------------------------------ */

export default function AgentsPage() {
  const { agents, loadingAgents, fetchAgents } = useDashboardStore();

  useEffect(() => {
    fetchAgents();
    const interval = setInterval(fetchAgents, 15_000);
    return () => clearInterval(interval);
  }, [fetchAgents]);

  /** Perform an action on a single agent or all agents */
  const agentAction = useCallback(
    async (agentId: string, action: "restart" | "stop" | "start") => {
      try {
        await fetch("/api/agents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agent_id: agentId, action }),
        });
        /* Re-fetch after a short delay so the action can take effect */
        setTimeout(fetchAgents, 1500);
      } catch (err) {
        console.error(`Failed to ${action} agent ${agentId}:`, err);
      }
    },
    [fetchAgents],
  );

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Agents</h1>
          <p className="mt-1 text-sm text-gray-500">
            Manage and monitor each agent on this server.
          </p>
        </div>
        <button
          className="btn-secondary"
          onClick={async () => {
            await fetch("/api/agents", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "restart_all" }),
            });
            setTimeout(fetchAgents, 2000);
          }}
        >
          Restart All
        </button>
      </div>

      {loadingAgents && agents.length === 0 ? (
        <LoadingSkeleton />
      ) : agents.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          {/* Desktop table view */}
          <div className="card hidden overflow-hidden md:block">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50 text-xs font-medium uppercase tracking-wider text-gray-500">
                  <th className="px-5 py-3">Agent</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">AI Provider</th>
                  <th className="px-5 py-3">Model</th>
                  <th className="px-5 py-3">Channels</th>
                  <th className="px-5 py-3 text-right">Messages</th>
                  <th className="px-5 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {agents.map((agent) => (
                  <AgentRow
                    key={agent.id}
                    agent={agent}
                    onAction={agentAction}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile card stack */}
          <div className="space-y-3 md:hidden">
            {agents.map((agent) => (
              <AgentMobileCard
                key={agent.id}
                agent={agent}
                onAction={agentAction}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Desktop table row                                                    */
/* ------------------------------------------------------------------ */

function AgentRow({
  agent,
  onAction,
}: {
  agent: Agent;
  onAction: (id: string, action: "restart" | "stop" | "start") => void;
}) {
  const provider = agent.config?.model_provider ?? "openai";
  const model = agent.config?.model ?? "-";
  const channels = agent.channels ?? [];
  const isHealthy = agent.status === "running" && agent.healthy !== false;

  return (
    <tr className="hover:bg-gray-50 transition-colors">
      {/* Name + link */}
      <td className="px-5 py-3.5">
        <Link
          href={`/agents/${agent.id}`}
          className="font-medium text-brand-600 hover:underline"
        >
          {agent.name}
        </Link>
      </td>

      {/* Status badge */}
      <td className="px-5 py-3.5">
        <span className="flex items-center gap-1.5">
          <span
            className={
              isHealthy
                ? "dot-running"
                : agent.status === "stopped"
                  ? "dot-stopped"
                  : "dot-error"
            }
          />
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColor(agent.status)}`}>
            {agent.status}
          </span>
        </span>
      </td>

      {/* Provider */}
      <td className="px-5 py-3.5 text-gray-700">{providerLabel(provider)}</td>

      {/* Model */}
      <td className="px-5 py-3.5">
        <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-mono text-gray-600">
          {model}
        </span>
      </td>

      {/* Channels */}
      <td className="px-5 py-3.5">
        <div className="flex gap-1">
          {channels.length > 0
            ? channels.map((ch) => (
                <span
                  key={ch.id}
                  className={`rounded px-1.5 py-0.5 text-xs font-medium ${statusColor(ch.status)}`}
                >
                  {channelLabel(ch.type)}
                </span>
              ))
            : <span className="text-xs text-gray-400">-</span>}
        </div>
      </td>

      {/* Messages */}
      <td className="px-5 py-3.5 text-right font-medium text-gray-700">
        {agent.messages_today ?? 0}
      </td>

      {/* Actions */}
      <td className="px-5 py-3.5 text-right">
        <div className="flex items-center justify-end gap-1">
          {agent.status === "running" ? (
            <>
              <button
                className="btn-ghost text-xs"
                onClick={() => onAction(agent.id, "restart")}
              >
                Restart
              </button>
              <button
                className="btn-ghost text-xs text-red-600 hover:bg-red-50"
                onClick={() => onAction(agent.id, "stop")}
              >
                Stop
              </button>
            </>
          ) : (
            <button
              className="btn-ghost text-xs text-green-600 hover:bg-green-50"
              onClick={() => onAction(agent.id, "start")}
            >
              Start
            </button>
          )}
          <Link
            href={`http://localhost:${agent.dashboard_port}`}
            target="_blank"
            className="btn-ghost text-xs text-brand-600"
            title="Open per-agent dashboard"
          >
            Dashboard
          </Link>
        </div>
      </td>
    </tr>
  );
}

/* ------------------------------------------------------------------ */
/*  Mobile agent card                                                    */
/* ------------------------------------------------------------------ */

function AgentMobileCard({
  agent,
  onAction,
}: {
  agent: Agent;
  onAction: (id: string, action: "restart" | "stop" | "start") => void;
}) {
  const provider = agent.config?.model_provider ?? "openai";
  const model = agent.config?.model ?? "-";
  const channels = agent.channels ?? [];
  const isHealthy = agent.status === "running" && agent.healthy !== false;

  return (
    <div className="card p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <Link
          href={`/agents/${agent.id}`}
          className="text-base font-semibold text-brand-600 hover:underline"
        >
          {agent.name}
        </Link>
        <span className="flex items-center gap-1.5">
          <span
            className={
              isHealthy
                ? "dot-running"
                : agent.status === "stopped"
                  ? "dot-stopped"
                  : "dot-error"
            }
          />
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColor(agent.status)}`}>
            {agent.status}
          </span>
        </span>
      </div>

      {/* Details */}
      <div className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <span className="text-xs text-gray-500">AI Provider</span>
          <p className="font-medium text-gray-700">{providerLabel(provider)}</p>
        </div>
        <div>
          <span className="text-xs text-gray-500">Model</span>
          <p className="font-mono text-xs text-gray-600">{model}</p>
        </div>
        <div>
          <span className="text-xs text-gray-500">Channels</span>
          <div className="flex gap-1 mt-0.5">
            {channels.length > 0
              ? channels.map((ch) => (
                  <span
                    key={ch.id}
                    className={`rounded px-1.5 py-0.5 text-xs font-medium ${statusColor(ch.status)}`}
                  >
                    {channelLabel(ch.type)}
                  </span>
                ))
              : <span className="text-xs text-gray-400">None</span>}
          </div>
        </div>
        <div>
          <span className="text-xs text-gray-500">Messages Today</span>
          <p className="font-medium text-gray-700">{agent.messages_today ?? 0}</p>
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2 border-t border-gray-100 pt-3">
        {agent.status === "running" ? (
          <>
            <button
              className="btn-secondary flex-1 text-xs"
              onClick={() => onAction(agent.id, "restart")}
            >
              Restart
            </button>
            <button
              className="btn-danger flex-1 text-xs"
              onClick={() => onAction(agent.id, "stop")}
            >
              Stop
            </button>
          </>
        ) : (
          <button
            className="btn-primary flex-1 text-xs"
            onClick={() => onAction(agent.id, "start")}
          >
            Start
          </button>
        )}
        <Link
          href={`/agents/${agent.id}`}
          className="btn-secondary flex-1 text-xs text-center"
        >
          Details
        </Link>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Loading / empty states                                               */
/* ------------------------------------------------------------------ */

function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      {[1, 2, 3].map((i) => (
        <div key={i} className="card h-24 animate-pulse bg-gray-100" />
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="card flex flex-col items-center justify-center px-6 py-16 text-center">
      <h3 className="text-lg font-semibold text-gray-900">No agents found</h3>
      <p className="mt-1 max-w-sm text-sm text-gray-500">
        Deploy agents using the setup wizard and they will appear here.
      </p>
    </div>
  );
}
