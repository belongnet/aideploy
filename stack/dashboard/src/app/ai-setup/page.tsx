"use client";

import { useEffect, useState, useCallback } from "react";
import {
  fetchConfig,
  updateConfig,
  fetchSetupStatus,
  startProviderConnect,
  submitProviderConnect,
  fetchProviderConnectSession,
  cancelProviderConnect,
  type ProviderConnectSession,
} from "@/lib/api";

/* ------------------------------------------------------------------ */
/*  Provider display metadata                                          */
/* ------------------------------------------------------------------ */

const PROVIDER_META: Record<
  string,
  {
    label: string;
    color: string;
    icon: string;
    description: string;
    hint: string;
    buttonLabel: string;
    steps: string[];
  }
> = {
  openai: {
    label: "ChatGPT",
    color: "#10A37F",
    icon: "C",
    description:
      "ChatGPT is made by OpenAI. When you connect your ChatGPT account, your agent can use GPT models to understand messages and write responses.",
    hint: "Click the button to get a sign-in link. Open it in your browser, sign in with your ChatGPT account, then come back here and paste what you see.",
    buttonLabel: "New Browser Link",
    steps: [
      "Click the button below to get a one-time sign-in link",
      "Open that link in your browser and sign in with your ChatGPT account",
      'When you see a page that says "localhost" in the address bar, copy everything in the address bar',
      "Paste it below to finish the connection",
    ],
  },
  anthropic: {
    label: "Claude",
    color: "#D4A574",
    icon: "Cl",
    description:
      "Claude is made by Anthropic. When you connect your Claude account, Aideploy routes Claude traffic through its local billing proxy so the agent can keep using Claude models on your plan.",
    hint: "Click the button to get a sign-in link. Open it in your browser, sign in with your Claude account, then come back here and paste what you see.",
    buttonLabel: "New Browser Link",
    steps: [
      "Click the button below to get a one-time sign-in link",
      "Open that link in your browser and sign in with your Claude account",
      "After signing in, Claude will show you a code or redirect you to a page \u2014 copy whatever you see",
      "Paste it below to finish the connection",
    ],
  },
  gemini: {
    label: "Gemini",
    color: "#4285F4",
    icon: "G",
    description:
      "Gemini is made by Google. It connects via an API key, so there's no browser sign-in needed.",
    hint: "",
    buttonLabel: "",
    steps: [],
  },
  kimi: {
    label: "Kimi",
    color: "#6C5CE7",
    icon: "K",
    description:
      "Kimi is made by Moonshot AI. It connects via an API key, so there's no browser sign-in needed.",
    hint: "",
    buttonLabel: "",
    steps: [],
  },
};

/* Model options by provider */
const MODEL_OPTIONS: Record<
  string,
  { value: string; label: string; note?: string }[]
> = {
  openai: [
    { value: "gpt-5.5", label: "GPT-5.5", note: "OAuth" },
    { value: "gpt-5.4", label: "GPT-5.4", note: "OAuth / API key" },
    { value: "gpt-5.4-mini", label: "GPT-5.4 Mini", note: "OAuth / API key" },
    { value: "gpt-5.3-codex", label: "GPT-5.3 Codex", note: "OAuth / API key" },
    { value: "gpt-5.2", label: "GPT-5.2", note: "OAuth / API key" },
    { value: "gpt-5.1", label: "GPT-5.1", note: "OAuth / API key" },
  ],
  anthropic: [
    { value: "claude-opus-4-8", label: "Claude Opus 4.8" },
    { value: "claude-sonnet-4", label: "Claude Sonnet 4" },
  ],
  gemini: [
    { value: "gemini-3-deep-think", label: "Gemini 3 Deep Think" },
    { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  ],
  kimi: [
    { value: "kimi-k2.6", label: "Kimi K2.6" },
    { value: "kimi-k2", label: "Kimi K2" },
  ],
};

const PROVIDER_LABELS: Record<string, string> = {
  openai: "ChatGPT",
  anthropic: "Claude",
  gemini: "Gemini",
  kimi: "Kimi",
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

interface Config {
  modelProvider: string;
  model: string;
  authMethod: string;
  connectedAs: string | null;
}

function extractSessionError(session: ProviderConnectSession | null): string {
  const lines = (session?.logs || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines[lines.length - 1] || "Could not complete the connection. Try again."
  );
}

/* ------------------------------------------------------------------ */
/*  AI Setup Page                                                      */
/* ------------------------------------------------------------------ */

export default function AiSetupPage() {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [model, setModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  /* Connect flow state */
  const [draftInputs, setDraftInputs] = useState<Record<string, string>>({});
  const [sessions, setSessions] = useState<
    Record<string, ProviderConnectSession | null>
  >({});
  const [submitting, setSubmitting] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  /* ---------------------------------------------------------------- */
  /*  Data loading                                                     */
  /* ---------------------------------------------------------------- */

  const loadStatus = useCallback(async () => {
    try {
      const data = await fetchSetupStatus();
      setProviders(data.providers);
    } catch {
      /* Agent may not be ready */
    }
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const data = await fetchConfig();
      setConfig(data);
      setModel(data.model);
    } catch {
      /* Silent */
    }
  }, []);

  const loadPageData = useCallback(async () => {
    await Promise.all([loadStatus(), loadConfig()]);
  }, [loadConfig, loadStatus]);

  useEffect(() => {
    loadPageData().finally(() => setLoading(false));
  }, [loadPageData]);

  /* Poll active sessions */
  useEffect(() => {
    const activeProviders = Object.entries(sessions).filter(
      ([, session]) =>
        session &&
        (session.status === "running" || session.status === "awaiting_input"),
    );
    if (activeProviders.length === 0) return;

    const interval = window.setInterval(async () => {
      const updates = await Promise.all(
        activeProviders.map(async ([providerId]) => {
          try {
            const result = await fetchProviderConnectSession(
              providerId as "openai" | "anthropic",
            );
            return [providerId, result.session] as const;
          } catch {
            return [providerId, sessions[providerId] ?? null] as const;
          }
        }),
      );

      const nextSessions = Object.fromEntries(updates);
      setSessions((prev) => ({ ...prev, ...nextSessions }));

      const completed = updates.filter(
        ([, session]) => session?.status === "completed",
      );
      if (completed.length > 0) {
        setErrors((prev) => {
          const next = { ...prev };
          completed.forEach(([pid]) => delete next[pid]);
          return next;
        });
        await loadPageData();
      }
    }, 2000);

    return () => window.clearInterval(interval);
  }, [loadPageData, sessions]);

  /* ---------------------------------------------------------------- */
  /*  Connect actions                                                  */
  /* ---------------------------------------------------------------- */

  const handleStartConnect = useCallback(async (providerId: string) => {
    setSubmitting((prev) => ({ ...prev, [providerId]: true }));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[providerId];
      return next;
    });
    try {
      const result = await startProviderConnect(
        providerId as "openai" | "anthropic",
      );
      setSessions((prev) => ({ ...prev, [providerId]: result.session }));
    } catch (error) {
      setErrors((prev) => ({
        ...prev,
        [providerId]:
          error instanceof Error
            ? error.message
            : "Could not start the browser link.",
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
          input,
        );
        setSessions((prev) => ({ ...prev, [providerId]: result.session }));

        if (result.session?.status === "completed") {
          setDraftInputs((prev) => ({ ...prev, [providerId]: "" }));
          await loadPageData();
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
            error instanceof Error
              ? error.message
              : "Could not submit that code.",
        }));
      } finally {
        setSubmitting((prev) => ({ ...prev, [providerId]: false }));
      }
    },
    [draftInputs, loadPageData],
  );

  /* ---------------------------------------------------------------- */
  /*  Save model selection                                             */
  /* ---------------------------------------------------------------- */

  const handleSaveModel = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await updateConfig({ model });
      setConfig((prev) => (prev ? { ...prev, model } : prev));
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      /* Silent */
    } finally {
      setSaving(false);
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Loading state                                                    */
  /* ---------------------------------------------------------------- */

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-48 rounded bg-gray-200" />
        <div className="h-32 rounded-xl bg-gray-200" />
        {[1, 2].map((i) => (
          <div key={i} className="h-40 rounded-xl bg-gray-200" />
        ))}
      </div>
    );
  }

  const providerLabel = config
    ? (PROVIDER_LABELS[config.modelProvider] ?? config.modelProvider)
    : "";
  const models = config ? (MODEL_OPTIONS[config.modelProvider] ?? []) : [];
  const consumerProviders = providers.filter(
    (p) => p.authMethod === "consumer",
  );
  const apiKeyProviders = providers.filter((p) => p.authMethod === "api_key");

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  return (
    <div className="settings-shell">
      {/* Page header */}
      <div>
        <h1 className="page-title">AI Setup</h1>
        <p className="mt-1 text-sm text-gray-500">
          Connect the AI brain that powers your agent&apos;s conversations.
        </p>
      </div>

      {/* Explainer card */}
      <section className="settings-hero">
        <div className="settings-hero-content">
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
                d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z"
              />
            </svg>
          </div>
          <div>
            <h2 className="text-base font-semibold text-gray-900">
              What is an AI provider?
            </h2>
            <p className="mt-1 text-sm text-gray-600 leading-relaxed">
              Your agent needs an <strong>AI service</strong> to understand
              messages and write replies. Think of it like the brain behind your
              agent. You connect your account with one of these services, and
              your agent uses it to have conversations.
            </p>
            <p className="mt-2 text-sm text-gray-600 leading-relaxed">
              Right now there are four options: <strong>ChatGPT</strong> (by
              OpenAI), <strong>Claude</strong> (by Anthropic),{" "}
              <strong>Gemini</strong> (by Google), and <strong>Kimi</strong> (by
              Moonshot AI). Some require you to sign in with your browser, while
              others connect automatically using an API key.
            </p>
            <p className="mt-2 text-sm text-gray-500">
              <strong>You only need one.</strong> If you&apos;re not sure which
              to pick, ChatGPT or Claude are the most popular choices.
            </p>
          </div>
        </div>
      </section>

      {/* ============================================================ */}
      {/*  Current AI account status + model picker                     */}
      {/* ============================================================ */}
      {config && (
        <section className="card space-y-4">
          <h2 className="section-title">Your Current AI</h2>
          <p className="text-sm text-gray-500">
            This is the AI service your agent is currently using. You can change
            which model it uses below.
          </p>

          {/* Connection status */}
          <div className="rounded-lg bg-gray-50 p-4">
            <div className="flex items-center gap-3">
              <div
                className="flex h-10 w-10 items-center justify-center rounded-lg text-white text-sm font-bold"
                style={{
                  backgroundColor:
                    PROVIDER_META[config.modelProvider]?.color ?? "#6366f1",
                }}
              >
                {PROVIDER_META[config.modelProvider]?.icon ??
                  providerLabel.charAt(0)}
              </div>
              <div>
                <p className="text-sm font-medium text-gray-900">
                  {providerLabel}
                </p>
                {config.authMethod === "oauth" && config.connectedAs ? (
                  <p className="text-xs text-green-600">
                    Connected as {config.connectedAs}
                  </p>
                ) : config.authMethod === "api_key" ? (
                  <p className="text-xs text-green-600">
                    Connected with API key
                  </p>
                ) : (
                  <p className="text-xs text-gray-500">Not connected</p>
                )}
              </div>
            </div>
          </div>

          {/* Model picker */}
          <div>
            <label
              htmlFor="model-picker"
              className="block text-sm font-medium text-gray-700 mb-1.5"
            >
              AI model
            </label>
            <p className="text-xs text-gray-400 mb-2">
              Different models have different strengths. More powerful models
              give better answers but may be slower or cost more.
            </p>
            {models.length > 0 ? (
              <select
                id="model-picker"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="input-field max-w-md"
              >
                {models.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                    {m.note ? ` (${m.note})` : ""}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="model-picker"
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="input-field max-w-md"
              />
            )}
          </div>

          <button
            onClick={handleSaveModel}
            disabled={saving || model === config.model}
            className="btn-primary text-sm"
          >
            {saving ? "Saving..." : saved ? "Saved!" : "Save Model Choice"}
          </button>
        </section>
      )}

      {/* ============================================================ */}
      {/*  Connect AI providers (consumer login / OAuth)                 */}
      {/* ============================================================ */}
      {consumerProviders.length > 0 && (
        <section className="space-y-4">
          <div>
            <h2 className="section-title">Connect AI Accounts</h2>
            <p className="text-sm text-gray-500 mt-1">
              These AI services require you to sign in with your browser. Your
              login credentials stay on this server and are never shared.
            </p>
          </div>

          <div className="settings-card-grid">
          {consumerProviders.map((provider) => {
            const meta = PROVIDER_META[provider.id];
            if (!meta) return null;

            const isConnected = provider.connected;
            const isSubmitting = submitting[provider.id] === true;
            const session = sessions[provider.id] ?? null;
            const waitingForInput = session?.status === "awaiting_input";
            const browserLinkReady = Boolean(session?.url);
            const canSubmit = Boolean((draftInputs[provider.id] || "").trim());

            return (
              <div
                key={provider.id}
                className={`card flex h-full flex-col transition-all ${
                  isConnected
                    ? "border-green-200 bg-green-50"
                    : "border-gray-200"
                }`}
              >
                {/* Provider header */}
                <div className="mb-2 flex flex-col gap-3 sm:flex-row sm:items-start">
                  <div
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-sm font-bold text-white shadow-sm"
                    style={{ backgroundColor: meta.color }}
                  >
                    {meta.icon}
                  </div>
                  <div className="flex-1">
                    <h3 className="text-base font-semibold text-gray-900">
                      {meta.label}
                    </h3>
                    <p className="text-xs text-gray-500">{meta.description}</p>
                  </div>
                  {isConnected && (
                    <div className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white/80 px-2.5 py-1 text-green-700 ring-1 ring-green-200">
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

                {/* Connect flow */}
                {!isConnected && (
                  <div className="mt-4 flex flex-1 flex-col space-y-4 border-t border-gray-100 pt-4">
                    <p className="text-xs text-gray-500">{meta.hint}</p>

                    <ol className="space-y-2">
                      {meta.steps.map((step, i) => (
                        <li
                          key={i}
                          className="flex items-start gap-3 text-sm text-gray-600"
                        >
                          <span
                            className="flex-shrink-0 w-5 h-5 rounded-full text-white text-xs font-semibold flex items-center justify-center mt-0.5"
                            style={{ backgroundColor: meta.color }}
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
                      className="mt-auto inline-flex w-full items-center justify-center gap-2 rounded-2xl py-4 text-base font-semibold text-white shadow-lg transition-all hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-50"
                      style={{ backgroundColor: meta.color }}
                    >
                      {isSubmitting ? "Generating link..." : meta.buttonLabel}
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
                          Open this one-time browser link on your own device,
                          then come back here and paste what you see.
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
                          if (e.key === "Enter")
                            handleSubmitConnect(provider.id);
                        }}
                        placeholder={
                          session?.inputPlaceholder ||
                          "Paste what you see in your browser's address bar"
                        }
                        className={`flex-1 px-4 py-2.5 rounded-xl border text-sm outline-none transition-all focus:ring-2 focus:ring-brand-500 focus:border-brand-500 ${
                          errors[provider.id]
                            ? "border-red-300 bg-red-50"
                            : "border-gray-300 bg-white"
                        }`}
                      />
                      <button
                        onClick={() => handleSubmitConnect(provider.id)}
                        disabled={isSubmitting || !canSubmit}
                        className="px-5 py-2.5 bg-gray-900 text-white text-sm font-medium rounded-xl hover:bg-gray-800 transition-all disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
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

                    {errors[provider.id] && (
                      <p className="text-sm text-red-600">
                        {errors[provider.id]}
                      </p>
                    )}

                    <p className="text-xs text-gray-400">
                      If you generate a fresh link, the previous unfinished
                      browser flow is replaced. The final credentials stay on
                      this server.
                    </p>

                    {session &&
                      (session.status === "running" ||
                        session.status === "awaiting_input") && (
                        <button
                          type="button"
                          onClick={async () => {
                            await cancelProviderConnect(
                              provider.id as "openai" | "anthropic",
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
          </div>
        </section>
      )}

      {/* ============================================================ */}
      {/*  API key providers (auto-connected)                           */}
      {/* ============================================================ */}
      {apiKeyProviders.length > 0 && (
        <section className="space-y-4">
          <div>
            <h2 className="section-title">API Key Providers</h2>
            <p className="text-sm text-gray-500 mt-1">
              These AI services were connected automatically using an API key
              during deployment. No action needed.
            </p>
          </div>

          <div className="settings-card-grid">
          {apiKeyProviders.map((provider) => {
            const meta = PROVIDER_META[provider.id];
            return (
              <div
                key={provider.id}
                className="card h-full border-green-200 bg-green-50"
              >
                <div className="flex items-center gap-3">
                  <div
                    className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold text-sm"
                    style={{
                      backgroundColor: meta?.color ?? "#22c55e",
                    }}
                  >
                    {meta?.icon ?? provider.name.charAt(0)}
                  </div>
                  <div className="flex-1">
                    <h3 className="text-base font-semibold text-gray-900">
                      {meta?.label ?? provider.name}
                    </h3>
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
            );
          })}
          </div>
        </section>
      )}
    </div>
  );
}
