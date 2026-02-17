"use client";

import "./globals.css";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useDashboardStore } from "@/lib/store";
import { useEffect, useCallback } from "react";
import { fetchStatus, fetchStats } from "@/lib/api";

/* ------------------------------------------------------------------ */
/*  Navigation items (zero-jargon labels)                              */
/* ------------------------------------------------------------------ */

const NAV_ITEMS = [
  {
    href: "/",
    label: "Home",
    icon: (active: boolean) => (
      <svg
        className={`h-5 w-5 ${active ? "text-brand-600" : "text-gray-500"}`}
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={1.5}
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M2.25 12l8.954-8.955a1.126 1.126 0 011.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25"
        />
      </svg>
    ),
  },
  {
    href: "/conversations",
    label: "Conversations",
    icon: (active: boolean) => (
      <svg
        className={`h-5 w-5 ${active ? "text-brand-600" : "text-gray-500"}`}
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={1.5}
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3a49.5 49.5 0 01-4.02-.163 2.115 2.115 0 01-1.23-.567m7.75-6.926V6.75a2.25 2.25 0 00-2.25-2.25H6.75A2.25 2.25 0 004.5 6.75v4.5a2.25 2.25 0 002.25 2.25h1.5m7.5-6.75h-3"
        />
      </svg>
    ),
  },
  {
    href: "/tasks",
    label: "Tasks",
    icon: (active: boolean) => (
      <svg
        className={`h-5 w-5 ${active ? "text-brand-600" : "text-gray-500"}`}
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={1.5}
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
    ),
  },
  {
    href: "/channels",
    label: "Channels",
    icon: (active: boolean) => (
      <svg
        className={`h-5 w-5 ${active ? "text-brand-600" : "text-gray-500"}`}
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={1.5}
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5"
        />
      </svg>
    ),
  },
  {
    href: "/analytics",
    label: "Analytics",
    icon: (active: boolean) => (
      <svg
        className={`h-5 w-5 ${active ? "text-brand-600" : "text-gray-500"}`}
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={1.5}
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z"
        />
      </svg>
    ),
  },
  {
    href: "/settings",
    label: "Settings",
    icon: (active: boolean) => (
      <svg
        className={`h-5 w-5 ${active ? "text-brand-600" : "text-gray-500"}`}
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={1.5}
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z"
        />
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
        />
      </svg>
    ),
  },
];

/* ------------------------------------------------------------------ */
/*  Layout                                                             */
/* ------------------------------------------------------------------ */

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { sidebarOpen, setSidebarOpen, setAgentStatus, setStats } =
    useDashboardStore();

  /** Fetch agent status and stats on mount */
  const loadGlobalData = useCallback(async () => {
    try {
      const [status, stats] = await Promise.all([
        fetchStatus(),
        fetchStats(),
      ]);
      setAgentStatus(status as any);
      setStats(stats);
    } catch {
      /* Agent may not be reachable yet; fail silently */
    }
  }, [setAgentStatus, setStats]);

  useEffect(() => {
    loadGlobalData();
    const interval = setInterval(loadGlobalData, 30_000);
    return () => clearInterval(interval);
  }, [loadGlobalData]);

  /** Close sidebar on route change (mobile) */
  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname, setSidebarOpen]);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Agent Dashboard</title>
      </head>
      <body className="min-h-screen">
        {/* -------------------------------------------------------- */}
        {/*  Mobile overlay                                          */}
        {/* -------------------------------------------------------- */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/40 lg:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
        )}

        {/* -------------------------------------------------------- */}
        {/*  Sidebar (desktop: always visible, mobile: slide-over)   */}
        {/* -------------------------------------------------------- */}
        <aside
          className={`
            fixed inset-y-0 left-0 z-50 w-60 flex-col bg-white border-r
            border-gray-200 transition-transform duration-200 ease-in-out
            lg:translate-x-0 lg:flex
            ${sidebarOpen ? "translate-x-0 flex" : "-translate-x-full hidden"}
          `}
        >
          {/* Brand */}
          <div className="flex h-16 items-center gap-2 px-5 border-b border-gray-100">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white font-bold text-sm">
              OC
            </div>
            <span className="text-lg font-semibold text-gray-900">
              Agent Dashboard
            </span>
          </div>

          {/* Nav links */}
          <nav className="flex-1 overflow-y-auto py-4 px-3">
            <ul className="space-y-1">
              {NAV_ITEMS.map((item) => {
                const active = isActive(item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={`
                        flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm
                        font-medium transition min-h-touch
                        ${
                          active
                            ? "bg-brand-50 text-brand-700"
                            : "text-gray-700 hover:bg-gray-100"
                        }
                      `}
                    >
                      {item.icon(active)}
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          {/* Agent status footer */}
          <AgentStatusFooter />
        </aside>

        {/* -------------------------------------------------------- */}
        {/*  Main content area                                       */}
        {/* -------------------------------------------------------- */}
        <div className="lg:pl-60 pb-20 lg:pb-0">
          {/* Top bar (mobile only — hamburger + title) */}
          <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-gray-200 bg-white px-4 lg:hidden">
            <button
              type="button"
              className="flex items-center justify-center rounded-lg p-2 text-gray-600 hover:bg-gray-100 min-h-touch min-w-touch"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open navigation"
            >
              <svg
                className="h-6 w-6"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
                />
              </svg>
            </button>
            <span className="text-base font-semibold text-gray-900">
              {NAV_ITEMS.find((i) => isActive(i.href))?.label ?? "Dashboard"}
            </span>
          </header>

          {/* Page content */}
          <main className="mx-auto max-w-7xl p-4 sm:p-6 lg:p-8">
            {children}
          </main>
        </div>

        {/* -------------------------------------------------------- */}
        {/*  Bottom nav bar (mobile only)                            */}
        {/* -------------------------------------------------------- */}
        <nav className="fixed bottom-0 left-0 right-0 z-30 flex border-t border-gray-200 bg-white lg:hidden">
          {NAV_ITEMS.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`
                  flex flex-1 flex-col items-center justify-center py-2 min-h-touch
                  text-[10px] font-medium transition
                  ${active ? "text-brand-600" : "text-gray-500"}
                `}
              >
                {item.icon(active)}
                <span className="mt-0.5">{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </body>
    </html>
  );
}

/* ------------------------------------------------------------------ */
/*  Sidebar footer: agent status indicator                             */
/* ------------------------------------------------------------------ */

function AgentStatusFooter() {
  const agentStatus = useDashboardStore((s) => s.agentStatus);

  const statusColor =
    agentStatus?.status === "running"
      ? "bg-green-500"
      : agentStatus?.status === "error"
      ? "bg-red-500"
      : "bg-yellow-500";

  const statusLabel =
    agentStatus?.status === "running"
      ? "Running"
      : agentStatus?.status === "error"
      ? "Error"
      : "Stopped";

  return (
    <div className="border-t border-gray-100 px-4 py-3">
      <div className="flex items-center gap-2">
        <span className={`status-dot ${statusColor}`} />
        <span className="text-sm font-medium text-gray-700">
          {agentStatus?.name ?? "Agent"}
        </span>
      </div>
      <p className="mt-0.5 text-xs text-gray-500">
        {agentStatus ? `${statusLabel} — up ${agentStatus.uptime}` : "Connecting..."}
      </p>
    </div>
  );
}
