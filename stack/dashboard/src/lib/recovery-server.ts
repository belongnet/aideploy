import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_STATE_DIR = "/var/lib/aideploy/backups";

export interface RecoveryArtifact {
  name: string;
  type: string;
  sha256: string;
  bytes: number;
  remotePath: string;
}

export interface RecoveryManifest {
  version: number;
  runId: string;
  mode: "full" | "incremental" | string;
  deployId: string;
  timestamp: string;
  targetUrl: string;
  provider: string;
  nativeProvider: string;
  bucket: string;
  prefix: string;
  includeStorage: string;
  hostname: string;
  artifacts: RecoveryArtifact[];
}

export interface RecoveryBackupRun {
  id: string;
  mode: "full" | "incremental" | string;
  status: "running" | "completed" | "failed" | string;
  provider: string;
  nativeProvider: string;
  bucket: string;
  prefix: string;
  archiveRoot: string;
  startedAt: string;
  updatedAt: string;
  error: string;
  manifestAvailable: boolean;
  artifactCount: number;
  totalBytes: number;
}

export interface RecoveryOverview {
  stateDir: string;
  readable: boolean;
  status: "healthy" | "empty" | "unavailable";
  message: string;
  latestRun: RecoveryBackupRun | null;
  backups: RecoveryBackupRun[];
  latestRestore: RecoveryRestoreRun | null;
  restores: RecoveryRestoreRun[];
}

export interface RecoveryPreview {
  backup: RecoveryBackupRun;
  manifest: RecoveryManifest | null;
  restorePlan: string[];
}

export interface RecoveryRestoreRun {
  id: string;
  backupRunId: string;
  status: string;
  mode: string;
  productionOverwrite: boolean;
  logPath: string;
  message: string;
  error: string;
  updatedAt: string;
}

export interface RecoveryArtifactChange {
  name: string;
  type: string;
  change: "added" | "removed" | "changed" | "unchanged";
  beforeSha256: string;
  afterSha256: string;
  beforeBytes: number;
  afterBytes: number;
  beforeRemotePath: string;
  afterRemotePath: string;
}

export interface RecoveryMergePreview {
  runId: string;
  baselineRunId: string;
  baselineLabel: string;
  destructive: boolean;
  summary: string;
  artifactChanges: RecoveryArtifactChange[];
  manifestDiff: string;
  decision: {
    action: "record-merge-request";
    label: string;
  };
}

export type RecoveryRestoreMode = "full" | "merge";

export interface RecoveryRestoreRequestOptions {
  mode?: RecoveryRestoreMode;
  mergeReviewed?: boolean;
  confirmation?: string;
}

export class RestoreRequestValidationError extends Error {
  status = 400;
}

export function fullRestoreConfirmation(runId: string) {
  return `RESTORE ${runId}`;
}

function normalizeBackupId(value: string): string {
  const id = (value ?? "").trim();
  if (!id || id === "." || id === "..") return "";
  if (id.includes("/") || id.includes("\\") || id.includes("\0")) return "";
  return id;
}

function stateDir() {
  return process.env.SUPABASE_BACKUP_STATE_DIR || DEFAULT_STATE_DIR;
}

function restoreRunsDir() {
  return path.join(stateDir(), "restore-runs");
}

function restoreExecutable() {
  return process.env.SUPABASE_RESTORE_COMMAND || "/usr/local/bin/aideploy-supabase-restore";
}

async function ensureRestoreExecutor() {
  const executable = restoreExecutable();
  try {
    await access(executable, constants.X_OK);
  } catch {
    throw new RestoreRequestValidationError(
      `Restore executor is not installed at ${executable}.`,
    );
  }
  return executable;
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function artifactValue(value: unknown): RecoveryArtifact | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  return {
    name: stringValue(raw.name),
    type: stringValue(raw.type),
    sha256: stringValue(raw.sha256),
    bytes: numberValue(raw.bytes),
    remotePath: stringValue(raw.remotePath),
  };
}

function manifestValue(value: unknown): RecoveryManifest | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const artifacts = Array.isArray(raw.artifacts)
    ? raw.artifacts.map(artifactValue).filter((item): item is RecoveryArtifact => !!item)
    : [];

  return {
    version: numberValue(raw.version, 1),
    runId: stringValue(raw.runId),
    mode: stringValue(raw.mode),
    deployId: stringValue(raw.deployId),
    timestamp: stringValue(raw.timestamp),
    targetUrl: stringValue(raw.targetUrl),
    provider: stringValue(raw.provider),
    nativeProvider: stringValue(raw.nativeProvider),
    bucket: stringValue(raw.bucket),
    prefix: stringValue(raw.prefix),
    includeStorage: stringValue(raw.includeStorage),
    hostname: stringValue(raw.hostname),
    artifacts,
  };
}

function runValue(
  value: unknown,
  manifest: RecoveryManifest | null,
): RecoveryBackupRun | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = stringValue(raw.id);
  if (!id) return null;

  const artifacts = manifest?.artifacts ?? [];
  return {
    id,
    mode: stringValue(raw.mode),
    status: stringValue(raw.status),
    provider: stringValue(raw.provider),
    nativeProvider: stringValue(raw.nativeProvider),
    bucket: stringValue(raw.bucket),
    prefix: stringValue(raw.prefix),
    archiveRoot: stringValue(raw.archiveRoot),
    startedAt: stringValue(raw.startedAt),
    updatedAt: stringValue(raw.updatedAt),
    error: stringValue(raw.error),
    manifestAvailable: !!manifest,
    artifactCount: artifacts.length,
    totalBytes: artifacts.reduce((sum, item) => sum + item.bytes, 0),
  };
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function compareRuns(a: RecoveryBackupRun, b: RecoveryBackupRun) {
  const aTime = Date.parse(a.updatedAt || a.startedAt || "");
  const bTime = Date.parse(b.updatedAt || b.startedAt || "");
  return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
}

async function readRun(runsDir: string, fileName: string) {
  const rawRun = await readJsonFile<Record<string, unknown>>(path.join(runsDir, fileName));
  const id = stringValue(rawRun?.id);
  if (!id) return null;

  const manifest = await readManifest(runsDir, id);
  return runValue(rawRun, manifest);
}

function restoreRunValue(value: unknown): RecoveryRestoreRun | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = stringValue(raw.id);
  if (!id) return null;

  return {
    id,
    backupRunId: stringValue(raw.backupRunId),
    status: stringValue(raw.status, "unknown"),
    mode: stringValue(raw.mode),
    productionOverwrite: raw.productionOverwrite === true,
    logPath: stringValue(raw.logPath),
    message: stringValue(raw.message),
    error: stringValue(raw.error),
    updatedAt: stringValue(
      raw.updatedAt,
      stringValue(raw.completedAt, stringValue(raw.startedAt, stringValue(raw.requestedAt))),
    ),
  };
}

async function readRestoreRun(fileName: string) {
  return restoreRunValue(
    await readJsonFile<Record<string, unknown>>(path.join(restoreRunsDir(), fileName)),
  );
}

async function listRestoreRuns() {
  try {
    await access(restoreRunsDir());
    const files = await readdir(restoreRunsDir());
    const restoreFiles = files.filter((file) => file.endsWith(".json"));
    return (await Promise.all(restoreFiles.map((file) => readRestoreRun(file))))
      .filter((run: RecoveryRestoreRun | null): run is RecoveryRestoreRun => !!run)
      .sort((a, b) => {
        const aTime = Date.parse(a.updatedAt || "");
        const bTime = Date.parse(b.updatedAt || "");
        return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
      });
  } catch {
    return [];
  }
}

async function readManifest(runsDir: string, runId: string) {
  return manifestValue(
    await readJsonFile<Record<string, unknown>>(
      path.join(runsDir, `${runId}-manifest.json`),
    ),
  );
}

export async function getRecoveryOverview(): Promise<RecoveryOverview> {
  const dir = stateDir();
  const runsDir = path.join(dir, "runs");
  const restores = await listRestoreRuns();

  try {
    await access(runsDir);
    const dirStat = await stat(runsDir);
    if (!dirStat.isDirectory()) {
      return {
        stateDir: dir,
        readable: false,
        status: "unavailable",
        message: "Backup metadata path is not a directory.",
        latestRun: null,
        backups: [],
        latestRestore: restores[0] ?? null,
        restores,
      };
    }
  } catch {
    return {
      stateDir: dir,
      readable: false,
      status: "unavailable",
      message: "No local backup metadata directory was found.",
      latestRun: null,
      backups: [],
      latestRestore: restores[0] ?? null,
      restores,
    };
  }

  const files: string[] = await readdir(runsDir);
  const runFiles = files.filter(
    (file: string) => file.endsWith(".json") && !file.endsWith("-manifest.json"),
  );
  const backups = (
    await Promise.all(runFiles.map((file: string) => readRun(runsDir, file)))
  )
    .filter((run: RecoveryBackupRun | null): run is RecoveryBackupRun => !!run)
    .sort(compareRuns);

  return {
    stateDir: dir,
    readable: true,
    status: backups.length > 0 ? "healthy" : "empty",
    message:
      backups.length > 0
        ? "Backup metadata is available."
        : "Backup metadata directory is readable, but no runs were found.",
    latestRun: backups[0] ?? null,
    backups,
    latestRestore: restores[0] ?? null,
    restores,
  };
}

export async function getRecoveryPreview(
  runId: string,
): Promise<RecoveryPreview | null> {
  const safeId = normalizeBackupId(runId);
  if (!safeId) return null;
  const overview = await getRecoveryOverview();
  const backup = overview.backups.find((item) => item.id === safeId);
  if (!backup) return null;

  const manifest = await readManifest(path.join(overview.stateDir, "runs"), safeId);
  const artifactNames = manifest?.artifacts.map((artifact) => artifact.name) ?? [];

  return {
    backup,
    manifest,
    restorePlan: [
      `Validate backup run ${backup.id} and artifact checksums.`,
      `Fetch artifacts from ${backup.provider || "the configured backup provider"}.`,
      artifactNames.length > 0
        ? `Restore ${artifactNames.join(", ")}.`
        : "Restore artifacts listed in the backup manifest.",
      "Restart affected runtime services and verify agent health.",
    ],
  };
}

function artifactMap(manifest: RecoveryManifest | null) {
  const map = new Map<string, RecoveryArtifact>();
  for (const artifact of manifest?.artifacts ?? []) {
    map.set(artifact.name, artifact);
  }
  return map;
}

function manifestSummary(manifest: RecoveryManifest | null) {
  if (!manifest) return {};
  return {
    runId: manifest.runId,
    mode: manifest.mode,
    deployId: manifest.deployId,
    provider: manifest.provider,
    nativeProvider: manifest.nativeProvider,
    bucket: manifest.bucket,
    prefix: manifest.prefix,
    includeStorage: manifest.includeStorage,
    artifacts: manifest.artifacts.map((artifact) => ({
      name: artifact.name,
      type: artifact.type,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      remotePath: artifact.remotePath,
    })),
  };
}

function unifiedJsonDiff(beforeLabel: string, before: unknown, afterLabel: string, after: unknown) {
  const beforeLines = JSON.stringify(before, null, 2).split("\n");
  const afterLines = JSON.stringify(after, null, 2).split("\n");
  const lines = [`--- ${beforeLabel}`, `+++ ${afterLabel}`];
  const max = Math.max(beforeLines.length, afterLines.length);

  for (let index = 0; index < max; index += 1) {
    const left = beforeLines[index];
    const right = afterLines[index];
    if (left === right && left !== undefined) {
      lines.push(` ${left}`);
      continue;
    }
    if (left !== undefined) lines.push(`-${left}`);
    if (right !== undefined) lines.push(`+${right}`);
  }

  return lines.join("\n");
}

function buildArtifactChanges(
  baseline: RecoveryManifest | null,
  target: RecoveryManifest | null,
): RecoveryArtifactChange[] {
  const before = artifactMap(baseline);
  const after = artifactMap(target);
  const names = Array.from(new Set([...before.keys(), ...after.keys()])).sort();

  return names.map((name) => {
    const previous = before.get(name);
    const next = after.get(name);
    const changed =
      !!previous &&
      !!next &&
      (previous.sha256 !== next.sha256 ||
        previous.bytes !== next.bytes ||
        previous.remotePath !== next.remotePath);
    const change = !previous
      ? "added"
      : !next
        ? "removed"
        : changed
          ? "changed"
          : "unchanged";

    return {
      name,
      type: next?.type || previous?.type || "",
      change,
      beforeSha256: previous?.sha256 ?? "",
      afterSha256: next?.sha256 ?? "",
      beforeBytes: previous?.bytes ?? 0,
      afterBytes: next?.bytes ?? 0,
      beforeRemotePath: previous?.remotePath ?? "",
      afterRemotePath: next?.remotePath ?? "",
    };
  });
}

async function latestComparableBackup(runId: string) {
  const overview = await getRecoveryOverview();
  return (
    overview.backups.find((backup) => backup.id !== runId && backup.status === "completed") ??
    overview.backups.find((backup) => backup.id !== runId) ??
    null
  );
}

export async function getRecoveryMergePreview(
  runId: string,
): Promise<RecoveryMergePreview | null> {
  const preview = await getRecoveryPreview(runId);
  if (!preview) return null;
  const safeId = preview.backup.id;

  const baseline = await latestComparableBackup(safeId);
  const safeBaselineId = baseline ? normalizeBackupId(baseline.id) : "";
  const runsDir = path.join(stateDir(), "runs");
  const baselineManifest = safeBaselineId ? await readManifest(runsDir, safeBaselineId) : null;
  const artifactChanges = buildArtifactChanges(baselineManifest, preview.manifest);
  const changedCount = artifactChanges.filter((item) => item.change !== "unchanged").length;
  const baselineLabel = safeBaselineId
    ? `latest local backup ${safeBaselineId}`
    : "current state baseline unavailable";

  return {
    runId: safeId,
    baselineRunId: safeBaselineId,
    baselineLabel,
    destructive: changedCount > 0,
    summary:
      changedCount > 0
        ? `${changedCount} backup artifact change${changedCount === 1 ? "" : "s"} would be applied.`
        : "No artifact-level changes were detected against the local baseline.",
    artifactChanges,
    manifestDiff: unifiedJsonDiff(
      safeBaselineId ? `baseline:${safeBaselineId}` : "baseline:empty",
      manifestSummary(baselineManifest),
      `restore:${safeId}`,
      manifestSummary(preview.manifest),
    ),
    decision: {
      action: "record-merge-request",
      label: "Record merge restore request",
    },
  };
}

export async function createRestorePlaceholder(
  runId: string,
  requestOptions: RecoveryRestoreMode | RecoveryRestoreRequestOptions = "full",
) {
  const options =
    typeof requestOptions === "string" ? { mode: requestOptions } : requestOptions;
  const mode: RecoveryRestoreMode = options.mode === "merge" ? "merge" : "full";
  const preview = await getRecoveryPreview(runId);
  if (!preview) return null;
  const safeId = preview.backup.id;
  const mergePreview = await getRecoveryMergePreview(safeId);

  if (mode === "full") {
    if (!mergePreview || options.mergeReviewed !== true) {
      throw new RestoreRequestValidationError(
        "Review the merge diff before requesting a full restore.",
      );
    }
    if (options.confirmation !== fullRestoreConfirmation(safeId)) {
      throw new RestoreRequestValidationError(
        `Type ${fullRestoreConfirmation(safeId)} to request a full restore.`,
      );
    }
    await ensureRestoreExecutor();
  }

  const requestedAt = new Date().toISOString();
  const restoreRunId = `restore-${Date.now()}`;
  const restoreRequestFile = path.join(restoreRunsDir(), `${restoreRunId}.json`);
  await mkdir(restoreRunsDir(), { recursive: true });
  await writeFile(
    restoreRequestFile,
    JSON.stringify(
      {
        id: restoreRunId,
        backupRunId: safeId,
        status: mode === "full" ? "starting" : "requested",
        requestedBy: "dashboard",
        requestedAt,
        mode,
        productionOverwrite: mode === "full",
        fullRestoreApproved: mode === "full",
        mergeReviewed: mode === "full" ? options.mergeReviewed === true : true,
        confirmation: mode === "full" ? options.confirmation : undefined,
        restorePlan: preview.restorePlan,
        mergePreview,
      },
      null,
      2,
    ),
    "utf8",
  );

  let executorPid = 0;
  if (mode === "full") {
    const child = spawn(restoreExecutable(), [safeId], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        AIDEPLOY_SUPABASE_ENV_FILE:
          process.env.AIDEPLOY_SUPABASE_ENV_FILE || "/etc/aideploy/supabase.env",
        SUPABASE_RESTORE_RUN_ID: safeId,
        SUPABASE_RESTORE_REQUEST_ID: restoreRunId,
        SUPABASE_RESTORE_REQUEST_FILE: restoreRequestFile,
        SUPABASE_RESTORE_ALLOW_PRODUCTION_OVERWRITE: "true",
        SUPABASE_RESTORE_MODE: "full",
      },
    });
    executorPid = child.pid ?? 0;
    child.unref();
  }

  return {
    ok: true,
    placeholder: mode !== "full",
    destructive: mode === "full",
    started: mode === "full",
    executorPid,
    restoreRunId,
    runId: safeId,
    message:
      mode === "merge"
        ? "Merge restore request recorded with diff preview. Run the guarded operator restore workflow from the host."
        : "Full production overwrite restore started after merge diff review. Track progress in the restore run log.",
  };
}
