/**
 * OpenClaw Per-Agent Dashboard — Storage proxy
 *
 * GET /dashboard-api/storage?path=<object_path>&bucket=<bucket>
 *
 * Generates a signed URL from Supabase Storage so the frontend
 * can display images and files uploaded by the gateway.
 * Uses the service role key to sign (never exposed to the browser).
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const DEPLOY_ID = process.env.DEPLOY_ID ?? "";
const DEFAULT_BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? "agent-files";
const SIGNED_URL_EXPIRY = 3600; // 1 hour

function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const objectPath = searchParams.get("path");
  const requestedBucket = searchParams.get("bucket");

  if (!objectPath) {
    return NextResponse.json(
      { error: "Missing 'path' query parameter" },
      { status: 400 },
    );
  }

  if (!DEPLOY_ID) {
    return NextResponse.json(
      { error: "Storage signing is not configured for this deployment" },
      { status: 503 },
    );
  }

  if (requestedBucket && requestedBucket !== DEFAULT_BUCKET) {
    return NextResponse.json(
      { error: "Requested bucket is not allowed" },
      { status: 403 },
    );
  }

  if (
    objectPath.startsWith("/") ||
    objectPath.includes("..") ||
    !objectPath.startsWith(`${DEPLOY_ID}/`)
  ) {
    return NextResponse.json(
      { error: "Requested path is not allowed" },
      { status: 403 },
    );
  }

  const sb = getSupabase();
  if (!sb) {
    return NextResponse.json(
      { error: "Supabase Storage is not configured" },
      { status: 503 },
    );
  }

  const { data, error } = await sb.storage
    .from(DEFAULT_BUCKET)
    .createSignedUrl(objectPath, SIGNED_URL_EXPIRY);

  if (error) {
    console.error("[storage] Signed URL error:", error.message);
    return NextResponse.json(
      { error: "Failed to create signed URL" },
      { status: 500 },
    );
  }

  return NextResponse.json({ signedUrl: data.signedUrl });
}
