/**
 * OpenClaw Master Dashboard — Shared type definitions
 * Maps to the Postgres schema defined in stack/db/init.sql
 */

/** Agent record from public.agents joined with per-agent config */
export interface Agent {
  id: string;
  name: string;
  schema_name: string;
  dashboard_port: number;
  gateway_port: number;
  agent_port: number;
  status: "running" | "stopped" | "error";
  created_at: string;
  updated_at: string;
  /** Populated from per-agent health check / config */
  config?: AgentConfig;
  /** Today's message count — populated by overview query */
  messages_today?: number;
  /** Channels this agent is connected to */
  channels?: ChannelSummary[];
  /** Whether the agent process responded to /health */
  healthy?: boolean;
  /** Whether the active AI provider is ready to answer messages */
  ai_connected?: boolean;
  /** Direct setup page for connecting the active AI provider */
  setup_url?: string;
}

/** Per-agent config from <schema>.agent_config */
export interface AgentConfig {
  model_provider: "openai" | "anthropic" | "gemini" | "kimi";
  auth_method: "oauth" | "api_key";
  model: string;
  system_prompt: string;
  agent_name: string;
  temperature: number;
  max_tokens: number;
  prune_enabled: boolean;
  prune_after_days: number;
  prune_keep_starred: boolean;
  memory_enabled: boolean;
  memory_provider: "supabase" | "mem0" | "none";
  memory_capture_mode: "async" | "off";
  memory_recall_top_k: number;
  memory_similarity_threshold: number;
  knowledge_provider: "none" | "qmd";
  knowledge_collections: string[];
}

/** Minimal channel info shown on agent cards */
export interface ChannelSummary {
  id: string;
  type: "telegram" | "whatsapp" | "slack";
  name: string;
  status: "active" | "inactive" | "error";
}

/** Message bus row from public.message_bus */
export interface BusMessage {
  id: number;
  source_agent_id: string | null;
  target_agent_id: string | null;
  channel: "agent_bus" | "system_bus" | "dashboard_bus";
  event_type:
    | "message_forward"
    | "task_result"
    | "health"
    | "agent_started"
    | "agent_stopped"
    | "config_changed"
    | "channel_event"
    | "broadcast";
  payload: Record<string, unknown>;
  status: "pending" | "delivered" | "failed";
  created_at: string;
  /** Resolved names for display */
  source_name?: string;
  target_name?: string;
}

/** Deployment info from public.deploy_info */
export interface DeployInfo {
  id: string;
  deploy_id: string;
  cloud_provider: string;
  region: string;
  server_size: string;
  server_ip: string | null;
  tailscale_ip: string | null;
  agent_count: number;
  created_at: string;
}

/** Aggregate overview stats returned by /api/overview */
export interface OverviewStats {
  total_agents: number;
  healthy_agents: number;
  unhealthy_agents: number;
  total_messages_today: number;
  total_bus_messages: number;
}

/** Conversation preview for agent detail page */
export interface ConversationPreview {
  id: string;
  title: string | null;
  participant_name: string | null;
  message_count: number;
  last_message_at: string | null;
  starred: boolean;
}
