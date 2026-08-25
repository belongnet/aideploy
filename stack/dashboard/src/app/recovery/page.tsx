"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchRecoveryOverview,
  fetchRecoveryMergePreview,
  fetchRecoveryPreview,
  requestRecoveryRestore,
  type RecoveryBackupRun,
  type RecoveryMergePreview,
  type RecoveryOverview,
  type RecoveryPreview,
  type RestorePlaceholderResult,
} from "@/lib/api";

function formatDate(value: string) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function statusClasses(status: string) {
  switch (status) {
    case "completed":
      return "bg-green-100 text-green-700";
    case "failed":
      return "bg-red-100 text-red-700";
    case "running":
      return "bg-yellow-100 text-yellow-800";
    default:
      return "bg-gray-100 text-gray-700";
  }
}

export default function RecoveryPage() {
  const [overview, setOverview] = useState<RecoveryOverview | null>(null);
  const [preview, setPreview] = useState<RecoveryPreview | null>(null);
  const [mergePreview, setMergePreview] = useState<RecoveryMergePreview | null>(null);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [loading, setLoading] = useState(true);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [restoreResult, setRestoreResult] =
    useState<RestorePlaceholderResult | null>(null);
  const [fullRestoreConfirm, setFullRestoreConfirm] = useState("");
  const [error, setError] = useState("");

  const selectedRun = useMemo(
    () => overview?.backups.find((backup) => backup.id === selectedRunId) ?? null,
    [overview?.backups, selectedRunId],
  );
  const expectedFullRestoreConfirm = selectedRunId
    ? `RESTORE ${selectedRunId}`
    : "";
  const fullRestoreReady =
    !!mergePreview &&
    selectedRun?.restoreEligible !== false &&
    !!expectedFullRestoreConfirm &&
    fullRestoreConfirm.trim() === expectedFullRestoreConfirm;

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await fetchRecoveryOverview();
      setOverview(data);
      const nextSelected = data.latestRun?.id ?? "";
      setSelectedRunId((current) =>
        current && data.backups.some((backup) => backup.id === current)
          ? current
          : nextSelected,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load recovery data.");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPreview = useCallback(async (runId: string) => {
    if (!runId) {
      setPreview(null);
      setMergePreview(null);
      return;
    }
    setPreviewLoading(true);
    setRestoreResult(null);
    setFullRestoreConfirm("");
    try {
      const [backupPreview, merge] = await Promise.all([
        fetchRecoveryPreview(runId),
        fetchRecoveryMergePreview(runId),
      ]);
      setPreview(backupPreview);
      setMergePreview(merge);
    } catch {
      setPreview(null);
      setMergePreview(null);
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  useEffect(() => {
    // This effect intentionally refreshes the overview and its loading state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    // This effect intentionally resets and refreshes the selected preview.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadPreview(selectedRunId);
  }, [loadPreview, selectedRunId]);

  const handleRestore = async () => {
    if (!selectedRunId) return;
    setRestoreLoading(true);
    setRestoreResult(null);
    setError("");
    try {
      setRestoreResult(await requestRecoveryRestore(selectedRunId, "merge"));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not record restore request.",
      );
    } finally {
      setRestoreLoading(false);
    }
  };

  const handleFullRestore = async () => {
    if (!selectedRunId || !fullRestoreReady) return;
    setRestoreLoading(true);
    setRestoreResult(null);
    setError("");
    try {
      setRestoreResult(
        await requestRecoveryRestore(selectedRunId, "full", {
          mergeReviewed: true,
          confirmation: fullRestoreConfirm.trim(),
        }),
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not start full restore.",
      );
    } finally {
      setRestoreLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-40 rounded bg-gray-200" />
        <div className="grid gap-4 md:grid-cols-3">
          {[1, 2, 3].map((item) => (
            <div key={item} className="h-28 rounded-xl bg-gray-200" />
          ))}
        </div>
        <div className="h-72 rounded-xl bg-gray-200" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="page-title">Recovery</h1>
          <p className="mt-1 text-sm text-gray-500">
            Review local and cloud backup metadata and prepare a restore run.
          </p>
        </div>
        <button onClick={loadOverview} className="btn-secondary text-sm">
          Refresh
        </button>
      </div>

      {error && (
        <div className="card border-red-100 bg-red-50 text-sm text-red-700">
          {error}
        </div>
      )}

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatusCard
          label="Backup status"
          value={
            overview?.status === "healthy"
              ? "Available"
              : overview?.status === "empty"
                ? "No runs"
                : "Unavailable"
          }
          detail={overview?.message ?? "No recovery status loaded."}
        />
        <StatusCard
          label="Latest run"
          value={overview?.latestRun?.id ?? "None"}
          detail={
            overview?.latestRun
              ? `${overview.latestRun.mode} · ${formatDate(overview.latestRun.updatedAt)}`
            : "No backup run metadata found."
          }
        />
        <StatusCard
          label="Latest restore"
          value={overview?.latestRestore?.status ?? "None"}
          detail={
            overview?.latestRestore
              ? `${overview.latestRestore.productionOverwrite ? "overwrite" : "merge"} · ${
                  overview.latestRestore.backupRunId || overview.latestRestore.id
                }`
              : "No restore runs found."
          }
        />
        <StatusCard
          label="Cloud catalog"
          value={
            overview?.catalogStatus === "healthy"
              ? "Available"
              : overview?.catalogStatus === "empty"
                ? "No manifests"
                : "Unavailable"
          }
          detail={overview?.catalogMessage ?? "No cloud catalog loaded."}
        />
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.9fr)]">
        <section className="card">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h2 className="section-title">Backups</h2>
              <p className="mt-1 text-sm text-gray-500">
                Local records merged with cloud manifests from the native object store.
              </p>
            </div>
            <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-600">
              {overview?.backups.length ?? 0}
            </span>
          </div>

          {overview?.backups.length ? (
            <div className="space-y-3">
              {overview.backups.map((backup) => (
                <BackupButton
                  key={backup.id}
                  backup={backup}
                  selected={backup.id === selectedRunId}
                  onSelect={() => setSelectedRunId(backup.id)}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-gray-200 p-6 text-center">
              <p className="text-sm font-medium text-gray-700">
                No backup runs found
              </p>
              <p className="mt-1 text-sm text-gray-500">
                Backup metadata will appear here after a run writes to the state directory.
                Cloud manifests are listed when the target object store is reachable.
              </p>
            </div>
          )}
        </section>

        <section className="card">
          <div className="mb-4">
            <h2 className="section-title">Preview</h2>
            <p className="mt-1 text-sm text-gray-500">
              Confirm artifacts before starting an operator restore workflow.
            </p>
          </div>

          {!selectedRun ? (
            <p className="text-sm text-gray-500">Select a backup to preview it.</p>
          ) : previewLoading ? (
            <div className="space-y-3 animate-pulse">
              <div className="h-5 rounded bg-gray-200" />
              <div className="h-24 rounded bg-gray-200" />
              <div className="h-32 rounded bg-gray-200" />
            </div>
          ) : (
            <div className="space-y-5">
              <div className="rounded-lg bg-gray-50 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-gray-900">
                      {selectedRun.id}
                    </p>
                    <p className="mt-1 text-xs text-gray-500">
                      {selectedRun.provider || "Unknown provider"} ·{" "}
                      {selectedRun.bucket || "No bucket"} · {selectedRun.source || "local"}
                    </p>
                  </div>
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-medium ${statusClasses(
                      selectedRun.status,
                    )}`}
                  >
                    {selectedRun.status || "unknown"}
                  </span>
                </div>
                {selectedRun.error && (
                  <p className="mt-3 text-sm text-red-600">{selectedRun.error}</p>
                )}
                {selectedRun.catalogMessage && (
                  <p className="mt-3 text-sm text-gray-600">
                    {selectedRun.catalogMessage}
                  </p>
                )}
                {!selectedRun.restoreEligible && selectedRun.restoreBlockedReason && (
                  <p className="mt-3 text-sm text-amber-700">
                    {selectedRun.restoreBlockedReason}
                  </p>
                )}
              </div>

              <div>
                <h3 className="text-sm font-semibold text-gray-800">Restore plan</h3>
                <ol className="mt-2 space-y-2">
                  {(preview?.restorePlan ?? []).map((step, index) => (
                    <li key={step} className="flex gap-2 text-sm text-gray-600">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700">
                        {index + 1}
                      </span>
                      <span>{step}</span>
                    </li>
                  ))}
                </ol>
              </div>

              <div>
                <h3 className="text-sm font-semibold text-gray-800">Artifacts</h3>
                {preview?.manifest?.artifacts.length ? (
                  <div className="mt-2 divide-y divide-gray-100 rounded-lg border border-gray-100">
                    {preview.manifest.artifacts.map((artifact) => (
                      <div key={artifact.name} className="p-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="truncate text-sm font-medium text-gray-800">
                            {artifact.name}
                          </p>
                          <span className="text-xs text-gray-500">
                            {formatBytes(artifact.bytes)}
                          </span>
                        </div>
                        <p className="mt-1 truncate text-xs text-gray-500">
                          {artifact.type} · {artifact.remotePath}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-gray-500">
                    No manifest artifacts are available for this run.
                  </p>
                )}
              </div>

              {mergePreview && (
                <div>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-gray-800">
                        Merge diff
                      </h3>
                      <p className="mt-1 text-xs text-gray-500">
                        Compared with {mergePreview.baselineLabel}.
                      </p>
                    </div>
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                        mergePreview.destructive
                          ? "bg-amber-100 text-amber-800"
                          : "bg-green-100 text-green-700"
                      }`}
                    >
                      {mergePreview.destructive ? "Review" : "No changes"}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-gray-600">{mergePreview.summary}</p>
                  <div className="mt-3 overflow-hidden rounded-lg border border-gray-100">
                    <div className="max-h-64 overflow-auto bg-gray-950 p-3">
                      <pre className="whitespace-pre-wrap break-words text-xs leading-5 text-gray-100">
                        {mergePreview.manifestDiff}
                      </pre>
                    </div>
                  </div>
                  {mergePreview.artifactChanges.length > 0 && (
                    <div className="mt-3 grid gap-2">
                      {mergePreview.artifactChanges.map((change) => (
                        <div
                          key={change.name}
                          className="rounded-lg border border-gray-100 bg-gray-50 p-3"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className="truncate text-sm font-medium text-gray-800">
                              {change.name}
                            </span>
                            <span className="text-xs uppercase text-gray-500">
                              {change.change}
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-gray-500">
                            {formatBytes(change.beforeBytes)} to{" "}
                            {formatBytes(change.afterBytes)}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <button
                onClick={handleRestore}
                disabled={restoreLoading}
                className="btn-primary w-full text-sm"
              >
                {restoreLoading ? "Recording..." : "Record Merge Restore Request"}
              </button>

              <div className="rounded-lg border border-red-100 bg-red-50 p-4">
                <div className="flex flex-col gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-red-900">
                      Full restore
                    </h3>
                    <p className="mt-1 text-xs text-red-700">
                      Overwrites production data after the merge diff is loaded and explicitly confirmed.
                    </p>
                  </div>
                  <input
                    value={fullRestoreConfirm}
                    onChange={(event) =>
                      setFullRestoreConfirm(event.currentTarget.value)
                    }
                    placeholder={expectedFullRestoreConfirm || "RESTORE <run-id>"}
                    className="rounded-md border border-red-200 bg-white px-3 py-2 text-sm text-red-950 placeholder:text-red-300 focus:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-100"
                  />
                  <button
                    onClick={handleFullRestore}
                    disabled={restoreLoading || !fullRestoreReady}
                    className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-600 disabled:cursor-not-allowed disabled:bg-red-200"
                  >
                    {restoreLoading
                      ? "Recording..."
                      : selectedRun.restoreEligible === false
                        ? "Full Restore Unavailable"
                        : "Start Full Production Restore"}
                  </button>
                </div>
              </div>

              {restoreResult && (
                <div className="rounded-lg border border-brand-100 bg-brand-50 p-4 text-sm text-brand-800">
                  {restoreResult.message}
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function StatusCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="stat-card">
      <span className="text-sm text-gray-500">{label}</span>
      <span className="truncate text-xl font-semibold text-gray-900">{value}</span>
      <span className="break-words text-xs text-gray-500">{detail}</span>
    </div>
  );
}

function BackupButton({
  backup,
  selected,
  onSelect,
}: {
  backup: RecoveryBackupRun;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-lg border p-4 text-left transition ${
        selected
          ? "border-brand-200 bg-brand-50"
          : "border-gray-100 bg-white hover:border-gray-200 hover:bg-gray-50"
      }`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-semibold text-gray-900">
              {backup.id}
            </p>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusClasses(
                backup.status,
              )}`}
            >
              {backup.status || "unknown"}
            </span>
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
              {backup.source || "local"}
            </span>
          </div>
          <p className="mt-1 text-sm text-gray-500">
            {backup.mode || "unknown"} · {formatDate(backup.updatedAt)}
          </p>
          <p className="mt-1 truncate text-xs text-gray-400">
            {backup.archiveRoot || backup.prefix || "No archive path recorded"}
          </p>
          {backup.catalogStatus && (
            <p className="mt-1 truncate text-xs text-gray-500">
              {backup.catalogStatus}
            </p>
          )}
        </div>
        <div className="shrink-0 text-left sm:text-right">
          <p className="text-sm font-medium text-gray-700">
            {backup.artifactCount} artifacts
          </p>
          <p className="text-xs text-gray-500">{formatBytes(backup.totalBytes)}</p>
          {!backup.restoreEligible && (
            <p className="text-xs text-amber-600">inspect only</p>
          )}
        </div>
      </div>
    </button>
  );
}
