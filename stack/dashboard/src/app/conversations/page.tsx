"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useSearchParams } from "next/navigation";
import {
  fetchConversations,
  fetchConversationMessages,
  toggleStar,
} from "@/lib/api";
import { useConversationRealtime } from "@/lib/supabase-realtime";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Conversation {
  id: string;
  channelType: string;
  contactName: string;
  lastMessage: string;
  lastMessageAt: string;
  messageCount: number;
  starred: boolean;
}

interface Message {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/*  Conversations Page                                                 */
/* ------------------------------------------------------------------ */

export default function ConversationsPage() {
  const searchParams = useSearchParams();
  const preselectedId = searchParams.get("id");

  /* State */
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [search, setSearch] = useState("");
  const [starredOnly, setStarredOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(
    preselectedId
  );
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingThread, setLoadingThread] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  /* ---------------------------------------------------------------- */
  /*  Data fetching                                                    */
  /* ---------------------------------------------------------------- */

  const loadConversations = useCallback(async () => {
    setLoadingList(true);
    try {
      const data = await fetchConversations({
        search: search || undefined,
        starred: starredOnly || undefined,
      });
      setConversations(data as Conversation[]);
    } catch {
      /* Silent fail — user sees empty state */
    } finally {
      setLoadingList(false);
    }
  }, [search, starredOnly]);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  const loadMessages = useCallback(async (id: string) => {
    setLoadingThread(true);
    try {
      const data = await fetchConversationMessages(id);
      setMessages(data as Message[]);
    } catch {
      setMessages([]);
    } finally {
      setLoadingThread(false);
    }
  }, []);

  /* Load thread when a conversation is selected */
  useEffect(() => {
    if (selectedId) {
      loadMessages(selectedId);
    }
  }, [selectedId, loadMessages]);

  /* Supabase Realtime — live conversation + message updates */
  useConversationRealtime({
    onNewMessage: useCallback(() => {
      // Re-fetch the active thread when a new message arrives
      if (selectedId) loadMessages(selectedId);
      // Also refresh the conversation list (for updated lastMessage/count)
      loadConversations();
    }, [selectedId, loadMessages, loadConversations]),
    onConversationUpdate: useCallback(() => {
      loadConversations();
    }, [loadConversations]),
  });

  /* Auto-scroll to bottom of thread */
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  /* ---------------------------------------------------------------- */
  /*  Actions                                                          */
  /* ---------------------------------------------------------------- */

  const handleToggleStar = async (conv: Conversation) => {
    const newStarred = !conv.starred;
    /* Optimistic update */
    setConversations((prev) =>
      prev.map((c) =>
        c.id === conv.id ? { ...c, starred: newStarred } : c
      )
    );
    try {
      await toggleStar(conv.id, newStarred);
    } catch {
      /* Revert on failure */
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conv.id ? { ...c, starred: !newStarred } : c
        )
      );
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Helpers                                                          */
  /* ---------------------------------------------------------------- */

  const channelBadge = (type: string) => {
    const map: Record<string, { label: string; classes: string }> = {
      telegram: { label: "Telegram", classes: "bg-blue-100 text-blue-700" },
      whatsapp: { label: "WhatsApp", classes: "bg-green-100 text-green-700" },
      slack: { label: "Slack", classes: "bg-purple-100 text-purple-700" },
    };
    const info = map[type] ?? { label: type, classes: "bg-gray-100 text-gray-600" };
    return (
      <span
        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${info.classes}`}
      >
        {info.label}
      </span>
    );
  };

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    if (hrs < 48) return "yesterday";
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  const formatMessageTime = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });

  const selectedConversation = conversations.find(
    (c) => c.id === selectedId
  );

  /* ---------------------------------------------------------------- */
  /*  Thread view                                                      */
  /* ---------------------------------------------------------------- */

  const threadView = selectedId && (
    <div className="flex h-full flex-col">
      {/* Thread header */}
      <div className="flex items-center gap-3 border-b border-gray-200 bg-white px-4 py-3">
        {/* Back button (mobile) */}
        <button
          onClick={() => setSelectedId(null)}
          className="lg:hidden flex items-center justify-center rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 min-h-touch min-w-touch"
          aria-label="Back to conversations"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-900 truncate">
              {selectedConversation?.contactName ?? "Conversation"}
            </span>
            {selectedConversation && channelBadge(selectedConversation.channelType)}
          </div>
          <p className="text-xs text-gray-500">
            {selectedConversation
              ? `${selectedConversation.messageCount} messages`
              : ""}
          </p>
        </div>

        {/* Star button */}
        {selectedConversation && (
          <button
            onClick={() => handleToggleStar(selectedConversation)}
            className="flex items-center justify-center rounded-lg p-2 hover:bg-gray-100 min-h-touch min-w-touch"
            aria-label={
              selectedConversation.starred ? "Remove star" : "Star conversation"
            }
          >
            {selectedConversation.starred ? (
              <svg className="h-5 w-5 text-yellow-400" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M10.868 2.884c-.321-.772-1.415-.772-1.736 0l-1.83 4.401-4.753.381c-.833.067-1.171 1.107-.536 1.651l3.62 3.102-1.106 4.637c-.194.813.691 1.456 1.405 1.02L10 15.591l4.069 2.485c.713.436 1.598-.207 1.404-1.02l-1.106-4.637 3.62-3.102c.635-.544.297-1.584-.536-1.65l-4.752-.382-1.831-4.401z" clipRule="evenodd" />
              </svg>
            ) : (
              <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
              </svg>
            )}
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar bg-gray-50">
        {loadingThread ? (
          <div className="flex h-full items-center justify-center">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
          </div>
        ) : messages.length > 0 ? (
          <>
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${
                  msg.role === "user" ? "justify-end" : "justify-start"
                }`}
              >
                <div
                  className={`
                    max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed
                    ${
                      msg.role === "user"
                        ? "bg-brand-600 text-white rounded-br-md"
                        : "bg-white text-gray-900 border border-gray-200 rounded-bl-md shadow-sm"
                    }
                  `}
                >
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                  <p
                    className={`mt-1 text-[10px] ${
                      msg.role === "user"
                        ? "text-brand-200"
                        : "text-gray-400"
                    }`}
                  >
                    {formatMessageTime(msg.createdAt)}
                  </p>
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-gray-400">
            No messages in this conversation.
          </div>
        )}
      </div>
    </div>
  );

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  return (
    <div className="space-y-4">
      <h1 className="page-title">Conversations</h1>

      <div className="flex h-[calc(100vh-180px)] lg:h-[calc(100vh-160px)] overflow-hidden rounded-xl border border-gray-200 bg-white">
        {/* -------------------------------------------------------------- */}
        {/*  Conversation list (left panel)                                 */}
        {/*  Hidden on mobile when a thread is open                        */}
        {/* -------------------------------------------------------------- */}
        <div
          className={`
            w-full lg:w-80 lg:min-w-[320px] lg:border-r border-gray-200
            flex flex-col
            ${selectedId ? "hidden lg:flex" : "flex"}
          `}
        >
          {/* Search + filter bar */}
          <div className="border-b border-gray-100 p-3 space-y-2">
            <div className="relative">
              <svg
                className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
                />
              </svg>
              <input
                type="text"
                placeholder="Search conversations..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="input-field pl-9 text-sm"
              />
            </div>

            <button
              onClick={() => setStarredOnly(!starredOnly)}
              className={`
                inline-flex items-center gap-1.5 rounded-full px-3 py-1.5
                text-xs font-medium transition min-h-touch
                ${
                  starredOnly
                    ? "bg-yellow-100 text-yellow-700"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }
              `}
            >
              <svg
                className={`h-3.5 w-3.5 ${
                  starredOnly ? "text-yellow-500" : "text-gray-400"
                }`}
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M10.868 2.884c-.321-.772-1.415-.772-1.736 0l-1.83 4.401-4.753.381c-.833.067-1.171 1.107-.536 1.651l3.62 3.102-1.106 4.637c-.194.813.691 1.456 1.405 1.02L10 15.591l4.069 2.485c.713.436 1.598-.207 1.404-1.02l-1.106-4.637 3.62-3.102c.635-.544.297-1.584-.536-1.65l-4.752-.382-1.831-4.401z"
                  clipRule="evenodd"
                />
              </svg>
              {starredOnly ? "Showing starred" : "Starred only"}
            </button>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto custom-scrollbar">
            {loadingList ? (
              <div className="p-4 space-y-3">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="animate-pulse flex gap-3">
                    <div className="h-10 w-10 rounded-full bg-gray-200" />
                    <div className="flex-1 space-y-2 py-1">
                      <div className="h-3 w-1/2 rounded bg-gray-200" />
                      <div className="h-3 w-3/4 rounded bg-gray-200" />
                    </div>
                  </div>
                ))}
              </div>
            ) : conversations.length > 0 ? (
              <ul>
                {conversations.map((conv) => (
                  <li key={conv.id}>
                    <button
                      onClick={() => setSelectedId(conv.id)}
                      className={`
                        flex w-full items-center gap-3 px-4 py-3 text-left
                        transition min-h-touch border-b border-gray-50
                        ${
                          conv.id === selectedId
                            ? "bg-brand-50"
                            : "hover:bg-gray-50"
                        }
                      `}
                    >
                      {/* Avatar placeholder */}
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gray-200 text-xs font-bold text-gray-600">
                        {conv.contactName.charAt(0).toUpperCase()}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-gray-900 truncate">
                            {conv.contactName}
                          </span>
                          <span className="text-[10px] text-gray-400 shrink-0 ml-2">
                            {formatTime(conv.lastMessageAt)}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          {conv.starred && (
                            <svg className="h-3 w-3 text-yellow-400 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                              <path fillRule="evenodd" d="M10.868 2.884c-.321-.772-1.415-.772-1.736 0l-1.83 4.401-4.753.381c-.833.067-1.171 1.107-.536 1.651l3.62 3.102-1.106 4.637c-.194.813.691 1.456 1.405 1.02L10 15.591l4.069 2.485c.713.436 1.598-.207 1.404-1.02l-1.106-4.637 3.62-3.102c.635-.544.297-1.584-.536-1.65l-4.752-.382-1.831-4.401z" clipRule="evenodd" />
                            </svg>
                          )}
                          <p className="text-xs text-gray-500 truncate">
                            {conv.lastMessage}
                          </p>
                        </div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="flex h-full items-center justify-center p-8 text-center">
                <div>
                  <p className="text-sm font-medium text-gray-500">
                    {starredOnly
                      ? "No starred conversations"
                      : search
                      ? "No results found"
                      : "No conversations yet"}
                  </p>
                  <p className="mt-1 text-xs text-gray-400">
                    {starredOnly
                      ? "Star a conversation to find it easily later."
                      : search
                      ? "Try a different search."
                      : "Start chatting with your agent!"}
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* -------------------------------------------------------------- */}
        {/*  Thread view (right panel / full-screen on mobile)              */}
        {/* -------------------------------------------------------------- */}
        <div
          className={`
            flex-1 flex flex-col
            ${selectedId ? "flex" : "hidden lg:flex"}
          `}
        >
          {selectedId ? (
            threadView
          ) : (
            <div className="flex h-full items-center justify-center text-center p-8">
              <div>
                <svg
                  className="mx-auto h-12 w-12 text-gray-300"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z"
                  />
                </svg>
                <p className="mt-3 text-sm font-medium text-gray-500">
                  Pick a conversation
                </p>
                <p className="mt-1 text-xs text-gray-400">
                  Select a conversation from the list to view the messages.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
