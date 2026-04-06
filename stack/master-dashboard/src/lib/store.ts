/**
 * OpenClaw Master Dashboard — Global state (Zustand)
 *
 * Keeps fetched data in memory so pages feel snappy when switching tabs.
 * Each slice has a fetch function that calls the corresponding API route.
 *
 * Realtime updates (via Supabase) use appendBusMessage / patchAgent
 * to apply incremental changes without a full re-fetch.
 */

import { create } from "zustand";
import type { Agent, BusMessage, DeployInfo, OverviewStats } from "./types";

/* ------------------------------------------------------------------ */
/*  State shape                                                        */
/* ------------------------------------------------------------------ */

interface DashboardState {
  /* Data */
  agents: Agent[];
  overview: OverviewStats | null;
  busMessages: BusMessage[];
  deployInfo: DeployInfo | null;

  /* Loading / error flags */
  loadingAgents: boolean;
  loadingOverview: boolean;
  loadingBus: boolean;

  /* Full-fetch actions */
  fetchAgents: () => Promise<void>;
  fetchOverview: () => Promise<void>;
  fetchBusMessages: (filters?: BusFilters) => Promise<void>;
  fetchDeployInfo: () => Promise<void>;

  /* Realtime incremental actions */
  appendBusMessage: (row: Record<string, unknown>) => void;
  patchAgent: (row: Record<string, unknown>) => void;
}

export interface BusFilters {
  channel?: string;
  event_type?: string;
  limit?: number;
}

const MAX_BUS_MESSAGES = 200;

/* ------------------------------------------------------------------ */
/*  Store                                                              */
/* ------------------------------------------------------------------ */

export const useDashboardStore = create<DashboardState>((set, get) => ({
  agents: [],
  overview: null,
  busMessages: [],
  deployInfo: null,

  loadingAgents: false,
  loadingOverview: false,
  loadingBus: false,

  fetchAgents: async () => {
    set({ loadingAgents: true });
    try {
      const res = await fetch("/api/agents");
      if (!res.ok) throw new Error(`Failed to fetch agents: ${res.status}`);
      const data: Agent[] = await res.json();
      set({ agents: data });
    } catch (err) {
      console.error("[store] fetchAgents error:", err);
    } finally {
      set({ loadingAgents: false });
    }
  },

  fetchOverview: async () => {
    set({ loadingOverview: true });
    try {
      const res = await fetch("/api/overview");
      if (!res.ok) throw new Error(`Failed to fetch overview: ${res.status}`);
      const data = await res.json();
      set({ overview: data.stats, deployInfo: data.deploy ?? null });
    } catch (err) {
      console.error("[store] fetchOverview error:", err);
    } finally {
      set({ loadingOverview: false });
    }
  },

  fetchBusMessages: async (filters?: BusFilters) => {
    set({ loadingBus: true });
    try {
      const params = new URLSearchParams();
      if (filters?.channel) params.set("channel", filters.channel);
      if (filters?.event_type) params.set("event_type", filters.event_type);
      if (filters?.limit) params.set("limit", String(filters.limit));

      const qs = params.toString();
      const res = await fetch(`/api/bus${qs ? `?${qs}` : ""}`);
      if (!res.ok)
        throw new Error(`Failed to fetch bus messages: ${res.status}`);
      const data: BusMessage[] = await res.json();
      set({ busMessages: data });
    } catch (err) {
      console.error("[store] fetchBusMessages error:", err);
    } finally {
      set({ loadingBus: false });
    }
  },

  fetchDeployInfo: async () => {
    try {
      const res = await fetch("/api/overview");
      if (!res.ok) return;
      const data = await res.json();
      set({ deployInfo: data.deploy ?? null });
    } catch (err) {
      console.error("[store] fetchDeployInfo error:", err);
    }
  },

  /**
   * Append a bus message received via Supabase Realtime (INSERT event).
   * Prepends to the list and caps at MAX_BUS_MESSAGES.
   */
  appendBusMessage: (row) => {
    const msg = row as unknown as BusMessage;
    if (!msg.id) return;

    const current = get().busMessages;
    // Avoid duplicates
    if (current.some((m) => m.id === msg.id)) return;

    set({
      busMessages: [msg, ...current].slice(0, MAX_BUS_MESSAGES),
    });
  },

  /**
   * Patch an agent's fields from a Supabase Realtime UPDATE event.
   * Merges the changed fields into the existing agent object.
   */
  patchAgent: (row) => {
    const id = row.id as string;
    if (!id) return;

    set({
      agents: get().agents.map((agent) =>
        agent.id === id ? { ...agent, ...row } : agent,
      ),
    });
  },
}));
