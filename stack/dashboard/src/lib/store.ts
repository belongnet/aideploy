import { create } from "zustand";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface AgentStatus {
  name: string;
  status: "running" | "stopped" | "error";
  uptime: string;
  version: string;
}

export interface Stats {
  messagesToday: number;
  totalConversations: number;
  activeChannels: number;
  activeTasks: number;
}

export interface Conversation {
  id: string;
  channelType: "telegram" | "whatsapp" | "slack";
  contactName: string;
  lastMessage: string;
  lastMessageAt: string;
  messageCount: number;
  starred: boolean;
}

export interface Message {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface Task {
  id: string;
  name: string;
  description: string;
  trigger: string;
  action: string;
  enabled: boolean;
  lastRun: string | null;
  runCount: number;
}

export interface Channel {
  id: string;
  type: "telegram" | "whatsapp" | "slack";
  name: string;
  status: "connected" | "disconnected" | "error";
  lastActivity: string | null;
}

export interface AgentConfig {
  name: string;
  personality: string;
  modelProvider: string;
  model: string;
  authMethod: "oauth" | "api_key";
  connectedAs: string | null;
  pruneEnabled: boolean;
  pruneAfterDays: number;
  pruneKeepStarred: boolean;
  serverInfo: {
    ip: string;
    tailscaleIp: string;
    provider: string;
    region: string;
  };
}

export interface DailyVolume {
  date: string;
  messages: number;
}

/* ------------------------------------------------------------------ */
/*  Store                                                              */
/* ------------------------------------------------------------------ */

interface DashboardStore {
  /** Whether the mobile sidebar is open */
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;

  /** Agent status */
  agentStatus: AgentStatus | null;
  setAgentStatus: (s: AgentStatus) => void;

  /** Aggregate stats */
  stats: Stats | null;
  setStats: (s: Stats) => void;

  /** Loading state for API calls */
  loading: Record<string, boolean>;
  setLoading: (key: string, v: boolean) => void;
}

export const useDashboardStore = create<DashboardStore>((set) => ({
  sidebarOpen: false,
  setSidebarOpen: (open) => set({ sidebarOpen: open }),

  agentStatus: null,
  setAgentStatus: (agentStatus) => set({ agentStatus }),

  stats: null,
  setStats: (stats) => set({ stats }),

  loading: {},
  setLoading: (key, v) =>
    set((state) => ({ loading: { ...state.loading, [key]: v } })),
}));
