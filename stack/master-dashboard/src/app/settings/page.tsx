"use client";

import { useEffect, useState, useCallback } from "react";
import { useDashboardStore } from "@/lib/store";
import type { DeployInfo } from "@/lib/types";

/* ------------------------------------------------------------------ */
/*  Settings page                                                       */
/*  Server info, deployment info, bus cleanup, system actions.          */
/* ------------------------------------------------------------------ */

export default function SettingsPage() {
  const { deployInfo, agents, fetchOverview, fetchAgents } =
    useDashboardStore();

  const [busCleanupDays, setBusCleanupDays] = useState(7);
  const [showShutdownConfirm, setShowShutdownConfirm] = useState(false);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

  useEffect(() => {
    fetchOverview();
    fetchAgents();
  }, [fetchOverview, fetchAgents]);

  /** Perform a system action via the agents API */
  const systemAction = useCallback(
    async (action: string) => {
      setActionInProgress(action);
      try {
        await fetch("/api/agents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        if (action === "restart_all") {
          setTimeout(() => {
            fetchAgents();
            fetchOverview();
          }, 2000);
        }
      } catch (err) {
        console.error(`System action ${action} failed:`, err);
      } finally {
        setActionInProgress(null);
        setShowShutdownConfirm(false);
      }
    },
    [fetchAgents, fetchOverview],
  );

  /** Trigger bus cleanup */
  const cleanupBus = useCallback(async () => {
    setActionInProgress("cleanup_bus");
    try {
      await fetch("/api/bus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "cleanup",
          older_than_days: busCleanupDays,
        }),
      });
    } catch (err) {
      console.error("Bus cleanup failed:", err);
    } finally {
      setActionInProgress(null);
    }
  }, [busCleanupDays]);

  /** Export config as JSON download */
  const exportConfig = useCallback(async () => {
    setActionInProgress("export");
    try {
      const res = await fetch("/api/overview");
      if (!res.ok) throw new Error("Export failed");
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `openclaw-config-${new Date().toISOString().split("T")[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Export failed:", err);
    } finally {
      setActionInProgress(null);
    }
  }, []);

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
        <p className="mt-1 text-sm text-gray-500">
          Server configuration, deployment info, and system actions.
        </p>
      </div>

      {/* ── Server info ── */}
      <div className="card p-5 space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500">
          Server Information
        </h2>
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-sm">
          <InfoItem
            label="Server IP"
            value={deployInfo?.server_ip ?? "Not available"}
          />
          <InfoItem
            label="Cloud Provider"
            value={formatProvider(deployInfo?.cloud_provider)}
          />
          <InfoItem
            label="Tailscale IP"
            value={deployInfo?.tailscale_ip ?? "Not available"}
          />
          <InfoItem
            label="Server Size"
            value={deployInfo?.server_size ?? "Not available"}
          />
          <InfoItem
            label="Region"
            value={deployInfo?.region ?? "Not available"}
          />
        </dl>
      </div>

      {/* ── Deployment info ── */}
      <div className="card p-5 space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500">
          Deployment
        </h2>
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-sm">
          <InfoItem
            label="Deploy ID"
            value={deployInfo?.deploy_id ?? "-"}
            mono
          />
          <InfoItem
            label="Agent Count"
            value={String(deployInfo?.agent_count ?? agents.length)}
          />
          <InfoItem
            label="Deployed"
            value={
              deployInfo?.created_at
                ? new Date(deployInfo.created_at).toLocaleString()
                : "-"
            }
          />
        </dl>
      </div>

      {/* ── Bus cleanup settings ── */}
      <div className="card p-5 space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500">
          Bus Message Cleanup
        </h2>
        <p className="text-sm text-gray-600">
          Automatically remove delivered bus messages older than a certain number
          of days. This helps keep the database lean.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div>
            <label
              htmlFor="cleanup-days"
              className="mb-1 block text-sm font-medium text-gray-700"
            >
              Remove messages older than
            </label>
            <div className="flex items-center gap-2">
              <input
                id="cleanup-days"
                type="range"
                min={1}
                max={30}
                value={busCleanupDays}
                onChange={(e) => setBusCleanupDays(Number(e.target.value))}
                className="h-2 w-48 cursor-pointer appearance-none rounded-full bg-gray-200 accent-brand-600"
              />
              <span className="min-w-[3rem] text-sm font-medium text-gray-800">
                {busCleanupDays} {busCleanupDays === 1 ? "day" : "days"}
              </span>
            </div>
          </div>
          <button
            className="btn-secondary"
            onClick={cleanupBus}
            disabled={actionInProgress === "cleanup_bus"}
          >
            {actionInProgress === "cleanup_bus"
              ? "Cleaning up..."
              : "Clean Up Now"}
          </button>
        </div>
      </div>

      {/* ── System actions ── */}
      <div className="card p-5 space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500">
          System Actions
        </h2>
        <div className="flex flex-wrap gap-3">
          <button
            className="btn-secondary"
            onClick={() => systemAction("restart_all")}
            disabled={actionInProgress === "restart_all"}
          >
            {actionInProgress === "restart_all"
              ? "Restarting..."
              : "Restart All Agents"}
          </button>
          <button
            className="btn-secondary"
            onClick={exportConfig}
            disabled={actionInProgress === "export"}
          >
            {actionInProgress === "export"
              ? "Exporting..."
              : "Export Configuration"}
          </button>
        </div>
      </div>

      {/* ── Danger zone ── */}
      <div className="card border-red-200 p-5 space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-red-600">
          Danger Zone
        </h2>
        <p className="text-sm text-gray-600">
          These actions are destructive and cannot be easily undone. Use with
          caution.
        </p>

        {showShutdownConfirm ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 space-y-3">
            <p className="text-sm font-medium text-red-800">
              Are you sure you want to shut down the server? All agents will be
              stopped and the dashboard will become unreachable.
            </p>
            <div className="flex gap-2">
              <button
                className="btn-danger"
                onClick={() => systemAction("shutdown")}
                disabled={actionInProgress === "shutdown"}
              >
                {actionInProgress === "shutdown"
                  ? "Shutting down..."
                  : "Yes, Shut Down"}
              </button>
              <button
                className="btn-secondary"
                onClick={() => setShowShutdownConfirm(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            className="btn-danger"
            onClick={() => setShowShutdownConfirm(true)}
          >
            Shut Down Server
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Helper components                                                    */
/* ------------------------------------------------------------------ */

function InfoItem({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-lg border border-gray-100 px-3 py-2">
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd
        className={`mt-0.5 font-medium text-gray-800 ${mono ? "font-mono text-xs" : "text-sm"}`}
      >
        {value}
      </dd>
    </div>
  );
}

/** Human-readable cloud provider name */
function formatProvider(provider?: string): string {
  if (!provider) return "Not available";
  const map: Record<string, string> = {
    digitalocean: "DigitalOcean",
    gcp: "Google Cloud",
    azure: "Azure",
    aws: "AWS",
  };
  return map[provider] ?? provider;
}
