import { constants } from "node:fs";
import { execFile, spawn } from "node:child_process";
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
  source: "local" | "cloud" | "local+cloud" | string;
  provider: string;
  nativeProvider: string;
  cloudProvider: string;
  bucket: string;
  prefix: string;
  archiveRoot: string;
  startedAt: string;
  updatedAt: string;
  error: string;
  catalogStatus: string;
  catalogMessage: string;
  remoteManifestPath: string;
  restoreEligible: boolean;
  restoreBlockedReason: string;
  manifestAvailable: boolean;
  artifactCount: number;
  totalBytes: number;
}

export interface RecoveryOverview {
  stateDir: string;
  readable: boolean;
  status: "healthy" | "empty" | "unavailable";
  message: string;
  catalogStatus: string;
  catalogMessage: string;
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

function supabaseEnvPath() {
  return process.env.AIDEPLOY_SUPABASE_ENV_FILE || "/etc/aideploy/supabase.env";
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

function boolValue(value: unknown, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function parseEnvFile(contents: string) {
  const values: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2] ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

async function backupEnv() {
  let fileEnv: Record<string, string> = {};
  try {
    fileEnv = parseEnvFile(await readFile(supabaseEnvPath(), "utf8"));
  } catch {
    fileEnv = {};
  }
  return {
    ...fileEnv,
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => {
        return typeof entry[1] === "string";
      }),
    ),
  };
}

function normalizeNativeProvider(provider: string) {
  return provider.trim().toLowerCase();
}

function isCloudNativeProvider(provider: string) {
  return provider === "cloud-native" || provider === "native";
}

function backupRestoreEligibility(mode: string, status: string, manifestAvailable: boolean) {
  if (status !== "completed") {
    return {
      restoreEligible: false,
      restoreBlockedReason: "Only completed backup runs can be restored.",
    };
  }
  if (!manifestAvailable) {
    return {
      restoreEligible: false,
      restoreBlockedReason: "Restore requires a backup manifest.",
    };
  }
  if (mode !== "full") {
    return {
      restoreEligible: false,
      restoreBlockedReason:
        "Incremental backups are inspectable but not full-restorable until chained incremental apply is implemented.",
    };
  }
  return { restoreEligible: true, restoreBlockedReason: "" };
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
  const mode = stringValue(raw.mode, manifest?.mode ?? "");
  const status = stringValue(raw.status, stringValue(raw.catalogStatus, "unknown"));
  const manifestAvailable = !!manifest;
  const eligibility = backupRestoreEligibility(mode, status, manifestAvailable);
  return {
    id,
    mode,
    status,
    source: stringValue(raw.source, "local"),
    provider: stringValue(raw.provider, manifest?.provider ?? ""),
    nativeProvider: stringValue(raw.nativeProvider, manifest?.nativeProvider ?? ""),
    cloudProvider: stringValue(raw.cloudProvider),
    bucket: stringValue(raw.bucket, manifest?.bucket ?? ""),
    prefix: stringValue(raw.prefix, manifest?.prefix ?? ""),
    archiveRoot: stringValue(raw.archiveRoot),
    startedAt: stringValue(raw.startedAt),
    updatedAt: stringValue(raw.updatedAt),
    error: stringValue(raw.error),
    catalogStatus: stringValue(raw.catalogStatus, manifestAvailable ? "local" : "missing-manifest"),
    catalogMessage: stringValue(raw.catalogMessage),
    remoteManifestPath: stringValue(raw.remoteManifestPath),
    restoreEligible: boolValue(raw.restoreEligible, eligibility.restoreEligible),
    restoreBlockedReason: stringValue(
      raw.restoreBlockedReason,
      eligibility.restoreBlockedReason,
    ),
    manifestAvailable,
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

interface BackupCatalogConfig {
  available: boolean;
  provider: string;
  nativeProvider: string;
  cloudProvider: string;
  bucket: string;
  prefix: string;
  region: string;
  endpoint: string;
  azureAccount: string;
  message: string;
  env: Record<string, string>;
}

interface RemoteBackupRun {
  id: string;
  mode: string;
  status: string;
  provider: string;
  nativeProvider: string;
  cloudProvider: string;
  bucket: string;
  prefix: string;
  archiveRoot: string;
  startedAt: string;
  updatedAt: string;
  error: string;
  catalogStatus: string;
  catalogMessage: string;
  remoteManifestPath: string;
  restoreEligible: boolean;
  restoreBlockedReason: string;
  manifest: RecoveryManifest;
  objectNames: Set<string>;
}

function remoteModeFromPath(prefix: string, key: string) {
  const rest = key.startsWith(`${prefix}/`) ? key.slice(prefix.length + 1) : key;
  const parts = rest.split("/");
  return parts.length >= 3 ? parts[0] : "";
}

function remoteTimestampFromPath(key: string) {
  const parts = key.split("/");
  return parts.length >= 2 ? parts[parts.length - 2] : "";
}

function timestampToIso(timestamp: string) {
  const match = timestamp.match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
  );
  if (!match) return "";
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
}

function summarizeRemoteArtifacts(
  manifest: RecoveryManifest,
  objectNames: Set<string>,
) {
  const missing = manifest.artifacts.filter(
    (artifact) => artifact.remotePath && !objectNames.has(artifact.remotePath),
  );
  if (missing.length > 0) {
    return {
      status: "failed",
      catalogStatus: "missing-artifacts",
      catalogMessage: `${missing.length} manifest artifact${missing.length === 1 ? "" : "s"} missing from cloud storage.`,
      error: "Remote catalog is missing one or more listed artifacts.",
    };
  }
  return {
    status: "completed",
    catalogStatus: "cloud-complete",
    catalogMessage: "Cloud manifest and listed artifacts are present.",
    error: "",
  };
}

function remoteBackupFromManifest(
  config: BackupCatalogConfig,
  manifestPath: string,
  manifest: RecoveryManifest,
  objectNames: Set<string>,
  runRecord: Record<string, unknown> | null = null,
) {
  const mode = manifest.mode || remoteModeFromPath(config.prefix, manifestPath);
  const timestamp = manifest.timestamp || remoteTimestampFromPath(manifestPath);
  const id = normalizeBackupId(manifest.runId || `${mode}-${timestamp}`);
  if (!id) return null;
  const archiveRoot = path.posix.dirname(manifestPath);
  const summary = summarizeRemoteArtifacts(manifest, objectNames);
  const runStatus = stringValue(runRecord?.status, summary.status);
  const status = summary.status === "failed" ? "failed" : runStatus;
  const catalogMessage =
    summary.status === "completed" && runRecord
      ? `Cloud run status marker: ${runStatus}.`
      : summary.catalogMessage;
  const eligibility = backupRestoreEligibility(mode, status, true);
  return {
    id,
    mode,
    status,
    provider: manifest.provider || "cloud-native",
    nativeProvider: manifest.nativeProvider || config.nativeProvider,
    cloudProvider: config.cloudProvider,
    bucket: manifest.bucket || config.bucket,
    prefix: manifest.prefix || config.prefix,
    archiveRoot,
    startedAt: stringValue(runRecord?.startedAt, timestampToIso(timestamp)),
    updatedAt: stringValue(runRecord?.updatedAt, timestampToIso(timestamp)),
    error: stringValue(runRecord?.error, summary.error),
    catalogStatus: status === "completed" ? summary.catalogStatus : "cloud-run-" + status,
    catalogMessage,
    remoteManifestPath: manifestPath,
    restoreEligible: eligibility.restoreEligible,
    restoreBlockedReason: eligibility.restoreBlockedReason,
    manifest,
    objectNames,
  };
}

async function execFileText(
  command: string,
  args: string[],
  options: { input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
) {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        timeout: options.timeoutMs ?? 15000,
        maxBuffer: 12 * 1024 * 1024,
        encoding: "utf8",
        env: options.env ?? process.env,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(String(stdout));
      },
    );
    if (options.input) {
      child.stdin?.end(options.input);
    }
  });
}

async function backupCatalogConfig(): Promise<BackupCatalogConfig> {
  const env = await backupEnv();
  const provider = normalizeNativeProvider(
    env.SUPABASE_BACKUP_PROVIDER || "supabase-storage",
  );
  const cloudProvider = normalizeNativeProvider(
    env.AIDEPLOY_CLOUD_PROVIDER || env.SUPABASE_BACKUP_CLOUD_PROVIDER || "",
  );
  const nativeProvider = isCloudNativeProvider(provider) ? cloudProvider : provider;
  const bucket =
    env.SUPABASE_BACKUP_NATIVE_BUCKET || env.SUPABASE_BACKUP_BUCKET || "";
  const prefix =
    env.SUPABASE_BACKUP_NATIVE_PREFIX ||
    env.SUPABASE_BACKUP_PREFIX ||
    env.DEPLOY_ID ||
    "";

  if (!nativeProvider || nativeProvider === "supabase-storage") {
    return {
      available: false,
      provider,
      nativeProvider,
      cloudProvider,
      bucket,
      prefix,
      region: env.SUPABASE_BACKUP_REGION || env.AWS_REGION || env.AWS_DEFAULT_REGION || "",
      endpoint: env.SUPABASE_BACKUP_S3_ENDPOINT || "",
      azureAccount: env.SUPABASE_BACKUP_AZURE_ACCOUNT || env.AZURE_STORAGE_ACCOUNT || "",
      message: "Cloud backup catalog is not configured for this deployment.",
      env,
    };
  }
  if (!bucket || !prefix) {
    return {
      available: false,
      provider,
      nativeProvider,
      cloudProvider,
      bucket,
      prefix,
      region: env.SUPABASE_BACKUP_REGION || env.AWS_REGION || env.AWS_DEFAULT_REGION || "",
      endpoint: env.SUPABASE_BACKUP_S3_ENDPOINT || "",
      azureAccount: env.SUPABASE_BACKUP_AZURE_ACCOUNT || env.AZURE_STORAGE_ACCOUNT || "",
      message: "Cloud backup catalog needs SUPABASE_BACKUP_NATIVE_BUCKET and SUPABASE_BACKUP_NATIVE_PREFIX.",
      env,
    };
  }

  return {
    available: true,
    provider,
    nativeProvider,
    cloudProvider,
    bucket,
    prefix,
    region: env.SUPABASE_BACKUP_REGION || env.AWS_REGION || env.AWS_DEFAULT_REGION || "",
    endpoint: env.SUPABASE_BACKUP_S3_ENDPOINT || "",
    azureAccount: env.SUPABASE_BACKUP_AZURE_ACCOUNT || env.AZURE_STORAGE_ACCOUNT || "",
    message: "",
    env,
  };
}

async function listS3Objects(config: BackupCatalogConfig) {
  const args = [];
  if (config.nativeProvider === "digitalocean" || config.nativeProvider === "scaleway") {
    if (!config.endpoint) throw new Error(`${config.nativeProvider} catalog requires SUPABASE_BACKUP_S3_ENDPOINT.`);
    args.push("--endpoint-url", config.endpoint);
  }
  args.push("s3", "ls", `s3://${config.bucket}/${config.prefix}/`, "--recursive");
  const stdout = await execFileText("aws", args, {
    timeoutMs: 30000,
    env: {
      ...process.env,
      AWS_REGION: config.region || process.env.AWS_REGION || "",
      AWS_DEFAULT_REGION: config.region || process.env.AWS_DEFAULT_REGION || "",
    },
  });
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^\S+\s+\S+\s+\d+\s+(.+)$/)?.[1] ?? "")
    .filter(Boolean);
}

async function s3ObjectText(config: BackupCatalogConfig, key: string) {
  const args = [];
  if (config.nativeProvider === "digitalocean" || config.nativeProvider === "scaleway") {
    args.push("--endpoint-url", config.endpoint);
  }
  args.push("s3", "cp", `s3://${config.bucket}/${key}`, "-");
  return execFileText("aws", args, {
    timeoutMs: 30000,
    env: {
      ...process.env,
      AWS_REGION: config.region || process.env.AWS_REGION || "",
      AWS_DEFAULT_REGION: config.region || process.env.AWS_DEFAULT_REGION || "",
    },
  });
}

async function metadataToken(url: string, headers: Record<string, string>) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(2500) });
  if (!response.ok) return "";
  const json = (await response.json()) as { access_token?: string };
  return typeof json.access_token === "string" ? json.access_token : "";
}

async function azureToken() {
  try {
    const token = await metadataToken(
      "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fstorage.azure.com%2F",
      { Metadata: "true" },
    );
    if (token) return token;
  } catch {
    // Fall through to az CLI for local dashboards.
  }
  try {
    return (
      await execFileText(
        "az",
        ["account", "get-access-token", "--resource", "https://storage.azure.com/", "--query", "accessToken", "-o", "tsv"],
        { timeoutMs: 15000 },
      )
    ).trim();
  } catch {
    return "";
  }
}

function decodeXml(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

async function listAzureObjects(config: BackupCatalogConfig) {
  if (!config.azureAccount) {
    throw new Error("Azure catalog requires SUPABASE_BACKUP_AZURE_ACCOUNT or AZURE_STORAGE_ACCOUNT.");
  }
  const token = await azureToken();
  if (!token) throw new Error("Could not acquire Azure storage token.");
  const names: string[] = [];
  let marker = "";
  do {
    const query = new URLSearchParams({
      restype: "container",
      comp: "list",
      prefix: `${config.prefix}/`,
    });
    if (marker) query.set("marker", marker);
    const response = await fetch(
      `https://${config.azureAccount}.blob.core.windows.net/${config.bucket}?${query.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "x-ms-version": "2021-12-02",
        },
      },
    );
    if (!response.ok) {
      throw new Error(`Azure catalog list failed with HTTP ${response.status}.`);
    }
    const xml = await response.text();
    names.push(
      ...Array.from(xml.matchAll(/<Name>([\s\S]*?)<\/Name>/g)).map((match) =>
        decodeXml(match[1] ?? ""),
      ),
    );
    marker = decodeXml(xml.match(/<NextMarker>([\s\S]*?)<\/NextMarker>/)?.[1] ?? "");
  } while (marker);
  return names;
}

async function azureObjectText(config: BackupCatalogConfig, key: string) {
  const token = await azureToken();
  if (!token) throw new Error("Could not acquire Azure storage token.");
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(
    `https://${config.azureAccount}.blob.core.windows.net/${config.bucket}/${encoded}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "x-ms-version": "2021-12-02",
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Azure catalog read failed with HTTP ${response.status}.`);
  }
  return response.text();
}

async function gcpToken() {
  try {
    const token = await metadataToken(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { "Metadata-Flavor": "Google" },
    );
    if (token) return token;
  } catch {
    // Fall through to gcloud for local dashboards.
  }
  try {
    return (await execFileText("gcloud", ["auth", "print-access-token"], { timeoutMs: 15000 })).trim();
  } catch {
    return "";
  }
}

async function listGcpObjects(config: BackupCatalogConfig) {
  const token = await gcpToken();
  if (!token) throw new Error("Could not acquire GCP storage token.");
  const names: string[] = [];
  let pageToken = "";
  do {
    const query = new URLSearchParams({ prefix: `${config.prefix}/` });
    if (pageToken) query.set("pageToken", pageToken);
    const url =
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(config.bucket)}/o?` +
      query.toString();
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      throw new Error(`GCP catalog list failed with HTTP ${response.status}.`);
    }
    const json = (await response.json()) as {
      items?: Array<{ name?: string }>;
      nextPageToken?: string;
    };
    names.push(...(json.items ?? []).map((item) => item.name ?? "").filter(Boolean));
    pageToken = json.nextPageToken ?? "";
  } while (pageToken);
  return names;
}

async function gcpObjectText(config: BackupCatalogConfig, key: string) {
  const token = await gcpToken();
  if (!token) throw new Error("Could not acquire GCP storage token.");
  const response = await fetch(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(config.bucket)}/o/${encodeURIComponent(key)}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) {
    throw new Error(`GCP catalog read failed with HTTP ${response.status}.`);
  }
  return response.text();
}

async function listRemoteObjectNames(config: BackupCatalogConfig) {
  switch (config.nativeProvider) {
    case "aws":
    case "digitalocean":
    case "scaleway":
      return listS3Objects(config);
    case "azure":
      return listAzureObjects(config);
    case "gcp":
      return listGcpObjects(config);
    default:
      return [];
  }
}

async function remoteObjectText(config: BackupCatalogConfig, key: string) {
  switch (config.nativeProvider) {
    case "aws":
    case "digitalocean":
    case "scaleway":
      return s3ObjectText(config, key);
    case "azure":
      return azureObjectText(config, key);
    case "gcp":
      return gcpObjectText(config, key);
    default:
      throw new Error(`Unsupported cloud backup catalog provider: ${config.nativeProvider}`);
  }
}

async function readRemoteRunRecord(config: BackupCatalogConfig, key: string) {
  try {
    const value = JSON.parse(await remoteObjectText(config, key));
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function listRemoteBackupRuns() {
  const config = await backupCatalogConfig();
  if (!config.available) {
    return { backups: [] as RemoteBackupRun[], status: "unavailable", message: config.message };
  }
  try {
    const objectNames = new Set(await listRemoteObjectNames(config));
    const manifestPaths = Array.from(objectNames)
      .filter((name) => name.startsWith(`${config.prefix}/`) && name.endsWith("/manifest.json"))
      .sort()
      .reverse();
    const backups = (
      await Promise.all(
        manifestPaths.map(async (manifestPath) => {
          try {
            const manifest = manifestValue(JSON.parse(await remoteObjectText(config, manifestPath)));
            if (!manifest) return null;
            const runPath = `${path.posix.dirname(manifestPath)}/run.json`;
            const runRecord = objectNames.has(runPath)
              ? await readRemoteRunRecord(config, runPath)
              : null;
            return remoteBackupFromManifest(config, manifestPath, manifest, objectNames, runRecord);
          } catch {
            return null;
          }
        }),
      )
    ).filter((backup: RemoteBackupRun | null): backup is RemoteBackupRun => !!backup);
    return {
      backups,
      status: backups.length > 0 ? "healthy" : "empty",
      message:
        backups.length > 0
          ? "Cloud backup catalog is available."
          : "Cloud backup catalog is available, but no manifests were found.",
    };
  } catch (error) {
    return {
      backups: [] as RemoteBackupRun[],
      status: "unavailable",
      message:
        error instanceof Error
          ? `Cloud backup catalog unavailable: ${error.message}`
          : "Cloud backup catalog unavailable.",
    };
  }
}

function remoteBackupSummary(remote: RemoteBackupRun): RecoveryBackupRun {
  return {
    id: remote.id,
    mode: remote.mode,
    status: remote.status,
    source: "cloud",
    provider: remote.provider,
    nativeProvider: remote.nativeProvider,
    cloudProvider: remote.cloudProvider,
    bucket: remote.bucket,
    prefix: remote.prefix,
    archiveRoot: remote.archiveRoot,
    startedAt: remote.startedAt,
    updatedAt: remote.updatedAt,
    error: remote.error,
    catalogStatus: remote.catalogStatus,
    catalogMessage: remote.catalogMessage,
    remoteManifestPath: remote.remoteManifestPath,
    restoreEligible: remote.restoreEligible,
    restoreBlockedReason: remote.restoreBlockedReason,
    manifestAvailable: true,
    artifactCount: remote.manifest.artifacts.length,
    totalBytes: remote.manifest.artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0),
  };
}

async function hydrateRemoteBackup(remote: RemoteBackupRun) {
  const runsDir = path.join(stateDir(), "runs");
  await mkdir(runsDir, { recursive: true });
  const runRecord = remoteBackupSummary(remote);
  await writeFile(
    path.join(runsDir, `${remote.id}.json`),
    JSON.stringify(
      {
        ...runRecord,
        source: "cloud-hydrated",
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    path.join(runsDir, `${remote.id}-manifest.json`),
    JSON.stringify(remote.manifest, null, 2),
    "utf8",
  );
}

async function remoteBackupById(runId: string) {
  const remoteCatalog = await listRemoteBackupRuns();
  return remoteCatalog.backups.find((backup) => backup.id === runId) ?? null;
}

function mergeLocalAndRemoteBackups(
  localBackups: RecoveryBackupRun[],
  remoteBackups: RemoteBackupRun[],
) {
  const byId = new Map<string, RecoveryBackupRun>();
  for (const backup of localBackups) {
    byId.set(backup.id, backup);
  }
  for (const remote of remoteBackups) {
    const remoteSummary = remoteBackupSummary(remote);
    const existing = byId.get(remote.id);
    if (!existing) {
      byId.set(remote.id, remoteSummary);
      continue;
    }
    const source = existing.source === "cloud" ? "cloud" : "local+cloud";
    byId.set(remote.id, {
      ...existing,
      source,
      catalogStatus: remoteSummary.catalogStatus,
      catalogMessage: remoteSummary.catalogMessage,
      remoteManifestPath: remoteSummary.remoteManifestPath,
      restoreEligible: existing.restoreEligible && remoteSummary.status === "completed",
      restoreBlockedReason:
        existing.restoreBlockedReason ||
        (remoteSummary.status === "completed" ? "" : remoteSummary.catalogMessage),
      manifestAvailable: existing.manifestAvailable || remoteSummary.manifestAvailable,
    });
  }
  return Array.from(byId.values()).sort(compareRuns);
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
  const remoteCatalog = await listRemoteBackupRuns();
  let localReadable = true;
  let localMessage = "Backup metadata is available.";
  let localBackups: RecoveryBackupRun[] = [];

  try {
    await access(runsDir);
    const dirStat = await stat(runsDir);
    if (!dirStat.isDirectory()) {
      localReadable = false;
      localMessage = "Backup metadata path is not a directory.";
    }
  } catch {
    localReadable = false;
    localMessage = "No local backup metadata directory was found.";
  }

  if (localReadable) {
    const files: string[] = await readdir(runsDir);
    const runFiles = files.filter(
      (file: string) => file.endsWith(".json") && !file.endsWith("-manifest.json"),
    );
    localBackups = (
      await Promise.all(runFiles.map((file: string) => readRun(runsDir, file)))
    )
      .filter((run: RecoveryBackupRun | null): run is RecoveryBackupRun => !!run)
      .sort(compareRuns);
    if (localBackups.length === 0) {
      localMessage = "Backup metadata directory is readable, but no local runs were found.";
    }
  }

  const backups = mergeLocalAndRemoteBackups(localBackups, remoteCatalog.backups);
  const status = backups.length > 0 ? "healthy" : localReadable ? "empty" : "unavailable";
  const message =
    backups.length > 0
      ? remoteCatalog.backups.length > 0
        ? "Backup metadata is available locally and from the cloud catalog."
        : localMessage
      : remoteCatalog.message || localMessage;

  return {
    stateDir: dir,
    readable: localReadable,
    status,
    message,
    catalogStatus: remoteCatalog.status,
    catalogMessage: remoteCatalog.message,
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

  let manifest = await readManifest(path.join(overview.stateDir, "runs"), safeId);
  if (!manifest && (backup.source === "cloud" || backup.source === "local+cloud")) {
    const remote = await remoteBackupById(safeId);
    if (remote) {
      await hydrateRemoteBackup(remote);
      manifest = remote.manifest;
    }
  }
  const artifactNames = manifest?.artifacts.map((artifact) => artifact.name) ?? [];

  return {
    backup: manifest && backup.source === "cloud" ? { ...backup, source: "cloud-hydrated" } : backup,
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
  const baselinePreview = safeBaselineId ? await getRecoveryPreview(safeBaselineId) : null;
  const baselineManifest = baselinePreview?.manifest ?? null;
  const artifactChanges = buildArtifactChanges(baselineManifest, preview.manifest);
  const changedCount = artifactChanges.filter((item) => item.change !== "unchanged").length;
  const baselineLabel = safeBaselineId
    ? `latest ${baseline?.source?.includes("cloud") ? "cloud" : "local"} backup ${safeBaselineId}`
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
    if (!preview.backup.restoreEligible) {
      throw new RestoreRequestValidationError(
        preview.backup.restoreBlockedReason || "This backup cannot be full-restored.",
      );
    }
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
