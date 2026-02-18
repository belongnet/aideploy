"use client";

/**
 * First-run setup page for AI provider authentication.
 *
 * After the provisioner deploys the stack, consumer-login AI providers
 * (OpenAI/Anthropic) need the user to sign in on their own server.
 * This page guides them through extracting a session token for each
 * provider and stores it locally in Postgres. The token never leaves
 * the user's VM.
 *
 * For OpenAI: user signs into chatgpt.com, visits the session endpoint,
 * copies the accessToken, and pastes it here.
 *
 * For Anthropic: user signs into claude.ai, opens DevTools cookies,
 * copies the sessionKey, and pastes it here.
 */

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { fetchSetupStatus, submitProviderToken, completeSetup } from "@/lib/api";

/* ------------------------------------------------------------------ */
/*  Provider setup instructions                                        */
/* ------------------------------------------------------------------ */

const PROVIDER_SETUP: Record<
  string,
  {
    label: string;
    color: string;
    loginUrl: string;
    loginLabel: string;
    steps: string[];
    placeholder: string;
  }
> = {
  openai: {
    label: "ChatGPT",
    color: "#10A37F",
    loginUrl: "https://chatgpt.com/auth/login",
    loginLabel: "Open ChatGPT",
    steps: [
      "Click the button below to open ChatGPT and sign in",
      "After signing in, visit chatgpt.com/api/auth/session in the same browser",
      'Copy the accessToken value (the long string after "accessToken":")',
      "Paste it below and click Connect",
    ],
    placeholder: "Paste your accessToken here",
  },
  anthropic: {
    label: "Claude",
    color: "#D4A574",
    loginUrl: "https://claude.ai/login",
    loginLabel: "Open Claude",
    steps: [
      "Click the button below to open Claude and sign in",
      "Open your browser DevTools (F12 or Cmd+Option+I)",
      "Go to Application > Cookies > claude.ai and copy the sessionKey value",
      "Paste it below and click Connect",
    ],
    placeholder: "Paste your sessionKey here",
  },
};

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ProviderStatus {
  id: string;
  name: string;
  authMethod: "consumer" | "api_key";
  connected: boolean;
}

/* ------------------------------------------------------------------ */
/*  Setup Page                                                         */
/* ------------------------------------------------------------------ */

export default function SetupPage() {
  const router = useRouter();
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [tokenInputs, setTokenInputs] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [finishing, setFinishing] = useState(false);

  /** Load setup status */
  const loadStatus = useCallback(async () => {
    try {
      const data = await fetchSetupStatus();
      if (!data.setupRequired) {
        router.replace("/");
        return;
      }
      setProviders(data.providers);
    } catch {
      /* Agent may not be ready yet */
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  /** Submit token for a provider */
  const handleConnect = useCallback(
    async (providerId: string) => {
      const token = (tokenInputs[providerId] || "").trim();
      if (!token) return;

      setSubmitting((prev) => ({ ...prev, [providerId]: true }));
      setErrors((prev) => {
        const next = { ...prev };
        delete next[providerId];
        return next;
      });

      try {
        const result = await submitProviderToken(providerId, token);
        if (result.ok) {
          setProviders((prev) =>
            prev.map((p) =>
              p.id === providerId ? { ...p, connected: true } : p
            )
          );
        } else {
          setErrors((prev) => ({
            ...prev,
            [providerId]: "Token is invalid or expired. Please try again.",
          }));
        }
      } catch {
        setErrors((prev) => ({
          ...prev,
          [providerId]: "Could not connect. Please try again.",
        }));
      } finally {
        setSubmitting((prev) => ({ ...prev, [providerId]: false }));
      }
    },
    [tokenInputs]
  );

  /** All consumer providers connected — finish setup */
  const consumerProviders = providers.filter((p) => p.authMethod === "consumer");
  const allConnected = consumerProviders.length > 0 && consumerProviders.every((p) => p.connected);

  const handleFinish = useCallback(async () => {
    setFinishing(true);
    try {
      await completeSetup();
      router.replace("/");
    } catch {
      setFinishing(false);
    }
  }, [router]);

  /* ---------------------------------------------------------------- */
  /*  Loading state                                                    */
  /* ---------------------------------------------------------------- */

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center space-y-4">
          <div className="w-10 h-10 border-4 border-gray-200 border-t-brand-600 rounded-full animate-spin mx-auto" />
          <p className="text-sm text-gray-500">Checking setup status...</p>
        </div>
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      {/* Header */}
      <div className="text-center space-y-2">
        <h1 className="text-2xl font-bold text-gray-900">
          Connect your AI accounts
        </h1>
        <p className="text-sm text-gray-500 leading-relaxed max-w-md mx-auto">
          Sign into your AI subscriptions below. Your credentials are stored
          locally on this server and never leave your machine.
        </p>
      </div>

      {/* Provider cards */}
      <div className="space-y-5">
        {consumerProviders.map((provider) => {
          const setup = PROVIDER_SETUP[provider.id];
          if (!setup) return null;

          const isConnected = provider.connected;
          const isSubmitting = submitting[provider.id] === true;

          return (
            <div
              key={provider.id}
              className={`rounded-2xl border p-6 transition-all ${
                isConnected
                  ? "border-green-200 bg-green-50"
                  : "border-gray-200 bg-white"
              }`}
            >
              {/* Provider header */}
              <div className="flex items-center gap-3 mb-4">
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold text-sm"
                  style={{ backgroundColor: setup.color }}
                >
                  {setup.label.charAt(0)}
                </div>
                <div className="flex-1">
                  <h2 className="text-base font-semibold text-gray-900">
                    {setup.label}
                  </h2>
                  <p className="text-xs text-gray-500">
                    Uses your {setup.label} subscription
                  </p>
                </div>
                {isConnected && (
                  <div className="flex items-center gap-1.5 text-green-700">
                    <svg
                      className="w-5 h-5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2.5}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                    <span className="text-sm font-medium">Connected</span>
                  </div>
                )}
              </div>

              {/* Setup steps — only shown when not connected */}
              {!isConnected && (
                <div className="space-y-4">
                  {/* Steps */}
                  <ol className="space-y-2">
                    {setup.steps.map((step, i) => (
                      <li
                        key={i}
                        className="flex items-start gap-3 text-sm text-gray-600"
                      >
                        <span
                          className="flex-shrink-0 w-5 h-5 rounded-full text-white text-xs font-semibold
                                     flex items-center justify-center mt-0.5"
                          style={{ backgroundColor: setup.color }}
                        >
                          {i + 1}
                        </span>
                        <span>{step}</span>
                      </li>
                    ))}
                  </ol>

                  {/* Open provider button */}
                  <a
                    href={setup.loginUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center gap-2 w-full py-3 rounded-xl
                               font-medium text-sm text-white transition-all"
                    style={{ backgroundColor: setup.color }}
                  >
                    {setup.loginLabel}
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                      />
                    </svg>
                  </a>

                  {/* Token input */}
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      type="password"
                      value={tokenInputs[provider.id] || ""}
                      onChange={(e) =>
                        setTokenInputs((prev) => ({
                          ...prev,
                          [provider.id]: e.target.value,
                        }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleConnect(provider.id);
                      }}
                      placeholder={setup.placeholder}
                      className={`flex-1 px-4 py-2.5 rounded-xl border text-sm outline-none transition-all
                        focus:ring-2 focus:ring-brand-500 focus:border-brand-500
                        ${errors[provider.id] ? "border-red-300 bg-red-50" : "border-gray-300 bg-white"}
                      `}
                    />
                    <button
                      onClick={() => handleConnect(provider.id)}
                      disabled={
                        isSubmitting ||
                        !(tokenInputs[provider.id] || "").trim()
                      }
                      className="px-5 py-2.5 bg-gray-900 text-white text-sm font-medium
                                 rounded-xl hover:bg-gray-800 transition-all
                                 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
                    >
                      {isSubmitting ? "Verifying..." : "Connect"}
                    </button>
                  </div>

                  {/* Error */}
                  {errors[provider.id] && (
                    <p className="text-sm text-red-600">{errors[provider.id]}</p>
                  )}

                  {/* Privacy note */}
                  <p className="text-xs text-gray-400">
                    This token is stored locally on this server and never sent anywhere else.
                  </p>
                </div>
              )}
            </div>
          );
        })}

        {/* API key providers — show as already connected */}
        {providers
          .filter((p) => p.authMethod === "api_key")
          .map((provider) => (
            <div
              key={provider.id}
              className="rounded-2xl border border-green-200 bg-green-50 p-6"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-green-600 flex items-center justify-center text-white font-bold text-sm">
                  {provider.name.charAt(0)}
                </div>
                <div className="flex-1">
                  <h2 className="text-base font-semibold text-gray-900">
                    {provider.name}
                  </h2>
                  <p className="text-xs text-green-700">
                    Connected with API key
                  </p>
                </div>
                <svg
                  className="w-5 h-5 text-green-700"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              </div>
            </div>
          ))}
      </div>

      {/* Continue button */}
      <div className="pt-2">
        <button
          onClick={handleFinish}
          disabled={!allConnected || finishing}
          className="w-full py-4 rounded-2xl font-bold text-white text-lg
                     bg-brand-600 hover:bg-brand-700
                     transition-all duration-200
                     disabled:opacity-40 disabled:cursor-not-allowed
                     shadow-lg hover:shadow-xl"
        >
          {finishing ? "Setting up..." : "Continue to Dashboard"}
        </button>
        {!allConnected && consumerProviders.length > 0 && (
          <p className="text-center text-xs text-gray-400 mt-3">
            Connect all AI accounts above to continue
          </p>
        )}
      </div>
    </div>
  );
}
