/**
 * OpenClaw Master Dashboard — Global state (Zustand)
 *
 * Keeps fetched data in memory so pages feel snappy when switching tabs.
 * Each slice has a fetch function that calls the corresponding API route.
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

  /* Actions */
  fetchAgents: () => Promise<void>;
  fetchOverview: () => Promise<void>;
  fetchBusMessages: (filters?: BusFilters) => Promise<void>;
  fetchDeployInfo: () => Promise<void>;
}

export interface BusFilters {
  channel?: string;
  event_type?: string;
  limit?: number;
}

/* ------------------------------------------------------------------ */
/*  Store                                                              */
/* ------------------------------------------------------------------ */

export const useDashboardStore = create<DashboardState>((set) => ({
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
}));
