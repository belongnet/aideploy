import { NextResponse } from "next/server";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  applySavedKmsCredentialsToEnv,
  type KmsConfig,
} from "@/lib/secret-resolver";
import { readJsonBody, requestBodyErrorResponse } from "@/lib/request-body";

/**
 * POST /dashboard-api/secrets/configure
 *
 * Saves KMS provider credentials to a local config file so the
 * secret-resolver can use them at runtime. This avoids requiring
 * users to edit .env files manually.
 *
 * Body: { providerId: string, credentials: Record<string, string> }
 *
 * GET /dashboard-api/secrets/configure
 *
 * Returns the current saved credentials (masked) for each provider.
 */

const HOME_ROOT = process.env.AIDEPLOY_HOME_ROOT || "/home/aideploy";
const KMS_CONFIG_PATH = `${HOME_ROOT}/.openclaw/kms-credentials.json`;
const LEGACY_SECRET_PROVIDERS_PATH = `${HOME_ROOT}/.aideploy/secret-providers.json`;

async function readKmsConfig(): Promise<KmsConfig> {
  try {
    const raw = await readFile(KMS_CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as KmsConfig;
  } catch {
    return { version: 1, providers: {} };
  }
}

async function writeKmsConfig(config: KmsConfig): Promise<void> {
  await mkdir(dirname(KMS_CONFIG_PATH), { recursive: true });
  await writeFile(KMS_CONFIG_PATH, JSON.stringify(config, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/**
 * Mirror Doppler credentials to the legacy secret-providers.json so the
 * materializer and old dashboard can find them.
 */
async function syncDopplerToLegacy(config: KmsConfig): Promise<void> {
  const doppler = config.providers.doppler;

  try {
    let existing: Record<string, unknown> = {};
    try {
      const raw = await readFile(LEGACY_SECRET_PROVIDERS_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") existing = parsed as Record<string, unknown>;
    } catch {
      // file doesn't exist yet — fine
    }

    const token = doppler?.DOPPLER_TOKEN?.trim() ?? "";
    if (token) {
      existing.doppler = {
        token,
        project: doppler?.DOPPLER_PROJECT ?? "",
        config: doppler?.DOPPLER_CONFIG ?? "",
        updatedAt: new Date().toISOString(),
      };
    } else {
      delete existing.doppler;
    }

    await mkdir(dirname(LEGACY_SECRET_PROVIDERS_PATH), { recursive: true });
    await writeFile(
      LEGACY_SECRET_PROVIDERS_PATH,
      JSON.stringify(existing, null, 2),
      { encoding: "utf-8", mode: 0o600 },
    );
  } catch {
    // Best-effort — don't block the save if legacy write fails
  }
}

// Env var names each provider needs
const PROVIDER_FIELDS: Record<
  string,
  { key: string; label: string; placeholder: string; secret?: boolean }[]
> = {
  doppler: [
    {
      key: "DOPPLER_TOKEN",
      label: "Service Token",
      placeholder: "dp.st.xxxx",
      secret: true,
    },
    {
      key: "DOPPLER_PROJECT",
      label: "Project Name",
      placeholder: "my-project",
    },
    {
      key: "DOPPLER_CONFIG",
      label: "Config Environment",
      placeholder: "prd",
    },
  ],
  "aws-sm": [
    {
      key: "AWS_ACCESS_KEY_ID",
      label: "Access Key ID",
      placeholder: "AKIAIOSFODNN7EXAMPLE",
      secret: true,
    },
    {
      key: "AWS_SECRET_ACCESS_KEY",
      label: "Secret Access Key",
      placeholder: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      secret: true,
    },
    {
      key: "AWS_SESSION_TOKEN",
      label: "Session Token (optional)",
      placeholder: "Leave blank if using long-lived keys",
      secret: true,
    },
    {
      key: "AWS_REGION",
      label: "Region",
      placeholder: "us-east-1",
    },
  ],
  "gcp-sm": [
    {
      key: "GCP_SECRET_MANAGER_TOKEN",
      label: "Access Token",
      placeholder: "ya29.a0AfH6SM...",
      secret: true,
    },
  ],
  "azure-kv": [
    {
      key: "AZURE_KEY_VAULT_TOKEN",
      label: "Access Token",
      placeholder: "eyJ0eXAiOiJKV1Qi...",
      secret: true,
    },
  ],
};

function maskValue(value: string): string {
  if (value.length <= 6) return "******";
  return value.slice(0, 4) + "****" + value.slice(-2);
}

export async function GET() {
  const config = await readKmsConfig();

  // Also check env vars — credentials may come from docker-compose
  const result: Record<
    string,
    {
      configured: boolean;
      source: "dashboard" | "environment" | "none";
      fields: Record<string, { set: boolean; masked?: string }>;
    }
  > = {};

  for (const [providerId, fields] of Object.entries(PROVIDER_FIELDS)) {
    const savedCreds = config.providers[providerId] ?? {};
    const fieldStatus: Record<string, { set: boolean; masked?: string }> = {};
    let hasAnyCred = false;
    let source: "dashboard" | "environment" | "none" = "none";

    for (const field of fields) {
      const savedValue = savedCreds[field.key];
      const envValue = process.env[field.key];

      if (savedValue) {
        fieldStatus[field.key] = {
          set: true,
          masked: maskValue(savedValue),
        };
        hasAnyCred = true;
        source = "dashboard";
      } else if (envValue) {
        fieldStatus[field.key] = {
          set: true,
          masked: maskValue(envValue),
        };
        hasAnyCred = true;
        if (source === "none") source = "environment";
      } else {
        fieldStatus[field.key] = { set: false };
      }
    }

    result[providerId] = { configured: hasAnyCred, source, fields: fieldStatus };
  }

  return NextResponse.json({ providers: result, fields: PROVIDER_FIELDS });
}

export async function POST(request: Request) {
  try {
    const body = await readJsonBody<{
      providerId?: string;
      credentials?: Record<string, string>;
    }>(request);

    const { providerId, credentials } = body;

    if (!providerId || !PROVIDER_FIELDS[providerId]) {
      return NextResponse.json(
        { error: "Unknown provider" },
        { status: 400 },
      );
    }

    if (!credentials || typeof credentials !== "object") {
      return NextResponse.json(
        { error: "credentials must be an object" },
        { status: 400 },
      );
    }

    // Only allow known field keys for this provider
    const allowedKeys = new Set(
      PROVIDER_FIELDS[providerId].map((f) => f.key),
    );
    const sanitized: Record<string, string> = {};
    for (const [key, value] of Object.entries(credentials)) {
      if (allowedKeys.has(key) && typeof value === "string") {
        const normalized = value.trim();
        if (normalized) sanitized[key] = normalized;
      }
    }

    const config = await readKmsConfig();
    const existing = config.providers[providerId] ?? {};
    config.providers[providerId] = { ...existing, ...sanitized };
    await writeKmsConfig(config);

    // Mirror Doppler credentials to legacy path for materializer compatibility
    if (providerId === "doppler") {
      await syncDopplerToLegacy(config);
    }

    // Apply to current process so resolvers work immediately
    applySavedKmsCredentialsToEnv(config);

    return NextResponse.json({ ok: true });
  } catch (error) {
    const bodyError = requestBodyErrorResponse(error);
    if (bodyError) return bodyError;

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to save credentials",
      },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await readJsonBody<{ providerId?: string }>(request);
    const { providerId } = body;

    if (!providerId || !PROVIDER_FIELDS[providerId]) {
      return NextResponse.json(
        { error: "Unknown provider" },
        { status: 400 },
      );
    }

    const config = await readKmsConfig();
    delete config.providers[providerId];
    await writeKmsConfig(config);

    if (providerId === "doppler") {
      await syncDopplerToLegacy(config);
    }

    // Restore environment-backed values while removing dashboard-saved ones.
    applySavedKmsCredentialsToEnv(config);

    return NextResponse.json({ ok: true });
  } catch (error) {
    const bodyError = requestBodyErrorResponse(error);
    if (bodyError) return bodyError;

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to remove credentials",
      },
      { status: 500 },
    );
  }
}
