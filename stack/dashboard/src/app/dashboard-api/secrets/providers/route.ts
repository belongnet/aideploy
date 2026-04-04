import { NextResponse } from "next/server";
import { ensureKmsCredentials } from "@/lib/secret-resolver";

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

  const providers = [
    {
      id: "env" as const,
      name: "Environment Variables",
      configured: true, // always available
    },
    {
      id: "doppler" as const,
      name: "Doppler",
      configured: Boolean(
        process.env.DOPPLER_TOKEN || process.env.DOPPLER_SERVICE_TOKEN,
      ),
    },
    {
      id: "aws-sm" as const,
      name: "AWS Secrets Manager",
      configured: Boolean(
        process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY,
      ),
    },
    {
      id: "gcp-sm" as const,
      name: "Google Cloud Secret Manager",
      configured: Boolean(
        process.env.GCP_SECRET_MANAGER_TOKEN ||
          process.env.GOOGLE_ACCESS_TOKEN ||
          process.env.GOOGLE_OAUTH_ACCESS_TOKEN,
      ),
    },
    {
      id: "azure-kv" as const,
      name: "Azure Key Vault",
      configured: Boolean(
        process.env.AZURE_KEY_VAULT_TOKEN || process.env.AZURE_ACCESS_TOKEN,
      ),
    },
  ];

  return NextResponse.json({ providers });
}
