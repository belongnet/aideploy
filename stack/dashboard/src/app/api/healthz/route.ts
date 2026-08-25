import { NextResponse } from "next/server";

const startTime = Date.now();

export async function GET() {
  return NextResponse.json({
    ok: true,
    uptime: Math.floor((Date.now() - startTime) / 1000),
  });
}
