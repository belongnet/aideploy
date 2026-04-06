/**
 * OpenClaw Master Dashboard — Supabase browser client
 *
 * Used by client components for Realtime subscriptions.
 * Config is fetched once from /api/supabase-config so we don't
 * leak the service-role key to the browser.
 */

"use client";

import { createClient, SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;
let _configPromise: Promise<{ url: string; anonKey: string }> | null = null;

async function fetchConfig(): Promise<{ url: string; anonKey: string }> {
  const res = await fetch("/api/supabase-config");
  if (!res.ok) throw new Error("Failed to fetch Supabase config");
  return res.json();
}

/**
 * Get the singleton browser Supabase client (lazy-initialized).
 * Returns null if config is not available.
 */
export async function getSupabaseBrowser(): Promise<SupabaseClient | null> {
  if (_client) return _client;

  try {
    if (!_configPromise) _configPromise = fetchConfig();
    const { url, anonKey } = await _configPromise;
    if (!url || !anonKey) return null;

    _client = createClient(url, anonKey, {
      realtime: { params: { eventsPerSecond: 10 } },
    });
    return _client;
  } catch {
    console.warn("[supabase-browser] Could not initialize client");
    return null;
  }
}
