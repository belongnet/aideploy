"use client";

import { useEffect, useState, useCallback } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useDashboardStore } from "@/lib/store";
import {
  fetchStatus,
  fetchStats,
  fetchMessageVolume,
  fetchConversations,
  restartAgent,
} from "@/lib/api";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface VolumePoint {
  date: string;
  messages: number;
}

interface RecentConversation {
  id: string;
  channelType: string;
  contactName: string;
  lastMessage: string;
  lastMessageAt: string;
  starred: boolean;
}

/* ------------------------------------------------------------------ */
/*  Home Page                                                          */
/* ------------------------------------------------------------------ */

export default function HomePage() {
  const { agentStatus, stats, setAgentStatus, setStats } = useDashboardStore();
  const [volume, setVolume] = useState<VolumePoint[]>([]);
  const [recent, setRecent] = useState<RecentConversation[]>([]);
  const [restarting, setRestarting] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const [statusRes, statsRes, volRes, convRes] = await Promise.all([
        fetchStatus(),
        fetchStats(),
        fetchMessageVolume(),
        fetchConversations(),
      ]);
      setAgentStatus(statusRes as any);
      setStats(statsRes);
      setVolume(volRes);
      setRecent(convRes.slice(0, 5));
    } catch {
      /* If agent unreachable, show empty state */
    } finally {
      setLoaded(true);
    }
  }, [setAgentStatus, setStats]);

  useEffect(() => {
    // This mount-triggered loader intentionally owns the page loading state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const handleRestart = async () => {
    setRestarting(true);
    try {
      await restartAgent();
      /* Wait a moment for the agent to come back up, then refresh */
      setTimeout(load, 3000);
    } catch {
      /* error state handled gracefully */
    } finally {
      setRestarting(false);
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Helpers                                                          */
  /* ---------------------------------------------------------------- */

  const channelIcon = (type: string) => {
    switch (type) {
      case "telegram":
        return "TG";
      case "whatsapp":
        return "WA";
      case "slack":
        return "SL";
      default:
        return "?";
    }
  };

  const channelColor = (type: string) => {
    switch (type) {
      case "telegram":
        return "bg-blue-100 text-blue-700";
      case "whatsapp":
        return "bg-green-100 text-green-700";
      case "slack":
        return "bg-purple-100 text-purple-700";
      default:
        return "bg-gray-100 text-gray-700";
    }
  };

  const timeAgo = (iso: string) => {
    // Relative-time copy intentionally reflects the current render time.
    // eslint-disable-next-line react-hooks/purity
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  /* Loading skeleton */
  if (!loaded) {
    return (
      <div className="animate-pulse space-y-6">
        <div className="h-8 w-48 rounded bg-gray-200" />
        <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 rounded-xl bg-gray-200" />
          ))}
        </div>
        <div className="h-64 rounded-xl bg-gray-200" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* -------------------------------------------------------------- */}
      {/*  Header                                                        */}
      {/* -------------------------------------------------------------- */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="page-title">
            {agentStatus?.name ?? "Your Agent"}
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Here is what is happening with your agent today.
          </p>
        </div>
        <button
          onClick={handleRestart}
          disabled={restarting}
          className="btn-secondary text-sm"
        >
          {restarting ? "Restarting..." : "Restart Agent"}
        </button>
      </div>

      {/* -------------------------------------------------------------- */}
      {/*  Status card                                                   */}
      {/* -------------------------------------------------------------- */}
      <div className="card flex items-center gap-4">
        <span
          className={`
            status-dot
            ${
              agentStatus?.status === "running"
                ? "status-dot-green"
                : agentStatus?.status === "error"
                ? "status-dot-red"
                : "status-dot-yellow"
            }
          `}
        />
        <div>
          <p className="text-sm font-medium text-gray-900">
            {agentStatus?.status === "running"
              ? "Your agent is running"
              : agentStatus?.status === "error"
              ? "Your agent has an issue"
              : "Your agent is stopped"}
          </p>
          <p className="text-xs text-gray-500">
            {agentStatus?.uptime
              ? `Up for ${agentStatus.uptime}`
              : "Status unavailable"}
            {agentStatus?.version && ` — v${agentStatus.version}`}
          </p>
        </div>
      </div>

      {/* -------------------------------------------------------------- */}
      {/*  Stat cards (2-col on mobile, 4-col on desktop)                */}
      {/* -------------------------------------------------------------- */}
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Messages Today"
          value={stats?.messagesToday ?? 0}
          icon={
            <svg className="h-5 w-5 text-brand-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
            </svg>
          }
        />
        <StatCard
          label="Total Conversations"
          value={stats?.totalConversations ?? 0}
          icon={
            <svg className="h-5 w-5 text-brand-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3a49.5 49.5 0 01-4.02-.163 2.115 2.115 0 01-1.23-.567m7.75-6.926V6.75a2.25 2.25 0 00-2.25-2.25H6.75A2.25 2.25 0 004.5 6.75v4.5a2.25 2.25 0 002.25 2.25h1.5m7.5-6.75h-3" />
            </svg>
          }
        />
        <StatCard
          label="Connected Apps"
          value={stats?.activeChannels ?? 0}
          icon={
            <svg className="h-5 w-5 text-brand-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
            </svg>
          }
        />
        <StatCard
          label="Active Tasks"
          value={stats?.activeTasks ?? 0}
          icon={
            <svg className="h-5 w-5 text-brand-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
        />
      </div>

      {/* -------------------------------------------------------------- */}
      {/*  Message volume chart (last 7 days)                            */}
      {/* -------------------------------------------------------------- */}
      <div className="card">
        <h2 className="section-title mb-4">Messages This Week</h2>
        {volume.length > 0 ? (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={volume}
                margin={{ top: 5, right: 10, left: -20, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="msgGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 12 }}
                  tickFormatter={(v: string) => {
                    const d = new Date(v);
                    return d.toLocaleDateString("en-US", {
                      weekday: "short",
                    });
                  }}
                />
                <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
                <Tooltip
                  contentStyle={{
                    borderRadius: "8px",
                    border: "1px solid #e5e7eb",
                    fontSize: "13px",
                  }}
                  labelFormatter={(v: string) =>
                    new Date(v).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })
                  }
                />
                <Area
                  type="monotone"
                  dataKey="messages"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  fill="url(#msgGrad)"
                  name="Messages"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex h-40 items-center justify-center text-sm text-gray-400">
            No message data yet. Start chatting with your agent!
          </div>
        )}
      </div>

      {/* -------------------------------------------------------------- */}
      {/*  Recent conversations                                          */}
      {/* -------------------------------------------------------------- */}
      <div className="card">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="section-title">Recent Conversations</h2>
          <a
            href="/conversations"
            className="text-sm font-medium text-brand-600 hover:text-brand-700"
          >
            View all
          </a>
        </div>

        {recent.length > 0 ? (
          <ul className="divide-y divide-gray-100">
            {recent.map((c) => (
              <li key={c.id}>
                <a
                  href={`/conversations?id=${c.id}`}
                  className="flex items-center gap-3 py-3 hover:bg-gray-50 rounded-lg px-2 -mx-2 transition min-h-touch"
                >
                  {/* Channel badge */}
                  <span
                    className={`inline-flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold ${channelColor(c.channelType)}`}
                  >
                    {channelIcon(c.channelType)}
                  </span>

                  {/* Name + last message */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium text-gray-900 truncate">
                        {c.contactName}
                      </span>
                      {c.starred && (
                        <svg className="h-3.5 w-3.5 text-yellow-400 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                          <path fillRule="evenodd" d="M10.868 2.884c-.321-.772-1.415-.772-1.736 0l-1.83 4.401-4.753.381c-.833.067-1.171 1.107-.536 1.651l3.62 3.102-1.106 4.637c-.194.813.691 1.456 1.405 1.02L10 15.591l4.069 2.485c.713.436 1.598-.207 1.404-1.02l-1.106-4.637 3.62-3.102c.635-.544.297-1.584-.536-1.65l-4.752-.382-1.831-4.401z" clipRule="evenodd" />
                        </svg>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 truncate">
                      {c.lastMessage}
                    </p>
                  </div>

                  {/* Time */}
                  <span className="text-xs text-gray-400 shrink-0">
                    {timeAgo(c.lastMessageAt)}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex h-24 items-center justify-center text-sm text-gray-400">
            No conversations yet. Send a message to get started!
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Stat card sub-component                                            */
/* ------------------------------------------------------------------ */

function StatCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
}) {
  return (
    <div className="stat-card">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
          {label}
        </span>
        {icon}
      </div>
      <p className="text-2xl font-bold text-gray-900">{value.toLocaleString()}</p>
    </div>
  );
}
