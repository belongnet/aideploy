/**
 * OpenClaw Master Dashboard — Supabase client (server-side)
 *
 * Uses the service-role key to query the local Supabase instance
 * that runs alongside the agents in Docker Compose.
 *
 * All API routes should use `supabase()` instead of raw `pg` connections.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL =
  process.env.SUPABASE_URL ?? "http://supabase-kong:8000";
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

let _client: SupabaseClient | null = null;

/**
 * Return a singleton Supabase client for server-side use.
 * Falls back to null if the service-role key is not configured.
 */
export function supabase(): SupabaseClient | null {
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.warn("[supabase] SUPABASE_SERVICE_ROLE_KEY not set — Supabase client unavailable");
    return null;
  }

  if (!_client) {
    _client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
  }
  return _client;
}

/**
 * Return the public-facing Supabase URL (for browser clients to connect Realtime).
 * Defaults to the internal URL if SUPABASE_PUBLIC_URL is not set.
 */
export function supabasePublicConfig() {
  return {
    url: process.env.SUPABASE_PUBLIC_URL ?? process.env.SUPABASE_URL ?? "http://localhost:8000",
    anonKey: process.env.SUPABASE_ANON_KEY ?? "",
  };
}
