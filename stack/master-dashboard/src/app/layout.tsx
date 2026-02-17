"use client";

import "./globals.css";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ReactNode } from "react";

/* ------------------------------------------------------------------ */
/*  Navigation items                                                    */
/* ------------------------------------------------------------------ */

interface NavItem {
  label: string;
  href: string;
  /** Short label for mobile bottom nav */
  shortLabel: string;
  /** SVG path data for the icon (24x24 viewBox) */
  iconPath: string;
}

const NAV_ITEMS: NavItem[] = [
  {
    label: "Overview",
    shortLabel: "Home",
    href: "/",
    iconPath:
      "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0h4",
  },
  {
    label: "Agents",
    shortLabel: "Agents",
    href: "/agents",
    iconPath:
      "M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z",
  },
  {
    label: "Message Bus",
    shortLabel: "Bus",
    href: "/bus",
    iconPath:
      "M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z",
  },
  {
    label: "Settings",
    shortLabel: "Settings",
    href: "/settings",
    iconPath:
      "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.573-1.066z",
  },
];

/* ------------------------------------------------------------------ */
/*  Layout                                                              */
/* ------------------------------------------------------------------ */

export default function RootLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  /** Returns true if the nav item is the current route */
  function isActive(href: string): boolean {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  }

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>OpenClaw - Server Dashboard</title>
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="font-sans">
        <div className="flex min-h-screen">
          {/* ── Desktop sidebar ── */}
          <aside className="hidden md:flex md:w-60 lg:w-64 flex-col border-r border-gray-200 bg-white">
            {/* Brand */}
            <div className="flex h-16 items-center gap-2 border-b border-gray-100 px-5">
              <span className="text-xl font-bold text-brand-600">
                OpenClaw
              </span>
              <span className="rounded bg-brand-100 px-1.5 py-0.5 text-xs font-medium text-brand-700">
                Server
              </span>
            </div>

            {/* Nav links */}
            <nav className="flex-1 space-y-1 px-3 py-4">
              {NAV_ITEMS.map((item) => {
                const active = isActive(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors min-h-[44px] ${
                      active
                        ? "bg-brand-50 text-brand-700"
                        : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                    }`}
                  >
                    <svg
                      className="h-5 w-5 flex-shrink-0"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={1.75}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d={item.iconPath}
                      />
                    </svg>
                    {item.label}
                  </Link>
                );
              })}
            </nav>

            {/* Footer */}
            <div className="border-t border-gray-100 px-5 py-3">
              <p className="text-xs text-gray-400">
                OpenClaw Agent Launcher v1.0
              </p>
            </div>
          </aside>

          {/* ── Main content ── */}
          <main className="flex-1 overflow-auto pb-20 md:pb-0">
            {/* Mobile header */}
            <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-gray-200 bg-white px-4 md:hidden">
              <span className="text-lg font-bold text-brand-600">
                OpenClaw
              </span>
              <span className="rounded bg-brand-100 px-1.5 py-0.5 text-xs font-medium text-brand-700">
                Server
              </span>
            </header>

            <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
              {children}
            </div>
          </main>
        </div>

        {/* ── Mobile bottom nav ── */}
        <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-gray-200 bg-white md:hidden">
          {NAV_ITEMS.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex flex-1 flex-col items-center justify-center py-2 text-xs min-h-[56px] transition-colors ${
                  active
                    ? "text-brand-600"
                    : "text-gray-500 hover:text-gray-700"
                }`}
              >
                <svg
                  className="mb-0.5 h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={active ? 2 : 1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d={item.iconPath}
                  />
                </svg>
                {item.shortLabel}
              </Link>
            );
          })}
        </nav>
      </body>
    </html>
  );
}
