import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { ensureKmsCredentials } from "@/lib/secret-resolver";

const HOME_ROOT = process.env.AIDEPLOY_HOME_ROOT || "/home/aideploy";
const SECRET_PROVIDERS_PATH = `${HOME_ROOT}/.aideploy/secret-providers.json`;

async function readSecretProviderMetadata(): Promise<{
  secretManagement?: {
    selection?: string;
    effectiveProvider?: string;
    cloudNativeProvider?: string | null;
    supportedProviders?: string[];
  };
  providers?: Record<string, { selected?: boolean; cloudNative?: boolean }>;
}> {
  try {
    const raw = await readFile(SECRET_PROVIDERS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * GET /dashboard-api/secrets/providers
 *
 * Returns which KMS providers are currently configured (have credentials
 * available in the environment or saved via dashboard). The dashboard UI
 * uses this to show which secret reference schemes are available.
 */
export async function GET() {
  // Load any dashboard-saved credentials into process.env first
  await ensureKmsCredentials();
  const metadata = await readSecretProviderMetadata();
  const selectedProvider =
    metadata.secretManagement?.effectiveProvider || "doppler";
  const providerMetadata = metadata.providers || {};

  const providers = [
    {
      id: "env" as const,
      name: "Environment Variables",
      configured: true, // always available
      selected: selectedProvider === "env",
      cloudNative: false,
    },
    {
      id: "doppler" as const,
      name: "Doppler",
      configured: Boolean(
        process.env.DOPPLER_TOKEN || process.env.DOPPLER_SERVICE_TOKEN,
      ),
      selected: selectedProvider === "doppler",
      cloudNative: Boolean(providerMetadata.doppler?.cloudNative),
    },
    {
      id: "aws-sm" as const,
      name: "AWS Secrets Manager",
      configured: Boolean(
        process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY,
      ),
      selected: selectedProvider === "aws-sm",
      cloudNative: Boolean(providerMetadata["aws-sm"]?.cloudNative),
    },
    {
      id: "gcp-sm" as const,
      name: "Google Cloud Secret Manager",
      configured: Boolean(
        process.env.GCP_SECRET_MANAGER_TOKEN ||
          process.env.GOOGLE_ACCESS_TOKEN ||
          process.env.GOOGLE_OAUTH_ACCESS_TOKEN,
      ),
      selected: selectedProvider === "gcp-sm",
      cloudNative: Boolean(providerMetadata["gcp-sm"]?.cloudNative),
    },
    {
      id: "azure-kv" as const,
      name: "Azure Key Vault",
      configured: Boolean(
        process.env.AZURE_KEY_VAULT_TOKEN || process.env.AZURE_ACCESS_TOKEN,
      ),
      selected: selectedProvider === "azure-kv",
      cloudNative: Boolean(providerMetadata["azure-kv"]?.cloudNative),
    },
  ];

  return NextResponse.json({
    providers,
    secretManagement: {
      selection: metadata.secretManagement?.selection || "automatic",
      effectiveProvider: selectedProvider,
      cloudNativeProvider:
        metadata.secretManagement?.cloudNativeProvider || null,
      supportedProviders:
        metadata.secretManagement?.supportedProviders ||
        providers.map((provider) => provider.id),
    },
  });
}
