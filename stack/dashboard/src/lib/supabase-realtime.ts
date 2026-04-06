/**
 * OpenClaw Per-Agent Dashboard — Supabase Realtime client
 *
 * Connects to the local Supabase instance (via Kong) for live
 * conversation and message updates. The public URL is exposed
 * by the agent's docker-compose environment.
 *
 * Falls back gracefully if Supabase config is not available.
 */

"use client";

import { useEffect, useRef } from "react";
import { createClient, SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
  if (_client) return _client;

  // These are injected at build time from docker-compose environment
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;

  _client = createClient(url, key, {
    realtime: { params: { eventsPerSecond: 10 } },
  });
  return _client;
}

/**
 * Hook that subscribes to Supabase Realtime for live conversation updates.
 * Calls the provided callbacks when new messages or conversations are inserted/updated.
 */
export function useConversationRealtime(opts: {
  onNewMessage?: (payload: Record<string, unknown>) => void;
  onConversationUpdate?: (payload: Record<string, unknown>) => void;
}) {
  const channelRef = useRef<RealtimeChannel | null>(null);
  const { onNewMessage, onConversationUpdate } = opts;

  useEffect(() => {
    const sb = getClient();
    if (!sb) return;

    const channel = sb
      .channel("agent-conversations")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "agent_messages",
        },
        (payload) => {
          if (payload.new && onNewMessage) {
            onNewMessage(payload.new as Record<string, unknown>);
          }
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "agent_conversations",
        },
        (payload) => {
          if (payload.new && onConversationUpdate) {
            onConversationUpdate(payload.new as Record<string, unknown>);
          }
        },
      )
      .subscribe();

    channelRef.current = channel;

    return () => {
      channel.unsubscribe();
      channelRef.current = null;
    };
  }, [onNewMessage, onConversationUpdate]);
}
