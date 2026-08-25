"use client";

import { useCallback, useEffect, useState } from "react";
import {
  fetchReviewQueue,
  actOnReviewItem,
  type ReviewItemDTO,
} from "@/lib/api";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const PENDING = new Set(["needs_review", "pending_confirm"]);

function prettify(value: string): string {
  return value.replace(/_/g, " ");
}

function tierBadge(tier?: string): { label: string; cls: string } | null {
  switch (tier) {
    case "auto_execute":
      return { label: "Auto", cls: "bg-emerald-100 text-emerald-700" };
    case "quick_confirm":
      return { label: "One-tap confirm", cls: "bg-amber-100 text-amber-700" };
    case "full_review":
      return { label: "Needs review", cls: "bg-gray-100 text-gray-600" };
    default:
      return null;
  }
}

function statusBadge(status: string): string {
  if (status === "approved" || status === "auto_executed") return "bg-emerald-100 text-emerald-700";
  if (status === "rejected" || status === "auto_failed") return "bg-rose-100 text-rose-700";
  if (status === "compensated") return "bg-violet-100 text-violet-700";
  if (PENDING.has(status)) return "bg-amber-100 text-amber-700";
  return "bg-gray-100 text-gray-600";
}

/* ------------------------------------------------------------------ */
/*  Review Page                                                        */
/* ------------------------------------------------------------------ */

export default function ReviewPage() {
  const [items, setItems] = useState<ReviewItemDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const queue = await fetchReviewQueue();
      setItems(queue.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the review queue");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // This mount-triggered loader intentionally owns the page loading state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const act = useCallback(
    async (id: string, action: "approve" | "reject" | "revise" | "confirm" | "undo") => {
      setBusyId(id);
      try {
        const { item } = await actOnReviewItem(id, action);
        setItems((prev) => prev.map((i) => (i.id === item.id ? item : i)));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save your decision");
      } finally {
        setBusyId(null);
      }
    },
    [],
  );

  const pending = items.filter((i) => PENDING.has(i.status));
  const decided = items.filter((i) => !PENDING.has(i.status));

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">Review</h1>
        <p className="mt-1 text-sm text-gray-500">
          Approve, reject, or revise what your agent drafted. Money, comps, VIP, bookings, and
          safety always wait for you here.
        </p>
      </header>

      {error && (
        <div className="mb-4 rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 bg-white px-6 py-12 text-center">
          <p className="text-sm font-medium text-gray-700">Nothing waiting for you</p>
          <p className="mt-1 text-sm text-gray-500">
            When your agent drafts a reply or proposes an action that needs a human, it shows up
            here.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {pending.length > 0 && (
            <section>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-400">
                Waiting for you ({pending.length})
              </h2>
              <ul className="space-y-4">
                {pending.map((item) => (
                  <ReviewCard key={item.id} item={item} busy={busyId === item.id} onAct={act} />
                ))}
              </ul>
            </section>
          )}
          {decided.length > 0 && (
            <section>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-400">
                Recently decided ({decided.length})
              </h2>
              <ul className="space-y-4">
                {decided.map((item) => (
                  <ReviewCard key={item.id} item={item} busy={busyId === item.id} onAct={act} />
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Review Card                                                        */
/* ------------------------------------------------------------------ */

function ReviewCard({
  item,
  busy,
  onAct,
}: {
  item: ReviewItemDTO;
  busy: boolean;
  onAct: (id: string, action: "approve" | "reject" | "revise" | "confirm" | "undo") => void;
}) {
  const tier = tierBadge(item.autonomy?.tier);
  const isPending = PENDING.has(item.status);
  const isConfirm = item.status === "pending_confirm";
  const canUndo = item.status === "auto_executed";

  return (
    <li className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
          {prettify(item.itemType)}
        </span>
        {tier && (
          <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${tier.cls}`}>
            {tier.label}
          </span>
        )}
        <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${statusBadge(item.status)}`}>
          {prettify(item.status)}
        </span>
        <span className="ml-auto text-xs text-gray-400">
          {item.source.channel}
          {item.source.sender ? ` · ${item.source.sender}` : ""}
        </span>
      </div>

      <p className="mt-3 whitespace-pre-wrap text-sm text-gray-800">{item.draft}</p>

      {item.approvalReason && (
        <p className="mt-2 text-xs text-gray-500">
          <span className="font-medium text-gray-600">Why it needs you:</span> {item.approvalReason}
        </p>
      )}

      {item.riskFlags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {item.riskFlags.map((flag) => (
            <span
              key={flag}
              className="rounded bg-rose-50 px-1.5 py-0.5 text-[11px] font-medium text-rose-600"
            >
              {prettify(flag)}
            </span>
          ))}
        </div>
      )}

      {item.missingContext.length > 0 && (
        <p className="mt-2 text-xs text-gray-500">
          <span className="font-medium text-gray-600">Missing:</span>{" "}
          {item.missingContext.map(prettify).join(", ")}
        </p>
      )}

      {isPending ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            disabled={busy}
            onClick={() => onAct(item.id, isConfirm ? "confirm" : "approve")}
            className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {isConfirm ? "Confirm" : "Approve"}
          </button>
          {!isConfirm && (
            <button
              disabled={busy}
              onClick={() => onAct(item.id, "revise")}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Revise
            </button>
          )}
          <button
            disabled={busy}
            onClick={() => onAct(item.id, "reject")}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      ) : (
        <div className="mt-4 flex items-center gap-3">
          {item.decidedAt && (
            <span className="text-xs text-gray-400">
              Decided {new Date(item.decidedAt).toLocaleString()}
            </span>
          )}
          {canUndo && (
            <button
              disabled={busy}
              onClick={() => onAct(item.id, "undo")}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Undo
            </button>
          )}
        </div>
      )}
    </li>
  );
}
