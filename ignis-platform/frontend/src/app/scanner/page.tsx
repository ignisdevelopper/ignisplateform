/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';

/* ──────────────────────────────────────────────────────────────
   Types (robustes: on normalise car ScannerResult exact peut varier)
────────────────────────────────────────────────────────────── */

type SetupStatus = 'VALID' | 'PENDING' | 'INVALID' | 'WATCH' | 'EXPIRED';
type PAPattern = 'ACCU' | 'THREE_DRIVES' | 'FTL' | 'PATTERN_69' | 'HIDDEN_SDE' | 'NONE';
type ZoneType = 'DEMAND' | 'SUPPLY' | 'FLIPPY_D' | 'FLIPPY_S' | 'HIDDEN_D' | 'HIDDEN_S';
type Timeframe = 'M1'|'M5'|'M15'|'M30'|'H1'|'H2'|'H4'|'H8'|'D1'|'W1'|'MN1';

interface ScanResponse {
  total: number;
  valid_count: number;
  pending_count: number;
  results: any[];
  duration_ms: number;
  // errors? maybe
  errors?: any[];
}

interface AssetResponse {
  symbol: string;
  asset_class: string;
  name: string;
  exchange: string;
  active: boolean;
}

type NormalizedScanRow = {
  symbol: string;
  timeframe: string;
  status: SetupStatus;
  score: number;
  zone_type?: ZoneType;
  pa_pattern?: PAPattern;
  rr?: number;
  phase?: string;
  trend?: string;
  invalidation_reason?: string;
  pending_step?: string;
  from_cache?: boolean;
  analyzed_at?: string;
  raw: any;
};

/* ──────────────────────────────────────────────────────────────
   Config
────────────────────────────────────────────────────────────── */

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:8000/api/v1';

const TIMEFRAMES: Timeframe[] = ['M15','M30','H1','H2','H4','H8','D1','W1','MN1'];
const STATUS_OPTIONS: SetupStatus[] = ['VALID', 'PENDING', 'WATCH', 'INVALID', 'EXPIRED'];
const PA_OPTIONS: PAPattern[] = ['ACCU', 'THREE_DRIVES', 'FTL', 'PATTERN_69', 'HIDDEN_SDE', 'NONE'];

const ZONE_COLORS: Record<string, string> = {
  DEMAND: '#1D9E75',
  SUPPLY: '#E24B4A',
  FLIPPY_D: '#378ADD',
  FLIPPY_S: '#E85D1A',
  HIDDEN_D: '#2AD4A5',
  HIDDEN_S: '#FF6B6A',
};

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

function splitSymbols(input: string): string[] {
  const parts = input
    .split(/[\s,;]+/g)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  // dedupe
  return Array.from(new Set(parts));
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

function scoreGradient(score: number) {
  if (score >= 85) return 'from-emerald-400/55 to-emerald-700/10';
  if (score >= 70) return 'from-orange-400/55 to-orange-700/10';
  if (score >= 55) return 'from-amber-400/55 to-amber-700/10';
  return 'from-rose-400/55 to-rose-700/10';
}

function normalizeRow(r: any): NormalizedScanRow {
  const symbol = (r?.symbol ?? r?.asset?.symbol ?? r?.s ?? '—').toString().toUpperCase();
  const timeframe = (r?.timeframe ?? r?.tf ?? r?.t ?? '—').toString();

  const status =
    (r?.setup?.status ??
      r?.setup_status ??
      r?.status ??
      'INVALID') as SetupStatus;

  const score = Number(r?.setup?.score ?? r?.score ?? r?.setup_score ?? 0);

  const zone_type =
    (r?.zone_type ??
      r?.setup?.zone_type ??
      r?.sd_zone?.zone_type ??
      r?.zone?.zone_type) as ZoneType | undefined;

  const pa_pattern =
    (r?.pa_pattern ??
      r?.setup?.pa_pattern ??
      r?.pa?.pattern ??
      r?.pattern) as PAPattern | undefined;

  const rrVal = r?.rr ?? r?.setup?.rr ?? r?.sl_tp?.rr;
  const rr = rrVal !== undefined ? Number(rrVal) : undefined;

  const phase = r?.market_structure?.phase ?? r?.phase;
  const trend = r?.market_structure?.trend ?? r?.trend;

  const invalidation_reason = r?.setup?.invalidation_reason ?? r?.invalidation_reason;
  const pending_step = r?.setup?.pending_step ?? r?.pending_step;

  const from_cache = !!(r?.from_cache ?? r?.analysis?.from_cache);
  const analyzed_at = r?.analyzed_at ?? r?.analysis?.analyzed_at;

  return {
    symbol,
    timeframe,
    status,
    score: Number.isFinite(score) ? score : 0,
    zone_type,
    pa_pattern,
    rr: rr !== undefined && Number.isFinite(rr) ? rr : undefined,
    phase,
    trend,
    invalidation_reason,
    pending_step,
    from_cache,
    analyzed_at,
    raw: r,
  };
}

/* ──────────────────────────────────────────────────────────────
   Page
────────────────────────────────────────────────────────────── */

export default function ScannerPage() {
  // inputs
  const [symbolsText, setSymbolsText] = useState<string>('BTCUSDT ETHUSDT SOLUSDT');
  const [timeframes, setTimeframes] = useState<Timeframe[]>(['H4', 'D1']);
  const [minScore, setMinScore] = useState<number>(60);
  const [candleLimit, setCandleLimit] = useState<number>(300);
  const [statusFilter, setStatusFilter] = useState<SetupStatus[]>(['VALID', 'PENDING']);
  const [paFilter, setPaFilter] = useState<PAPattern[]>([]);

  // UI extras
  const [view, setView] = useState<'cards' | 'table'>('cards');
  const [query, setQuery] = useState<string>('');
  const [sort, setSort] = useState<'score_desc' | 'score_asc' | 'symbol_asc' | 'status_then_score'>('score_desc');

  // data
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const [lastRunAt, setLastRunAt] = useState<string | null>(null);
  const [scan, setScan] = useState<ScanResponse | null>(null);
  const [rows, setRows] = useState<NormalizedScanRow[]>([]);

  // assets loader
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [assetClass, setAssetClass] = useState<'CRYPTO' | 'STOCK' | 'FOREX' | 'ALL'>('CRYPTO');

  const symbols = useMemo(() => splitSymbols(symbolsText), [symbolsText]);

  const filteredRows = useMemo(() => {
    let r = [...rows];

    if (query.trim()) {
      const q = query.trim().toUpperCase();
      r = r.filter((x) => x.symbol.includes(q) || x.timeframe.toUpperCase().includes(q));
    }

    switch (sort) {
      case 'score_desc':
        r.sort((a, b) => (b.score - a.score) || a.symbol.localeCompare(b.symbol));
        break;
      case 'score_asc':
        r.sort((a, b) => (a.score - b.score) || a.symbol.localeCompare(b.symbol));
        break;
      case 'symbol_asc':
        r.sort((a, b) => a.symbol.localeCompare(b.symbol) || (b.score - a.score));
        break;
      case 'status_then_score':
        r.sort((a, b) => {
          const rank = (s: SetupStatus) =>
            s === 'VALID' ? 0 : s === 'PENDING' ? 1 : s === 'WATCH' ? 2 : s === 'INVALID' ? 3 : 4;
          return (rank(a.status) - rank(b.status)) || (b.score - a.score) || a.symbol.localeCompare(b.symbol);
        });
        break;
    }

    return r;
  }, [rows, query, sort]);

  const quickCounts = useMemo(() => {
    const counts = { VALID: 0, PENDING: 0, WATCH: 0, INVALID: 0, EXPIRED: 0 } as Record<SetupStatus, number>;
    for (const x of rows) counts[x.status] = (counts[x.status] ?? 0) + 1;
    return counts;
  }, [rows]);

  const runScan = useCallback(async () => {
    setError(null);

    if (!symbols.length) {
      setError('Ajoute au moins 1 symbol.');
      return;
    }
    if (!timeframes.length) {
      setError('Sélectionne au moins 1 timeframe.');
      return;
    }

    setLoading(true);
    try {
      const body = {
        symbols,
        timeframes,
        min_score: minScore,
        status_filter: statusFilter, // backend attend string[]
        pa_filter: paFilter,         // backend attend string[]
        candle_limit: candleLimit,
      };

      const res = await fetch(`${API_BASE}/analysis/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${txt || 'Erreur scan'}`);
      }

      const data = (await res.json()) as ScanResponse;
      setScan(data);

      const normalized = (data.results ?? []).map(normalizeRow);
      setRows(normalized);
      setLastRunAt(new Date().toISOString());
    } catch (e: any) {
      setError(e?.message ?? 'Erreur inconnue');
    } finally {
      setLoading(false);
    }
  }, [symbols, timeframes, minScore, statusFilter, paFilter, candleLimit]);

  const loadActiveAssets = useCallback(async () => {
    setError(null);
    setAssetsLoading(true);
    try {
      // on tire un gros batch; ajustable
      const url = new URL(`${API_BASE}/assets`);
      if (assetClass !== 'ALL') url.searchParams.set('asset_class', assetClass);
      url.searchParams.set('active', 'true');
      url.searchParams.set('limit', '200');
      url.searchParams.set('offset', '0');

      const res = await fetch(url.toString(), { method: 'GET' });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${txt || 'Erreur assets'}`);
      }

      const data = await res.json();
      const assets = (data.assets ?? []) as AssetResponse[];
      const list = assets.map((a) => a.symbol.toUpperCase()).filter(Boolean);

      if (!list.length) {
        setError('Aucun asset actif trouvé.');
        return;
      }

      // merge with current
      const merged = Array.from(new Set([...symbols, ...list]));
      setSymbolsText(merged.join(' '));
    } catch (e: any) {
      setError(e?.message ?? 'Erreur inconnue');
    } finally {
      setAssetsLoading(false);
    }
  }, [assetClass, symbols]);

  // first scan auto (optionnel) – ici on le fait pas d’office pour éviter spam API.
  useEffect(() => {
    // no-op
  }, []);

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
              <div className="flex items-center gap-3">
                <Link
                  href="/"
                  className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/85 hover:bg-white/10 transition"
                >
                  ← Dashboard
                </Link>
                <div>
                  <h1 className="text-xl font-semibold tracking-tight">Scanner</h1>
                  <div className="text-xs text-white/60">
                    Scan multi-symbols + multi-timeframes (S&D setups) — filtrage par score/status/PA.
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setView((v) => (v === 'cards' ? 'table' : 'cards'))}
                  className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10 transition"
                >
                  View: {view === 'cards' ? 'Cards' : 'Table'}
                </button>

                <button
                  onClick={runScan}
                  disabled={loading}
                  className="rounded-xl border border-white/10 bg-gradient-to-b from-[#E85D1A]/90 to-[#E85D1A]/40 px-4 py-2 text-sm font-medium text-white shadow-[0_12px_40px_rgba(232,93,26,0.25)] hover:from-[#E85D1A] hover:to-[#E85D1A]/50 transition disabled:opacity-60"
                >
                  {loading ? 'Scanning…' : 'Run scan'}
                </button>
              </div>
            </div>

            {/* Controls */}
            <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-12">
              {/* symbols */}
              <div className="xl:col-span-5">
                <div className="flex items-end justify-between gap-3 mb-1">
                  <label className="block text-xs text-white/60">
                    Symbols ({symbols.length})
                  </label>

                  <div className="flex items-center gap-2">
                    <select
                      value={assetClass}
                      onChange={(e) => setAssetClass(e.target.value as any)}
                      className="rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 text-xs outline-none"
                      title="Classe d'assets à charger depuis /assets"
                    >
                      <option value="CRYPTO">CRYPTO</option>
                      <option value="STOCK">STOCK</option>
                      <option value="FOREX">FOREX</option>
                      <option value="ALL">ALL</option>
                    </select>

                    <button
                      onClick={loadActiveAssets}
                      disabled={assetsLoading}
                      className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-2 text-xs text-white/80 hover:bg-white/10 transition disabled:opacity-60"
                      title="Ajoute les assets actifs depuis la DB"
                    >
                      {assetsLoading ? 'Loading…' : 'Load assets'}
                    </button>
                  </div>
                </div>

                <textarea
                  value={symbolsText}
                  onChange={(e) => setSymbolsText(e.target.value)}
                  rows={4}
                  placeholder="BTCUSDT ETHUSDT SOLUSDT (séparés par espaces, virgules ou retours)"
                  className="w-full rounded-2xl border border-white/10 bg-black/30 px-3 py-3 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
                />

                <div className="mt-2 flex flex-wrap gap-2">
                  {symbols.slice(0, 16).map((s) => (
                    <span
                      key={s}
                      className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/70"
                      title={s}
                    >
                      {s}
                    </span>
                  ))}
                  {symbols.length > 16 && (
                    <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/55">
                      +{symbols.length - 16} more
                    </span>
                  )}
                </div>
              </div>

              {/* timeframes + numeric */}
              <div className="xl:col-span-4 space-y-3">
                <div>
                  <div className="flex items-end justify-between mb-1">
                    <label className="block text-xs text-white/60">Timeframes</label>
                    <div className="flex items-center gap-2 text-[11px] text-white/50">
                      <button
                        onClick={() => setTimeframes(['H4', 'D1'])}
                        className="hover:text-white/80 transition"
                      >
                        preset H4/D1
                      </button>
                      <span className="text-white/25">·</span>
                      <button
                        onClick={() => setTimeframes([...TIMEFRAMES])}
                        className="hover:text-white/80 transition"
                      >
                        all
                      </button>
                      <span className="text-white/25">·</span>
                      <button
                        onClick={() => setTimeframes([])}
                        className="hover:text-white/80 transition"
                      >
                        none
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {TIMEFRAMES.map((tf) => {
                      const on = timeframes.includes(tf);
                      return (
                        <button
                          key={tf}
                          onClick={() =>
                            setTimeframes((prev) =>
                              prev.includes(tf) ? prev.filter((x) => x !== tf) : [...prev, tf]
                            )
                          }
                          className={cn(
                            'rounded-full border px-3 py-1.5 text-xs font-medium transition',
                            on
                              ? 'border-[#E85D1A]/30 bg-[#E85D1A]/10 text-white'
                              : 'border-white/10 bg-white/5 text-white/65 hover:bg-white/10'
                          )}
                        >
                          {tf}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  <Field label="Min score">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={minScore}
                      onChange={(e) => setMinScore(Number(e.target.value))}
                      className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
                    />
                  </Field>

                  <Field label="Candle limit">
                    <input
                      type="number"
                      min={100}
                      max={5000}
                      value={candleLimit}
                      onChange={(e) => setCandleLimit(Number(e.target.value))}
                      className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
                    />
                  </Field>

                  <Field label="Search results">
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="BTC / H4 / VALID…"
                      className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
                    />
                  </Field>
                </div>
              </div>

              {/* filters */}
              <div className="xl:col-span-3 space-y-3">
                <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-xs font-medium text-white/70">Status filter</div>
                    <div className="flex items-center gap-2 text-[11px] text-white/50">
                      <button
                        onClick={() => setStatusFilter(['VALID', 'PENDING'])}
                        className="hover:text-white/80 transition"
                      >
                        default
                      </button>
                      <span className="text-white/25">·</span>
                      <button
                        onClick={() => setStatusFilter([...STATUS_OPTIONS])}
                        className="hover:text-white/80 transition"
                      >
                        all
                      </button>
                      <span className="text-white/25">·</span>
                      <button
                        onClick={() => setStatusFilter([])}
                        className="hover:text-white/80 transition"
                      >
                        none
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {STATUS_OPTIONS.map((s) => {
                      const on = statusFilter.includes(s);
                      return (
                        <button
                          key={s}
                          onClick={() =>
                            setStatusFilter((prev) =>
                              prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]
                            )
                          }
                          className={cn(
                            'rounded-full border px-2.5 py-1 text-[11px] font-medium transition',
                            on ? statusPill(s) : 'border-white/10 bg-white/5 text-white/60 hover:bg-white/10'
                          )}
                        >
                          {s}
                        </button>
                      );
                    })}
                  </div>

                  <div className="mt-3 text-[11px] text-white/45">
                    Tip: vide = backend recevra <code>[]</code> (souvent “aucun”). Mets “all” si tu veux tout.
                  </div>
                </div>

                <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-xs font-medium text-white/70">PA filter</div>
                    <div className="flex items-center gap-2 text-[11px] text-white/50">
                      <button
                        onClick={() => setPaFilter([])}
                        className="hover:text-white/80 transition"
                      >
                        clear
                      </button>
                      <span className="text-white/25">·</span>
                      <button
                        onClick={() => setPaFilter(['ACCU', 'FTL'])}
                        className="hover:text-white/80 transition"
                      >
                        ACCU/FTL
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {PA_OPTIONS.map((p) => {
                      const on = paFilter.includes(p);
                      return (
                        <button
                          key={p}
                          onClick={() =>
                            setPaFilter((prev) =>
                              prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]
                            )
                          }
                          className={cn(
                            'rounded-full border px-2.5 py-1 text-[11px] font-medium transition',
                            on
                              ? 'border-[#378ADD]/25 bg-[#378ADD]/10 text-sky-200'
                              : 'border-white/10 bg-white/5 text-white/60 hover:bg-white/10'
                          )}
                        >
                          {p}
                        </button>
                      );
                    })}
                  </div>

                  <div className="mt-3">
                    <Field label="Sort">
                      <select
                        value={sort}
                        onChange={(e) => setSort(e.target.value as any)}
                        className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                      >
                        <option value="score_desc">Score ↓</option>
                        <option value="score_asc">Score ↑</option>
                        <option value="symbol_asc">Symbol A→Z</option>
                        <option value="status_then_score">Status → Score</option>
                      </select>
                    </Field>
                  </div>
                </div>
              </div>
            </div>

            {error && (
              <div className="mt-4 rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                {error}
              </div>
            )}
          </div>
        </motion.div>

        {/* Summary */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="mb-5">
          <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-[20px] p-5 shadow-[0_25px_80px_rgba(0,0,0,0.55)]">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-base font-semibold">Scan summary</h2>
                <div className="text-xs text-white/60 mt-1">
                  {scan
                    ? <>Dernier run: <span className="text-white/80">{lastRunAt ? new Date(lastRunAt).toLocaleString('fr-FR', { hour12: false }) : '—'}</span></>
                    : 'Lance un scan pour obtenir des résultats.'}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-xs text-white/50">API:</span>
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70">
                  {API_BASE}
                </span>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-6">
              <Stat label="Results" value={scan ? String(scan.total) : '—'} />
              <Stat label="Valid" value={scan ? String(scan.valid_count) : String(quickCounts.VALID)} accent />
              <Stat label="Pending" value={scan ? String(scan.pending_count) : String(quickCounts.PENDING)} />
              <Stat label="Watch" value={String(quickCounts.WATCH)} />
              <Stat label="Invalid" value={String(quickCounts.INVALID)} />
              <Stat label="Duration" value={scan ? `${fmt(scan.duration_ms, 0)} ms` : '—'} />
            </div>

            {scan?.errors?.length ? (
              <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3">
                <div className="text-xs font-medium text-amber-200">Errors</div>
                <div className="mt-2 space-y-2">
                  {scan.errors.slice(0, 6).map((er, idx) => (
                    <div key={idx} className="text-xs text-amber-100/80 whitespace-pre-wrap">
                      {typeof er === 'string' ? er : JSON.stringify(er)}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </motion.div>

        {/* Results */}
        <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-[20px] shadow-[0_25px_80px_rgba(0,0,0,0.55)] overflow-hidden">
          <div className="border-b border-white/10 bg-black/20 px-4 py-3 flex items-center justify-between">
            <div className="text-sm font-semibold">Results</div>
            <div className="text-xs text-white/55">
              {loading ? 'Scanning…' : `${filteredRows.length} affichés / ${rows.length} reçus`}
            </div>
          </div>

          <div className="p-4">
            {!rows.length && !loading && (
              <div className="rounded-2xl border border-white/10 bg-black/20 p-5">
                <div className="text-sm text-white/70">
                  Aucun résultat pour l’instant.
                </div>
                <div className="text-xs text-white/50 mt-1">
                  1) Mets tes symbols, 2) choisis TF, 3) clique “Run scan”.
                </div>
              </div>
            )}

            {view === 'cards' ? (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                <AnimatePresence>
                  {filteredRows.map((r) => (
                    <motion.div
                      key={`${r.symbol}-${r.timeframe}-${r.score}-${r.status}`}
                      layout
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 10 }}
                      className={cn(
                        'rounded-2xl border border-white/10 bg-gradient-to-b p-4',
                        scoreGradient(r.score)
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <div className="text-base font-semibold truncate">
                              {r.symbol}
                              <span className="text-white/50 font-normal"> · {r.timeframe}</span>
                            </div>
                            {r.from_cache !== undefined && (
                              <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-white/60">
                                {r.from_cache ? 'cache' : 'fresh'}
                              </span>
                            )}
                          </div>

                          <div className="mt-1 text-xs text-white/65">
                            {r.phase || r.trend ? (
                              <>
                                {r.phase ? <span>Phase: <span className="text-white/85">{r.phase}</span></span> : null}
                                {r.phase && r.trend ? <span className="mx-2 text-white/25">·</span> : null}
                                {r.trend ? <span>Trend: <span className="text-white/85">{r.trend}</span></span> : null}
                              </>
                            ) : (
                              <span className="text-white/45">Structure: —</span>
                            )}
                          </div>
                        </div>

                        <div className="text-right">
                          <div className="text-xs text-white/60">Score</div>
                          <div className="text-2xl font-semibold tracking-tight">{fmt(r.score, 0)}%</div>
                        </div>
                      </div>

                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <span className={cn('rounded-full border px-2.5 py-1 text-[11px] font-medium', statusPill(r.status))}>
                          {r.status}
                        </span>

                        {r.zone_type && (
                          <span
                            className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/75"
                            style={{ boxShadow: `0 0 0 1px ${ZONE_COLORS[r.zone_type] ?? 'rgba(255,255,255,0.12)' } inset` }}
                            title="Zone type"
                          >
                            <span
                              className="inline-block h-2 w-2 rounded-full mr-2 align-middle"
                              style={{ backgroundColor: ZONE_COLORS[r.zone_type] ?? 'rgba(255,255,255,0.3)' }}
                            />
                            {r.zone_type}
                          </span>
                        )}

                        {r.pa_pattern && (
                          <span className="rounded-full border border-[#378ADD]/25 bg-[#378ADD]/10 px-2.5 py-1 text-[11px] text-sky-200">
                            PA: {r.pa_pattern}
                          </span>
                        )}

                        {r.rr !== undefined && (
                          <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/70">
                            RR {fmt(r.rr, 2)}
                          </span>
                        )}
                      </div>

                      {(r.invalidation_reason || r.pending_step) && (
                        <div className="mt-3 rounded-xl border border-white/10 bg-black/20 p-3">
                          <div className="text-[11px] uppercase tracking-wide text-white/45">
                            {r.status === 'INVALID' ? 'Reason' : 'Pending'}
                          </div>
                          <div className="mt-1 text-xs text-white/75 whitespace-pre-wrap">
                            {r.invalidation_reason ?? r.pending_step}
                          </div>
                        </div>
                      )}

                      <div className="mt-4 flex items-center justify-between gap-3">
                        <div className="text-[11px] text-white/45 truncate">
                          {r.analyzed_at ? `Analyzed: ${new Date(r.analyzed_at).toLocaleString('fr-FR', { hour12: false })}` : '—'}
                        </div>

                        <Link
                          href={`/analysis/${encodeURIComponent(r.symbol)}`}
                          className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-white/85 hover:bg-white/10 transition"
                          title="Ouvrir page analysis"
                        >
                          Open analysis →
                        </Link>
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-left">
                  <thead className="bg-black/25">
                    <tr className="text-[11px] uppercase tracking-wider text-white/45">
                      <th className="px-3 py-3">Symbol</th>
                      <th className="px-3 py-3">TF</th>
                      <th className="px-3 py-3">Status</th>
                      <th className="px-3 py-3">Score</th>
                      <th className="px-3 py-3">Zone</th>
                      <th className="px-3 py-3">PA</th>
                      <th className="px-3 py-3">RR</th>
                      <th className="px-3 py-3">Phase/Trend</th>
                      <th className="px-3 py-3 text-right">Open</th>
                    </tr>
                  </thead>

                  <tbody className="divide-y divide-white/10">
                    {filteredRows.map((r) => (
                      <tr key={`${r.symbol}-${r.timeframe}-${r.status}-${r.score}`} className="hover:bg-white/5 transition">
                        <td className="px-3 py-3">
                          <div className="text-sm font-semibold text-white/90">{r.symbol}</div>
                          <div className="text-[11px] text-white/45">{r.from_cache ? 'cache' : 'fresh'}</div>
                        </td>
                        <td className="px-3 py-3 text-sm text-white/80">{r.timeframe}</td>
                        <td className="px-3 py-3">
                          <span className={cn('rounded-full border px-2.5 py-1 text-[11px] font-medium', statusPill(r.status))}>
                            {r.status}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-sm font-semibold text-white/90">{fmt(r.score, 0)}%</td>
                        <td className="px-3 py-3 text-xs text-white/80">
                          {r.zone_type ? (
                            <span className="inline-flex items-center gap-2">
                              <span
                                className="h-2 w-2 rounded-full"
                                style={{ backgroundColor: ZONE_COLORS[r.zone_type] ?? 'rgba(255,255,255,0.3)' }}
                              />
                              {r.zone_type}
                            </span>
                          ) : '—'}
                        </td>
                        <td className="px-3 py-3 text-xs text-white/80">{r.pa_pattern ?? '—'}</td>
                        <td className="px-3 py-3 text-xs text-white/80">{r.rr !== undefined ? fmt(r.rr, 2) : '—'}</td>
                        <td className="px-3 py-3 text-xs text-white/70">
                          {(r.phase || '—')}{' '}
                          <span className="text-white/25">·</span>{' '}
                          {(r.trend || '—')}
                        </td>
                        <td className="px-3 py-3 text-right">
                          <Link
                            href={`/analysis/${encodeURIComponent(r.symbol)}`}
                            className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white/80 hover:bg-white/10 transition"
                          >
                            Open →
                          </Link>
                        </td>
                      </tr>
                    ))}

                    {!filteredRows.length && rows.length > 0 && (
                      <tr>
                        <td colSpan={9} className="px-3 py-6 text-sm text-white/55">
                          Aucun résultat ne matche ta recherche/tri.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {loading && (
              <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-white/70">
                Scan en cours… (symbols: {symbols.length}, timeframes: {timeframes.length})
              </div>
            )}
          </div>
        </div>

        <div className="mt-6 text-xs text-white/40">
          Endpoint: <span className="text-white/60">{API_BASE}/analysis/scan</span>
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Small UI components
────────────────────────────────────────────────────────────── */

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
    <div className={cn(
      'rounded-xl border border-white/10 bg-black/20 px-3 py-2',
      accent && 'bg-gradient-to-b from-white/10 to-black/20'
    )}>
      <div className="text-[11px] text-white/55">{label}</div>
      <div className="text-sm font-semibold text-white/90">{value}</div>
    </div>
  );
}