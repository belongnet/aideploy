"use client";

/**
 * First-run setup page for AI provider authentication.
 *
 * After the provisioner deploys the stack, consumer-login AI providers
 * (OpenAI/Anthropic) need the user to complete a browser-based
 * connection flow on their own device. This page generates the link,
 * tracks progress, and stores the resulting credentials locally.
 */

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  cancelProviderConnect,
  completeSetup,
  fetchProviderConnectSession,
  fetchSetupStatus,
  startProviderConnect,
  submitProviderConnect,
  type ProviderConnectSession,
} from "@/lib/api";

/* ------------------------------------------------------------------ */
/*  Provider setup instructions                                        */
/* ------------------------------------------------------------------ */

const PROVIDER_SETUP: Record<
  string,
  {
    label: string;
    color: string;
    hint: string;
    buttonLabel: string;
    steps: string[];
  }
> = {
  openai: {
    label: "ChatGPT",
    color: "#10A37F",
    hint:
      "Click the button to get a sign-in link. Open it in your browser, sign in with your ChatGPT account, then come back here and paste what you see.",
    buttonLabel: "New Browser Link",
    steps: [
      "Click the button below to get a one-time sign-in link",
      "Open that link in your browser and sign in with your ChatGPT account",
      "When you see a page that says 'localhost' in the address bar, copy everything in the address bar",
      "Paste it below to finish the connection",
    ],
  },
  anthropic: {
    label: "Claude",
    color: "#D4A574",
    hint:
      "Click the button to get a sign-in link. Open it in your browser, sign in with your Claude account, then come back here and paste what you see. Aideploy will route Claude traffic through its local billing proxy on the gateway.",
    buttonLabel: "New Browser Link",
    steps: [
      "Click the button below to get a one-time sign-in link",
      "Open that link in your browser and sign in with your Claude account",
      "After signing in, Claude will show you a code or redirect you to a page — copy whatever you see",
      "Paste it below to finish the connection",
    ],
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

function extractSessionError(session: ProviderConnectSession | null): string {
  const lines = (session?.logs || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] || "Could not complete the connection. Try again.";
}

/* ------------------------------------------------------------------ */
/*  Setup Page                                                         */
/* ------------------------------------------------------------------ */

export default function SetupPage() {
  const router = useRouter();
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [draftInputs, setDraftInputs] = useState<Record<string, string>>({});
  const [sessions, setSessions] = useState<Record<string, ProviderConnectSession | null>>({});
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

  useEffect(() => {
    const activeProviders = Object.entries(sessions).filter(([, session]) =>
      session &&
      (session.status === "running" || session.status === "awaiting_input")
    );
    if (activeProviders.length === 0) return;

    const interval = window.setInterval(async () => {
      const updates = await Promise.all(
        activeProviders.map(async ([providerId]) => {
          try {
            const result = await fetchProviderConnectSession(
              providerId as "openai" | "anthropic"
            );
            return [providerId, result.session] as const;
          } catch {
            return [providerId, sessions[providerId] ?? null] as const;
          }
        })
      );

      const nextSessions = Object.fromEntries(updates);
      setSessions((prev) => ({ ...prev, ...nextSessions }));

      const completedProviders = updates.filter(([, session]) => session?.status === "completed");
      if (completedProviders.length > 0) {
        setErrors((prev) => {
          const next = { ...prev };
          completedProviders.forEach(([providerId]) => {
            delete next[providerId];
          });
          return next;
        });
        await loadStatus();
      }
    }, 2000);

    return () => window.clearInterval(interval);
  }, [loadStatus, sessions]);

  const handleStartConnect = useCallback(async (providerId: string) => {
    setSubmitting((prev) => ({ ...prev, [providerId]: true }));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[providerId];
      return next;
    });

    try {
      const result = await startProviderConnect(providerId as "openai" | "anthropic");
      setSessions((prev) => ({ ...prev, [providerId]: result.session }));
    } catch (error) {
      setErrors((prev) => ({
        ...prev,
        [providerId]:
          error instanceof Error ? error.message : "Could not start the browser link.",
      }));
    } finally {
      setSubmitting((prev) => ({ ...prev, [providerId]: false }));
    }
  }, []);

  const handleSubmitConnect = useCallback(
    async (providerId: string) => {
      const input = (draftInputs[providerId] || "").trim();
      if (!input) return;

      setSubmitting((prev) => ({ ...prev, [providerId]: true }));
      setErrors((prev) => {
        const next = { ...prev };
        delete next[providerId];
        return next;
      });

      try {
        const result = await submitProviderConnect(
          providerId as "openai" | "anthropic",
          input
        );
        setSessions((prev) => ({ ...prev, [providerId]: result.session }));

        if (result.session?.status === "completed") {
          setDraftInputs((prev) => ({ ...prev, [providerId]: "" }));
          await loadStatus();
        } else if (result.session?.status === "error") {
          setErrors((prev) => ({
            ...prev,
            [providerId]: extractSessionError(result.session),
          }));
        }
      } catch (error) {
        setErrors((prev) => ({
          ...prev,
          [providerId]:
            error instanceof Error ? error.message : "Could not submit that code.",
        }));
      } finally {
        setSubmitting((prev) => ({ ...prev, [providerId]: false }));
      }
    },
    [draftInputs, loadStatus]
  );

  /** All consumer providers connected — finish setup */
  const consumerProviders = providers.filter((p) => p.authMethod === "consumer");
  const allConnected =
    consumerProviders.length > 0 && consumerProviders.every((p) => p.connected);

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
          Generate a browser link, sign in on your own device, then paste the
          returned redirect or code here. Your credentials stay on this server.
        </p>
      </div>

      {/* Provider cards */}
      <div className="space-y-5">
        {consumerProviders.map((provider) => {
          const setup = PROVIDER_SETUP[provider.id];
          if (!setup) return null;

          const isConnected = provider.connected;
          const isSubmitting = submitting[provider.id] === true;
          const session = sessions[provider.id] ?? null;
          const waitingForInput = session?.status === "awaiting_input";
          const browserLinkReady = Boolean(session?.url);
          const canSubmit = Boolean((draftInputs[provider.id] || "").trim());

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
                  <p className="text-xs text-gray-500">{setup.hint}</p>
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

                  <button
                    onClick={() => handleStartConnect(provider.id)}
                    disabled={isSubmitting}
                    className="inline-flex items-center justify-center gap-2 w-full py-4 rounded-2xl
                               font-semibold text-base text-white transition-all shadow-lg hover:shadow-xl
                               disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ backgroundColor: setup.color }}
                  >
                    {isSubmitting ? "Generating link..." : setup.buttonLabel}
                    <svg
                      className="w-5 h-5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M13.5 4.5H19.5M19.5 4.5V10.5M19.5 4.5L9 15"
                      />
                    </svg>
                  </button>

                  {browserLinkReady && (
                    <div className="rounded-2xl border border-brand-100 bg-brand-50 p-4">
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-700">
                        Step 2
                      </p>
                      <p className="mt-2 text-sm text-gray-700">
                        Open this one-time browser link on your own device, then
                        come back here and paste what you see.
                      </p>
                      <a
                        href={session?.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-3 inline-flex w-full items-center justify-center rounded-xl border border-brand-200 bg-white px-4 py-3 text-sm font-medium text-brand-700 transition hover:bg-brand-50"
                      >
                        Open Browser Link
                      </a>
                      <p className="mt-3 break-all rounded-xl bg-white px-3 py-2 text-xs text-gray-500">
                        {session?.url}
                      </p>
                    </div>
                  )}

                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      type="text"
                      value={draftInputs[provider.id] || ""}
                      onChange={(e) =>
                        setDraftInputs((prev) => ({
                          ...prev,
                          [provider.id]: e.target.value,
                        }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleSubmitConnect(provider.id);
                      }}
                      placeholder={
                        session?.inputPlaceholder ||
                        "Paste what you see in your browser's address bar"
                      }
                      className={`flex-1 px-4 py-2.5 rounded-xl border text-sm outline-none transition-all
                        focus:ring-2 focus:ring-brand-500 focus:border-brand-500
                        ${errors[provider.id] ? "border-red-300 bg-red-50" : "border-gray-300 bg-white"}
                      `}
                    />
                    <button
                      onClick={() => handleSubmitConnect(provider.id)}
                      disabled={isSubmitting || !canSubmit}
                      className="px-5 py-2.5 bg-gray-900 text-white text-sm font-medium
                                 rounded-xl hover:bg-gray-800 transition-all
                                 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
                    >
                      {isSubmitting
                        ? "Saving..."
                        : waitingForInput
                          ? "Submit Code"
                          : "Submit"}
                    </button>
                  </div>

                  {session?.logs && (
                    <details className="rounded-2xl bg-gray-950 text-xs text-gray-200">
                      <summary className="px-4 py-3 font-semibold uppercase tracking-[0.18em] text-gray-400 cursor-pointer">
                        Troubleshooting details
                      </summary>
                      <pre className="px-4 pb-3 whitespace-pre-wrap break-words font-mono">
                        {session.logs}
                      </pre>
                    </details>
                  )}

                  {/* Error */}
                  {errors[provider.id] && (
                    <p className="text-sm text-red-600">{errors[provider.id]}</p>
                  )}

                  <p className="text-xs text-gray-400">
                    If you generate a fresh link, the previous unfinished browser
                    flow is replaced. The final credentials stay on this server.
                  </p>

                  {session &&
                    (session.status === "running" || session.status === "awaiting_input") && (
                      <button
                        type="button"
                        onClick={async () => {
                          await cancelProviderConnect(
                            provider.id as "openai" | "anthropic"
                          );
                          setSessions((prev) => ({
                            ...prev,
                            [provider.id]: null,
                          }));
                        }}
                        className="text-sm font-medium text-gray-500 hover:text-gray-700"
                      >
                        Cancel this connect flow
                      </button>
                    )}
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
