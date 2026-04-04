"use client";

import { useEffect, useState, useCallback } from "react";
import {
  fetchChannels,
  addChannel,
  connectTelegramChannel,
  removeChannel,
} from "@/lib/api";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Channel {
  id: string;
  type: string;
  name: string;
  status: string;
  lastActivity: string | null;
}

/* Channel metadata — zero-jargon descriptions */
const CHANNEL_META: Record<
  string,
  {
    label: string;
    color: string;
    bgColor: string;
    description: string;
    setupSteps: string[];
    placeholder: string;
    badge: string;
  }
> = {
  telegram: {
    label: "Telegram",
    color: "text-blue-700",
    bgColor: "bg-blue-100",
    description:
      "The fastest way to talk to your agent. Works on phones and desktop.",
    setupSteps: [
      'Open Telegram and search for "@BotFather".',
      'Send the command "/newbot" and follow the prompts.',
      "BotFather will give you a token (a long string of letters and numbers).",
      "Open your bot in Telegram and send it a private message from the account that should receive setup prompts.",
      "Paste the bot token and that account's private chat ID below.",
    ],
    placeholder: "Paste your Telegram bot token here",
    badge: "Fastest setup",
  },
  whatsapp: {
    label: "WhatsApp",
    color: "text-green-700",
    bgColor: "bg-green-100",
    description:
      "Connect your WhatsApp Business account so people can message your agent on WhatsApp.",
    setupSteps: [
      "Go to the Meta Business Suite (business.facebook.com).",
      'Navigate to Settings then "WhatsApp Accounts".',
      'Find "Temporary access token" and copy it.',
      "Paste the token below.",
    ],
    placeholder: "Paste your WhatsApp access token here",
    badge: "Popular",
  },
  slack: {
    label: "Slack",
    color: "text-purple-700",
    bgColor: "bg-purple-100",
    description:
      "Add your agent to a Slack workspace. Great for team use.",
    setupSteps: [
      "Go to api.slack.com/apps and click \"Create New App\".",
      'Choose "From scratch" and pick your workspace.',
      'Under "Permissions", give the bot permission to send messages (chat:write) and read mentions (app_mentions:read).',
      "Install to workspace, then copy the bot token.",
      "Paste the token below.",
    ],
    placeholder: "Paste your Slack bot token here",
    badge: "Team-friendly",
  },
};

/* ------------------------------------------------------------------ */
/*  Channels Page                                                      */
/* ------------------------------------------------------------------ */

export default function ChannelsPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [addType, setAddType] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [ownerChatId, setOwnerChatId] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [saveError, setSaveError] = useState("");
  const [removeConfirmId, setRemoveConfirmId] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  /* ---------------------------------------------------------------- */
  /*  Data loading                                                     */
  /* ---------------------------------------------------------------- */

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchChannels();
      setChannels(data as Channel[]);
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
  /*  Actions                                                          */
  /* ---------------------------------------------------------------- */

  const handleAdd = async () => {
    if (!addType || !token.trim()) return;
    if (addType === "telegram" && !ownerChatId.trim()) return;
    setSaving(true);
    setSaveError("");
    setSaveMessage("");
    try {
      if (addType === "telegram") {
        const result = await connectTelegramChannel({
          token: token.trim(),
          ownerChatId: ownerChatId.trim(),
        });
        const promptError =
          result.promptResult &&
          typeof result.promptResult.error === "string"
            ? result.promptResult.error
            : "";
        setSaveMessage(
          result.promptTriggered
            ? "Telegram is connected. If AI setup is still needed, the bot just sent you a message with next steps."
            : promptError
              ? "Telegram is connected, but the bot couldn't send you the setup message yet. It will try again shortly."
              : "Telegram is connected. If AI still needs setup, the bot will message you with next steps soon.",
        );
      } else {
        await addChannel({ type: addType, token: token.trim() });
      }
      setShowAdd(false);
      setAddType(null);
      setToken("");
      setOwnerChatId("");
      load();
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : "Could not connect that app.",
      );
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (id: string) => {
    setRemoving(true);
    try {
      await removeChannel(id);
      setRemoveConfirmId(null);
      load();
    } catch {
      /* Silent fail */
    } finally {
      setRemoving(false);
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Helpers                                                          */
  /* ---------------------------------------------------------------- */

  const statusDot = (status: string) => {
    switch (status) {
      case "connected":
        return "status-dot-green";
      case "error":
        return "status-dot-red";
      default:
        return "status-dot-yellow";
    }
  };

  const statusLabel = (status: string) => {
    switch (status) {
      case "connected":
        return "Connected";
      case "error":
        return "Problem detected";
      default:
        return "Disconnected";
    }
  };

  const formatDate = (iso: string | null) => {
    if (!iso) return "No activity yet";
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "Active just now";
    if (mins < 60) return `Active ${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `Active ${hrs}h ago`;
    return `Active ${Math.floor(hrs / 24)}d ago`;
  };

  /* Which channel types are not yet connected? */
  const connectedTypes = new Set(channels.map((c) => c.type));
  const availableTypes = Object.keys(CHANNEL_META).filter(
    (t) => !connectedTypes.has(t)
  );

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="page-title">Messaging Apps</h1>
          <p className="mt-1 text-sm text-gray-500">
            Connect the apps where people will talk to your agent.
          </p>
        </div>
        {availableTypes.length > 0 && (
          <button
            onClick={() => {
              setShowAdd(true);
              setAddType(null);
              setToken("");
              setOwnerChatId("");
              setSaveMessage("");
              setSaveError("");
            }}
            className="btn-primary"
          >
            <svg className="mr-1.5 h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            Add App
          </button>
        )}
      </div>

      {/* Explainer card */}
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
                d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z"
              />
            </svg>
          </div>
          <div>
            <h2 className="text-base font-semibold text-gray-900">
              What are messaging apps?
            </h2>
            <p className="mt-1 text-sm text-gray-600 leading-relaxed">
              Messaging apps are how people reach your agent. When someone sends
              a message on <strong>Telegram</strong>, <strong>WhatsApp</strong>,
              or <strong>Slack</strong>, your agent reads it, thinks of a reply,
              and sends it back &mdash; all automatically.
            </p>
            <p className="mt-2 text-sm text-gray-600 leading-relaxed">
              You connect an app by creating a &ldquo;bot&rdquo; inside it and
              giving your agent the bot&apos;s access token. Don&apos;t worry
              &mdash; each app has step-by-step instructions below.
            </p>
            <p className="mt-2 text-sm text-gray-500">
              <strong>Start with one.</strong> Telegram is the fastest to set up
              and works on both phones and desktop. You can always add more
              later.
            </p>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------------- */}
      {/*  Add channel panel                                              */}
      {/* -------------------------------------------------------------- */}
      {showAdd && (
        <div className="card space-y-5 border-2 border-brand-200">
          <div className="flex items-center justify-between">
            <h2 className="section-title">Connect a Messaging App</h2>
            <button
              onClick={() => setShowAdd(false)}
              className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 min-h-touch min-w-touch"
              aria-label="Close"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Step 1: Pick the app */}
          {!addType ? (
            <div className="grid gap-3 sm:grid-cols-3">
              {availableTypes.map((type) => {
                const meta = CHANNEL_META[type];
                return (
                  <button
                    key={type}
                    onClick={() => {
                      setAddType(type);
                      setToken("");
                      setOwnerChatId("");
                      setSaveMessage("");
                      setSaveError("");
                    }}
                    className="card text-left hover:border-brand-300 hover:shadow-md transition cursor-pointer min-h-touch"
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <span
                        className={`inline-flex h-8 w-8 items-center justify-center rounded-lg ${meta.bgColor} ${meta.color} text-xs font-bold`}
                      >
                        {meta.label.charAt(0)}
                      </span>
                      <span className="text-sm font-semibold text-gray-900">
                        {meta.label}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500">
                      {meta.description}
                    </p>
                    <span
                      className={`mt-2 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${meta.bgColor} ${meta.color}`}
                    >
                      {meta.badge}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            /* Step 2: Guided setup */
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setAddType(null)}
                  className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 min-h-touch min-w-touch"
                  aria-label="Back"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                  </svg>
                </button>
                <span
                  className={`inline-flex h-8 w-8 items-center justify-center rounded-lg ${CHANNEL_META[addType].bgColor} ${CHANNEL_META[addType].color} text-xs font-bold`}
                >
                  {CHANNEL_META[addType].label.charAt(0)}
                </span>
                <span className="text-sm font-semibold text-gray-900">
                  Connect {CHANNEL_META[addType].label}
                </span>
              </div>

              {/* Setup steps */}
              <div className="rounded-lg bg-gray-50 p-4">
                <p className="text-xs font-medium text-gray-600 mb-2 uppercase tracking-wide">
                  How to get your token
                </p>
                <ol className="space-y-2">
                  {CHANNEL_META[addType].setupSteps.map((step, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-2.5 text-sm text-gray-700"
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-100 text-[10px] font-bold text-brand-700 mt-0.5">
                        {i + 1}
                      </span>
                      {step}
                    </li>
                  ))}
                </ol>
              </div>

              {/* Token input */}
              <div>
                <label
                  htmlFor="channel-token"
                  className="block text-sm font-medium text-gray-700 mb-1.5"
                >
                  Paste your token
                </label>
                <input
                  id="channel-token"
                  type="text"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={CHANNEL_META[addType].placeholder}
                  className="input-field font-mono text-sm"
                />
              </div>

              {addType === "telegram" && (
                <div className="space-y-2">
                  <div>
                    <label
                      htmlFor="telegram-owner-chat-id"
                      className="block text-sm font-medium text-gray-700 mb-1.5"
                    >
                      Telegram private chat ID
                    </label>
                    <input
                      id="telegram-owner-chat-id"
                      type="text"
                      value={ownerChatId}
                      onChange={(e) => setOwnerChatId(e.target.value)}
                      placeholder="Paste the numeric Telegram private chat ID"
                      className="input-field font-mono text-sm"
                    />
                  </div>
                  <p className="text-xs text-gray-500">
                    We need this numeric private chat ID so the bot knows which
                    Telegram account should receive setup messages and startup
                    notices.
                  </p>
                </div>
              )}

              {saveError && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {saveError}
                </div>
              )}

              <button
                onClick={handleAdd}
                disabled={
                  saving ||
                  !token.trim() ||
                  (addType === "telegram" && !ownerChatId.trim())
                }
                className="btn-primary"
              >
                {saving ? (
                  <>
                    <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    Connecting...
                  </>
                ) : (
                  `Connect ${CHANNEL_META[addType].label}`
                )}
              </button>
            </div>
          )}
        </div>
      )}

      {/* -------------------------------------------------------------- */}
      {/*  Connected channels list                                        */}
      {/* -------------------------------------------------------------- */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div
              key={i}
              className="animate-pulse h-20 rounded-xl bg-gray-200"
            />
          ))}
        </div>
      ) : channels.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {channels.map((ch) => {
            const meta = CHANNEL_META[ch.type] ?? {
              label: ch.type,
              color: "text-gray-700",
              bgColor: "bg-gray-100",
            };

            return (
              <div key={ch.id} className="card">
                {/* Header */}
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex h-9 w-9 items-center justify-center rounded-lg ${meta.bgColor} ${meta.color} text-sm font-bold`}
                    >
                      {meta.label.charAt(0)}
                    </span>
                    <div>
                      <p className="text-sm font-semibold text-gray-900">
                        {ch.name || meta.label}
                      </p>
                      <p className="text-[11px] text-gray-500">
                        {meta.label}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Status */}
                <div className="flex items-center gap-2 mb-3">
                  <span className={statusDot(ch.status)} />
                  <span className="text-xs text-gray-600">
                    {statusLabel(ch.status)}
                  </span>
                </div>

                {/* Last activity */}
                <p className="text-[11px] text-gray-400 mb-3">
                  {formatDate(ch.lastActivity)}
                </p>

                {/* Remove */}
                {removeConfirmId === ch.id ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-red-600">
                      Disconnect this app?
                    </span>
                    <button
                      onClick={() => handleRemove(ch.id)}
                      disabled={removing}
                      className="text-xs font-medium text-red-600 hover:text-red-700 min-h-touch"
                    >
                      {removing ? "Removing..." : "Yes, disconnect"}
                    </button>
                    <button
                      onClick={() => setRemoveConfirmId(null)}
                      className="text-xs font-medium text-gray-500 hover:text-gray-700 min-h-touch"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setRemoveConfirmId(ch.id)}
                    className="text-xs font-medium text-gray-400 hover:text-red-600 transition min-h-touch"
                  >
                    Disconnect
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        /* Empty state */
        <div className="card flex flex-col items-center justify-center py-12 text-center">
          <svg
            className="h-12 w-12 text-gray-300"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5"
            />
          </svg>
          <h3 className="mt-3 text-sm font-medium text-gray-600">
            No apps connected
          </h3>
          <p className="mt-1 text-xs text-gray-400 max-w-sm">
            Connect a messaging app so people can talk to your agent.
            Telegram is the fastest to set up.
          </p>
          <button
            onClick={() => {
              setShowAdd(true);
              setAddType(null);
              setToken("");
              setOwnerChatId("");
              setSaveMessage("");
              setSaveError("");
            }}
            className="btn-primary mt-4 text-sm"
          >
            Connect Your First App
          </button>
        </div>
      )}

      {saveMessage && (
        <div className="rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-900">
          {saveMessage}
        </div>
      )}
    </div>
  );
}
