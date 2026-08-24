/**
 * OpenClaw Master Dashboard — Supabase config endpoint
 *
 * Returns the public Supabase URL + anon key so browser clients
 * can connect for Realtime subscriptions without exposing the
 * service-role key.
 */

import { NextResponse } from "next/server";
import { supabasePublicConfig } from "@/lib/supabase";

export async function GET() {
  const config = supabasePublicConfig();
  return NextResponse.json(config);
}
