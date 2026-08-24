/**
 * OpenClaw Master Dashboard — Supabase Realtime hook
 *
 * Subscribes to Postgres changes for agent state and, optionally,
 * message-bus updates. Bus syncing is split out so filtered bus views
 * are not overwritten by background unfiltered refreshes.
 */

"use client";

import { useEffect, useRef } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { getSupabaseBrowser } from "./supabase-browser";
import { useDashboardStore } from "./store";
import type { BusFilters } from "./store";

const POLL_INTERVAL_MS = 15_000;
const OVERVIEW_REFRESH_MS = 30_000;
const REALTIME_RETRY_MS = 30_000;

interface RealtimeSyncOptions {
  syncBus?: boolean;
  busFilters?: BusFilters;
}

export function useRealtimeSync(opts?: RealtimeSyncOptions) {
  const {
    fetchAgents,
    fetchOverview,
    fetchBusMessages,
    appendBusMessage,
    patchAgent,
  } = useDashboardStore();

  const agentChannelRef = useRef<RealtimeChannel | null>(null);
  const busChannelRef = useRef<RealtimeChannel | null>(null);
  const agentPollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const busPollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const syncBus = opts?.syncBus ?? false;
  const busFilters = opts?.busFilters;

  useEffect(() => {
    let cancelled = false;

    fetchAgents();
    fetchOverview();

    const stopAgentPolling = () => {
      if (agentPollingRef.current) {
        clearInterval(agentPollingRef.current);
        agentPollingRef.current = null;
      }
    };

    const startAgentPolling = () => {
      if (agentPollingRef.current) return;
      agentPollingRef.current = setInterval(() => {
        fetchAgents();
        fetchOverview();
      }, POLL_INTERVAL_MS);
    };

    const setupAgentRealtime = async () => {
      try {
        const sb = await getSupabaseBrowser();
        if (!sb || cancelled) {
          startAgentPolling();
          return;
        }

        const channel = sb
          .channel("dashboard-agents-realtime")
          .on(
            "postgres_changes",
            {
              event: "UPDATE",
              schema: "public",
              table: "agents",
            },
            (payload) => {
              if (payload.new) {
                patchAgent(payload.new as Record<string, unknown>);
              }
            },
          )
          .on(
            "postgres_changes",
            {
              event: "INSERT",
              schema: "public",
              table: "agents",
            },
            () => {
              fetchAgents();
            },
          )
          .subscribe((status) => {
            if (status === "SUBSCRIBED") {
              stopAgentPolling();
              return;
            }

            if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
              console.warn("[realtime] Agent subscription failed, falling back to polling");
              startAgentPolling();
              if (!cancelled) {
                setTimeout(() => {
                  if (!cancelled) setupAgentRealtime();
                }, REALTIME_RETRY_MS);
              }
            }
          });

        agentChannelRef.current = channel;
      } catch (err) {
        console.warn("[realtime] Agent setup failed, falling back to polling:", err);
        startAgentPolling();
      }
    };

    setupAgentRealtime();

    const overviewInterval = setInterval(fetchOverview, OVERVIEW_REFRESH_MS);

    return () => {
      cancelled = true;
      stopAgentPolling();
      clearInterval(overviewInterval);
      if (agentChannelRef.current) {
        agentChannelRef.current.unsubscribe();
        agentChannelRef.current = null;
      }
    };
  }, [fetchAgents, fetchOverview, patchAgent]);

  useEffect(() => {
    if (!syncBus) return;

    let cancelled = false;
    fetchBusMessages(busFilters);

    const stopBusPolling = () => {
      if (busPollingRef.current) {
        clearInterval(busPollingRef.current);
        busPollingRef.current = null;
      }
    };

    const startBusPolling = () => {
      if (busPollingRef.current) return;
      busPollingRef.current = setInterval(() => {
        fetchBusMessages(busFilters);
      }, POLL_INTERVAL_MS);
    };

    const setupBusRealtime = async () => {
      try {
        const sb = await getSupabaseBrowser();
        if (!sb || cancelled) {
          startBusPolling();
          return;
        }

        const channel = sb
          .channel("dashboard-bus-realtime")
          .on(
            "postgres_changes",
            {
              event: "INSERT",
              schema: "public",
              table: "message_bus",
            },
            (payload) => {
              if (payload.new) {
                appendBusMessage(payload.new as Record<string, unknown>);
              }
            },
          )
          .subscribe((status) => {
            if (status === "SUBSCRIBED") {
              stopBusPolling();
              return;
            }

            if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
              console.warn("[realtime] Bus subscription failed, falling back to polling");
              startBusPolling();
              if (!cancelled) {
                setTimeout(() => {
                  if (!cancelled) setupBusRealtime();
                }, REALTIME_RETRY_MS);
              }
            }
          });

        busChannelRef.current = channel;
      } catch (err) {
        console.warn("[realtime] Bus setup failed, falling back to polling:", err);
        startBusPolling();
      }
    };

    setupBusRealtime();

    return () => {
      cancelled = true;
      stopBusPolling();
      if (busChannelRef.current) {
        busChannelRef.current.unsubscribe();
        busChannelRef.current = null;
      }
    };
  }, [syncBus, busFilters, fetchBusMessages, appendBusMessage]);
}
