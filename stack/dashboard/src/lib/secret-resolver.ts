/**
 * Lightweight secret reference resolver for the dashboard runtime.
 *
 * Supports the same five URI schemes as the provisioner:
 *   env://      – environment variable lookup
 *   doppler://  – Doppler managed secrets
 *   aws-sm://   – AWS Secrets Manager
 *   gcp-sm://   – Google Cloud Secret Manager
 *   azure-kv:// – Azure Key Vault
 *
 * Uses native fetch for HTTP-based providers and the AWS SDK for
 * Secrets Manager (requires @aws-sdk/client-secrets-manager).
 */

import { readFile } from "node:fs/promises";
import net from "node:net";

// ── Types ──────────────────────────────────────────────────────

type SecretFieldPath = string[];

interface EnvRef {
  scheme: "env";
  variableName: string;
  fieldPath: SecretFieldPath;
}

interface DopplerRef {
  scheme: "doppler";
  project?: string;
  config?: string;
  secretName: string;
  fieldPath: SecretFieldPath;
}

interface AwsSmRef {
  scheme: "aws-sm";
  secretId: string;
  region?: string;
  fieldPath: SecretFieldPath;
}

interface GcpSmRef {
  scheme: "gcp-sm";
  resourceName: string;
  fieldPath: SecretFieldPath;
}

interface AzureKvRef {
  scheme: "azure-kv";
  vaultName: string;
  secretName: string;
  version?: string;
  fieldPath: SecretFieldPath;
}

export type SecretReference =
  | EnvRef
  | DopplerRef
  | AwsSmRef
  | GcpSmRef
  | AzureKvRef;

export class SecretResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretResolutionError";
  }
}

// ── KMS config file (dashboard-saved credentials) ─────────────

const HOME_ROOT = process.env.AIDEPLOY_HOME_ROOT || "/home/aideploy";
const KMS_CONFIG_PATH = `${HOME_ROOT}/.openclaw/kms-credentials.json`;

export interface KmsConfig {
  version: 1;
  providers: Record<string, Record<string, string>>;
}

export const KMS_PROVIDER_ENV_KEYS = [
  "DOPPLER_TOKEN",
  "DOPPLER_PROJECT",
  "DOPPLER_CONFIG",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "GCP_SECRET_MANAGER_TOKEN",
  "AZURE_KEY_VAULT_TOKEN",
] as const;

const KMS_ENV_BASELINE = new Map(
  KMS_PROVIDER_ENV_KEYS.map((key) => [key, process.env[key]]),
);

export async function readKmsConfig(): Promise<KmsConfig> {
  try {
    const raw = await readFile(KMS_CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as KmsConfig;
  } catch {
    return { version: 1, providers: {} };
  }
}

export function applySavedKmsCredentialsToEnv(config: KmsConfig): void {
  const nextValues = new Map<string, string>();

  for (const creds of Object.values(config.providers)) {
    for (const [key, value] of Object.entries(creds)) {
      if (value) nextValues.set(key, value);
    }
  }

  for (const key of KMS_PROVIDER_ENV_KEYS) {
    const nextValue = nextValues.get(key);
    if (nextValue) {
      process.env[key] = nextValue;
      continue;
    }

    const baselineValue = KMS_ENV_BASELINE.get(key);
    if (baselineValue) process.env[key] = baselineValue;
    else delete process.env[key];
  }
}

/**
 * Load KMS credentials saved via the dashboard UI into process.env
 * so all resolvers can find them.
 */
export async function ensureKmsCredentials(): Promise<void> {
  const config = await readKmsConfig();
  applySavedKmsCredentialsToEnv(config);
}

// ── Constants ──────────────────────────────────────────────────

const SUPPORTED_SCHEMES = new Set([
  "env",
  "doppler",
  "aws-sm",
  "gcp-sm",
  "azure-kv",
]);

const DEFAULT_DOPPLER_API = "https://api.doppler.com/v3";
const DEFAULT_GCP_SM_API = "https://secretmanager.googleapis.com/v1";
const AZURE_KV_API_VERSION =
  process.env.AZURE_KEY_VAULT_API_VERSION || "7.4";

// ── Parsing ────────────────────────────────────────────────────

function decode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

function splitFragment(value: string): {
  ref: string;
  fieldPath: SecretFieldPath;
} {
  const i = value.indexOf("#");
  if (i === -1) return { ref: value, fieldPath: [] };
  return {
    ref: value.slice(0, i),
    fieldPath: value
      .slice(i + 1)
      .split(".")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(decode),
  };
}

function splitQuery(value: string): {
  path: string;
  query: URLSearchParams;
} {
  const i = value.indexOf("?");
  if (i === -1) return { path: value, query: new URLSearchParams() };
  return {
    path: value.slice(0, i),
    query: new URLSearchParams(value.slice(i + 1)),
  };
}

function isPrivateOrReservedIpv4(host: string): boolean {
  const octets = host.split(".").map((part) => Number(part));
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a = 0, b = 0, c = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPrivateOrReservedIpv6(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    const mapped = lower.slice("::ffff:".length);
    return net.isIP(mapped) !== 4 || isPrivateOrReservedIpv4(mapped);
  }
  return (
    lower === "::" ||
    lower === "::1" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe80") ||
    lower.startsWith("ff") ||
    lower.startsWith("2001:db8")
  );
}

export function isPrivateOrReservedSecretApiHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host.endsWith(".home")
  ) {
    return true;
  }

  const ipVersion = net.isIP(host);
  if (!ipVersion && !host.includes(".")) return true;
  if (ipVersion === 4) return isPrivateOrReservedIpv4(host);
  if (ipVersion === 6) return isPrivateOrReservedIpv6(host);
  return false;
}

export function trustedSecretApiBase(rawValue: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawValue);
  } catch {
    throw new SecretResolutionError(`${label} must be a valid URL`);
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    isPrivateOrReservedSecretApiHost(host)
  ) {
    throw new SecretResolutionError(
      `${label} must be an https URL on a public provider host`,
    );
  }

  const basePath =
    parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/g, "");
  return `${parsed.origin}${basePath}`;
}

function dopplerApiBase(): string {
  return trustedSecretApiBase(
    process.env.DOPPLER_API_BASE || DEFAULT_DOPPLER_API,
    "DOPPLER_API_BASE",
  );
}

function gcpSecretManagerApiBase(): string {
  return trustedSecretApiBase(
    process.env.GCP_SECRET_MANAGER_API_BASE || DEFAULT_GCP_SM_API,
    "GCP_SECRET_MANAGER_API_BASE",
  );
}

function validateGcpResourceName(
  project: string,
  secret: string,
  version: string,
): string {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(project)) {
    throw new SecretResolutionError(
      "gcp-sm project id contains unsupported characters",
    );
  }
  if (!/^[A-Za-z0-9_-]{1,255}$/.test(secret)) {
    throw new SecretResolutionError(
      "gcp-sm secret id contains unsupported characters",
    );
  }
  if (!/^(latest|[0-9]+)$/.test(version)) {
    throw new SecretResolutionError(
      "gcp-sm secret version must be latest or a numeric version",
    );
  }
  return `projects/${project}/secrets/${secret}/versions/${version}`;
}

function validateAzureKeyVaultReference(
  vaultName: string,
  secretName: string,
  version?: string,
): void {
  if (!/^[A-Za-z][A-Za-z0-9-]{1,22}[A-Za-z0-9]$/.test(vaultName)) {
    throw new SecretResolutionError(
      "azure-kv vault name must be 3-24 letters, numbers, or hyphens and cannot end with a hyphen",
    );
  }
  if (!/^[A-Za-z0-9-]{1,127}$/.test(secretName)) {
    throw new SecretResolutionError(
      "azure-kv secret name contains unsupported characters",
    );
  }
  if (version && !/^[A-Za-z0-9-]{1,64}$/.test(version)) {
    throw new SecretResolutionError(
      "azure-kv secret version contains unsupported characters",
    );
  }
}

export function isSecretRef(value: string): boolean {
  const scheme = String(value || "").split("://", 1)[0];
  return SUPPORTED_SCHEMES.has(scheme);
}

export function parseSecretRef(value: string): SecretReference | null {
  if (!isSecretRef(value)) return null;

  const { ref, fieldPath } = splitFragment(value);
  const schemeEnd = ref.indexOf("://");
  const scheme = ref.slice(0, schemeEnd);
  const raw = ref.slice(schemeEnd + 3);

  switch (scheme) {
    case "env": {
      const variableName = raw.replace(/^\/+|\/+$/g, "").trim();
      if (!variableName)
        throw new SecretResolutionError("env:// ref missing variable name");
      return { scheme: "env", variableName, fieldPath };
    }

    case "doppler": {
      const segs = raw.split("/").filter(Boolean).map(decode);
      if (segs.length === 1)
        return { scheme: "doppler", secretName: segs[0], fieldPath };
      if (segs.length === 3)
        return {
          scheme: "doppler",
          project: segs[0],
          config: segs[1],
          secretName: segs[2],
          fieldPath,
        };
      throw new SecretResolutionError(
        "doppler:// ref must be doppler://SECRET or doppler://project/config/SECRET",
      );
    }

    case "aws-sm": {
      const { path: secretId, query } = splitQuery(raw);
      if (!secretId)
        throw new SecretResolutionError("aws-sm:// ref missing secret id");
      return {
        scheme: "aws-sm",
        secretId: decode(secretId),
        region: query.get("region") || undefined,
        fieldPath,
      };
    }

    case "gcp-sm": {
      const trimmed = raw.replace(/^\/+|\/+$/g, "");
      if (!trimmed)
        throw new SecretResolutionError(
          "gcp-sm:// ref missing resource path",
        );
      const clean = trimmed.endsWith(":access")
        ? trimmed.slice(0, -":access".length)
        : trimmed;
      let resourceName: string;
      const segs = clean.split("/").filter(Boolean).map(decode);
      if (clean.startsWith("projects/")) {
        if (
          segs.length !== 6 ||
          segs[0] !== "projects" ||
          segs[2] !== "secrets" ||
          segs[4] !== "versions"
        ) {
          throw new SecretResolutionError(
            "gcp-sm:// ref must be projects/.../secrets/.../versions/...",
          );
        }
        resourceName = validateGcpResourceName(segs[1], segs[3], segs[5]);
      } else {
        if (segs.length === 2) {
          resourceName = validateGcpResourceName(segs[0], segs[1], "latest");
        } else if (segs.length === 3) {
          resourceName = validateGcpResourceName(segs[0], segs[1], segs[2]);
        } else {
          throw new SecretResolutionError(
            "gcp-sm:// ref must be project/secret[/version]",
          );
        }
      }
      return { scheme: "gcp-sm", resourceName, fieldPath };
    }

    case "azure-kv": {
      const segs = raw.split("/").filter(Boolean).map(decode);
      if (segs.length < 2 || segs.length > 3)
        throw new SecretResolutionError(
          "azure-kv:// ref must be azure-kv://vault/secret[/version]",
        );
      validateAzureKeyVaultReference(segs[0], segs[1], segs[2]);
      return {
        scheme: "azure-kv",
        vaultName: segs[0],
        secretName: segs[1],
        version: segs[2],
        fieldPath,
      };
    }

    default:
      return null;
  }
}

// ── Field extraction ───────────────────────────────────────────

function extractField(
  raw: unknown,
  fieldPath: SecretFieldPath,
  label: string,
): string {
  let val = raw;

  if (fieldPath.length > 0) {
    if (typeof val === "string") {
      try {
        val = JSON.parse(val);
      } catch {
        throw new SecretResolutionError(
          `${label} field path requested but value is not JSON`,
        );
      }
    }
    for (const seg of fieldPath) {
      if (!val || typeof val !== "object" || !(seg in val)) {
        throw new SecretResolutionError(
          `${label} missing field #${fieldPath.join(".")}`,
        );
      }
      val = (val as Record<string, unknown>)[seg];
    }
  }

  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  if (val === null || val === undefined)
    throw new SecretResolutionError(`${label} resolved to empty`);
  if (fieldPath.length === 0) return JSON.stringify(val);
  throw new SecretResolutionError(
    `${label} field #${fieldPath.join(".")} must be a scalar`,
  );
}

// ── Provider resolvers ─────────────────────────────────────────

async function httpJson(
  url: string,
  headers: Record<string, string>,
): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new SecretResolutionError(
      `HTTP ${res.status}${detail ? `: ${detail.slice(0, 240)}` : ""}`,
    );
  }
  return res.json();
}

async function resolveEnv(ref: EnvRef): Promise<string> {
  const val = process.env[ref.variableName];
  if (val === undefined)
    throw new SecretResolutionError(
      `env secret ${ref.variableName} is not set`,
    );
  return val;
}

async function resolveDoppler(ref: DopplerRef): Promise<unknown> {
  const token =
    process.env.DOPPLER_TOKEN || process.env.DOPPLER_SERVICE_TOKEN;
  if (!token)
    throw new SecretResolutionError(
      "doppler resolution requires DOPPLER_TOKEN or DOPPLER_SERVICE_TOKEN",
    );

  const params = new URLSearchParams({ format: "json" });
  const project = ref.project || process.env.DOPPLER_PROJECT;
  const config = ref.config || process.env.DOPPLER_CONFIG;
  if (project) params.set("project", project);
  if (config) params.set("config", config);

  const payload = (await httpJson(
    `${dopplerApiBase()}/configs/config/secrets/download?${params}`,
    { Authorization: `Bearer ${token}` },
  )) as Record<string, unknown>;

  const secretMap =
    payload.secrets && typeof payload.secrets === "object"
      ? (payload.secrets as Record<string, unknown>)
      : payload;

  const entry = secretMap[ref.secretName];
  if (entry === undefined)
    throw new SecretResolutionError(
      `doppler secret ${ref.secretName} not found`,
    );

  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const obj = entry as Record<string, unknown>;
    if (typeof obj.computed === "string") return obj.computed;
    if (typeof obj.raw === "string") return obj.raw;
    if (typeof obj.value === "string") return obj.value;
  }
  return entry;
}

async function resolveAwsSm(ref: AwsSmRef): Promise<string> {
  // Dynamic import — the SDK is optional; if missing, give a clear error
  let SecretsManagerClient: typeof import("@aws-sdk/client-secrets-manager").SecretsManagerClient;
  let GetSecretValueCommand: typeof import("@aws-sdk/client-secrets-manager").GetSecretValueCommand;
  try {
    const mod = await import("@aws-sdk/client-secrets-manager");
    SecretsManagerClient = mod.SecretsManagerClient;
    GetSecretValueCommand = mod.GetSecretValueCommand;
  } catch {
    throw new SecretResolutionError(
      "aws-sm resolution requires @aws-sdk/client-secrets-manager — install it with: npm i @aws-sdk/client-secrets-manager",
    );
  }

  const region =
    ref.region ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    inferAwsRegion(ref.secretId);

  const client = new SecretsManagerClient(region ? { region } : {});
  const result = await client.send(
    new GetSecretValueCommand({ SecretId: ref.secretId }),
  );

  if (typeof result.SecretString === "string") return result.SecretString;
  if (result.SecretBinary)
    return Buffer.from(result.SecretBinary).toString("utf8");

  throw new SecretResolutionError(
    `aws-sm secret ${ref.secretId} has no string value`,
  );
}

function inferAwsRegion(secretId: string): string | undefined {
  if (!secretId.startsWith("arn:")) return undefined;
  return secretId.split(":")[3] || undefined;
}

async function resolveGcpSm(ref: GcpSmRef): Promise<string> {
  const token =
    process.env.GCP_SECRET_MANAGER_TOKEN ||
    process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
  if (!token)
    throw new SecretResolutionError(
      "gcp-sm resolution requires GCP_SECRET_MANAGER_TOKEN or GOOGLE_ACCESS_TOKEN",
    );

  const payload = (await httpJson(
    `${gcpSecretManagerApiBase()}/${ref.resourceName}:access`,
    { Authorization: `Bearer ${token}` },
  )) as { payload?: { data?: string } };

  const encoded = payload?.payload?.data;
  if (typeof encoded !== "string")
    throw new SecretResolutionError(
      `gcp-sm secret ${ref.resourceName} returned invalid payload`,
    );
  return Buffer.from(encoded, "base64").toString("utf8");
}

async function resolveAzureKv(ref: AzureKvRef): Promise<string> {
  const token =
    process.env.AZURE_KEY_VAULT_TOKEN || process.env.AZURE_ACCESS_TOKEN;
  if (!token)
    throw new SecretResolutionError(
      "azure-kv resolution requires AZURE_KEY_VAULT_TOKEN or AZURE_ACCESS_TOKEN",
    );

  const version = ref.version ? `/${ref.version}` : "";
  const url = `https://${ref.vaultName}.vault.azure.net/secrets/${ref.secretName}${version}?api-version=${encodeURIComponent(AZURE_KV_API_VERSION)}`;

  const payload = (await httpJson(url, {
    Authorization: `Bearer ${token}`,
  })) as { value?: string };

  if (typeof payload.value !== "string")
    throw new SecretResolutionError(
      `azure-kv secret ${ref.vaultName}/${ref.secretName} returned invalid payload`,
    );
  return payload.value;
}

// ── Public API ─────────────────────────────────────────────────

async function fetchRaw(ref: SecretReference): Promise<unknown> {
  switch (ref.scheme) {
    case "env":
      return resolveEnv(ref);
    case "doppler":
      return resolveDoppler(ref);
    case "aws-sm":
      return resolveAwsSm(ref);
    case "gcp-sm":
      return resolveGcpSm(ref);
    case "azure-kv":
      return resolveAzureKv(ref);
  }
}

/**
 * Resolve a single string value. If the value is a secret reference
 * (e.g. `doppler://MY_SECRET`), it is fetched and returned as a
 * plain string. Non-ref strings are returned unchanged.
 */
export async function resolveSecretValue(
  value: string,
  label = "secret",
): Promise<string> {
  const ref = parseSecretRef(value);
  if (!ref) return value;
  await ensureKmsCredentials();
  const raw = await fetchRaw(ref);
  return extractField(raw, ref.fieldPath, label);
}

/**
 * Deep-walk an object tree and resolve every string that looks
 * like a secret reference. Returns a new tree with all refs
 * replaced by their resolved values.
 */
export async function resolveValueTree(
  value: unknown,
  label = "config",
): Promise<unknown> {
  if (typeof value === "string") return resolveSecretValue(value, label);

  if (Array.isArray(value)) {
    return Promise.all(
      value.map((item, i) => resolveValueTree(item, `${label}[${i}]`)),
    );
  }

  if (value && typeof value === "object") {
    const entries = await Promise.all(
      Object.entries(value).map(async ([k, v]) => [
        k,
        await resolveValueTree(v, label ? `${label}.${k}` : k),
      ]),
    );
    return Object.fromEntries(entries);
  }

  return value;
}
