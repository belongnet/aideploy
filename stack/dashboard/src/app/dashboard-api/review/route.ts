import { NextRequest, NextResponse } from "next/server";

import { applyReviewDecision, readReviewQueue } from "@/lib/review-store";

// Local review-queue API for the per-agent dashboard. GET lists the items the
// event-workflow agent flagged for a human; POST records the owner's one-tap
// decision. Reads/writes local VM state only (no central control plane).

export async function GET() {
  try {
    const queue = await readReviewQueue();
    return NextResponse.json(queue);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load review queue" },
      { status: 500 },
    );
  }
}

const ACTIONS = new Set(["approve", "reject", "revise", "confirm", "undo"]);

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const id = typeof body?.id === "string" ? body.id : "";
    const action = typeof body?.action === "string" ? body.action : "";
    const note = typeof body?.note === "string" ? body.note : null;
    if (!id || !ACTIONS.has(action)) {
      return NextResponse.json(
        { error: "id and a valid action (approve|reject|revise|confirm|undo) are required" },
        { status: 400 },
      );
    }
    const updated = await applyReviewDecision(id, action, note, new Date().toISOString());
    if (!updated) {
      return NextResponse.json({ error: "Review item not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, item: updated });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not update review item" },
      { status: 500 },
    );
  }
}
