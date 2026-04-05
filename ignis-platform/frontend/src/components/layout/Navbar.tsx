'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';

type StatusState = 'ONLINE' | 'OFFLINE' | 'CONNECTING' | 'DEGRADED' | 'UNKNOWN';

type Breadcrumb = { label: string; href?: string };

type NavbarAction =
  | { key: 'scanner'; label: string; href: string; onClick?: () => void }
  | { key: 'ai'; label: string; href: string; onClick?: () => void }
  | { key: 'journal'; label: string; href: string; onClick?: () => void }
  | { key: 'settings'; label: string; href: string; onClick?: () => void }
  | { key: string; label: string; href?: string; onClick?: () => void };

type AIStatusResponse = {
  ollama_online: boolean;
  model: string;
  host: string;
  version?: string;
};

const DEFAULT_API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:8000/api/v1';

const DEFAULT_WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:8000/ws';

function cn(...classes: Array<string | undefined | null | false>) {
  return classes.filter(Boolean).join(' ');
}

function fmtDateTime(d = new Date()) {
  return d.toLocaleString('fr-FR', { hour12: false });
}

function withTimeout<T>(p: Promise<T>, ms: number) {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout ${ms}ms`)), ms);
    p.then((v) => {
      clearTimeout(t);
      resolve(v);
    }).catch((e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

function mapWsReadyState(rs: number): StatusState {
  // WebSocket.readyState: 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED
  if (rs === 0) return 'CONNECTING';
  if (rs === 1) return 'ONLINE';
  if (rs === 2) return 'DEGRADED';
  if (rs === 3) return 'OFFLINE';
  return 'UNKNOWN';
}

function statusPalette(state: StatusState) {
  switch (state) {
    case 'ONLINE':
      return {
        border: 'border-emerald-500/20',
        bg: 'bg-emerald-500/10',
        text: 'text-emerald-100',
        dot: 'bg-emerald-400',
        ring: 'rgba(16,185,129,0.18)',
      };
    case 'CONNECTING':
      return {
        border: 'border-sky-500/20',
        bg: 'bg-sky-500/10',
        text: 'text-sky-100',
        dot: 'bg-sky-400',
        ring: 'rgba(56,189,248,0.18)',
      };
    case 'DEGRADED':
      return {
        border: 'border-amber-500/20',
        bg: 'bg-amber-500/10',
        text: 'text-amber-100',
        dot: 'bg-amber-400',
        ring: 'rgba(245,158,11,0.18)',
      };
    case 'OFFLINE':
      return {
        border: 'border-rose-500/20',
        bg: 'bg-rose-500/10',
        text: 'text-rose-100',
        dot: 'bg-rose-400',
        ring: 'rgba(244,63,94,0.18)',
      };
    case 'UNKNOWN':
    default:
      return {
        border: 'border-white/10',
        bg: 'bg-white/5',
        text: 'text-white/75',
        dot: 'bg-white/35',
        ring: 'rgba(255,255,255,0.08)',
      };
  }
}

function StatusBadge({
  label,
  state,
  subtitle,
}: {
  label: string;
  state: StatusState;
  subtitle?: string;
}) {
  const pal = statusPalette(state);

  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 rounded-2xl border px-3 py-1.5 text-xs font-medium backdrop-blur-[14px]',
        pal.border,
        pal.bg,
        pal.text
      )}
      style={{ boxShadow: `0 0 0 1px ${pal.ring} inset` }}
      title={`${label}: ${state}${subtitle ? ` · ${subtitle}` : ''}`}
    >
      <span className={cn('h-2.5 w-2.5 rounded-full', pal.dot)} />
      <span className="tracking-wide">{label}</span>
      <span className="text-white/25">·</span>
      <span className="font-semibold">{state}</span>
      {subtitle && (
        <>
          <span className="text-white/20">·</span>
          <span className="text-white/70">{subtitle}</span>
        </>
      )}
    </span>
  );
}

export default function Navbar({
  title = 'IGNIS',
  subtitle = 'Supply & Demand Intelligence',
  breadcrumbs = [],

  showSearch = true,
  searchPlaceholder = 'Search symbols, pages, alerts…',
  searchValue,
  onSearchChange,
  onSearchSubmit,

  actions,
  rightSlot,

  apiBase = DEFAULT_API_BASE,
  wsUrl = DEFAULT_WS_URL,

  showSystemStatus = true,
  enableWsProbe = false,
  wsStatus: wsStatusProp,

  onToggleSidebar,

  className,
}: {
  title?: string;
  subtitle?: string;
  breadcrumbs?: Breadcrumb[];

  showSearch?: boolean;
  searchPlaceholder?: string;
  searchValue?: string;
  onSearchChange?: (v: string) => void;
  onSearchSubmit?: (v: string) => void;

  actions?: NavbarAction[];
  rightSlot?: React.ReactNode;

  apiBase?: string;
  wsUrl?: string;

  /** show API/WS/Ollama badges */
  showSystemStatus?: boolean;

  /**
   * If true, Navbar will open its own WS connection only to show status.
   * Prefer providing `wsStatus` from your global WS manager to avoid multiple connections.
   */
  enableWsProbe?: boolean;

  /** externally controlled WS status (recommended) */
  wsStatus?: StatusState;

  onToggleSidebar?: () => void;

  className?: string;
}) {
  const [query, setQuery] = useState('');
  const q = searchValue ?? query;

  const [menuOpen, setMenuOpen] = useState(false);

  // statuses
  const [apiStatus, setApiStatus] = useState<StatusState>('UNKNOWN');
  const [ollamaStatus, setOllamaStatus] = useState<StatusState>('UNKNOWN');
  const [ollamaModel, setOllamaModel] = useState<string>('');
  const [wsStatusLocal, setWsStatusLocal] = useState<StatusState>('UNKNOWN');

  // time
  const [now, setNow] = useState(() => new Date());

  const wsRef = useRef<WebSocket | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const effectiveActions: NavbarAction[] = useMemo(() => {
    return actions?.length
      ? actions
      : [
          { key: 'scanner', label: 'Scanner', href: '/scanner' },
          { key: 'ai', label: 'AI', href: '/ai' },
          { key: 'journal', label: 'Journal', href: '/journal' },
          { key: 'settings', label: 'Settings', href: '/settings' },
        ];
  }, [actions]);

  const wsState = wsStatusProp ?? wsStatusLocal;

  const submitSearch = useCallback(() => {
    const v = (q ?? '').trim();
    if (!v) return;
    onSearchSubmit?.(v);
  }, [q, onSearchSubmit]);

  // keyboard shortcuts: "/" focus search, "Esc" close menu
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);

      if (e.key === '/' && showSearch) {
        const ae = document.activeElement as HTMLElement | null;
        const tag = ae?.tagName?.toLowerCase();
        const typing = tag === 'input' || tag === 'textarea';
        if (typing) return;
        e.preventDefault();
        const el = document.getElementById('ignis-navbar-search') as HTMLInputElement | null;
        el?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showSearch]);

  // click outside to close menu
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!menuOpen) return;
      const t = e.target as Node;
      if (menuRef.current && !menuRef.current.contains(t)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menuOpen]);

  // ticking clock
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // API + Ollama status polling
  useEffect(() => {
    if (!showSystemStatus) return;

    let alive = true;

    const probe = async () => {
      // API probe: /assets/stats (cheap and reliable in your backend)
      try {
        const res = await withTimeout(fetch(`${apiBase}/assets/stats`, { method: 'GET' }), 3000);
        if (!alive) return;
        setApiStatus(res.ok ? 'ONLINE' : 'OFFLINE');
      } catch {
        if (!alive) return;
        setApiStatus('OFFLINE');
      }

      // Ollama probe: /ai/status
      try {
        const res = await withTimeout(fetch(`${apiBase}/ai/status`, { method: 'GET' }), 3500);
        if (!alive) return;
        if (!res.ok) {
          setOllamaStatus('DEGRADED');
          setOllamaModel('');
        } else {
          const data = (await res.json()) as AIStatusResponse;
          setOllamaStatus(data.ollama_online ? 'ONLINE' : 'OFFLINE');
          setOllamaModel(data.model ?? '');
        }
      } catch {
        if (!alive) return;
        setOllamaStatus('OFFLINE');
        setOllamaModel('');
      }
    };

    probe();
    const t = setInterval(probe, 20_000);

    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [apiBase, showSystemStatus]);

  // WS probe (optional)
  useEffect(() => {
    if (!showSystemStatus) return;
    if (!enableWsProbe) return;
    if (wsStatusProp) return; // if parent provides, do not probe

    let alive = true;
    let retry = 0;
    let retryTimer: any = null;

    const connect = () => {
      if (!alive) return;

      try {
        setWsStatusLocal('CONNECTING');

        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          if (!alive) return;
          retry = 0;
          setWsStatusLocal(mapWsReadyState(ws.readyState));
          ws.send(JSON.stringify({ type: 'ping' }));
        };

        ws.onmessage = () => {
          // no-op, we only show status
        };

        ws.onerror = () => {
          // onclose handles retry
        };

        ws.onclose = () => {
          if (!alive) return;
          setWsStatusLocal('OFFLINE');

          const delay = Math.min(2500 + retry * 1200, 12_000);
          retry += 1;
          retryTimer = setTimeout(connect, delay);
        };
      } catch {
        setWsStatusLocal('OFFLINE');
      }
    };

    connect();

    return () => {
      alive = false;
      if (retryTimer) clearTimeout(retryTimer);
      try {
        wsRef.current?.close();
      } catch {}
      wsRef.current = null;
    };
  }, [wsUrl, enableWsProbe, showSystemStatus, wsStatusProp]);

  return (
    <div
      className={cn(
        'sticky top-0 z-40',
        className
      )}
    >
      <div className="rounded-3xl border border-white/10 bg-white/5 backdrop-blur-[22px] shadow-[0_25px_80px_rgba(0,0,0,0.55)] overflow-hidden">
        {/* Top row */}
        <div className="border-b border-white/10 bg-black/20 px-5 py-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            {/* Left */}
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                {onToggleSidebar && (
                  <button
                    type="button"
                    onClick={onToggleSidebar}
                    className="rounded-xl border border-white/10 bg-white/5 p-2 text-white/80 hover:bg-white/10 transition"
                    title="Toggle sidebar"
                  >
                    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none">
                      <path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    </svg>
                  </button>
                )}

                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="text-base font-semibold text-white/90 truncate">{title}</div>
                    <span className="rounded-full border border-white/10 bg-black/20 px-2.5 py-1 text-[11px] text-white/65">
                      {fmtDateTime(now)}
                    </span>
                  </div>

                  <div className="text-xs text-white/60 mt-1 truncate">{subtitle}</div>

                  {breadcrumbs.length > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-white/50">
                      {breadcrumbs.map((b, i) => (
                        <React.Fragment key={`${b.label}-${i}`}>
                          {i > 0 && <span className="text-white/25">/</span>}
                          {b.href ? (
                            <Link href={b.href} className="hover:text-white/80 transition">
                              {b.label}
                            </Link>
                          ) : (
                            <span className="text-white/70">{b.label}</span>
                          )}
                        </React.Fragment>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Right */}
            <div className="flex flex-wrap items-center gap-2 justify-between lg:justify-end">
              {showSystemStatus && (
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge label="API" state={apiStatus} subtitle=":8000" />
                  <StatusBadge label="WS" state={wsState} subtitle="live" />
                  <StatusBadge label="OLLAMA" state={ollamaStatus} subtitle={ollamaModel || '—'} />
                </div>
              )}

              <div className="flex items-center gap-2">
                {rightSlot}

                <div className="relative" ref={menuRef}>
                  <button
                    type="button"
                    onClick={() => setMenuOpen((p) => !p)}
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-white/80 hover:bg-white/10 transition"
                    title="Quick menu"
                  >
                    Menu
                  </button>

                  <AnimatePresence>
                    {menuOpen && (
                      <motion.div
                        initial={{ opacity: 0, y: 8, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 8, scale: 0.98 }}
                        className="absolute right-0 mt-2 w-[320px] rounded-2xl border border-white/10 bg-[#0A0A0F]/75 backdrop-blur-[22px] shadow-[0_30px_100px_rgba(0,0,0,0.7)] overflow-hidden"
                      >
                        <div className="px-4 py-3 border-b border-white/10 bg-black/20">
                          <div className="text-sm font-semibold text-white/90">Quick actions</div>
                          <div className="text-xs text-white/60 mt-1">
                            Raccourcis + outils.
                          </div>
                        </div>

                        <div className="p-3 space-y-2">
                          <MenuLink href="/" label="Dashboard" desc="Watchlist + live alerts" />
                          <MenuLink href="/scanner" label="Scanner" desc="Multi-symbols & filters" />
                          <MenuLink href="/analysis/BTCUSDT" label="Analysis (BTCUSDT)" desc="Chart + zones + panels" />
                          <MenuLink href="/journal" label="Journal" desc="Trades + stats P&L" />
                          <MenuLink href="/ai" label="AI" desc="Chat + report generation" />
                          <MenuLink href="/settings" label="Settings" desc="Assets + alerts + Ollama" />

                          <div className="h-px bg-white/10 my-2" />

                          <button
                            type="button"
                            onClick={async () => {
                              await copyToClipboard(apiBase);
                              setMenuOpen(false);
                            }}
                            className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-left text-xs text-white/80 hover:bg-white/10 transition"
                          >
                            Copy API base
                            <div className="text-[11px] text-white/50 mt-0.5 break-all">{apiBase}</div>
                          </button>

                          <a
                            href={apiBase.replace(/\/api\/v1$/, '') + '/docs'}
                            target="_blank"
                            rel="noreferrer"
                            className="block w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-left text-xs text-white/80 hover:bg-white/10 transition"
                          >
                            Open Swagger
                            <div className="text-[11px] text-white/50 mt-0.5">
                              Backend docs
                            </div>
                          </a>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom row: search + actions */}
        <div className="px-5 py-4">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-12 lg:items-center">
            {showSearch && (
              <div className="lg:col-span-6">
                <label className="block text-xs text-white/60 mb-1">Search</label>
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <input
                      id="ignis-navbar-search"
                      value={q}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (onSearchChange) onSearchChange(v);
                        else setQuery(v);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') submitSearch();
                      }}
                      placeholder={searchPlaceholder}
                      className="w-full rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-white/90 outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
                    />
                    <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-white/45">
                      /
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={submitSearch}
                    className="rounded-2xl border border-white/10 bg-gradient-to-b from-[#E85D1A]/85 to-[#E85D1A]/35 px-4 py-3 text-sm font-semibold text-white hover:from-[#E85D1A] hover:to-[#E85D1A]/45 transition"
                  >
                    Go
                  </button>
                </div>

                <div className="mt-2 text-[11px] text-white/50">
                  Tip: tape <span className="text-white/70">/</span> pour focus la recherche · Enter pour valider.
                </div>
              </div>
            )}

            <div className={cn(showSearch ? 'lg:col-span-6' : 'lg:col-span-12')}>
              <div className="flex items-end justify-between gap-3">
                <div className="text-xs text-white/60">
                  Quick navigation
                </div>
                <div className="text-[11px] text-white/45">
                  Glass UI · Dark-only
                </div>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2">
                {effectiveActions.map((a) => {
                  const content = (
                    <span className="inline-flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-white/40" />
                      <span>{a.label}</span>
                      <span className="text-white/35">→</span>
                    </span>
                  );

                  if (a.href) {
                    return (
                      <Link
                        key={a.key}
                        href={a.href}
                        className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/85 hover:bg-white/10 transition"
                      >
                        {content}
                      </Link>
                    );
                  }

                  return (
                    <button
                      key={a.key}
                      type="button"
                      onClick={a.onClick}
                      className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/85 hover:bg-white/10 transition"
                    >
                      {content}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* subtle spacer shadow under navbar */}
      <div className="h-4" />
    </div>
  );
}

function MenuLink({ href, label, desc }: { href: string; label: string; desc: string }) {
  return (
    <Link
      href={href}
      className="block rounded-2xl border border-white/10 bg-white/5 px-3 py-2 hover:bg-white/10 transition"
    >
      <div className="text-xs font-semibold text-white/90">{label}</div>
      <div className="text-[11px] text-white/55 mt-0.5">{desc}</div>
    </Link>
  );
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