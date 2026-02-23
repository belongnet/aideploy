"use client";

import { useEffect, useState, useCallback } from "react";
import {
  fetchConfig,
  updateConfig,
  pruneNow,
  restartAgent,
  clearData,
  exportData,
  shutDown,
} from "@/lib/api";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Config {
  name: string;
  personality: string;
  modelProvider: string;
  model: string;
  authMethod: string;
  connectedAs: string | null;
  pruneEnabled: boolean;
  pruneAfterDays: number;
  pruneKeepStarred: boolean;
  serverInfo: {
    ip: string;
    tailscaleIp: string;
    provider: string;
    region: string;
  };
}

/* Model options by provider */
const MODEL_OPTIONS: Record<
  string,
  { value: string; label: string; note?: string }[]
> = {
  openai: [
    { value: "gpt-5.3-codex", label: "GPT-5.3 Codex", note: "OAuth" },
    { value: "gpt-5.2", label: "GPT-5.2", note: "OAuth / API key" },
    { value: "gpt-5.1", label: "GPT-5.1", note: "OAuth / API key" },
    { value: "gpt-5-mini", label: "GPT-5 Mini", note: "API key only" },
    { value: "gpt-4o", label: "GPT-4o", note: "API key only" },
  ],
  anthropic: [
    { value: "claude-opus-4-6", label: "Claude Opus 4.6" },
    { value: "claude-sonnet-4", label: "Claude Sonnet 4" },
  ],
  gemini: [
    { value: "gemini-3-deep-think", label: "Gemini 3 Deep Think" },
    { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  ],
  kimi: [
    { value: "kimi-k2.5", label: "Kimi K2.5" },
    { value: "kimi-k2", label: "Kimi K2" },
  ],
};

/* Provider display labels (zero-jargon: user-facing names) */
const PROVIDER_LABELS: Record<string, string> = {
  openai: "ChatGPT",
  anthropic: "Claude",
  gemini: "Gemini",
  kimi: "Kimi",
};

/* Prune day options */
const PRUNE_DAY_OPTIONS = [30, 60, 90, 180, 365];

/* ------------------------------------------------------------------ */
/*  Settings Page                                                      */
/* ------------------------------------------------------------------ */

export default function SettingsPage() {
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  /* Form state — mirrors config for edits */
  const [name, setName] = useState("");
  const [personality, setPersonality] = useState("");
  const [model, setModel] = useState("");
  const [pruneEnabled, setPruneEnabled] = useState(false);
  const [pruneAfterDays, setPruneAfterDays] = useState(90);
  const [pruneKeepStarred, setPruneKeepStarred] = useState(true);

  /* Danger zone confirmation dialogs */
  const [confirmAction, setConfirmAction] = useState<string | null>(null);
  const [dangerLoading, setDangerLoading] = useState(false);

  /* Prune now feedback */
  const [pruneResult, setPruneResult] = useState<number | null>(null);
  const [pruning, setPruning] = useState(false);

  /* ---------------------------------------------------------------- */
  /*  Data loading                                                     */
  /* ---------------------------------------------------------------- */

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchConfig();
      setConfig(data as Config);
      setName(data.name);
      setPersonality(data.personality);
      setModel(data.model);
      setPruneEnabled(data.pruneEnabled);
      setPruneAfterDays(data.pruneAfterDays);
      setPruneKeepStarred(data.pruneKeepStarred);
    } catch {
      /* Silent fail */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /* ---------------------------------------------------------------- */
  /*  Save settings                                                    */
  /* ---------------------------------------------------------------- */

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await updateConfig({
        name,
        personality,
        model,
        pruneEnabled,
        pruneAfterDays,
        pruneKeepStarred,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      /* Silent fail */
    } finally {
      setSaving(false);
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Conversation cleanup actions                                     */
  /* ---------------------------------------------------------------- */

  const handlePruneNow = async () => {
    setPruning(true);
    setPruneResult(null);
    try {
      const result = await pruneNow();
      setPruneResult(result.deleted);
    } catch {
      /* Silent fail */
    } finally {
      setPruning(false);
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Danger zone actions                                              */
  /* ---------------------------------------------------------------- */

  const handleDangerAction = async (action: string) => {
    setDangerLoading(true);
    try {
      switch (action) {
        case "restart":
          await restartAgent();
          break;
        case "clear":
          await clearData();
          break;
        case "export":
          const result = await exportData();
          if (result.url) window.open(result.url, "_blank");
          break;
        case "shutdown":
          await shutDown();
          break;
      }
      setConfirmAction(null);
    } catch {
      /* Silent fail */
    } finally {
      setDangerLoading(false);
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Loading state                                                    */
  /* ---------------------------------------------------------------- */

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-40 rounded bg-gray-200" />
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-32 rounded-xl bg-gray-200" />
        ))}
      </div>
    );
  }

  if (!config) {
    return (
      <div className="card flex flex-col items-center justify-center py-12 text-center">
        <p className="text-sm text-gray-500">
          Could not load settings. Make sure your agent is running.
        </p>
        <button onClick={load} className="btn-primary mt-4 text-sm">
          Try Again
        </button>
      </div>
    );
  }

  const providerLabel = PROVIDER_LABELS[config.modelProvider] ?? config.modelProvider;
  const models = MODEL_OPTIONS[config.modelProvider] ?? [];

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="mt-1 text-sm text-gray-500">
            Configure how your agent works.
          </p>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="btn-primary"
        >
          {saving ? "Saving..." : saved ? "Saved!" : "Save Changes"}
        </button>
      </div>

      {/* ============================================================ */}
      {/*  Section: Agent Identity                                      */}
      {/* ============================================================ */}
      <section className="card space-y-4">
        <h2 className="section-title">Agent Identity</h2>

        {/* Agent name */}
        <div>
          <label
            htmlFor="agent-name"
            className="block text-sm font-medium text-gray-700 mb-1.5"
          >
            Agent name
          </label>
          <input
            id="agent-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Agent"
            className="input-field max-w-md"
          />
          <p className="mt-1 text-xs text-gray-400">
            This is how your agent introduces itself.
          </p>
        </div>

        {/* Personality prompt */}
        <div>
          <label
            htmlFor="personality"
            className="block text-sm font-medium text-gray-700 mb-1.5"
          >
            Personality
          </label>
          <textarea
            id="personality"
            rows={4}
            value={personality}
            onChange={(e) => setPersonality(e.target.value)}
            placeholder="Describe how your agent should behave. For example: 'Be friendly and helpful. Keep responses concise. Always ask follow-up questions.'"
            className="input-field resize-none"
          />
          <p className="mt-1 text-xs text-gray-400">
            Tell your agent how to talk and what kind of personality to have.
          </p>
        </div>
      </section>

      {/* ============================================================ */}
      {/*  Section: AI Account                                          */}
      {/* ============================================================ */}
      <section className="card space-y-4">
        <h2 className="section-title">AI Account</h2>

        {/* Connection status */}
        <div className="rounded-lg bg-gray-50 p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-100 text-brand-700 text-sm font-bold">
              {providerLabel.charAt(0)}
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
          {models.length > 0 ? (
            <select
              id="model-picker"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="input-field max-w-md"
            >
              {models.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}{m.note ? ` (${m.note})` : ""}
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
          <p className="mt-1 text-xs text-gray-400">
            The AI model your agent uses to respond.
            {config.modelProvider === "openai" && (
              <> OAuth (ChatGPT subscription) supports Codex, 5.2, and 5.1. API key supports all models.</>
            )}
          </p>
        </div>
      </section>

      {/* ============================================================ */}
      {/*  Section: Conversation Cleanup                                */}
      {/* ============================================================ */}
      <section className="card space-y-4">
        <h2 className="section-title">Conversation Cleanup</h2>
        <p className="text-sm text-gray-500">
          Automatically remove old conversations to save space.
        </p>

        {/* Enable toggle */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-700">
              Automatically clean up old conversations
            </p>
            <p className="text-xs text-gray-400 mt-0.5">
              Conversations older than the selected period will be removed.
            </p>
          </div>
          <button
            onClick={() => setPruneEnabled(!pruneEnabled)}
            className={`toggle-track ${
              pruneEnabled ? "bg-brand-600" : "bg-gray-200"
            }`}
            role="switch"
            aria-checked={pruneEnabled}
            aria-label="Toggle automatic cleanup"
          >
            <span
              className={`toggle-knob ${
                pruneEnabled ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
        </div>

        {/* Days slider — only shown when enabled */}
        {pruneEnabled && (
          <>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Keep conversations for
              </label>
              <div className="flex flex-wrap gap-2">
                {PRUNE_DAY_OPTIONS.map((days) => (
                  <button
                    key={days}
                    onClick={() => setPruneAfterDays(days)}
                    className={`
                      rounded-lg px-4 py-2 text-sm font-medium transition min-h-touch
                      ${
                        pruneAfterDays === days
                          ? "bg-brand-600 text-white shadow-sm"
                          : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                      }
                    `}
                  >
                    {days < 365 ? `${days} days` : "1 year"}
                  </button>
                ))}
              </div>
            </div>

            {/* Keep starred checkbox */}
            <label className="flex items-center gap-3 cursor-pointer min-h-touch">
              <input
                type="checkbox"
                checked={pruneKeepStarred}
                onChange={(e) => setPruneKeepStarred(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
              />
              <span className="text-sm text-gray-700">
                Keep starred conversations forever
              </span>
            </label>

            {/* Clean up now */}
            <div className="flex items-center gap-3 pt-1">
              <button
                onClick={handlePruneNow}
                disabled={pruning}
                className="btn-secondary text-sm"
              >
                {pruning ? "Cleaning up..." : "Clean Up Now"}
              </button>
              {pruneResult !== null && (
                <span className="text-xs text-green-600">
                  {pruneResult === 0
                    ? "Nothing to clean up!"
                    : `Removed ${pruneResult} old conversation${pruneResult === 1 ? "" : "s"}.`}
                </span>
              )}
            </div>
          </>
        )}
      </section>

      {/* ============================================================ */}
      {/*  Section: Infrastructure                                      */}
      {/* ============================================================ */}
      <section className="card space-y-3">
        <h2 className="section-title">Server Information</h2>

        <div className="grid gap-3 sm:grid-cols-2">
          <InfoRow label="Server address" value={config.serverInfo.ip} />
          <InfoRow
            label="Private network address"
            value={config.serverInfo.tailscaleIp}
          />
          <InfoRow
            label="Cloud provider"
            value={
              config.serverInfo.provider === "digitalocean"
                ? "DigitalOcean"
                : config.serverInfo.provider === "gcp"
                ? "Google Cloud"
                : config.serverInfo.provider === "azure"
                ? "Azure"
                : config.serverInfo.provider === "aws"
                ? "AWS"
                : config.serverInfo.provider
            }
          />
          <InfoRow label="Region" value={config.serverInfo.region} />
        </div>
      </section>

      {/* ============================================================ */}
      {/*  Section: Danger Zone                                         */}
      {/* ============================================================ */}
      <section className="card border-red-200 space-y-3">
        <h2 className="text-lg font-semibold text-red-700">Danger Zone</h2>
        <p className="text-sm text-gray-500">
          These actions are permanent and cannot be undone.
        </p>

        <div className="space-y-3 pt-1">
          {/* Restart */}
          <DangerAction
            label="Restart agent"
            description="Stops and starts your agent. Active conversations will be briefly interrupted."
            buttonText="Restart"
            confirmText="This will restart your agent. Active conversations will be interrupted for a few seconds."
            actionKey="restart"
            confirmAction={confirmAction}
            setConfirmAction={setConfirmAction}
            dangerLoading={dangerLoading}
            onConfirm={handleDangerAction}
            variant="warning"
          />

          {/* Export */}
          <DangerAction
            label="Export all data"
            description="Download all conversations, tasks, and settings as a file."
            buttonText="Export"
            confirmText="This will create a downloadable file with all your agent's data."
            actionKey="export"
            confirmAction={confirmAction}
            setConfirmAction={setConfirmAction}
            dangerLoading={dangerLoading}
            onConfirm={handleDangerAction}
            variant="safe"
          />

          {/* Clear data */}
          <DangerAction
            label="Clear all data"
            description="Permanently delete all conversations, messages, and analytics. Tasks and settings are kept."
            buttonText="Clear Data"
            confirmText="This will permanently delete ALL conversations and messages. This cannot be undone. Tasks and settings will be kept."
            actionKey="clear"
            confirmAction={confirmAction}
            setConfirmAction={setConfirmAction}
            dangerLoading={dangerLoading}
            onConfirm={handleDangerAction}
            variant="danger"
          />

          {/* Shut down */}
          <DangerAction
            label="Shut down agent"
            description="Completely stop your agent. It will not respond to any messages until started again from the master dashboard."
            buttonText="Shut Down"
            confirmText="This will completely stop your agent. It will not respond to any messages. You will need to restart it from the main dashboard."
            actionKey="shutdown"
            confirmAction={confirmAction}
            setConfirmAction={setConfirmAction}
            dangerLoading={dangerLoading}
            onConfirm={handleDangerAction}
            variant="danger"
          />
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

/** Inline info row for infrastructure section */
function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-gray-50 px-4 py-3">
      <p className="text-[11px] text-gray-500 uppercase tracking-wide">
        {label}
      </p>
      <p className="mt-0.5 text-sm font-medium text-gray-900 font-mono">
        {value}
      </p>
    </div>
  );
}

/** Danger zone action row with inline confirmation dialog */
function DangerAction({
  label,
  description,
  buttonText,
  confirmText,
  actionKey,
  confirmAction,
  setConfirmAction,
  dangerLoading,
  onConfirm,
  variant,
}: {
  label: string;
  description: string;
  buttonText: string;
  confirmText: string;
  actionKey: string;
  confirmAction: string | null;
  setConfirmAction: (v: string | null) => void;
  dangerLoading: boolean;
  onConfirm: (key: string) => void;
  variant: "safe" | "warning" | "danger";
}) {
  const isOpen = confirmAction === actionKey;

  const buttonClass =
    variant === "danger"
      ? "btn-danger text-sm"
      : variant === "warning"
      ? "inline-flex items-center justify-center rounded-lg border border-yellow-300 bg-yellow-50 px-4 py-2.5 text-sm font-medium text-yellow-700 shadow-sm transition hover:bg-yellow-100 min-h-touch"
      : "btn-secondary text-sm";

  return (
    <div className="rounded-lg border border-gray-200 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium text-gray-900">{label}</p>
          <p className="text-xs text-gray-500 mt-0.5">{description}</p>
        </div>
        {!isOpen && (
          <button
            onClick={() => setConfirmAction(actionKey)}
            className={buttonClass}
          >
            {buttonText}
          </button>
        )}
      </div>

      {/* Confirmation dialog (inline) */}
      {isOpen && (
        <div className="mt-3 rounded-lg border border-red-100 bg-red-50 p-4 space-y-3">
          <p className="text-sm text-red-800">{confirmText}</p>
          <div className="flex gap-2">
            <button
              onClick={() => onConfirm(actionKey)}
              disabled={dangerLoading}
              className="btn-danger text-sm"
            >
              {dangerLoading
                ? "Please wait..."
                : `Yes, ${buttonText.toLowerCase()}`}
            </button>
            <button
              onClick={() => setConfirmAction(null)}
              disabled={dangerLoading}
              className="btn-secondary text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
