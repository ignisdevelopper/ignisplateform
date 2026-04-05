/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';

export type AlertResponse = {
  id: string;
  alert_type: string;
  priority: string;
  symbol: string;
  timeframe: string;
  title: string;
  message: string;
  emoji?: string;
  payload: any;
  channels: string[];
  status: string;
  created_at: string;
  sent_at?: string;
};

type AlertEvent = AlertResponse & { timestamp?: string };

type WSIn =
  | { type: 'subscribe'; room: 'alerts' | 'prices' }
  | { type: 'unsubscribe'; room: 'alerts' | 'prices' }
  | { type: 'ping' };

type WSOut =
  | { type: 'alert'; data: AlertEvent }
  | { type: 'pong' }
  | { type: string; data?: any };

export type AlertsFeedMode = 'http' | 'ws' | 'hybrid';

export default function AlertsFeed({
  mode = 'hybrid',
  title = 'Alerts',
  subtitle = 'Live feed + historique récent',
  limit = 50,
  initialFetchLimit,
  autoConnect = true,
  autoFetch = true,
  pollMs = 0,

  apiBase = (process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:8000/api/v1'),
  wsUrl = (process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:8000/ws'),

  defaultRoom = 'alerts',

  linkToAnalysis = true,
  compact = false,

  defaultSymbolFilter = '',
  defaultTypeFilter = '',
  defaultPriorityFilter = '',
  defaultChannelFilter = '',

  onAlertClick,
  onNewAlert,
  className,
}: {
  mode?: AlertsFeedMode;

  title?: string;
  subtitle?: string;

  /** max items kept in memory */
  limit?: number;

  /** how many to fetch initially from HTTP (defaults to limit) */
  initialFetchLimit?: number;

  autoConnect?: boolean;
  autoFetch?: boolean;

  /** if >0 and mode includes http: polling */
  pollMs?: number;

  apiBase?: string;
  wsUrl?: string;

  defaultRoom?: 'alerts';

  linkToAnalysis?: boolean;
  compact?: boolean;

  defaultSymbolFilter?: string;
  defaultTypeFilter?: string;
  defaultPriorityFilter?: string;
  defaultChannelFilter?: string;

  onAlertClick?: (a: AlertEvent) => void;
  onNewAlert?: (a: AlertEvent) => void;

  className?: string;
}) {
  const [alerts, setAlerts] = useState<AlertEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [wsStatus, setWsStatus] = useState<'DISCONNECTED' | 'CONNECTING' | 'CONNECTED'>('DISCONNECTED');
  const [error, setError] = useState<string | null>(null);

  // filters/search
  const [q, setQ] = useState('');
  const [symbolFilter, setSymbolFilter] = useState(defaultSymbolFilter);
  const [typeFilter, setTypeFilter] = useState(defaultTypeFilter);
  const [priorityFilter, setPriorityFilter] = useState(defaultPriorityFilter);
  const [channelFilter, setChannelFilter] = useState(defaultChannelFilter);

  // UX
  const [paused, setPaused] = useState(false);
  const [autoStickLatest, setAutoStickLatest] = useState(true);
  const [showPayload, setShowPayload] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement | null>(null);

  const effectiveInitialFetchLimit = initialFetchLimit ?? limit;

  const computedFilters = useMemo(() => {
    const _q = q.trim().toUpperCase();
    const _symbol = symbolFilter.trim().toUpperCase();
    const _type = typeFilter.trim().toUpperCase();
    const _prio = priorityFilter.trim().toUpperCase();
    const _ch = channelFilter.trim().toUpperCase();

    return { _q, _symbol, _type, _prio, _ch };
  }, [q, symbolFilter, typeFilter, priorityFilter, channelFilter]);

  const filtered = useMemo(() => {
    const { _q, _symbol, _type, _prio, _ch } = computedFilters;

    return alerts.filter((a) => {
      if (_symbol && String(a.symbol ?? '').toUpperCase() !== _symbol) return false;
      if (_type && String(a.alert_type ?? '').toUpperCase() !== _type) return false;
      if (_prio && String(a.priority ?? '').toUpperCase() !== _prio) return false;

      if (_ch) {
        const channels = (a.channels ?? []).map((c) => String(c).toUpperCase());
        if (!channels.includes(_ch)) return false;
      }

      if (_q) {
        const hay = `${a.id} ${a.symbol} ${a.timeframe} ${a.alert_type} ${a.priority} ${a.title} ${a.message} ${(a.channels ?? []).join(',')}`
          .toUpperCase();
        if (!hay.includes(_q)) return false;
      }

      return true;
    });
  }, [alerts, computedFilters]);

  const counts = useMemo(() => {
    const byPriority: Record<string, number> = {};
    const byType: Record<string, number> = {};
    for (const a of alerts) {
      const p = String(a.priority ?? '—').toUpperCase();
      const t = String(a.alert_type ?? '—').toUpperCase();
      byPriority[p] = (byPriority[p] ?? 0) + 1;
      byType[t] = (byType[t] ?? 0) + 1;
    }
    return { byPriority, byType };
  }, [alerts]);

  const scrollToTop = useCallback(() => {
    if (!listRef.current) return;
    listRef.current.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const pushAlert = useCallback((a: AlertEvent) => {
    // stable key: prefer id, otherwise deduce
    const key = a.id ?? `${a.symbol}-${a.alert_type}-${a.created_at}-${a.title}`;
    if (seenRef.current.has(key)) return;
    seenRef.current.add(key);

    setAlerts((prev) => {
      const merged = [a, ...prev];

      // hard cap + keep unique by key
      const out: AlertEvent[] = [];
      const seenLocal = new Set<string>();
      for (const x of merged) {
        const k = x.id ?? `${x.symbol}-${x.alert_type}-${x.created_at}-${x.title}`;
        if (seenLocal.has(k)) continue;
        seenLocal.add(k);
        out.push(x);
        if (out.length >= limit) break;
      }
      return out;
    });

    onNewAlert?.(a);
  }, [limit, onNewAlert]);

  const fetchRecentAlerts = useCallback(async () => {
    if (!autoFetch) return;
    if (mode === 'ws') return;

    setError(null);
    setLoading(true);
    try {
      const url = new URL(`${apiBase}/alerts`);
      url.searchParams.set('limit', String(effectiveInitialFetchLimit));
      url.searchParams.set('offset', '0');

      // (optionnel) server-side filtering if you want:
      if (symbolFilter.trim()) url.searchParams.set('symbol', symbolFilter.trim().toUpperCase());
      if (typeFilter.trim()) url.searchParams.set('alert_type', typeFilter.trim().toUpperCase());
      if (priorityFilter.trim()) url.searchParams.set('priority', priorityFilter.trim().toUpperCase());

      const res = await fetch(url.toString(), { method: 'GET' });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${txt || 'Erreur /alerts'}`);
      }

      const data = await res.json();
      const list: AlertEvent[] =
        (data.alerts ?? data.items ?? data.results ?? data) as AlertEvent[];

      const arr = Array.isArray(list) ? list : [];
      // normalize newest-first
      arr.sort((a, b) => (new Date(b.created_at).getTime() - new Date(a.created_at).getTime()));

      // reset seen + set
      const newSeen = new Set<string>();
      const trimmed = arr.slice(0, limit);

      for (const a of trimmed) {
        const k = a.id ?? `${a.symbol}-${a.alert_type}-${a.created_at}-${a.title}`;
        newSeen.add(k);
      }
      seenRef.current = newSeen;
      setAlerts(trimmed);
    } catch (e: any) {
      setError(e?.message ?? 'Erreur inconnue');
    } finally {
      setLoading(false);
    }
  }, [
    apiBase,
    effectiveInitialFetchLimit,
    limit,
    mode,
    autoFetch,
    symbolFilter,
    typeFilter,
    priorityFilter,
  ]);

  // Polling
  useEffect(() => {
    if (!autoFetch) return;
    if (mode === 'ws') return;
    if (!pollMs || pollMs < 2000) return;

    const t = setInterval(() => {
      if (paused) return;
      fetchRecentAlerts();
    }, pollMs);

    return () => clearInterval(t);
  }, [autoFetch, mode, pollMs, paused, fetchRecentAlerts]);

  // Initial fetch
  useEffect(() => {
    fetchRecentAlerts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // WS connect (hybrid or ws)
  useEffect(() => {
    if (!autoConnect) return;
    if (mode === 'http') return;

    let alive = true;
    let ws: WebSocket | null = null;
    let retry = 0;
    let retryTimer: any = null;

    const connect = () => {
      if (!alive) return;
      setWsStatus('CONNECTING');

      ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!alive) return;
        retry = 0;
        setWsStatus('CONNECTED');

        const sub: WSIn = { type: 'subscribe', room: defaultRoom };
        ws?.send(JSON.stringify(sub));
        ws?.send(JSON.stringify({ type: 'ping' } satisfies WSIn));
      };

      ws.onmessage = (evt) => {
        if (!alive) return;
        try {
          const msg = JSON.parse(evt.data) as WSOut;

          if (msg?.type === 'alert' && msg.data) {
            if (paused) return;
            pushAlert(msg.data as AlertEvent);

            if (autoStickLatest) {
              // scroll feed to top (newest)
              requestAnimationFrame(() => scrollToTop());
            }
          }
        } catch {
          // ignore
        }
      };

      ws.onclose = () => {
        if (!alive) return;
        setWsStatus('DISCONNECTED');

        // reconnect with backoff
        const delay = Math.min(2500 + retry * 1200, 12000);
        retry += 1;
        retryTimer = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // onclose handles retry
      };
    };

    connect();

    return () => {
      alive = false;
      if (retryTimer) clearTimeout(retryTimer);
      try { ws?.close(); } catch {}
      wsRef.current = null;
      setWsStatus('DISCONNECTED');
    };
  }, [autoConnect, mode, wsUrl, defaultRoom, pushAlert, paused, autoStickLatest, scrollToTop]);

  const clearFeed = useCallback(() => {
    seenRef.current = new Set();
    setAlerts([]);
  }, []);

  const exportJson = useCallback(() => {
    const data = JSON.stringify(alerts, null, 2);
    copyToClipboard(data);
  }, [alerts]);

  return (
    <div
      className={cn(
        'rounded-2xl border border-white/10 bg-white/5 backdrop-blur-[20px] shadow-[0_25px_80px_rgba(0,0,0,0.55)] overflow-hidden',
        className
      )}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {/* Header */}
      <div className="border-b border-white/10 bg-black/20 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="text-sm font-semibold text-white/90">{title}</div>

              <span className={cn('rounded-full border px-2.5 py-1 text-[11px] font-medium', wsPill(wsStatus, mode))}>
                {mode === 'http' ? 'HTTP' : `WS: ${wsStatus}`}
              </span>

              <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/70">
                {filtered.length}/{alerts.length}
              </span>

              {paused && (
                <span className="rounded-full border border-amber-500/25 bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-200">
                  paused (hover)
                </span>
              )}
            </div>

            <div className="text-xs text-white/60 mt-1 truncate">{subtitle}</div>
          </div>

          <div className="flex items-center gap-2">
            <ToggleButton
              label="Stick latest"
              value={autoStickLatest}
              onClick={() => setAutoStickLatest((p) => !p)}
            />
            <ToggleButton
              label="Payload"
              value={showPayload}
              onClick={() => setShowPayload((p) => !p)}
            />

            <button
              onClick={fetchRecentAlerts}
              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition"
              title="Reload HTTP recent alerts"
            >
              Reload
            </button>

            <button
              onClick={clearFeed}
              className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200 hover:bg-rose-500/15 transition"
              title="Clear feed (local only)"
            >
              Clear
            </button>
          </div>
        </div>

        {/* Controls */}
        <div className={cn('mt-3 grid grid-cols-1 gap-3 md:grid-cols-12', compact && 'md:grid-cols-12')}>
          <div className={cn(compact ? 'md:col-span-5' : 'md:col-span-6')}>
            <label className="block text-xs text-white/60 mb-1">Search</label>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="BTC / SETUP / CRITICAL…"
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
            />
          </div>

          <div className={cn(compact ? 'md:col-span-2' : 'md:col-span-2')}>
            <label className="block text-xs text-white/60 mb-1">Symbol</label>
            <input
              value={symbolFilter}
              onChange={(e) => setSymbolFilter(e.target.value)}
              placeholder="BTCUSDT"
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
            />
          </div>

          <div className={cn(compact ? 'md:col-span-2' : 'md:col-span-2')}>
            <label className="block text-xs text-white/60 mb-1">Type</label>
            <input
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              placeholder="SETUP"
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
            />
          </div>

          <div className={cn(compact ? 'md:col-span-2' : 'md:col-span-2')}>
            <label className="block text-xs text-white/60 mb-1">Priority</label>
            <input
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value)}
              placeholder="HIGH"
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
            />
          </div>

          <div className={cn(compact ? 'md:col-span-1' : 'md:col-span-12 lg:col-span-2')}>
            <label className="block text-xs text-white/60 mb-1">Channel</label>
            <input
              value={channelFilter}
              onChange={(e) => setChannelFilter(e.target.value)}
              placeholder="TELEGRAM"
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
            />
          </div>
        </div>

        {/* Quick stats */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {Object.entries(counts.byPriority)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([p, n]) => (
              <span
                key={p}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-[11px] font-medium',
                  priorityPill(p)
                )}
                title="Click to filter"
                onClick={() => setPriorityFilter(p === priorityFilter.toUpperCase() ? '' : p)}
                style={{ cursor: 'pointer' }}
              >
                {p} · {n}
              </span>
            ))}

          <span className="mx-1 text-white/20">·</span>

          {Object.entries(counts.byType)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([t, n]) => (
              <span
                key={t}
                className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/70 hover:bg-white/10 transition"
                title="Click to filter"
                onClick={() => setTypeFilter(t === typeFilter.toUpperCase() ? '' : t)}
                style={{ cursor: 'pointer' }}
              >
                {t} · {n}
              </span>
            ))}

          <span className="ml-auto flex items-center gap-2">
            <button
              onClick={exportJson}
              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/75 hover:bg-white/10 transition"
              title="Copy JSON to clipboard"
            >
              Copy JSON
            </button>
          </span>
        </div>

        {(error || loading) && (
          <div className="mt-3">
            {loading && (
              <div className="rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white/70">
                Loading…
              </div>
            )}
            {error && (
              <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                {error}
              </div>
            )}
          </div>
        )}
      </div>

      {/* List */}
      <div
        ref={listRef}
        className={cn(
          'max-h-[620px] overflow-auto p-4 space-y-2',
          compact && 'max-h-[520px]'
        )}
      >
        {!filtered.length && (
          <div className="rounded-xl border border-white/10 bg-black/20 p-4 text-sm text-white/60">
            Aucun résultat (essaie de vider les filtres).
          </div>
        )}

        <AnimatePresence initial={false}>
          {filtered.map((a) => (
            <motion.div
              key={a.id ?? `${a.symbol}-${a.alert_type}-${a.created_at}-${a.title}`}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="rounded-2xl border border-white/10 bg-black/20 p-4"
              onClick={() => onAlertClick?.(a)}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={cn('rounded-full border px-2.5 py-1 text-[11px] font-medium', priorityPill(a.priority))}>
                      {String(a.priority ?? '—').toUpperCase()}
                    </span>

                    <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/70">
                      {String(a.alert_type ?? '—').toUpperCase()}
                    </span>

                    <span className="text-sm font-semibold text-white/90 truncate">
                      {a.title || 'Alert'}
                    </span>

                    {a.emoji && <span className="text-sm">{a.emoji}</span>}
                  </div>

                  <div className="mt-1 text-xs text-white/65">
                    <span className="text-white/80 font-medium">{a.symbol}</span>
                    <span className="text-white/35"> · </span>
                    <span className="text-white/70">{a.timeframe}</span>
                    <span className="text-white/35"> · </span>
                    <span className="text-white/55">{fmtDate(a.created_at)}</span>
                  </div>

                  <div className="mt-2 text-sm text-white/80 whitespace-pre-wrap leading-relaxed">
                    {a.message}
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {(a.channels ?? []).slice(0, 4).map((ch) => (
                      <span
                        key={ch}
                        className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/70"
                      >
                        {String(ch).toUpperCase()}
                      </span>
                    ))}

                    <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/60">
                      status: {String(a.status ?? '—')}
                    </span>

                    {a.sent_at && (
                      <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/60">
                        sent: {fmtDate(a.sent_at)}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex flex-col items-end gap-2">
                  {linkToAnalysis && a.symbol && (
                    <Link
                      href={`/analysis/${encodeURIComponent(a.symbol)}`}
                      className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-white/85 hover:bg-white/10 transition"
                      onClick={(e) => e.stopPropagation()}
                    >
                      Open →
                    </Link>
                  )}

                  <button
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition"
                    onClick={(e) => {
                      e.stopPropagation();
                      copyToClipboard(`${a.title}\n${a.symbol} ${a.timeframe}\n${a.message}`);
                    }}
                    title="Copy alert"
                  >
                    Copy
                  </button>
                </div>
              </div>

              {showPayload && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs text-white/60 hover:text-white/80 transition">
                    Payload JSON
                  </summary>
                  <pre className="mt-2 rounded-xl border border-white/10 bg-black/30 p-3 text-xs text-white/75 overflow-auto max-h-[320px]">
                    {JSON.stringify(a.payload ?? {}, null, 2)}
                  </pre>
                </details>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Footer */}
      <div className="border-t border-white/10 bg-black/15 px-4 py-3 flex items-center justify-between gap-3">
        <div className="text-[11px] text-white/50">
          Mode: <span className="text-white/70">{mode}</span>
          <span className="mx-2 text-white/25">·</span>
          API: <span className="text-white/60">{apiBase}</span>
        </div>

        <button
          onClick={scrollToTop}
          className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/75 hover:bg-white/10 transition"
        >
          Top
        </button>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   UI helpers
────────────────────────────────────────────────────────────── */

function cn(...classes: Array<string | undefined | null | false>) {
  return classes.filter(Boolean).join(' ');
}

function wsPill(wsStatus: 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED', mode: AlertsFeedMode) {
  if (mode === 'http') return 'border-white/10 bg-white/5 text-white/70';
  if (wsStatus === 'CONNECTED') return 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200';
  if (wsStatus === 'CONNECTING') return 'border-sky-500/20 bg-sky-500/10 text-sky-200';
  return 'border-rose-500/20 bg-rose-500/10 text-rose-200';
}

function priorityPill(priority: string) {
  const p = String(priority ?? '').toUpperCase();
  if (p === 'CRITICAL') return 'border-rose-500/25 bg-rose-500/10 text-rose-200';
  if (p === 'HIGH') return 'border-orange-500/25 bg-orange-500/10 text-orange-200';
  if (p === 'MEDIUM') return 'border-sky-500/25 bg-sky-500/10 text-sky-200';
  if (p === 'LOW') return 'border-white/10 bg-white/5 text-white/70';
  return 'border-white/10 bg-white/5 text-white/70';
}

function ToggleButton({
  label,
  value,
  onClick,
}: {
  label: string;
  value: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-medium transition',
        value ? 'border-[#E85D1A]/30 bg-[#E85D1A]/10 text-white' : 'border-white/10 bg-white/5 text-white/70 hover:bg-white/10'
      )}
    >
      <span>{label}</span>
      <span
        className={cn(
          'h-2.5 w-2.5 rounded-full',
          value ? 'bg-[#E85D1A]' : 'bg-white/30'
        )}
      />
    </button>
  );
}

function fmtDate(iso: string | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('fr-FR', { hour12: false });
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