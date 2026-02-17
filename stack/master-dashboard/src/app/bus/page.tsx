"use client";

import { useEffect, useState, useCallback } from "react";
import { useDashboardStore } from "@/lib/store";
import type { BusFilters } from "@/lib/store";
import {
  eventTypeLabel,
  formatTime,
  statusColor,
  truncate,
} from "@/lib/helpers";
import type { BusMessage } from "@/lib/types";

/* ------------------------------------------------------------------ */
/*  Bus channels and event types (match DB CHECK constraints)           */
/* ------------------------------------------------------------------ */

const CHANNELS = ["all", "agent_bus", "system_bus", "dashboard_bus"] as const;

const EVENT_TYPES = [
  "all",
  "message_forward",
  "task_result",
  "health",
  "agent_started",
  "agent_stopped",
  "config_changed",
  "channel_event",
  "broadcast",
] as const;

/* ------------------------------------------------------------------ */
/*  Message bus monitor page                                            */
/* ------------------------------------------------------------------ */

export default function BusPage() {
  const { busMessages, loadingBus, fetchBusMessages } = useDashboardStore();

  const [channelFilter, setChannelFilter] = useState<string>("all");
  const [eventFilter, setEventFilter] = useState<string>("all");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  /** Build filters object from state */
  const buildFilters = useCallback((): BusFilters => {
    const f: BusFilters = { limit: 100 };
    if (channelFilter !== "all") f.channel = channelFilter;
    if (eventFilter !== "all") f.event_type = eventFilter;
    return f;
  }, [channelFilter, eventFilter]);

  /* Fetch on mount, re-fetch when filters change */
  useEffect(() => {
    fetchBusMessages(buildFilters());
  }, [fetchBusMessages, buildFilters]);

  /* Auto-refresh every 5 seconds */
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      fetchBusMessages(buildFilters());
    }, 5_000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchBusMessages, buildFilters]);

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Message Bus</h1>
          <p className="mt-1 text-sm text-gray-500">
            Live view of messages flowing between agents and the system.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
          />
          Auto-refresh
        </label>
      </div>

      {/* ── Filter bar ── */}
      <div className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
        {/* Channel filter */}
        <div className="flex items-center gap-2">
          <label htmlFor="channel" className="text-sm font-medium text-gray-700">
            Channel
          </label>
          <select
            id="channel"
            value={channelFilter}
            onChange={(e) => setChannelFilter(e.target.value)}
            className="min-h-[44px] rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          >
            {CHANNELS.map((ch) => (
              <option key={ch} value={ch}>
                {ch === "all" ? "All channels" : ch}
              </option>
            ))}
          </select>
        </div>

        {/* Event type filter */}
        <div className="flex items-center gap-2">
          <label htmlFor="event" className="text-sm font-medium text-gray-700">
            Event
          </label>
          <select
            id="event"
            value={eventFilter}
            onChange={(e) => setEventFilter(e.target.value)}
            className="min-h-[44px] rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          >
            {EVENT_TYPES.map((ev) => (
              <option key={ev} value={ev}>
                {ev === "all" ? "All events" : eventTypeLabel(ev)}
              </option>
            ))}
          </select>
        </div>

        {/* Refresh button */}
        <button
          className="btn-secondary ml-auto"
          onClick={() => fetchBusMessages(buildFilters())}
        >
          Refresh
        </button>
      </div>

      {/* ── Message log ── */}
      {loadingBus && busMessages.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-200 border-t-brand-600" />
          <span className="ml-3 text-sm text-gray-500">Loading messages...</span>
        </div>
      ) : busMessages.length === 0 ? (
        <div className="card flex flex-col items-center justify-center px-6 py-16 text-center">
          <h3 className="text-lg font-semibold text-gray-900">No messages</h3>
          <p className="mt-1 max-w-sm text-sm text-gray-500">
            Bus messages will appear here as agents communicate. Try changing
            the filters or wait for activity.
          </p>
        </div>
      ) : (
        <div className="card divide-y divide-gray-100 overflow-hidden">
          {/* Desktop header */}
          <div className="hidden border-b border-gray-100 bg-gray-50 px-5 py-2.5 sm:grid sm:grid-cols-12 sm:gap-2 text-xs font-medium uppercase tracking-wider text-gray-500">
            <span className="col-span-1">#</span>
            <span className="col-span-2">Channel</span>
            <span className="col-span-2">Event</span>
            <span className="col-span-3">Source / Target</span>
            <span className="col-span-2">Status</span>
            <span className="col-span-2 text-right">Time</span>
          </div>

          {busMessages.map((msg) => (
            <BusRow
              key={msg.id}
              msg={msg}
              expanded={expandedId === msg.id}
              onToggle={() =>
                setExpandedId(expandedId === msg.id ? null : msg.id)
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Individual bus message row                                          */
/* ------------------------------------------------------------------ */

function BusRow({
  msg,
  expanded,
  onToggle,
}: {
  msg: BusMessage;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="hover:bg-gray-50 transition-colors">
      {/* Desktop row */}
      <button
        className="hidden w-full cursor-pointer px-5 py-3 text-left text-sm sm:grid sm:grid-cols-12 sm:gap-2 sm:items-center"
        onClick={onToggle}
      >
        <span className="col-span-1 font-mono text-xs text-gray-400">
          {msg.id}
        </span>
        <span className="col-span-2">
          <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
            {msg.channel}
          </span>
        </span>
        <span className="col-span-2">
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColor(msg.status)}`}>
            {eventTypeLabel(msg.event_type)}
          </span>
        </span>
        <span className="col-span-3 text-xs text-gray-600 truncate">
          <span className="font-medium">{msg.source_name ?? "system"}</span>
          {" -> "}
          <span className="font-medium">{msg.target_name ?? "broadcast"}</span>
        </span>
        <span className="col-span-2">
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColor(msg.status)}`}>
            {msg.status}
          </span>
        </span>
        <span className="col-span-2 text-right text-xs text-gray-400">
          {formatTime(msg.created_at)}
        </span>
      </button>

      {/* Mobile row */}
      <button
        className="w-full cursor-pointer px-4 py-3 text-left sm:hidden"
        onClick={onToggle}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-700">
              {msg.channel}
            </span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColor(msg.status)}`}>
              {eventTypeLabel(msg.event_type)}
            </span>
          </div>
          <span className="text-xs text-gray-400">
            {formatTime(msg.created_at)}
          </span>
        </div>
        <p className="mt-1 text-xs text-gray-600">
          <span className="font-medium">{msg.source_name ?? "system"}</span>
          {" -> "}
          <span className="font-medium">{msg.target_name ?? "broadcast"}</span>
        </p>
      </button>

      {/* Expanded payload */}
      {expanded && (
        <div className="border-t border-gray-100 bg-gray-50 px-5 py-3">
          <p className="mb-1 text-xs font-semibold text-gray-500">Payload</p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-gray-900 p-3 text-xs text-green-400">
            {JSON.stringify(msg.payload, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
