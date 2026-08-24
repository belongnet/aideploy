/**
 * OpenClaw Master Dashboard — Health Check
 *
 * GET /api/healthz → { ok: true }
 *
 * Used by cloud-init to verify the dashboard is up before
 * sending the "ready" callback to the provisioner.
 */

import { NextResponse } from "next/server";

const startTime = Date.now();

export async function GET() {
  return NextResponse.json({
    ok: true,
    uptime: Math.floor((Date.now() - startTime) / 1000),
  });
}
