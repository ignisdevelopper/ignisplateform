'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '../../lib/utils';

type StatusState = 'ONLINE' | 'OFFLINE' | 'CONNECTING' | 'DEGRADED' | 'UNKNOWN';

type NavItem = {
  key: string;
  label: string;
  href: string;
  description?: string;
  icon: React.ReactNode;
  accent?: 'orange' | 'blue' | 'green' | 'zinc' | 'rose' | 'amber' | 'violet';
  badge?: number | string;
};

type NavGroup = {
  title: string;
  items: NavItem[];
};

export default function Sidebar({
  brand = 'IGNIS Platform',
  versionLabel = 'v1.0.0 · Phoenix',

  collapsed: collapsedProp,
  defaultCollapsed = false,
  onCollapsedChange,

  mobileOpen,
  onMobileClose,

  groups,
  pinnedSymbols = [],
  onUnpinSymbol,

  showStatus = true,
  status,
  apiBase = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:8000/api/v1',
  wsUrl = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:8000/ws',

  className,
}: {
  brand?: string;
  versionLabel?: string;

  /** controlled collapsed mode (optional) */
  collapsed?: boolean;
  defaultCollapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;

  /** optional mobile drawer mode */
  mobileOpen?: boolean;
  onMobileClose?: () => void;

  /** custom nav groups (optional) */
  groups?: NavGroup[];

  /** pinned symbols quick access (optional) */
  pinnedSymbols?: Array<{ symbol: string; note?: string }>;
  onUnpinSymbol?: (symbol: string) => void;

  showStatus?: boolean;
  status?: {
    api?: StatusState;
    ws?: StatusState;
    ollama?: StatusState;
    ollamaModel?: string;
  };

  apiBase?: string;
  wsUrl?: string;

  className?: string;
}) {
  const pathname = usePathname();
  const [internalCollapsed, setInternalCollapsed] = useState(defaultCollapsed);

  const collapsed = collapsedProp ?? internalCollapsed;

  const setCollapsed = (v: boolean) => {
    if (collapsedProp === undefined) setInternalCollapsed(v);
    onCollapsedChange?.(v);
  };

  const defaultGroups = useMemo<NavGroup[]>(() => {
    const icon = {
      dashboard: (
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
      scanner: (
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none">
          <path d="M4 6h16M4 12h10M4 18h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path
            d="M18.5 11.5l1.5 1.5 3-3"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
      analysis: (
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none">
          <path
            d="M4 19V5m0 14h16"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <path
            d="M7 15l3-4 3 2 4-6"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
      ai: (
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none">
          <path
            d="M7 19c-2.2 0-4-1.8-4-4V8c0-2.2 1.8-4 4-4h10c2.2 0 4 1.8 4 4v7c0 2.2-1.8 4-4 4H12l-4 3v-3H7Z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M8 10h8M8 13h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      ),
      journal: (
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none">
          <path
            d="M7 4h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
          <path d="M8 8h8M8 12h8M8 16h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      ),
      settings: (
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
    };

    return [
      {
        title: 'Workspace',
        items: [
          { key: 'dashboard', label: 'Dashboard', href: '/', description: 'Watchlist + live alerts', icon: icon.dashboard, accent: 'orange' },
          { key: 'scanner', label: 'Scanner', href: '/scanner', description: 'Multi-symbols / multi-TF', icon: icon.scanner, accent: 'blue' },
          { key: 'analysis', label: 'Analysis', href: '/analysis/BTCUSDT', description: 'Chart + zones + panels', icon: icon.analysis, accent: 'zinc' },
          { key: 'ai', label: 'AI', href: '/ai', description: 'Chat + report generation', icon: icon.ai, accent: 'green' },
        ],
      },
      {
        title: 'Trading',
        items: [
          { key: 'journal', label: 'Journal', href: '/journal', description: 'Trades + stats', icon: icon.journal, accent: 'zinc' },
        ],
      },
      {
        title: 'System',
        items: [
          { key: 'settings', label: 'Settings', href: '/settings', description: 'Assets/alerts/Ollama', icon: icon.settings, accent: 'orange' },
        ],
      },
    ];
  }, []);

  const navGroups = groups?.length ? groups : defaultGroups;

  const isActive = (href: string) => {
    if (href === '/') return pathname === '/';
    // match prefix (e.g. /analysis/xxx should activate /analysis)
    const base = href.split('/').filter(Boolean)[0];
    if (!base) return false;
    return pathname === href || pathname.startsWith(`/${base}`);
  };

  const container = (
    <motion.aside
      initial={false}
      animate={{ width: collapsed ? 88 : 340 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className={cn(
        'rounded-3xl border border-white/10 bg-white/5 backdrop-blur-[20px] shadow-[0_25px_80px_rgba(0,0,0,0.55)] overflow-hidden',
        className
      )}
    >
      {/* Brand */}
      <div className="border-b border-white/10 bg-black/20 px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className={cn('min-w-0', collapsed && 'hidden')}>
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-[#E85D1A] shadow-[0_0_0_6px_rgba(232,93,26,0.12)]" />
              <div className="text-sm font-semibold tracking-tight text-white/90 truncate">
                {brand}
              </div>
            </div>
            <div className="text-[11px] text-white/55 mt-1 truncate">{versionLabel}</div>
          </div>

          <div className={cn('flex items-center gap-2', collapsed && 'w-full justify-between')}>
            <button
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              className="rounded-xl border border-white/10 bg-white/5 p-2 text-white/80 hover:bg-white/10 transition"
              title={collapsed ? 'Expand' : 'Collapse'}
            >
              {collapsed ? (
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none">
                  <path d="M10 7l5 5-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none">
                  <path d="M14 7l-5 5 5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>

            <a
              href={apiBase.replace(/\/api\/v1$/, '') + '/docs'}
              target="_blank"
              rel="noreferrer"
              className={cn(
                'rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition',
                collapsed && 'px-2.5'
              )}
              title="Swagger"
            >
              {collapsed ? 'Docs' : 'Swagger'}
            </a>
          </div>
        </div>

        {/* Status */}
        {showStatus && (
          <div className={cn('mt-4 grid gap-2', collapsed ? 'grid-cols-1' : 'grid-cols-1')}>
            <StatusRow collapsed={collapsed} label="API" value={apiBase} state={status?.api} />
            <StatusRow collapsed={collapsed} label="WS" value={wsUrl} state={status?.ws} />
            <StatusRow
              collapsed={collapsed}
              label="Ollama"
              value={status?.ollamaModel || '—'}
              state={status?.ollama}
            />
          </div>
        )}
      </div>

      {/* Nav */}
      <div className="px-3 py-3 space-y-4">
        {navGroups.map((g) => (
          <div key={g.title}>
            <div className={cn('px-2 pb-2 text-[11px] uppercase tracking-wider text-white/45', collapsed && 'text-center')}>
              {collapsed ? '•' : g.title}
            </div>

            <div className="space-y-2">
              {g.items.map((it) => {
                const active = isActive(it.href);

                return (
                  <Link
                    key={it.key}
                    href={it.href}
                    className={cn(
                      'group flex items-start gap-3 rounded-2xl border bg-gradient-to-b px-4 py-3 transition',
                      active
                        ? 'border-white/18 bg-white/10'
                        : 'border-white/10 bg-white/5 hover:bg-white/10',
                      accentClasses(it.accent ?? 'zinc')
                    )}
                    title={collapsed ? it.label : it.description}
                    onClick={() => onMobileClose?.()}
                  >
                    <div className={cn('mt-0.5 text-white/80 group-hover:text-white transition', active && 'text-white')}>
                      {it.icon}
                    </div>

                    <div className={cn('min-w-0', collapsed && 'hidden')}>
                      <div className="flex items-center justify-between gap-2">
                        <div className={cn('text-sm font-semibold truncate', active ? 'text-white/95' : 'text-white/90')}>
                          {it.label}
                        </div>

                        {it.badge !== undefined && it.badge !== null && (
                          <span className="rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-[11px] text-white/70">
                            {it.badge}
                          </span>
                        )}
                      </div>

                      {it.description && (
                        <div className="text-[11px] text-white/55 truncate mt-0.5">
                          {it.description}
                        </div>
                      )}
                    </div>

                    {collapsed && (
                      <div className="ml-auto text-xs text-white/40 group-hover:text-white/70 transition">
                        →
                      </div>
                    )}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}

        {/* Pinned symbols */}
        {pinnedSymbols.length > 0 && (
          <div className="pt-2">
            <div className={cn('px-2 pb-2 text-[11px] uppercase tracking-wider text-white/45', collapsed && 'text-center')}>
              {collapsed ? '★' : 'Pinned'}
            </div>

            <div className="space-y-2">
              {pinnedSymbols.slice(0, collapsed ? 6 : 10).map((p) => (
                <div
                  key={p.symbol}
                  className={cn(
                    'rounded-2xl border border-white/10 bg-black/20 px-3 py-2 flex items-center gap-2',
                    collapsed && 'justify-center'
                  )}
                  title={p.note ? `${p.symbol} · ${p.note}` : p.symbol}
                >
                  <Link
                    href={`/analysis/${encodeURIComponent(p.symbol.toUpperCase())}`}
                    className={cn(
                      'text-xs font-semibold text-white/85 hover:text-white transition',
                      collapsed ? 'text-center' : ''
                    )}
                    onClick={() => onMobileClose?.()}
                  >
                    {p.symbol.toUpperCase()}
                  </Link>

                  {!collapsed && p.note && (
                    <span className="text-[11px] text-white/45 truncate">· {p.note}</span>
                  )}

                  {!collapsed && onUnpinSymbol && (
                    <button
                      type="button"
                      onClick={() => onUnpinSymbol(p.symbol)}
                      className="ml-auto rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-white/70 hover:bg-white/10 transition"
                      title="Unpin"
                    >
                      Unpin
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-white/10 bg-black/15 px-5 py-4">
        <div className={cn('text-[11px] text-white/55', collapsed && 'hidden')}>
          Dark-only · Glass UI · Next.js 14
        </div>

        <div className={cn('mt-2 flex items-center gap-2', collapsed && 'justify-center mt-0')}>
          <button
            type="button"
            onClick={() => copyToClipboard(apiBase)}
            className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/75 hover:bg-white/10 transition"
            title="Copy API base"
          >
            {collapsed ? 'API' : 'Copy API'}
          </button>

          <button
            type="button"
            onClick={() => copyToClipboard(wsUrl)}
            className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/75 hover:bg-white/10 transition"
            title="Copy WS URL"
          >
            {collapsed ? 'WS' : 'Copy WS'}
          </button>
        </div>
      </div>
    </motion.aside>
  );

  // Mobile drawer wrapper (optional)
  if (mobileOpen !== undefined) {
    return (
      <AnimatePresence>
        {mobileOpen ? (
          <motion.div
            className="fixed inset-0 z-50 lg:hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div className="absolute inset-0 bg-black/60" onClick={onMobileClose} />
            <motion.div
              className="absolute left-4 top-4 bottom-4"
              initial={{ x: -20, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: -20, opacity: 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              {container}
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    );
  }

  return container;
}

/* ──────────────────────────────────────────────────────────────
   UI helpers
────────────────────────────────────────────────────────────── */

function accentClasses(accent: NonNullable<NavItem['accent']>) {
  switch (accent) {
    case 'orange':
      return 'from-[#E85D1A]/22 to-transparent border-[#E85D1A]/14';
    case 'blue':
      return 'from-[#378ADD]/22 to-transparent border-[#378ADD]/14';
    case 'green':
      return 'from-[#1D9E75]/22 to-transparent border-[#1D9E75]/14';
    case 'rose':
      return 'from-[#E24B4A]/20 to-transparent border-[#E24B4A]/12';
    case 'amber':
      return 'from-amber-400/18 to-transparent border-amber-400/12';
    case 'violet':
      return 'from-violet-400/18 to-transparent border-violet-400/12';
    case 'zinc':
    default:
      return 'from-white/10 to-transparent border-white/10';
  }
}

function StatusRow({
  collapsed,
  label,
  value,
  state,
}: {
  collapsed: boolean;
  label: string;
  value: string;
  state?: StatusState;
}) {
  const pal = statePalette(state ?? 'UNKNOWN');

  return (
    <div
      className={cn(
        'rounded-2xl border bg-black/20 px-3 py-2',
        pal.border
      )}
      style={{ boxShadow: `0 0 0 1px ${pal.ring} inset` }}
      title={`${label}: ${state ?? 'UNKNOWN'} · ${value}`}
    >
      <div className={cn('flex items-center justify-between gap-2', collapsed && 'justify-center')}>
        <div className="flex items-center gap-2">
          <span className={cn('h-2.5 w-2.5 rounded-full', pal.dot)} />
          <div className="text-[11px] font-medium text-white/80">{label}</div>
          {!collapsed && (
            <span className={cn('rounded-full border px-2 py-0.5 text-[11px]', pal.border, pal.bg, pal.text)}>
              {(state ?? 'UNKNOWN')}
            </span>
          )}
        </div>

        {!collapsed && (
          <div className="text-[11px] text-white/55 truncate max-w-[190px]">
            {value}
          </div>
        )}
      </div>
    </div>
  );
}

function statePalette(state: StatusState) {
  switch (state) {
    case 'ONLINE':
      return {
        border: 'border-emerald-500/20',
        bg: 'bg-emerald-500/10',
        text: 'text-emerald-100',
        dot: 'bg-emerald-400 shadow-[0_0_0_6px_rgba(16,185,129,0.10)]',
        ring: 'rgba(16,185,129,0.14)',
      };
    case 'CONNECTING':
      return {
        border: 'border-sky-500/20',
        bg: 'bg-sky-500/10',
        text: 'text-sky-100',
        dot: 'bg-sky-400 shadow-[0_0_0_6px_rgba(56,189,248,0.10)]',
        ring: 'rgba(56,189,248,0.14)',
      };
    case 'DEGRADED':
      return {
        border: 'border-amber-500/20',
        bg: 'bg-amber-500/10',
        text: 'text-amber-100',
        dot: 'bg-amber-400 shadow-[0_0_0_6px_rgba(245,158,11,0.10)]',
        ring: 'rgba(245,158,11,0.14)',
      };
    case 'OFFLINE':
      return {
        border: 'border-rose-500/20',
        bg: 'bg-rose-500/10',
        text: 'text-rose-100',
        dot: 'bg-rose-400 shadow-[0_0_0_6px_rgba(244,63,94,0.10)]',
        ring: 'rgba(244,63,94,0.14)',
      };
    case 'UNKNOWN':
    default:
      return {
        border: 'border-white/10',
        bg: 'bg-white/5',
        text: 'text-white/75',
        dot: 'bg-white/35 shadow-[0_0_0_6px_rgba(255,255,255,0.06)]',
        ring: 'rgba(255,255,255,0.08)',
      };
  }
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const el = document.createElement('textarea');
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
  }
}