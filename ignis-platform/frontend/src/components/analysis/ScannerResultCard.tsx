/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';

/**
 * ScannerResultCard
 * - Affiche un résultat de /analysis/scan (format backend potentiellement variable)
 * - UI glass + gradient par score + chips confluence
 * - Détails pliables: pending/invalidation + raw JSON
 * - Actions: Open analysis + callbacks optionnels (analyze/add-to-watchlist)
 */

export type SetupStatus = 'VALID' | 'PENDING' | 'INVALID' | 'WATCH' | 'EXPIRED';
export type ZoneType = 'DEMAND' | 'SUPPLY' | 'FLIPPY_D' | 'FLIPPY_S' | 'HIDDEN_D' | 'HIDDEN_S';
export type PAPattern = 'ACCU' | 'THREE_DRIVES' | 'FTL' | 'PATTERN_69' | 'HIDDEN_SDE' | 'NONE';

export type ScannerResultCardModel = {
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

  analyzed_at?: string;
  from_cache?: boolean;

  // optional: if scan returns more info
  setup_id?: string;
  score_breakdown?: Record<string, number>;

  raw: any;
};

export default function ScannerResultCard({
  result,
  selected,
  onSelect,
  onRequestAnalyze,
  onAddToWatchlist,
  showRawDefault = false,
  className,
}: {
  result: any | ScannerResultCardModel;
  selected?: boolean;
  onSelect?: (model: ScannerResultCardModel) => void;

  /** Optional: trigger analysis (HTTP or WS) from parent */
  onRequestAnalyze?: (symbol: string, timeframe: string) => void;

  /** Optional: parent can implement POST /assets */
  onAddToWatchlist?: (symbol: string) => void;

  showRawDefault?: boolean;
  className?: string;
}) {
  const model = useMemo(() => (isModel(result) ? result : normalizeScannerResult(result)), [result]);

  const [open, setOpen] = useState<boolean>(false);
  const [showRaw, setShowRaw] = useState<boolean>(showRawDefault);

  const statusCls = useMemo(() => statusPill(model.status), [model.status]);

  const cardGrad = useMemo(() => scoreGradient(model.score), [model.score]);

  const zoneCol = useMemo(() => zoneColor(model.zone_type), [model.zone_type]);
  const zoneLabel = useMemo(() => (model.zone_type ? model.zone_type : '—'), [model.zone_type]);

  const patternLabel = useMemo(() => prettyPattern(model.pa_pattern), [model.pa_pattern]);

  const headline = useMemo(() => {
    const bits: string[] = [];
    if (model.phase) bits.push(`Phase: ${model.phase}`);
    if (model.trend) bits.push(`Trend: ${model.trend}`);
    return bits.join(' · ');
  }, [model.phase, model.trend]);

  const hasReason = !!(model.invalidation_reason?.trim() || model.pending_step?.trim());

  return (
    <motion.div
      layout
      className={cn(
        'rounded-2xl border border-white/10 bg-gradient-to-b p-4 shadow-[0_20px_70px_rgba(0,0,0,0.45)]',
        cardGrad,
        selected ? 'ring-2 ring-white/15' : '',
        className
      )}
      onClick={() => {
        onSelect?.(model);
      }}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="text-base font-semibold text-white/90 truncate">
              {model.symbol}
              <span className="text-white/50 font-normal"> · {model.timeframe}</span>
            </div>

            <span className={cn('rounded-full border px-2.5 py-1 text-[11px] font-medium', statusCls)}>
              {model.status}
            </span>

            {model.from_cache !== undefined && (
              <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/65">
                {model.from_cache ? 'cache' : 'fresh'}
              </span>
            )}
          </div>

          <div className="mt-1 text-xs text-white/65 truncate">
            {headline || <span className="text-white/45">Structure: —</span>}
          </div>
        </div>

        <div className="text-right">
          <div className="text-[11px] text-white/55">Score</div>
          <div className="text-2xl font-semibold tracking-tight text-white/95">
            {fmt(model.score, 0)}%
          </div>
        </div>
      </div>

      {/* Chips */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span
          className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/75"
          style={{ boxShadow: model.zone_type ? `0 0 0 1px ${zoneCol} inset` : undefined }}
          title="Zone type"
        >
          <span
            className="inline-block h-2 w-2 rounded-full mr-2 align-middle"
            style={{ backgroundColor: model.zone_type ? zoneCol : 'rgba(255,255,255,0.25)' }}
          />
          Zone: {zoneLabel}
        </span>

        <span className="rounded-full border border-[#378ADD]/25 bg-[#378ADD]/10 px-2.5 py-1 text-[11px] text-sky-200">
          PA: {patternLabel}
        </span>

        <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/70">
          RR {model.rr !== undefined ? fmt(model.rr, 2) : '—'}
        </span>

        {model.analyzed_at && (
          <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/60">
            {fmtDate(model.analyzed_at)}
          </span>
        )}
      </div>

      {/* Score bar */}
      <div className="mt-3">
        <div className="flex items-center justify-between mb-1">
          <div className="text-[11px] text-white/55">Setup strength</div>
          <div className="text-[11px] text-white/70">{fmt(model.score, 0)}%</div>
        </div>
        <ScoreBar value={model.score} />
      </div>

      {/* Optional: reason / pending */}
      {hasReason && (
        <div className="mt-3 rounded-xl border border-white/10 bg-black/20 p-3">
          <div className="text-[11px] uppercase tracking-wide text-white/45">
            {model.status === 'INVALID' ? 'Invalidation' : model.status === 'PENDING' ? 'Pending' : 'Info'}
          </div>
          <div className="mt-1 text-xs text-white/75 whitespace-pre-wrap leading-relaxed">
            {model.invalidation_reason ?? model.pending_step}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Link
            href={`/analysis/${encodeURIComponent(model.symbol)}`}
            className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-white/85 hover:bg-white/10 transition"
            onClick={(e) => e.stopPropagation()}
          >
            Open analysis →
          </Link>

          <button
            onClick={(e) => {
              e.stopPropagation();
              onRequestAnalyze?.(model.symbol, model.timeframe);
            }}
            disabled={!onRequestAnalyze}
            className={cn(
              'rounded-xl border px-3 py-2 text-xs font-medium transition',
              onRequestAnalyze
                ? 'border-[#E85D1A]/25 bg-[#E85D1A]/10 text-orange-200 hover:bg-[#E85D1A]/15'
                : 'border-white/10 bg-white/5 text-white/40'
            )}
            title={onRequestAnalyze ? 'Relancer une analyse (parent handler)' : 'onRequestAnalyze non fourni'}
          >
            Re-analyze
          </button>

          <button
            onClick={(e) => {
              e.stopPropagation();
              onAddToWatchlist?.(model.symbol);
            }}
            disabled={!onAddToWatchlist}
            className={cn(
              'rounded-xl border px-3 py-2 text-xs font-medium transition',
              onAddToWatchlist
                ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/15'
                : 'border-white/10 bg-white/5 text-white/40'
            )}
            title={onAddToWatchlist ? 'Ajouter à la watchlist (POST /assets)' : 'onAddToWatchlist non fourni'}
          >
            Add to watchlist
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setOpen((p) => !p);
            }}
            className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/75 hover:bg-white/10 transition"
          >
            {open ? 'Hide details' : 'Details'}
          </button>

          <button
            onClick={(e) => {
              e.stopPropagation();
              copyToClipboard(`${model.symbol} ${model.timeframe}`);
            }}
            className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/75 hover:bg-white/10 transition"
            title="Copier symbol + timeframe"
          >
            Copy
          </button>
        </div>
      </div>

      {/* Expand */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="details"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="mt-4 space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Breakdown (if present) */}
            {model.score_breakdown && Object.keys(model.score_breakdown).length > 0 && (
              <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <div className="text-xs font-medium text-white/70 mb-2">Score breakdown</div>
                <div className="grid grid-cols-1 gap-2">
                  {Object.entries(model.score_breakdown)
                    .sort((a, b) => a[0].localeCompare(b[0]))
                    .map(([k, v]) => (
                      <div key={k}>
                        <div className="flex items-center justify-between mb-1">
                          <div className="text-[11px] text-white/60">{k}</div>
                          <div className="text-[11px] text-white/70">{fmt(v, 0)}%</div>
                        </div>
                        <ScoreBar value={v} />
                      </div>
                    ))}
                </div>
              </div>
            )}

            {/* Raw JSON */}
            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs font-medium text-white/70">Raw payload</div>
                <button
                  onClick={() => setShowRaw((p) => !p)}
                  className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/75 hover:bg-white/10 transition"
                >
                  {showRaw ? 'Hide' : 'Show'}
                </button>
              </div>

              <AnimatePresence initial={false}>
                {showRaw && (
                  <motion.pre
                    key="raw"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    className="mt-3 rounded-xl border border-white/10 bg-black/30 p-3 text-xs text-white/75 overflow-auto max-h-[360px]"
                  >
                    {JSON.stringify(model.raw ?? null, null, 2)}
                  </motion.pre>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Normalization (robust vs backend variations)
────────────────────────────────────────────────────────────── */

function isModel(x: any): x is ScannerResultCardModel {
  return x && typeof x === 'object' && typeof x.symbol === 'string' && typeof x.timeframe === 'string';
}

export function normalizeScannerResult(r: any): ScannerResultCardModel {
  const symbol = String(r?.symbol ?? r?.asset?.symbol ?? r?.s ?? '—').toUpperCase();
  const timeframe = String(r?.timeframe ?? r?.tf ?? r?.t ?? '—');

  const status = (r?.setup?.status ?? r?.setup_status ?? r?.status ?? 'INVALID') as SetupStatus;
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

  const rrRaw = r?.rr ?? r?.setup?.rr ?? r?.sl_tp?.rr;
  const rr = rrRaw !== undefined && rrRaw !== null && rrRaw !== '' ? Number(rrRaw) : undefined;

  const phase = r?.market_structure?.phase ?? r?.phase;
  const trend = r?.market_structure?.trend ?? r?.trend;

  const invalidation_reason = r?.setup?.invalidation_reason ?? r?.invalidation_reason;
  const pending_step = r?.setup?.pending_step ?? r?.pending_step;

  const analyzed_at = r?.analyzed_at ?? r?.analysis?.analyzed_at;
  const from_cache = !!(r?.from_cache ?? r?.analysis?.from_cache);

  const setup_id = r?.setup_id ?? r?.setup?.id ?? r?.setup?.setup_id;
  const score_breakdown =
    r?.setup?.score_breakdown ??
    r?.score_breakdown ??
    undefined;

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
    analyzed_at,
    from_cache,
    setup_id,
    score_breakdown,
    raw: r,
  };
}

/* ──────────────────────────────────────────────────────────────
   UI helpers
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

function scoreGradient(score: number) {
  const s = Math.max(0, Math.min(100, score ?? 0));
  if (s >= 85) return 'from-emerald-400/45 to-emerald-700/10';
  if (s >= 70) return 'from-orange-400/45 to-orange-700/10';
  if (s >= 55) return 'from-amber-400/45 to-amber-700/10';
  return 'from-rose-400/45 to-rose-700/10';
}

function zoneColor(zoneType?: ZoneType) {
  if (!zoneType) return 'rgba(255,255,255,0.25)';
  const map: Record<ZoneType, string> = {
    DEMAND: '#1D9E75',
    SUPPLY: '#E24B4A',
    FLIPPY_D: '#378ADD',
    FLIPPY_S: '#E85D1A',
    HIDDEN_D: '#2AD4A5',
    HIDDEN_S: '#FF6B6A',
  };
  return map[zoneType] ?? 'rgba(255,255,255,0.25)';
}

function prettyPattern(p?: PAPattern) {
  if (!p) return '—';
  if (p === 'THREE_DRIVES') return '3 Drives';
  if (p === 'PATTERN_69') return 'Pattern 69';
  if (p === 'HIDDEN_SDE') return 'Hidden SDE';
  return p;
}

function ScoreBar({ value }: { value: number }) {
  const v = Math.max(0, Math.min(100, value ?? 0));
  const grad =
    v >= 85
      ? 'from-emerald-400/60 to-emerald-700/10'
      : v >= 70
        ? 'from-orange-400/60 to-orange-700/10'
        : v >= 55
          ? 'from-amber-400/60 to-amber-700/10'
          : 'from-rose-400/60 to-rose-700/10';

  return (
    <div className="h-2 rounded-full border border-white/10 bg-white/5 overflow-hidden">
      <div className={cn('h-full rounded-full bg-gradient-to-r', grad)} style={{ width: `${v}%` }} />
    </div>
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