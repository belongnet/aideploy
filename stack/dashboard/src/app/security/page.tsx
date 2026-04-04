"use client";

import { useEffect, useState, useCallback } from "react";
import {
  fetchSecretProviders,
  fetchKmsConfig,
  saveKmsCredentials,
  removeKmsCredentials,
  validateSecretRef,
  type SecretProviderInfo,
} from "@/lib/api";

/* ------------------------------------------------------------------ */
/*  Provider metadata — friendly names, descriptions, instructions     */
/* ------------------------------------------------------------------ */

interface ProviderMeta {
  id: string;
  name: string;
  tagline: string;
  description: string;
  learnMoreUrl: string;
  instructions: string[];
  color: string;
  initial: string;
}

const PROVIDER_META: Record<string, ProviderMeta> = {
  doppler: {
    id: "doppler",
    name: "Doppler",
    tagline: "The easiest way to manage secrets",
    description:
      "Doppler is a secrets manager that syncs your environment variables across your team and deployments. " +
      "It's the recommended option if you're just getting started — it has a free tier and a simple web interface.",
    learnMoreUrl: "https://docs.doppler.com/docs/getting-started",
    instructions: [
      "Go to doppler.com and create a free account.",
      'Create a new project (e.g., "my-agent") and a config (e.g., "prd" for production).',
      "Add your secrets (like API keys and tokens) in the Doppler dashboard.",
      'Go to the project settings and create a "Service Token" — this is what your agent uses to read secrets.',
      "Paste the service token, project name, and config name below.",
    ],
    color: "bg-purple-100 text-purple-700",
    initial: "D",
  },
  "aws-sm": {
    id: "aws-sm",
    name: "AWS Secrets Manager",
    tagline: "For teams already using Amazon Web Services",
    description:
      "AWS Secrets Manager stores and retrieves secrets like database passwords, API keys, and tokens. " +
      "Use this if your team already has an AWS account. You'll need an access key with permission to read secrets.",
    learnMoreUrl:
      "https://docs.aws.amazon.com/secretsmanager/latest/userguide/intro.html",
    instructions: [
      "Sign into your AWS account at aws.amazon.com.",
      'Go to "Secrets Manager" and store your secrets there (each secret gets a name like "my-api-key").',
      'Go to "IAM" and create an access key for a user that has "SecretsManagerReadWrite" permissions.',
      "Copy the Access Key ID and Secret Access Key — you'll need both.",
      "Choose which AWS region your secrets are stored in (e.g., us-east-1).",
      "Paste everything below.",
    ],
    color: "bg-orange-100 text-orange-700",
    initial: "A",
  },
  "gcp-sm": {
    id: "gcp-sm",
    name: "Google Cloud Secret Manager",
    tagline: "For teams already using Google Cloud",
    description:
      "Google Cloud Secret Manager lets you store API keys, passwords, and certificates securely. " +
      "Use this if your team already has a Google Cloud project. You'll need an access token.",
    learnMoreUrl:
      "https://cloud.google.com/secret-manager/docs/overview",
    instructions: [
      "Sign into your Google Cloud account at console.cloud.google.com.",
      'Enable the "Secret Manager API" for your project.',
      "Store your secrets in Secret Manager (each gets a name and version).",
      'Create a service account with "Secret Manager Secret Accessor" role.',
      "Generate an access token for the service account.",
      "Paste the token below.",
    ],
    color: "bg-blue-100 text-blue-700",
    initial: "G",
  },
  "azure-kv": {
    id: "azure-kv",
    name: "Azure Key Vault",
    tagline: "For teams already using Microsoft Azure",
    description:
      "Azure Key Vault safeguards cryptographic keys and secrets used by your applications. " +
      "Use this if your team already has an Azure subscription. You'll need an access token for your vault.",
    learnMoreUrl:
      "https://learn.microsoft.com/en-us/azure/key-vault/general/overview",
    instructions: [
      "Sign into your Azure account at portal.azure.com.",
      'Create a Key Vault (or use an existing one) — note the vault name (e.g., "my-vault").',
      'Add your secrets to the vault under "Secrets".',
      "Register an app in Azure Active Directory and grant it Key Vault access.",
      "Generate an access token for the app.",
      "Paste the token below.",
    ],
    color: "bg-sky-100 text-sky-700",
    initial: "Az",
  },
};

/* ------------------------------------------------------------------ */
/*  Page                                                                */
/* ------------------------------------------------------------------ */

export default function SecurityPage() {
  const [providers, setProviders] = useState<SecretProviderInfo[]>([]);
  const [kmsConfig, setKmsConfig] = useState<{
    providers: Record<
      string,
      {
        configured: boolean;
        source: string;
        fields: Record<string, { set: boolean; masked?: string }>;
      }
    >;
    fields: Record<
      string,
      { key: string; label: string; placeholder: string; secret?: boolean }[]
    >;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [showInstructions, setShowInstructions] = useState<string | null>(null);

  // Test secret reference
  const [testRef, setTestRef] = useState("");
  const [testResult, setTestResult] = useState<{
    valid: boolean;
    error?: string;
    resolved?: boolean;
  } | null>(null);
  const [testing, setTesting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [providerData, configData] = await Promise.all([
        fetchSecretProviders(),
        fetchKmsConfig(),
      ]);
      setProviders(providerData.providers);
      setKmsConfig(configData);
    } catch {
      // will show empty state
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleTestRef = async () => {
    if (!testRef.trim()) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await validateSecretRef(testRef.trim(), true);
      setTestResult(result);
    } catch (err) {
      setTestResult({
        valid: false,
        error: err instanceof Error ? err.message : "Test failed",
      });
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-48 rounded bg-gray-200" />
        <div className="h-24 rounded-xl bg-gray-200" />
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-32 rounded-xl bg-gray-200" />
        ))}
      </div>
    );
  }

  const configuredCount = providers.filter(
    (p) => p.configured && p.id !== "env",
  ).length;

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Page header */}
      <div>
        <h1 className="page-title">Password Storage</h1>
        <p className="mt-1 text-sm text-gray-500">
          Keep your API keys, passwords, and tokens safe using a secure vault.
        </p>
      </div>

      {/* What is this? explainer card */}
      <section className="card bg-gradient-to-br from-brand-50 to-white border-brand-100">
        <div className="flex gap-4">
          <div className="flex-shrink-0 flex h-12 w-12 items-center justify-center rounded-xl bg-brand-100">
            <svg
              className="h-6 w-6 text-brand-600"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
              />
            </svg>
          </div>
          <div>
            <h2 className="text-base font-semibold text-gray-900">
              What is password storage?
            </h2>
            <p className="mt-1 text-sm text-gray-600 leading-relaxed">
              Your agent needs various passwords and keys to work &mdash; things
              like your messaging app tokens or AI provider keys. Instead of
              typing those sensitive values directly into your settings, you can
              store them in a <strong>secure vault</strong> (also called a
              &ldquo;secrets manager&rdquo;) that keeps them encrypted and
              protected.
            </p>
            <p className="mt-2 text-sm text-gray-600 leading-relaxed">
              Your agent then uses a short <strong>reference</strong> like{" "}
              <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-mono text-brand-700">
                doppler://MY_API_KEY
              </code>{" "}
              to look up the real value when it needs it. The actual password
              never appears in settings or logs &mdash; it stays safely locked
              in the vault.
            </p>
            <p className="mt-2 text-sm text-gray-500">
              <strong>This is optional.</strong> Your agent works fine without
              it. But if you handle sensitive data or work with a team, a
              password vault adds an important layer of protection.
            </p>
          </div>
        </div>
      </section>

      {/* Status summary */}
      <div className="flex items-center gap-3 px-1">
        {configuredCount > 0 ? (
          <>
            <span className="status-dot bg-green-500" />
            <span className="text-sm text-gray-700">
              {configuredCount} secret manager{configuredCount !== 1 ? "s" : ""}{" "}
              connected
            </span>
          </>
        ) : (
          <>
            <span className="status-dot bg-gray-300" />
            <span className="text-sm text-gray-500">
              No secret managers connected yet
            </span>
          </>
        )}
      </div>

      {/* Provider cards */}
      {(["doppler", "aws-sm", "gcp-sm", "azure-kv"] as const).map(
        (providerId) => {
          const meta = PROVIDER_META[providerId];
          const providerStatus = providers.find((p) => p.id === providerId);
          const configStatus = kmsConfig?.providers[providerId];
          const fields = kmsConfig?.fields[providerId] ?? [];
          const isConfigured = providerStatus?.configured ?? false;
          const isExpanded = expandedProvider === providerId;
          const showingInstructions = showInstructions === providerId;

          return (
            <ProviderCard
              key={providerId}
              meta={meta}
              isConfigured={isConfigured}
              configStatus={configStatus}
              fields={fields}
              isExpanded={isExpanded}
              showingInstructions={showingInstructions}
              onToggleExpand={() =>
                setExpandedProvider(isExpanded ? null : providerId)
              }
              onToggleInstructions={() =>
                setShowInstructions(
                  showingInstructions ? null : providerId,
                )
              }
              onSaved={load}
            />
          );
        },
      )}

      {/* Test a secret reference */}
      <section className="card space-y-4">
        <h2 className="section-title">Test a secret reference</h2>
        <p className="text-sm text-gray-500">
          Paste a secret reference below to check if your agent can reach the
          secrets manager and fetch the value. The actual secret value is never
          shown.
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={testRef}
            onChange={(e) => {
              setTestRef(e.target.value);
              setTestResult(null);
            }}
            placeholder="e.g. doppler://MY_SECRET or aws-sm://my-secret-id"
            className="input-field flex-1 font-mono text-sm"
          />
          <button
            onClick={handleTestRef}
            disabled={testing || !testRef.trim()}
            className="btn-secondary text-sm whitespace-nowrap"
          >
            {testing ? "Testing..." : "Test"}
          </button>
        </div>
        {testResult && (
          <div
            className={`rounded-lg px-4 py-3 text-sm ${
              testResult.valid && testResult.resolved
                ? "bg-green-50 text-green-800"
                : testResult.valid
                  ? "bg-yellow-50 text-yellow-800"
                  : "bg-red-50 text-red-800"
            }`}
          >
            {testResult.valid && testResult.resolved
              ? "Secret resolved successfully. Your agent can read this value."
              : testResult.valid
                ? "Valid reference format, but could not fetch the value."
                : testResult.error || "Invalid secret reference."}
          </div>
        )}
      </section>

      {/* Reference format guide */}
      <section className="card space-y-4">
        <h2 className="section-title">How to use secret references</h2>
        <p className="text-sm text-gray-500">
          Anywhere your agent needs a sensitive value, you can use a reference
          instead of the actual secret. Here are the formats:
        </p>
        <div className="space-y-3">
          <RefExample
            scheme="doppler://"
            example="doppler://TELEGRAM_TOKEN"
            description="Fetches the secret named TELEGRAM_TOKEN from Doppler"
          />
          <RefExample
            scheme="aws-sm://"
            example="aws-sm://prod/api-key?region=us-east-1"
            description="Fetches the secret named prod/api-key from AWS Secrets Manager"
          />
          <RefExample
            scheme="gcp-sm://"
            example="gcp-sm://my-project/my-secret"
            description="Fetches the latest version of my-secret from Google Cloud"
          />
          <RefExample
            scheme="azure-kv://"
            example="azure-kv://my-vault/my-secret"
            description="Fetches my-secret from your Azure Key Vault"
          />
          <RefExample
            scheme="env://"
            example="env://MY_VARIABLE"
            description="Reads the value from the MY_VARIABLE environment variable (always available)"
          />
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Provider Card                                                       */
/* ------------------------------------------------------------------ */

function ProviderCard({
  meta,
  isConfigured,
  configStatus,
  fields,
  isExpanded,
  showingInstructions,
  onToggleExpand,
  onToggleInstructions,
  onSaved,
}: {
  meta: ProviderMeta;
  isConfigured: boolean;
  configStatus?: {
    configured: boolean;
    source: string;
    fields: Record<string, { set: boolean; masked?: string }>;
  };
  fields: {
    key: string;
    label: string;
    placeholder: string;
    secret?: boolean;
  }[];
  isExpanded: boolean;
  showingInstructions: boolean;
  onToggleExpand: () => void;
  onToggleInstructions: () => void;
  onSaved: () => void;
}) {
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    setSaveResult(null);
    try {
      await saveKmsCredentials(meta.id, formValues);
      setSaveResult({ ok: true, message: "Credentials saved!" });
      setFormValues({});
      onSaved();
    } catch (err) {
      setSaveResult({
        ok: false,
        message:
          err instanceof Error ? err.message : "Failed to save credentials",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    try {
      await removeKmsCredentials(meta.id);
      setConfirmRemove(false);
      onSaved();
    } catch {
      // silent
    } finally {
      setRemoving(false);
    }
  };

  const hasAnyValue = Object.values(formValues).some((v) => v.trim());

  return (
    <section className="card space-y-0 overflow-hidden">
      {/* Header — always visible */}
      <button
        onClick={onToggleExpand}
        className="flex w-full items-center gap-4 text-left py-1 -my-1"
      >
        <div
          className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg text-sm font-bold ${meta.color}`}
        >
          {meta.initial}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-gray-900">{meta.name}</p>
            {isConfigured && (
              <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2 py-0.5 text-[11px] font-medium text-green-700">
                <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                Connected
              </span>
            )}
            {configStatus?.source === "environment" && isConfigured && (
              <span className="text-[11px] text-gray-400">via environment</span>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-0.5">{meta.tagline}</p>
        </div>
        <svg
          className={`h-5 w-5 flex-shrink-0 text-gray-400 transition-transform ${
            isExpanded ? "rotate-180" : ""
          }`}
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M19.5 8.25l-7.5 7.5-7.5-7.5"
          />
        </svg>
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div className="mt-4 space-y-4 border-t border-gray-100 pt-4">
          {/* Description */}
          <p className="text-sm text-gray-600 leading-relaxed">
            {meta.description}
          </p>

          {/* Step-by-step instructions toggle */}
          <button
            onClick={onToggleInstructions}
            className="flex items-center gap-2 text-sm font-medium text-brand-600 hover:text-brand-700"
          >
            <svg
              className={`h-4 w-4 transition-transform ${
                showingInstructions ? "rotate-90" : ""
              }`}
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M8.25 4.5l7.5 7.5-7.5 7.5"
              />
            </svg>
            How to set this up (step by step)
          </button>

          {showingInstructions && (
            <div className="rounded-lg bg-gray-50 p-4">
              <ol className="space-y-2">
                {meta.instructions.map((step, i) => (
                  <li key={i} className="flex gap-3 text-sm text-gray-700">
                    <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-brand-100 text-[11px] font-bold text-brand-700 mt-0.5">
                      {i + 1}
                    </span>
                    <span className="leading-relaxed">{step}</span>
                  </li>
                ))}
              </ol>
              <a
                href={meta.learnMoreUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex items-center gap-1 text-sm text-brand-600 hover:underline"
              >
                Read the full documentation
                <svg
                  className="h-3.5 w-3.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
                  />
                </svg>
              </a>
            </div>
          )}

          {/* Current status for each field */}
          {configStatus && configStatus.configured && (
            <div className="rounded-lg border border-green-100 bg-green-50/50 p-4 space-y-2">
              <p className="text-xs font-medium text-green-800 uppercase tracking-wide">
                Current credentials
              </p>
              {fields.map((field) => {
                const fieldStatus = configStatus.fields[field.key];
                return (
                  <div
                    key={field.key}
                    className="flex items-center justify-between text-sm"
                  >
                    <span className="text-gray-600">{field.label}</span>
                    {fieldStatus?.set ? (
                      <span className="font-mono text-xs text-green-700">
                        {fieldStatus.masked}
                      </span>
                    ) : (
                      <span className="text-xs text-gray-400">Not set</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Credential form */}
          <div className="space-y-3">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
              {isConfigured ? "Update credentials" : "Enter your credentials"}
            </p>
            {fields.map((field) => (
              <div key={field.key}>
                <label
                  htmlFor={`kms-${meta.id}-${field.key}`}
                  className="block text-sm font-medium text-gray-700 mb-1"
                >
                  {field.label}
                </label>
                <input
                  id={`kms-${meta.id}-${field.key}`}
                  type={field.secret ? "password" : "text"}
                  value={formValues[field.key] ?? ""}
                  onChange={(e) =>
                    setFormValues((prev) => ({
                      ...prev,
                      [field.key]: e.target.value,
                    }))
                  }
                  placeholder={field.placeholder}
                  className="input-field max-w-lg font-mono text-sm"
                  autoComplete="off"
                />
              </div>
            ))}

            <div className="flex items-center gap-3 pt-1">
              <button
                onClick={handleSave}
                disabled={saving || !hasAnyValue}
                className="btn-primary text-sm"
              >
                {saving
                  ? "Saving..."
                  : isConfigured
                    ? "Update Credentials"
                    : "Connect"}
              </button>

              {isConfigured &&
                configStatus?.source === "dashboard" &&
                !confirmRemove && (
                  <button
                    onClick={() => setConfirmRemove(true)}
                    className="text-sm text-red-600 hover:text-red-700 hover:underline"
                  >
                    Disconnect
                  </button>
                )}
            </div>

            {/* Confirm remove */}
            {confirmRemove && (
              <div className="rounded-lg border border-red-100 bg-red-50 p-4 space-y-3">
                <p className="text-sm text-red-800">
                  This will remove the saved credentials for {meta.name}. Any
                  secret references using{" "}
                  <code className="font-mono text-xs">{meta.id}://</code> will
                  stop working.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={handleRemove}
                    disabled={removing}
                    className="btn-danger text-sm"
                  >
                    {removing ? "Removing..." : "Yes, disconnect"}
                  </button>
                  <button
                    onClick={() => setConfirmRemove(false)}
                    className="btn-secondary text-sm"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Save feedback */}
            {saveResult && (
              <p
                className={`text-sm ${
                  saveResult.ok ? "text-green-600" : "text-red-600"
                }`}
              >
                {saveResult.message}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Reference format example row                                        */
/* ------------------------------------------------------------------ */

function RefExample({
  scheme,
  example,
  description,
}: {
  scheme: string;
  example: string;
  description: string;
}) {
  return (
    <div className="rounded-lg bg-gray-50 px-4 py-3">
      <code className="text-sm font-mono font-medium text-brand-700">
        {scheme}
      </code>
      <p className="mt-1 text-xs text-gray-500">{description}</p>
      <p className="mt-1.5 text-xs text-gray-400">
        Example:{" "}
        <code className="rounded bg-white px-1.5 py-0.5 text-gray-600">
          {example}
        </code>
      </p>
    </div>
  );
}
