"use client";

import { useEffect, useState, useCallback } from "react";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import {
  fetchAnalyticsVolume,
  fetchResponseTimes,
  fetchTaskUsage,
  fetchAiUsage,
} from "@/lib/api";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface VolumePoint {
  date: string;
  messages: number;
}

interface ResponseBucket {
  bucket: string;
  count: number;
}

interface TaskUsageItem {
  name: string;
  runs: number;
}

interface AiUsage {
  totalCalls: number;
  totalTokens: number;
  estimatedCost: number;
  dailyUsage: { date: string; calls: number; tokens: number }[];
}

/* Colors for the task usage bar chart */
const BAR_COLORS = [
  "#3b82f6",
  "#8b5cf6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#06b6d4",
  "#ec4899",
  "#6366f1",
];

/* ------------------------------------------------------------------ */
/*  Analytics Page                                                     */
/* ------------------------------------------------------------------ */

export default function AnalyticsPage() {
  const [volume, setVolume] = useState<VolumePoint[]>([]);
  const [responseTimes, setResponseTimes] = useState<ResponseBucket[]>([]);
  const [taskUsage, setTaskUsage] = useState<TaskUsageItem[]>([]);
  const [aiUsage, setAiUsage] = useState<AiUsage | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [vol, rt, tu, ai] = await Promise.all([
        fetchAnalyticsVolume(),
        fetchResponseTimes(),
        fetchTaskUsage(),
        fetchAiUsage(),
      ]);
      setVolume(vol);
      setResponseTimes(rt);
      setTaskUsage(tu);
      setAiUsage(ai);
    } catch {
      /* Silent fail */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /* ---------------------------------------------------------------- */
  /*  Loading state                                                    */
  /* ---------------------------------------------------------------- */

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-40 rounded bg-gray-200 animate-pulse" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 rounded-xl bg-gray-200 animate-pulse" />
          ))}
        </div>
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="h-72 rounded-xl bg-gray-200 animate-pulse" />
          <div className="h-72 rounded-xl bg-gray-200 animate-pulse" />
        </div>
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /*  Format helpers                                                   */
  /* ---------------------------------------------------------------- */

  const formatCost = (n: number) =>
    n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;

  const formatNumber = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toLocaleString();
  };

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">Analytics</h1>
        <p className="mt-1 text-sm text-gray-500">
          See how your agent is performing.
        </p>
      </div>

      {/* ------------------------------------------------------------ */}
      {/*  Summary stat cards                                           */}
      {/* ------------------------------------------------------------ */}
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <SummaryCard
          label="Total Messages"
          value={formatNumber(
            volume.reduce((sum, v) => sum + v.messages, 0)
          )}
        />
        <SummaryCard
          label="AI Calls"
          value={formatNumber(aiUsage?.totalCalls ?? 0)}
        />
        <SummaryCard
          label="Tokens Used"
          value={formatNumber(aiUsage?.totalTokens ?? 0)}
        />
        <SummaryCard
          label="Estimated Cost"
          value={formatCost(aiUsage?.estimatedCost ?? 0)}
        />
      </div>

      {/* ------------------------------------------------------------ */}
      {/*  Charts — 2-col on desktop, stacked on mobile                 */}
      {/* ------------------------------------------------------------ */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Message volume over time */}
        <div className="card">
          <h2 className="section-title mb-4">Message Volume</h2>
          {volume.length > 0 ? (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={volume}
                  margin={{ top: 5, right: 10, left: -20, bottom: 0 }}
                >
                  <defs>
                    <linearGradient id="volGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop
                        offset="5%"
                        stopColor="#3b82f6"
                        stopOpacity={0.2}
                      />
                      <stop
                        offset="95%"
                        stopColor="#3b82f6"
                        stopOpacity={0}
                      />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 11 }}
                    tickFormatter={(v: string) =>
                      new Date(v).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })
                    }
                  />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{
                      borderRadius: "8px",
                      border: "1px solid #e5e7eb",
                      fontSize: "13px",
                    }}
                    labelFormatter={(v: string) =>
                      new Date(v).toLocaleDateString("en-US", {
                        month: "long",
                        day: "numeric",
                      })
                    }
                  />
                  <Area
                    type="monotone"
                    dataKey="messages"
                    stroke="#3b82f6"
                    strokeWidth={2}
                    fill="url(#volGrad)"
                    name="Messages"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <EmptyChart message="No message data yet." />
          )}
        </div>

        {/* Response time distribution */}
        <div className="card">
          <h2 className="section-title mb-4">Response Speed</h2>
          {responseTimes.length > 0 ? (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={responseTimes}
                  margin={{ top: 5, right: 10, left: -20, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="bucket" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{
                      borderRadius: "8px",
                      border: "1px solid #e5e7eb",
                      fontSize: "13px",
                    }}
                  />
                  <Bar
                    dataKey="count"
                    name="Responses"
                    radius={[4, 4, 0, 0]}
                    fill="#8b5cf6"
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <EmptyChart message="No response data yet." />
          )}
        </div>

        {/* Most-used tasks */}
        <div className="card">
          <h2 className="section-title mb-4">Most-Used Tasks</h2>
          {taskUsage.length > 0 ? (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={taskUsage}
                  layout="vertical"
                  margin={{ top: 5, right: 10, left: 10, bottom: 0 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="#f0f0f0"
                    horizontal={false}
                  />
                  <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tick={{ fontSize: 11 }}
                    width={100}
                  />
                  <Tooltip
                    contentStyle={{
                      borderRadius: "8px",
                      border: "1px solid #e5e7eb",
                      fontSize: "13px",
                    }}
                  />
                  <Bar dataKey="runs" name="Runs" radius={[0, 4, 4, 0]}>
                    {taskUsage.map((_, idx) => (
                      <Cell
                        key={idx}
                        fill={BAR_COLORS[idx % BAR_COLORS.length]}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <EmptyChart message="No task usage yet." />
          )}
        </div>

        {/* AI usage / cost estimate */}
        <div className="card">
          <h2 className="section-title mb-4">AI Usage</h2>
          {aiUsage && aiUsage.dailyUsage.length > 0 ? (
            <div className="space-y-4">
              {/* Quick stats */}
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-lg bg-gray-50 p-3 text-center">
                  <p className="text-lg font-bold text-gray-900">
                    {formatNumber(aiUsage.totalCalls)}
                  </p>
                  <p className="text-[10px] text-gray-500 uppercase tracking-wide">
                    Calls
                  </p>
                </div>
                <div className="rounded-lg bg-gray-50 p-3 text-center">
                  <p className="text-lg font-bold text-gray-900">
                    {formatNumber(aiUsage.totalTokens)}
                  </p>
                  <p className="text-[10px] text-gray-500 uppercase tracking-wide">
                    Tokens
                  </p>
                </div>
                <div className="rounded-lg bg-gray-50 p-3 text-center">
                  <p className="text-lg font-bold text-gray-900">
                    {formatCost(aiUsage.estimatedCost)}
                  </p>
                  <p className="text-[10px] text-gray-500 uppercase tracking-wide">
                    Est. Cost
                  </p>
                </div>
              </div>

              {/* Daily calls chart */}
              <div className="h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    data={aiUsage.dailyUsage}
                    margin={{ top: 5, right: 10, left: -20, bottom: 0 }}
                  >
                    <defs>
                      <linearGradient
                        id="aiGrad"
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                      >
                        <stop
                          offset="5%"
                          stopColor="#10b981"
                          stopOpacity={0.2}
                        />
                        <stop
                          offset="95%"
                          stopColor="#10b981"
                          stopOpacity={0}
                        />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 10 }}
                      tickFormatter={(v: string) =>
                        new Date(v).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                        })
                      }
                    />
                    <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                    <Tooltip
                      contentStyle={{
                        borderRadius: "8px",
                        border: "1px solid #e5e7eb",
                        fontSize: "12px",
                      }}
                      labelFormatter={(v: string) =>
                        new Date(v).toLocaleDateString("en-US", {
                          month: "long",
                          day: "numeric",
                        })
                      }
                    />
                    <Area
                      type="monotone"
                      dataKey="calls"
                      stroke="#10b981"
                      strokeWidth={2}
                      fill="url(#aiGrad)"
                      name="AI Calls"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              <p className="text-[11px] text-gray-400 text-center">
                Cost estimates are approximate and based on standard pricing.
                {aiUsage.estimatedCost === 0 &&
                  " If you are using a subscription plan, usage is included in your plan."}
              </p>
            </div>
          ) : (
            <EmptyChart message="No AI usage data yet." />
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-card">
      <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
        {label}
      </span>
      <p className="text-2xl font-bold text-gray-900">{value}</p>
    </div>
  );
}

function EmptyChart({ message }: { message: string }) {
  return (
    <div className="flex h-48 items-center justify-center text-sm text-gray-400">
      {message}
    </div>
  );
}
