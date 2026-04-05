import type { Metadata } from 'next';
import Link from 'next/link';
import { cn } from '../lib/utils';

import '../styles/globals.css';
import '../styles/ignis-theme.css';

export const metadata: Metadata = {
  title: {
    default: 'IGNIS Platform',
    template: '%s · IGNIS',
  },
  description:
    'IGNIS Platform — Supply & Demand analysis, market structure, setup scoring, alerts, and Ollama AI for traders.',
  applicationName: 'IGNIS Platform',
  authors: [{ name: 'IGNIS' }],
  icons: [{ rel: 'icon', url: '/favicon.ico' }],
  metadataBase: new URL('http://localhost:3000'),
};

const API_BASE =
  (process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:8000/api/v1').toString();

const WS_URL = (process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:8000/ws').toString();

type NavItem = {
  label: string;
  href: string;
  description: string;
  icon: React.ReactNode;
  accent: 'orange' | 'blue' | 'green' | 'zinc';
};

const nav: NavItem[] = [
  {
    label: 'Dashboard',
    href: '/',
    description: 'Watchlist + live alerts + overview',
    accent: 'orange',
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none">
        <path
          d="M4 13V6a2 2 0 0 1 2-2h5v9H4Zm9 7V4h5a2 2 0 0 1 2 2v14h-7Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    label: 'Scanner',
    href: '/scanner',
    description: 'Scan multi-symbols / multi-TF',
    accent: 'blue',
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none">
        <path
          d="M4 6h16M4 12h10M4 18h16"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <path
          d="M18.5 11.5l1.5 1.5 3-3"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    label: 'AI',
    href: '/ai',
    description: 'Chat Ollama + reports',
    accent: 'green',
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none">
        <path
          d="M7 19c-2.2 0-4-1.8-4-4V8c0-2.2 1.8-4 4-4h10c2.2 0 4 1.8 4 4v7c0 2.2-1.8 4-4 4H12l-4 3v-3H7Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M8 10h8M8 13h6"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    label: 'Journal',
    href: '/journal',
    description: 'Trades + P&L stats',
    accent: 'zinc',
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none">
        <path
          d="M7 4h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <path
          d="M8 8h8M8 12h8M8 16h6"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    label: 'Settings',
    href: '/settings',
    description: 'Assets CRUD + alerts + AI status',
    accent: 'orange',
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none">
        <path
          d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
          stroke="currentColor"
          strokeWidth="1.8"
        />
        <path
          d="M19.4 15a8.6 8.6 0 0 0 .1-2l2-1.2-2-3.4-2.3.7a8.5 8.5 0 0 0-1.7-1L15 5h-4l-.5 2.1a8.5 8.5 0 0 0-1.7 1l-2.3-.7-2 3.4 2 1.2a8.6 8.6 0 0 0 .1 2l-2 1.2 2 3.4 2.3-.7c.5.4 1.1.8 1.7 1L11 21h4l.5-2.1c.6-.2 1.2-.6 1.7-1l2.3.7 2-3.4-2-1.2Z"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.9"
        />
      </svg>
    ),
  },
];

function accentClasses(accent: NavItem['accent']) {
  switch (accent) {
    case 'orange':
      return 'from-[#E85D1A]/25 to-transparent border-[#E85D1A]/15';
    case 'blue':
      return 'from-[#378ADD]/25 to-transparent border-[#378ADD]/15';
    case 'green':
      return 'from-[#1D9E75]/25 to-transparent border-[#1D9E75]/15';
    case 'zinc':
    default:
      return 'from-white/10 to-transparent border-white/10';
  }
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body className="min-h-screen bg-[#0A0A0F] text-white antialiased selection:bg-[#E85D1A]/35 selection:text-white">
        {/* Global background glow */}
        <div className="pointer-events-none fixed inset-0 overflow-hidden">
          <div className="absolute -top-24 left-1/3 h-[420px] w-[420px] rounded-full bg-[#E85D1A]/12 blur-[90px]" />
          <div className="absolute top-1/3 right-1/4 h-[360px] w-[360px] rounded-full bg-[#378ADD]/10 blur-[95px]" />
          <div className="absolute bottom-0 left-1/4 h-[360px] w-[360px] rounded-full bg-[#1D9E75]/9 blur-[95px]" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_10%,rgba(255,255,255,0.06),transparent_45%),radial-gradient(circle_at_80%_40%,rgba(255,255,255,0.04),transparent_50%)]" />
        </div>

        <a
          href="#content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-xl focus:border focus:border-white/10 focus:bg-black/70 focus:px-4 focus:py-2 focus:text-sm focus:text-white/90 focus:backdrop-blur"
        >
          Aller au contenu
        </a>

        <div className="relative mx-auto max-w-[1700px] px-4 py-4 md:px-6 md:py-6">
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
            {/* Sidebar */}
            <aside className="lg:col-span-3 xl:col-span-2">
              <div className="rounded-3xl border border-white/10 bg-white/5 backdrop-blur-[20px] shadow-[0_25px_80px_rgba(0,0,0,0.55)] overflow-hidden">
                {/* Brand */}
                <div className="border-b border-white/10 bg-black/20 px-5 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-full bg-[#E85D1A] shadow-[0_0_0_6px_rgba(232,93,26,0.12)]" />
                        <div className="text-sm font-semibold tracking-tight">IGNIS Platform</div>
                      </div>
                      <div className="text-[11px] text-white/55 mt-1">
                        v1.0.0 · <span className="text-white/70">Phoenix</span>
                      </div>
                    </div>

                    <a
                      href={API_BASE.replace(/\/api\/v1$/, '') + '/docs'}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition"
                      title="Swagger"
                    >
                      Docs
                    </a>
                  </div>

                  <div className="mt-3 grid grid-cols-1 gap-2">
                    <div className="rounded-2xl border border-white/10 bg-black/20 px-3 py-2">
                      <div className="text-[11px] text-white/50">API</div>
                      <div className="text-[11px] text-white/75 break-all">{API_BASE}</div>
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-black/20 px-3 py-2">
                      <div className="text-[11px] text-white/50">WebSocket</div>
                      <div className="text-[11px] text-white/75 break-all">{WS_URL}</div>
                    </div>
                  </div>
                </div>

                {/* Mobile menu (no JS) */}
                <details className="lg:hidden border-b border-white/10 bg-black/20">
                  <summary className="cursor-pointer select-none px-5 py-4 text-sm text-white/80 hover:text-white transition">
                    Menu
                    <span className="ml-2 text-xs text-white/50">(tap)</span>
                  </summary>
                  <div className="px-3 pb-3">
                    <NavList />
                  </div>
                </details>

                {/* Desktop menu */}
                <div className="hidden lg:block px-3 py-3">
                  <NavList />
                </div>

                {/* Footer */}
                <div className="border-t border-white/10 bg-black/15 px-5 py-4">
                  <div className="text-[11px] text-white/55">
                    Dark-only · Glass UI · Tailwind
                  </div>
                  <div className="text-[11px] text-white/40 mt-1">
                    © {new Date().getFullYear()} IGNIS
                  </div>
                </div>
              </div>
            </aside>

            {/* Content area */}
            <section className="lg:col-span-9 xl:col-span-10">
              <div className="rounded-3xl border border-white/10 bg-white/5 backdrop-blur-[20px] shadow-[0_25px_80px_rgba(0,0,0,0.55)] overflow-hidden">
                {/* Top bar */}
                <div className="border-b border-white/10 bg-black/20 px-5 py-4">
                  <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-white/90">
                        Workspace
                        <span className="text-white/40 font-normal"> · Supply & Demand Intelligence</span>
                      </div>
                      <div className="text-xs text-white/55 mt-1">
                        Astuce: ouvre un symbol depuis Dashboard/Scanner pour accéder à l’analyse détaillée.
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href="/scanner"
                        className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10 transition"
                      >
                        Scanner
                      </Link>
                      <Link
                        href="/analysis/BTCUSDT"
                        className="rounded-xl border border-white/10 bg-gradient-to-b from-[#E85D1A]/70 to-[#E85D1A]/20 px-3 py-2 text-sm font-medium text-white hover:from-[#E85D1A]/80 hover:to-[#E85D1A]/25 transition"
                        title="Exemple"
                      >
                        Quick BTCUSDT →
                      </Link>
                    </div>
                  </div>
                </div>

                {/* Page content */}
                <main id="content" className="p-0">
                  {children}
                </main>
              </div>

              {/* subtle footer under content */}
              <div className="mt-4 text-xs text-white/35">
                Built for traders · Real-time alerts · Local LLM (Ollama)
              </div>
            </section>
          </div>
        </div>
      </body>
    </html>
  );
}

function NavList() {
  return (
    <nav className="space-y-2">
      {nav.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={cn(
            'group w-full flex items-start gap-3 rounded-2xl border bg-gradient-to-b px-4 py-3 transition',
            'hover:bg-white/10',
            accentClasses(item.accent)
          )}
        >
          <div className="mt-0.5 text-white/80 group-hover:text-white transition">
            {item.icon}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-white/90 truncate">{item.label}</div>
            <div className="text-[11px] text-white/55 truncate mt-0.5">
              {item.description}
            </div>
          </div>
          <div className="ml-auto text-xs text-white/40 group-hover:text-white/70 transition">
            →
          </div>
        </Link>
      ))}
    </nav>
  );
}