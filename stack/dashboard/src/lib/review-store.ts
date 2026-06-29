/**
 * Local review-queue store for the per-agent dashboard.
 *
 * The event-workflow agent emits review-queue items (drafts + autonomy
 * decisions that need a human). This module reads/writes them from a local
 * JSON file on the VM, using the same runtime/home path convention as
 * openclaw-runtime.ts so the dashboard (which only ever touches local state)
 * can render and act on them without reaching the central control plane.
 *
 * Contract: the runtime appends items here (status `needs_review` or
 * `pending_confirm`); the dashboard flips them to `approved`/`rejected`/
 * `revised`/`compensated` and the gateway acts on the owner's decision.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const SECRETS_ROOT =
  process.env.AIDEPLOY_RUNTIME_SECRETS_ROOT || "/run/aideploy-secrets";
const HOME_ROOT = process.env.AIDEPLOY_HOME_ROOT || "/home/aideploy";

const RUNTIME_STORE = `${SECRETS_ROOT}/default/.openclaw/review-queue.json`;
const SOURCE_STORE = `${HOME_ROOT}/.openclaw/review-queue.json`;

export type ReviewStatus =
  | "needs_review"
  | "approved"
  | "rejected"
  | "revised"
  | "pending_confirm"
  | "auto_executed"
  | "compensated"
  | "auto_failed";

export interface ReviewItemAutonomy {
  tier?: "auto_execute" | "quick_confirm" | "full_review";
  actionTier?: "A" | "B" | "C" | null;
  reason?: string;
  downgradedFrom?: string | null;
  actionId?: string;
}

export interface ReviewItem {
  id: string;
  workflowPackId: string;
  itemType: string;
  source: { channel: string; reference: string; sender?: string; receivedAt?: string };
  extractedFacts: string[];
  missingContext: string[];
  draft: string;
  riskFlags: string[];
  owner: string;
  approvalReason: string;
  status: ReviewStatus;
  autonomy?: ReviewItemAutonomy;
  decidedAt?: string | null;
  decisionNote?: string | null;
}

export interface ReviewQueue {
  version: number;
  items: ReviewItem[];
}

const EMPTY: ReviewQueue = { version: 1, items: [] };

async function readJson(path: string): Promise<ReviewQueue | null> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as ReviewQueue;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.items)) {
      return null;
    }
    return parsed;
  } catch {
    // Absent or unreadable store => no items yet (the common pre-population case).
    return null;
  }
}

/** Read the review queue, preferring the runtime path then the home path. */
export async function readReviewQueue(): Promise<ReviewQueue> {
  return (await readJson(RUNTIME_STORE)) ?? (await readJson(SOURCE_STORE)) ?? EMPTY;
}

async function writeJson(path: string, queue: ReviewQueue): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(queue, null, 2)}\n`, { mode: 0o600 });
}

/** Map a one-tap action to the resulting item status. */
function statusForAction(action: string): ReviewStatus | null {
  switch (action) {
    case "approve":
      return "approved";
    case "reject":
      return "rejected";
    case "revise":
      return "revised";
    case "confirm":
      // Owner confirmed a quick_confirm action; the gateway then executes it.
      return "approved";
    case "undo":
      return "compensated";
    default:
      return null;
  }
}

/**
 * Apply an owner decision to a review item and persist it. Returns the updated
 * item, or null if the id or action is unknown. The gateway/runtime watches for
 * `approved`/`compensated` items and performs the actual send/execute/undo —
 * the dashboard only records the human decision.
 */
export async function applyReviewDecision(
  id: string,
  action: string,
  note: string | null,
  now: string
): Promise<ReviewItem | null> {
  const status = statusForAction(action);
  if (!status) return null;
  const queue = await readReviewQueue();
  const item = queue.items.find((i) => i.id === id);
  if (!item) return null;
  item.status = status;
  item.decidedAt = now;
  item.decisionNote = note;
  await writeJson(RUNTIME_STORE, queue);
  await writeJson(SOURCE_STORE, queue).catch(() => {
    // Home-root mirror is best-effort (matches openclaw-runtime behavior).
  });
  return item;
}
