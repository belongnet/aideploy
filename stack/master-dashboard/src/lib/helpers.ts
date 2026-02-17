/**
 * OpenClaw Master Dashboard — UI helper utilities
 */

/**
 * Friendly label for AI model provider.
 * Shown on agent cards and detail views.
 */
export function providerLabel(provider: string): string {
  const map: Record<string, string> = {
    openai: "ChatGPT",
    anthropic: "Claude",
    gemini: "Gemini",
    kimi: "Kimi",
  };
  return map[provider] ?? provider;
}

/**
 * Friendly label for messaging channel type.
 */
export function channelLabel(type: string): string {
  const map: Record<string, string> = {
    telegram: "Telegram",
    whatsapp: "WhatsApp",
    slack: "Slack",
  };
  return map[type] ?? type;
}

/**
 * Icon character for channel type (emoji-free text-based icons).
 * Used in compact card views.
 */
export function channelIcon(type: string): string {
  const map: Record<string, string> = {
    telegram: "TG",
    whatsapp: "WA",
    slack: "SL",
  };
  return map[type] ?? type.slice(0, 2).toUpperCase();
}

/**
 * Icon text for AI provider shown on cards.
 */
export function providerIcon(provider: string): string {
  const map: Record<string, string> = {
    openai: "GPT",
    anthropic: "CL",
    gemini: "GM",
    kimi: "KM",
  };
  return map[provider] ?? provider.slice(0, 2).toUpperCase();
}

/**
 * Format a timestamp as a human-readable relative or absolute time.
 */
export function formatTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Truncate a string to a max length with ellipsis.
 */
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "\u2026";
}

/**
 * Event-type label for the bus monitor.
 */
export function eventTypeLabel(eventType: string): string {
  const map: Record<string, string> = {
    message_forward: "Message Forward",
    task_result: "Task Result",
    health: "Health Check",
    agent_started: "Agent Started",
    agent_stopped: "Agent Stopped",
    config_changed: "Config Changed",
    channel_event: "Channel Event",
    broadcast: "Broadcast",
  };
  return map[eventType] ?? eventType;
}

/**
 * CSS class for status badges.
 */
export function statusColor(status: string): string {
  switch (status) {
    case "running":
      return "bg-green-100 text-green-800";
    case "stopped":
      return "bg-gray-100 text-gray-600";
    case "error":
      return "bg-red-100 text-red-800";
    case "active":
      return "bg-green-100 text-green-800";
    case "inactive":
      return "bg-gray-100 text-gray-600";
    case "pending":
      return "bg-yellow-100 text-yellow-800";
    case "delivered":
      return "bg-green-100 text-green-800";
    case "failed":
      return "bg-red-100 text-red-800";
    default:
      return "bg-gray-100 text-gray-600";
  }
}
