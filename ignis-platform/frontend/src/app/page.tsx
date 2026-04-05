/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';

/* ──────────────────────────────────────────────────────────────
   Config
────────────────────────────────────────────────────────────── */

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:8000/api/v1';

const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:8000/ws';

/* ──────────────────────────────────────────────────────────────
   Types (best-effort based on your schemas)
────────────────────────────────────────────────────────────── */

type SetupStatus = 'VALID' | 'PENDING' | 'INVALID' | 'WATCH' | 'EXPIRED';
type ZoneType = 'DEMAND' | 'SUPPLY' | 'FLIPPY_D' | 'FLIPPY_S' | 'HIDDEN_D' | 'HIDDEN_S';
type PAPattern = 'ACCU' | 'THREE_DRIVES' | 'FTL' | 'PATTERN_69' | 'HIDDEN_SDE' | 'NONE';

type AssetClass = 'CRYPTO' | 'STOCK' | 'FOREX' | 'COMMODITY' | 'INDEX' | 'ETF' | 'OTHER';

interface AssetResponse {
  symbol: string;
  asset_class: string;
  name: string;
  exchange: string;
  active: boolean;
  last_price?: number;
  last_analysis_at?: string;
  setup?: {
    status: SetupStatus;
    score: number;
    zone_type?: ZoneType;
    pa_pattern?: PAPattern;
    rr?: number;
  };
  created_at: string;
  updated_at: string;
  meta?: any;
}

interface AssetsListResponse {
  total: number;
  assets: AssetResponse[];
  page?: number;
  page_size?: number;
}

interface AssetStatsResponse {
  total: number;
  active: number;
  by_class: Record<string, number>;
  with_analysis: number;
  valid_setups: number;
  pending_setups: number;
}

interface AlertResponse {
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
}

type AlertEvent = AlertResponse & { timestamp?: string };

type WSIn =
  | { type: 'subscribe'; room: 'alerts' | 'prices' }
  | { type: 'unsubscribe'; room: 'alerts' | 'prices' }
  | { type: 'ping' };

type WSOut =
  | { type: 'alert'; data: AlertEvent }
  | { type: 'price_update'; data: { symbol: string; price: number; timestamp: string | number } }
  | { type: 'pong' }
  | { type: string; data?: any };

/* ──────────────────────────────────────────────────────────────
   Helpers
────────────────────────────────────────────────────────────── */

function cn(...classes: Array<string | undefined | null | false>) {
  return classes.filter(Boolean).join(' ');
}

function fmt(n: number | undefined, digits = 2) {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits }).format(n);
}

function fmtDate(iso: string | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('fr-FR', { hour12: false });
}

function statusPill(status: SetupStatus) {
  switch (status) {
    case 'VALID':
      return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200';
    case 'PENDING':
      return 'border-sky-500/25 bg-sky-500/10 text-sky-200';
    case 'WATCH':
      return 'border-amber-500/25 bg-amber-500/10 text-amber-200';
    case 'INVALID':
      return 'border-rose-500/25 bg-rose-500/10 text-rose-200';
    case 'EXPIRED':
      return 'border-zinc-500/25 bg-zinc-500/10 text-zinc-200';
    default:
      return 'border-white/10 bg-white/5 text-white/70';
  }
}

function priorityPill(priority: string) {
  const p = (priority ?? '').toUpperCase();
  if (p === 'CRITICAL') return 'border-rose-500/25 bg-rose-500/10 text-rose-200';
  if (p === 'HIGH') return 'border-orange-500/25 bg-orange-500/10 text-orange-200';
  if (p === 'MEDIUM') return 'border-sky-500/25 bg-sky-500/10 text-sky-200';
  return 'border-white/10 bg-white/5 text-white/70';
}

function zoneColor(z?: ZoneType) {
  if (!z) return 'rgba(255,255,255,0.35)';
  const m: Record<ZoneType, string> = {
    DEMAND: '#1D9E75',
    SUPPLY: '#E24B4A',
    FLIPPY_D: '#378ADD',
    FLIPPY_S: '#E85D1A',
    HIDDEN_D: '#2AD4A5',
    HIDDEN_S: '#FF6B6A',
  };
  return m[z] ?? 'rgba(255,255,255,0.35)';
}

function scoreGradient(score: number) {
  if (score >= 85) return 'from-emerald-400/55 to-emerald-700/10';
  if (score >= 70) return 'from-orange-400/55 to-orange-700/10';
  if (score >= 55) return 'from-amber-400/55 to-amber-700/10';
  return 'from-rose-400/55 to-rose-700/10';
}

/* ──────────────────────────────────────────────────────────────
   Dashboard page
────────────────────────────────────────────────────────────── */

export default function DashboardPage() {
  // navigation / filters
  const [assetClass, setAssetClass] = useState<AssetClass | 'ALL'>('CRYPTO');
  const [activeOnly, setActiveOnly] = useState<boolean>(true);
  const [query, setQuery] = useState<string>('');
  const [limit, setLimit] = useState<number>(60);
  const [offset, setOffset] = useState<number>(0);

  // data
  const [assetsLoading, setAssetsLoading] = useState<boolean>(false);
  const [assetsTotal, setAssetsTotal] = useState<number>(0);
  const [assets, setAssets] = useState<AssetResponse[]>([]);
  const [statsLoading, setStatsLoading] = useState<boolean>(false);
  const [stats, setStats] = useState<AssetStatsResponse | null>(null);

  // alerts
  const [alertsLoading, setAlertsLoading] = useState<boolean>(false);
  const [alerts, setAlerts] = useState<AlertEvent[]>([]);
  const [alertLimit, setAlertLimit] = useState<number>(30);

  // ws
  const wsRef = useRef<WebSocket | null>(null);
  const [wsStatus, setWsStatus] = useState<'DISCONNECTED' | 'CONNECTING' | 'CONNECTED'>('DISCONNECTED');

  // UX
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const page = useMemo(() => Math.floor(offset / limit) + 1, [offset, limit]);
  const pageCount = useMemo(() => Math.max(1, Math.ceil(assetsTotal / limit)), [assetsTotal, limit]);

  const filteredAssets = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return assets;
    return assets.filter((a) => {
      const hay = `${a.symbol} ${a.name ?? ''} ${a.exchange ?? ''} ${a.asset_class ?? ''}`.toUpperCase();
      return hay.includes(q);
    });
  }, [assets, query]);

  const keyKPIs = useMemo(() => {
    const valid = stats?.valid_setups ?? 0;
    const pending = stats?.pending_setups ?? 0;
    const active = stats?.active ?? 0;
    const withAnalysis = stats?.with_analysis ?? 0;
    const coverage = active > 0 ? Math.round((withAnalysis / active) * 100) : 0;

    return { valid, pending, active, withAnalysis, coverage };
  }, [stats]);

  /* ──────────────────────────────────────────────────────────────
     Fetchers
  ─────────────────────────────────────────────────────────────── */

  const fetchAssets = useCallback(async () => {
    setError(null);
    setAssetsLoading(true);
    try {
      const url = new URL(`${API_BASE}/assets`);
      if (assetClass !== 'ALL') url.searchParams.set('asset_class', assetClass);
      url.searchParams.set('active', activeOnly ? 'true' : 'false');
      url.searchParams.set('limit', String(limit));
      url.searchParams.set('offset', String(offset));

      const res = await fetch(url.toString(), { method: 'GET' });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${txt || 'Erreur assets'}`);
      }

      const data = (await res.json()) as AssetsListResponse;
      setAssets(data.assets ?? []);
      setAssetsTotal(Number(data.total ?? (data.assets?.length ?? 0)));
    } catch (e: any) {
      setError(e?.message ?? 'Erreur inconnue (assets)');
    } finally {
      setAssetsLoading(false);
    }
  }, [assetClass, activeOnly, limit, offset]);

  const fetchStats = useCallback(async () => {
    setError(null);
    setStatsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/assets/stats`, { method: 'GET' });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${txt || 'Erreur stats'}`);
      }
      const data = (await res.json()) as AssetStatsResponse;
      setStats(data);
    } catch (e: any) {
      setError(e?.message ?? 'Erreur inconnue (stats)');
    } finally {
      setStatsLoading(false);
    }
  }, []);

  const fetchRecentAlerts = useCallback(async () => {
    setError(null);
    setAlertsLoading(true);
    try {
      const url = new URL(`${API_BASE}/alerts`);
      url.searchParams.set('limit', String(alertLimit));
      url.searchParams.set('offset', '0');

      const res = await fetch(url.toString(), { method: 'GET' });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${txt || 'Erreur alerts'}`);
      }

      const data = await res.json();
      const list = (data.alerts ?? data.items ?? data.results ?? data ?? []) as AlertEvent[];
      setAlerts(Array.isArray(list) ? list : []);
    } catch (e: any) {
      setError(e?.message ?? 'Erreur inconnue (alerts)');
    } finally {
      setAlertsLoading(false);
    }
  }, [alertLimit]);

  const refreshAll = useCallback(async () => {
    setNotice(null);
    await Promise.all([fetchAssets(), fetchStats(), fetchRecentAlerts()]);
    setNotice('Données rafraîchies.');
    setTimeout(() => setNotice(null), 2200);
  }, [fetchAssets, fetchStats, fetchRecentAlerts]);

  /* ──────────────────────────────────────────────────────────────
     Actions
  ─────────────────────────────────────────────────────────────── */

  const refreshAsset = useCallback(async (symbol: string) => {
    setError(null);
    setNotice(null);

    try {
      const res = await fetch(`${API_BASE}/assets/${encodeURIComponent(symbol)}/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeframe: 'H4', force: false }),
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${txt || 'Erreur refresh asset'}`);
      }

      setNotice(`Refresh demandé: ${symbol}`);
      setTimeout(() => setNotice(null), 2200);

      // refresh list to reflect last_analysis_at changes soon
      await fetchAssets();
      await fetchStats();
    } catch (e: any) {
      setError(e?.message ?? 'Erreur refresh asset');
    }
  }, [fetchAssets, fetchStats]);

  /* ──────────────────────────────────────────────────────────────
     Effects: initial load + auto refresh
  ─────────────────────────────────────────────────────────────── */

  useEffect(() => {
    fetchAssets();
  }, [fetchAssets]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  useEffect(() => {
    fetchRecentAlerts();
  }, [fetchRecentAlerts]);

  // optional periodic refresh (light): stats + alerts
  useEffect(() => {
    const t = setInterval(() => {
      fetchStats();
      fetchRecentAlerts();
    }, 30_000);
    return () => clearInterval(t);
  }, [fetchStats, fetchRecentAlerts]);

  /* ──────────────────────────────────────────────────────────────
     WebSocket: live alerts + price updates
  ─────────────────────────────────────────────────────────────── */

  useEffect(() => {
    let alive = true;
    let ws: WebSocket | null = null;
    let retry = 0;
    let retryTimer: any = null;

    const connect = () => {
      if (!alive) return;
      setWsStatus('CONNECTING');

      ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!alive) return;
        retry = 0;
        setWsStatus('CONNECTED');
        const subAlerts: WSIn = { type: 'subscribe', room: 'alerts' };
        const subPrices: WSIn = { type: 'subscribe', room: 'prices' };
        ws?.send(JSON.stringify(subAlerts));
        ws?.send(JSON.stringify(subPrices));
        ws?.send(JSON.stringify({ type: 'ping' } satisfies WSIn));
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data) as WSOut;

          if (msg?.type === 'alert' && msg.data) {
            const ev = msg.data as AlertEvent;
            setAlerts((prev) => {
              const merged = [ev, ...prev];
              // dedupe by id if present
              const seen = new Set<string>();
              const out: AlertEvent[] = [];
              for (const a of merged) {
                const key = a.id ?? `${a.symbol}-${a.title}-${a.created_at}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push(a);
                if (out.length >= alertLimit) break;
              }
              return out;
            });
          }

          if (msg?.type === 'price_update' && msg.data) {
            const { symbol, price } = msg.data as any;
            if (!symbol || typeof price !== 'number') return;
            const sym = String(symbol).toUpperCase();

            // update asset price locally (if present)
            setAssets((prev) =>
              prev.map((a) => (a.symbol.toUpperCase() === sym ? { ...a, last_price: price } : a))
            );
          }
        } catch {
          // ignore non-json
        }
      };

      ws.onclose = () => {
        if (!alive) return;
        setWsStatus('DISCONNECTED');

        const delay = Math.min(3000 + retry * 1500, 12_000);
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
    };
  }, [alertLimit]);

  /* ──────────────────────────────────────────────────────────────
     Render
  ─────────────────────────────────────────────────────────────── */

  return (
    <div className="min-h-screen bg-[#0A0A0F] text-white">
      {/* background glow */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-24 left-1/3 h-[420px] w-[420px] rounded-full bg-[#E85D1A]/15 blur-[80px]" />
        <div className="absolute top-1/3 right-1/4 h-[360px] w-[360px] rounded-full bg-[#378ADD]/12 blur-[90px]" />
        <div className="absolute bottom-0 left-1/4 h-[360px] w-[360px] rounded-full bg-[#1D9E75]/10 blur-[90px]" />
      </div>

      <div className="relative mx-auto max-w-[1600px] px-6 py-6">
        {/* Header */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-5">
          <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-[20px] px-5 py-4 shadow-[0_20px_70px_rgba(0,0,0,0.55)]">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <div className="flex items-center gap-3">
                  <h1 className="text-xl font-semibold tracking-tight">IGNIS — Dashboard</h1>
                  <span
                    className={cn(
                      'rounded-full border px-3 py-1 text-xs font-medium',
                      wsStatus === 'CONNECTED'
                        ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200'
                        : wsStatus === 'CONNECTING'
                          ? 'border-sky-500/20 bg-sky-500/10 text-sky-200'
                          : 'border-rose-500/20 bg-rose-500/10 text-rose-200'
                    )}
                  >
                    WS: {wsStatus}
                  </span>

                  <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70">
                    API: {API_BASE}
                  </span>
                </div>

                <div className="text-xs text-white/60 mt-1">
                  Watchlist + setups + alertes live + actions rapides.
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
                  href="/journal"
                  className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10 transition"
                >
                  Journal
                </Link>
                <Link
                  href="/ai"
                  className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10 transition"
                >
                  AI
                </Link>
                <Link
                  href="/settings"
                  className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10 transition"
                >
                  Settings
                </Link>

                <button
                  onClick={refreshAll}
                  className="rounded-xl border border-white/10 bg-gradient-to-b from-[#E85D1A]/90 to-[#E85D1A]/40 px-4 py-2 text-sm font-medium text-white shadow-[0_12px_40px_rgba(232,93,26,0.25)] hover:from-[#E85D1A] hover:to-[#E85D1A]/50 transition"
                >
                  Refresh all
                </button>
              </div>
            </div>

            {(notice || error) && (
              <div className="mt-4 grid grid-cols-1 gap-2">
                {notice && (
                  <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
                    {notice}
                  </div>
                )}
                {error && (
                  <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                    {error}
                  </div>
                )}
              </div>
            )}

            {/* KPIs */}
            <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-6">
              <Stat label="Assets (active)" value={statsLoading ? '…' : `${keyKPIs.active}`} />
              <Stat label="With analysis" value={statsLoading ? '…' : `${keyKPIs.withAnalysis}`} />
              <Stat label="Coverage" value={statsLoading ? '…' : `${keyKPIs.coverage}%`} />
              <Stat label="Valid setups" value={statsLoading ? '…' : `${keyKPIs.valid}`} accent />
              <Stat label="Pending" value={statsLoading ? '…' : `${keyKPIs.pending}`} />
              <Stat label="Alerts (loaded)" value={alertsLoading ? '…' : `${alerts.length}`} />
            </div>
          </div>
        </motion.div>

        <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
          {/* Watchlist */}
          <div className="xl:col-span-8 space-y-5">
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
              <Card>
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <div className="text-base font-semibold">Watchlist</div>
                    <div className="text-xs text-white/60 mt-1">
                      Assets venant de la DB (<code>/assets</code>). Clique “Open” pour l’analyse.
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <select
                      value={assetClass}
                      onChange={(e) => { setOffset(0); setAssetClass(e.target.value as any); }}
                      className="rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                    >
                      <option value="ALL">ALL</option>
                      <option value="CRYPTO">CRYPTO</option>
                      <option value="STOCK">STOCK</option>
                      <option value="FOREX">FOREX</option>
                      <option value="INDEX">INDEX</option>
                      <option value="ETF">ETF</option>
                      <option value="COMMODITY">COMMODITY</option>
                      <option value="OTHER">OTHER</option>
                    </select>

                    <button
                      onClick={() => { setOffset(0); setActiveOnly((p) => !p); }}
                      className={cn(
                        'rounded-xl border px-3 py-2 text-sm font-medium transition',
                        activeOnly
                          ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200'
                          : 'border-zinc-500/25 bg-zinc-500/10 text-zinc-200'
                      )}
                      title="Filtre actif"
                    >
                      active: {activeOnly ? 'true' : 'false'}
                    </button>

                    <select
                      value={limit}
                      onChange={(e) => { setOffset(0); setLimit(Number(e.target.value)); }}
                      className="rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                    >
                      {[30, 60, 90, 120].map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-12">
                  <div className="md:col-span-8">
                    <Field label={`Search (${filteredAssets.length}/${assets.length})`}>
                      <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="BTC, ETH, Binance, Apple…"
                        className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
                      />
                    </Field>
                  </div>

                  <div className="md:col-span-4 flex items-end gap-2">
                    <button
                      onClick={() => setOffset((p) => Math.max(0, p - limit))}
                      disabled={offset === 0}
                      className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10 transition disabled:opacity-50"
                    >
                      Prev
                    </button>
                    <button
                      onClick={() => setOffset((p) => Math.min((pageCount - 1) * limit, p + limit))}
                      disabled={offset + limit >= assetsTotal}
                      className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10 transition disabled:opacity-50"
                    >
                      Next
                    </button>
                  </div>
                </div>

                <div className="mt-3 text-xs text-white/50">
                  Page {page}/{pageCount} · total {assetsTotal} · source: <span className="text-white/65">{API_BASE}/assets</span>
                </div>
              </Card>
            </motion.div>

            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {assetsLoading && (
                  <div className="col-span-full rounded-2xl border border-white/10 bg-black/20 p-5 text-sm text-white/60">
                    Chargement des assets…
                  </div>
                )}

                {!assetsLoading && filteredAssets.length === 0 && (
                  <div className="col-span-full rounded-2xl border border-white/10 bg-black/20 p-5 text-sm text-white/60">
                    Aucun asset ne match la recherche. Ajuste les filtres ou ajoute des assets dans Settings.
                  </div>
                )}

                {filteredAssets.map((a) => {
                  const setupScore = a.setup?.score ?? 0;
                  const status = a.setup?.status;
                  const z = a.setup?.zone_type;

                  return (
                    <motion.div
                      key={a.symbol}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className={cn(
                        'rounded-2xl border border-white/10 bg-gradient-to-b p-4 shadow-[0_20px_70px_rgba(0,0,0,0.45)]',
                        scoreGradient(setupScore)
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-base font-semibold truncate">
                            {a.symbol}
                            <span className="text-white/45 font-normal"> · {a.asset_class}</span>
                          </div>
                          <div className="text-xs text-white/60 truncate mt-1">
                            {a.name || '—'} {a.exchange ? `· ${a.exchange}` : ''}
                          </div>
                        </div>

                        <div className="text-right">
                          <div className="text-xs text-white/60">Last</div>
                          <div className="text-lg font-semibold">{fmt(a.last_price, 6)}</div>
                        </div>
                      </div>

                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {status ? (
                          <span className={cn('rounded-full border px-2.5 py-1 text-[11px] font-medium', statusPill(status))}>
                            {status}
                          </span>
                        ) : (
                          <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/70">
                            No setup
                          </span>
                        )}

                        <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/75">
                          Score {fmt(setupScore, 0)}%
                        </span>

                        {z && (
                          <span
                            className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/75"
                            style={{ boxShadow: `0 0 0 1px ${zoneColor(z)} inset` }}
                            title="Zone type"
                          >
                            <span
                              className="inline-block h-2 w-2 rounded-full mr-2 align-middle"
                              style={{ backgroundColor: zoneColor(z) }}
                            />
                            {z}
                          </span>
                        )}

                        {a.setup?.pa_pattern && (
                          <span className="rounded-full border border-[#378ADD]/25 bg-[#378ADD]/10 px-2.5 py-1 text-[11px] text-sky-200">
                            PA {a.setup.pa_pattern}
                          </span>
                        )}

                        {a.setup?.rr !== undefined && (
                          <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/70">
                            RR {fmt(a.setup.rr, 2)}
                          </span>
                        )}
                      </div>

                      <div className="mt-3 rounded-xl border border-white/10 bg-black/20 p-3">
                        <div className="text-[11px] uppercase tracking-wide text-white/45">Last analysis</div>
                        <div className="text-xs text-white/70 mt-1">
                          {a.last_analysis_at ? fmtDate(a.last_analysis_at) : '—'}
                        </div>
                      </div>

                      <div className="mt-4 flex items-center justify-between gap-2">
                        <Link
                          href={`/analysis/${encodeURIComponent(a.symbol)}`}
                          className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-white/85 hover:bg-white/10 transition"
                        >
                          Open →
                        </Link>

                        <button
                          onClick={() => refreshAsset(a.symbol)}
                          className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-200 hover:bg-emerald-500/15 transition"
                          title="Demande une analyse backend (assets/{symbol}/refresh)"
                        >
                          Refresh
                        </button>
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            </motion.div>
          </div>

          {/* Right column: Alerts live + overview */}
          <div className="xl:col-span-4 space-y-5">
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
              <Card>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-base font-semibold">Live alerts</div>
                    <div className="text-xs text-white/60 mt-1">
                      Feed live via WebSocket (<code>/ws</code>) + fallback HTTP (<code>/alerts</code>).
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <select
                      value={alertLimit}
                      onChange={(e) => setAlertLimit(Number(e.target.value))}
                      className="rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                      title="Nombre d’alertes conservées dans le feed"
                    >
                      {[15, 30, 50, 80].map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>

                    <button
                      onClick={fetchRecentAlerts}
                      className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10 transition"
                    >
                      Reload
                    </button>
                  </div>
                </div>

                <div className="mt-4 space-y-2 max-h-[620px] overflow-auto pr-1">
                  {alertsLoading && (
                    <div className="rounded-xl border border-white/10 bg-black/20 p-4 text-sm text-white/60">
                      Chargement des alertes…
                    </div>
                  )}

                  {!alertsLoading && alerts.length === 0 && (
                    <div className="rounded-xl border border-white/10 bg-black/20 p-4 text-sm text-white/60">
                      Pas d’alertes. Utilise Settings → Alerts → Send test/emit pour tester.
                    </div>
                  )}

                  <AnimatePresence initial={false}>
                    {alerts.map((a) => (
                      <motion.div
                        key={a.id ?? `${a.symbol}-${a.title}-${a.created_at}`}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        className="rounded-2xl border border-white/10 bg-black/20 p-4"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-white/90 truncate">
                              {a.title || a.alert_type}
                              <span className="text-white/45 font-normal"> · {a.symbol} {a.timeframe}</span>
                            </div>
                            <div className="text-xs text-white/70 mt-1 whitespace-pre-wrap">
                              {a.message}
                            </div>
                          </div>

                          <div className="text-right">
                            <span className={cn('rounded-full border px-2.5 py-1 text-[11px] font-medium', priorityPill(a.priority))}>
                              {String(a.priority ?? '—').toUpperCase()}
                            </span>
                            <div className="text-[11px] text-white/50 mt-1">
                              {fmtDate(a.created_at)}
                            </div>
                          </div>
                        </div>

                        <div className="mt-3 flex items-center justify-between gap-2">
                          <div className="text-[11px] text-white/50 truncate">
                            type: <span className="text-white/70">{a.alert_type}</span>
                            <span className="mx-2 text-white/25">·</span>
                            channels: <span className="text-white/70">{(a.channels ?? []).join(', ') || '—'}</span>
                          </div>

                          <Link
                            href={`/analysis/${encodeURIComponent(a.symbol)}`}
                            className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-white/85 hover:bg-white/10 transition"
                          >
                            Open →
                          </Link>
                        </div>

                        <details className="mt-3">
                          <summary className="cursor-pointer text-xs text-white/60 hover:text-white/80 transition">
                            Payload
                          </summary>
                          <pre className="mt-2 rounded-xl border border-white/10 bg-black/30 p-3 text-xs text-white/75 overflow-auto">
                            {JSON.stringify(a.payload ?? {}, null, 2)}
                          </pre>
                        </details>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              </Card>
            </motion.div>

            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
              <Card>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-base font-semibold">Quick actions</div>
                    <div className="text-xs text-white/60 mt-1">
                      Accès rapide aux features clés.
                    </div>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-1 gap-3">
                  <QuickLink
                    href="/scanner"
                    title="Run Scanner"
                    desc="Scan multi-symbols multi-timeframes avec filtres score/status/PA."
                    accent="orange"
                  />
                  <QuickLink
                    href="/journal"
                    title="Journal"
                    desc="Ajouter/éditer/clôturer des trades + stats P&L."
                    accent="green"
                  />
                  <QuickLink
                    href="/ai"
                    title="IGNIS AI"
                    desc="Chat Ollama + rapports et résumés (streaming)."
                    accent="blue"
                  />
                  <QuickLink
                    href="/settings"
                    title="Settings"
                    desc="Assets CRUD + outils alerting + status/models Ollama."
                    accent="zinc"
                  />
                </div>
              </Card>
            </motion.div>
          </div>
        </div>

        <div className="mt-6 text-xs text-white/40">
          Dashboard · Glass UI · dark-only · WS: <span className="text-white/60">{WS_URL}</span>
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Small UI components
────────────────────────────────────────────────────────────── */

function Card({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-white/10 bg-white/5 backdrop-blur-[20px] shadow-[0_25px_80px_rgba(0,0,0,0.55)] p-5',
        className
      )}
    >
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-xs text-white/60 mb-1">{label}</div>
      {children}
    </label>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={cn('rounded-xl border border-white/10 bg-black/20 px-3 py-2', accent && 'bg-gradient-to-b from-white/10 to-black/20')}>
      <div className="text-[11px] text-white/55">{label}</div>
      <div className="text-sm font-semibold text-white/90 truncate">{value}</div>
    </div>
  );
}

function QuickLink({
  href,
  title,
  desc,
  accent,
}: {
  href: string;
  title: string;
  desc: string;
  accent: 'orange' | 'blue' | 'green' | 'zinc';
}) {
  const accentCls =
    accent === 'orange'
      ? 'from-[#E85D1A]/30 to-transparent border-[#E85D1A]/15'
      : accent === 'blue'
        ? 'from-[#378ADD]/30 to-transparent border-[#378ADD]/15'
        : accent === 'green'
          ? 'from-[#1D9E75]/30 to-transparent border-[#1D9E75]/15'
          : 'from-white/10 to-transparent border-white/10';

  return (
    <Link
      href={href}
      className={cn(
        'rounded-2xl border bg-gradient-to-b p-4 transition',
        accentCls,
        'hover:bg-white/10'
      )}
    >
      <div className="text-sm font-semibold text-white/90">{title}</div>
      <div className="text-xs text-white/60 mt-1">{desc}</div>
      <div className="text-xs text-white/70 mt-3">Open →</div>
    </Link>
  );
}