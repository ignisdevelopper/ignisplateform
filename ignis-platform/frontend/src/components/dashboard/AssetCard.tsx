/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';

export type SetupStatus = 'VALID' | 'PENDING' | 'INVALID' | 'WATCH' | 'EXPIRED';
export type ZoneType = 'DEMAND' | 'SUPPLY' | 'FLIPPY_D' | 'FLIPPY_S' | 'HIDDEN_D' | 'HIDDEN_S';
export type PAPattern = 'ACCU' | 'THREE_DRIVES' | 'FTL' | 'PATTERN_69' | 'HIDDEN_SDE' | 'NONE';

export type AssetResponse = {
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

  meta?: any;

  created_at: string;
  updated_at: string;
};

export default function AssetCard({
  asset,
  compact = false,
  selected = false,

  // optional extra context for UI
  livePrice,
  currencySuffix,
  showMeta = false,

  onSelect,
  onRefreshAnalysis,
  onToggleActive,
  onDelete,
  onEdit,

  className,
}: {
  asset: AssetResponse;

  compact?: boolean;
  selected?: boolean;

  /** live override from ws price updates */
  livePrice?: number | null;

  /** display helper (e.g., "$" or "USDT") */
  currencySuffix?: string;

  /** show meta json preview */
  showMeta?: boolean;

  onSelect?: (asset: AssetResponse) => void;

  /** call POST /assets/{symbol}/refresh in parent */
  onRefreshAnalysis?: (symbol: string) => void;

  /** call PATCH /assets/{symbol} active */
  onToggleActive?: (symbol: string, nextActive: boolean) => void;

  /** call DELETE /assets/{symbol} */
  onDelete?: (symbol: string) => void;

  /** open edit modal in parent */
  onEdit?: (asset: AssetResponse) => void;

  className?: string;
}) {
  const [open, setOpen] = useState(false);

  const symbol = asset.symbol?.toUpperCase();
  const price = livePrice ?? asset.last_price;

  const setup = asset.setup;
  const score = setup?.score ?? 0;

  const setupPillCls = useMemo(() => (setup ? statusPill(setup.status) : 'border-white/10 bg-white/5 text-white/65'), [setup]);
  const grad = useMemo(() => scoreGradient(score), [score]);
  const zoneCol = useMemo(() => zoneColor(setup?.zone_type), [setup?.zone_type]);

  const analysisAgo = useMemo(() => {
    if (!asset.last_analysis_at) return null;
    const t = new Date(asset.last_analysis_at).getTime();
    if (Number.isNaN(t)) return null;
    const diff = Date.now() - t;
    if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))}s ago`;
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
    return `${Math.round(diff / 86_400_000)}d ago`;
  }, [asset.last_analysis_at]);

  const title = `${asset.name || symbol}${asset.exchange ? ` · ${asset.exchange}` : ''}`;

  return (
    <motion.div
      layout
      className={cn(
        'rounded-2xl border border-white/10 bg-gradient-to-b shadow-[0_20px_70px_rgba(0,0,0,0.45)] overflow-hidden',
        grad,
        selected ? 'ring-2 ring-white/15' : '',
        className
      )}
      onClick={() => onSelect?.(asset)}
    >
      {/* Header */}
      <div className={cn('p-4', compact && 'p-3')}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className={cn('text-base font-semibold text-white/90 truncate', compact && 'text-sm')}>
                {symbol}
                <span className="text-white/45 font-normal"> · {asset.asset_class}</span>
              </div>

              <span
                className={cn(
                  'rounded-full border px-2.5 py-1 text-[11px] font-medium',
                  asset.active
                    ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200'
                    : 'border-zinc-500/25 bg-zinc-500/10 text-zinc-200'
                )}
                title="Active in watchlist"
              >
                {asset.active ? 'active' : 'inactive'}
              </span>
            </div>

            <div className="mt-1 text-xs text-white/60 truncate" title={title}>
              {asset.name || '—'}
              {asset.exchange ? <span className="text-white/40"> · {asset.exchange}</span> : null}
            </div>
          </div>

          <div className="text-right">
            <div className="text-[11px] text-white/55">Last</div>
            <div className={cn('text-xl font-semibold tracking-tight text-white/95', compact && 'text-lg')}>
              {price !== undefined && price !== null ? fmt(price, 6) : '—'}
              {currencySuffix ? <span className="text-white/45 text-sm ml-1">{currencySuffix}</span> : null}
            </div>
          </div>
        </div>

        {/* Setup row */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className={cn('rounded-full border px-2.5 py-1 text-[11px] font-medium', setupPillCls)}>
            {setup?.status ?? 'NO_SETUP'}
          </span>

          <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/75">
            Score {fmt(score, 0)}%
          </span>

          {setup?.zone_type && (
            <span
              className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/75"
              style={{ boxShadow: `0 0 0 1px ${zoneCol} inset` }}
              title="Zone type"
            >
              <span className="inline-block h-2 w-2 rounded-full mr-2 align-middle" style={{ backgroundColor: zoneCol }} />
              {setup.zone_type}
            </span>
          )}

          {setup?.pa_pattern && (
            <span className="rounded-full border border-[#378ADD]/25 bg-[#378ADD]/10 px-2.5 py-1 text-[11px] text-sky-200">
              PA {prettyPattern(setup.pa_pattern)}
            </span>
          )}

          {setup?.rr !== undefined && (
            <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/70">
              RR {fmt(setup.rr, 2)}
            </span>
          )}

          <span className="ml-auto rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/60">
            {analysisAgo ?? 'no analysis'}
          </span>
        </div>

        <div className="mt-3">
          <div className="flex items-center justify-between mb-1">
            <div className="text-[11px] text-white/55">Setup strength</div>
            <div className="text-[11px] text-white/70">{fmt(score, 0)}%</div>
          </div>
          <ScoreBar value={score} />
        </div>

        {/* Actions */}
        <div className={cn('mt-4 flex flex-wrap items-center justify-between gap-2', compact && 'mt-3')}>
          <div className="flex items-center gap-2">
            <Link
              href={`/analysis/${encodeURIComponent(symbol)}`}
              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-white/85 hover:bg-white/10 transition"
              onClick={(e) => e.stopPropagation()}
            >
              Open →
            </Link>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRefreshAnalysis?.(symbol);
              }}
              disabled={!onRefreshAnalysis}
              className={cn(
                'rounded-xl border px-3 py-2 text-xs font-medium transition',
                onRefreshAnalysis
                  ? 'border-[#E85D1A]/25 bg-[#E85D1A]/10 text-orange-200 hover:bg-[#E85D1A]/15'
                  : 'border-white/10 bg-white/5 text-white/40'
              )}
              title={!onRefreshAnalysis ? 'onRefreshAnalysis non fourni' : 'Demande une analyse backend'}
            >
              Refresh
            </button>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setOpen((p) => !p);
              }}
              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/75 hover:bg-white/10 transition"
            >
              {open ? 'Hide' : 'Details'}
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onEdit?.(asset);
              }}
              disabled={!onEdit}
              className={cn(
                'rounded-xl border px-3 py-2 text-xs transition',
                onEdit
                  ? 'border-white/10 bg-white/5 text-white/80 hover:bg-white/10'
                  : 'border-white/10 bg-white/5 text-white/40'
              )}
            >
              Edit
            </button>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleActive?.(symbol, !asset.active);
              }}
              disabled={!onToggleActive}
              className={cn(
                'rounded-xl border px-3 py-2 text-xs font-medium transition',
                onToggleActive
                  ? asset.active
                    ? 'border-zinc-500/25 bg-zinc-500/10 text-zinc-200 hover:bg-zinc-500/15'
                    : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/15'
                  : 'border-white/10 bg-white/5 text-white/40'
              )}
              title={!onToggleActive ? 'onToggleActive non fourni' : 'Activer/désactiver'}
            >
              {asset.active ? 'Disable' : 'Enable'}
            </button>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDelete?.(symbol);
              }}
              disabled={!onDelete}
              className={cn(
                'rounded-xl border px-3 py-2 text-xs font-medium transition',
                onDelete
                  ? 'border-rose-500/20 bg-rose-500/10 text-rose-200 hover:bg-rose-500/15'
                  : 'border-white/10 bg-white/5 text-white/40'
              )}
            >
              Delete
            </button>
          </div>
        </div>
      </div>

      {/* Expand */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="open"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="border-t border-white/10 bg-black/20 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
              <div className="md:col-span-6 space-y-3">
                <div className="rounded-xl border border-white/10 bg-black/25 p-3">
                  <div className="text-xs font-medium text-white/70 mb-2">Asset</div>
                  <div className="grid grid-cols-2 gap-2">
                    <MiniStat label="Symbol" value={symbol} />
                    <MiniStat label="Class" value={asset.asset_class} />
                    <MiniStat label="Name" value={asset.name || '—'} />
                    <MiniStat label="Exchange" value={asset.exchange || '—'} />
                    <MiniStat label="Created" value={fmtDate(asset.created_at)} />
                    <MiniStat label="Updated" value={fmtDate(asset.updated_at)} />
                  </div>
                </div>

                {showMeta && (
                  <details className="rounded-xl border border-white/10 bg-black/25 p-3">
                    <summary className="cursor-pointer text-xs text-white/70 hover:text-white/85 transition">
                      Meta JSON
                    </summary>
                    <pre className="mt-2 rounded-xl border border-white/10 bg-black/30 p-3 text-xs text-white/75 overflow-auto max-h-[260px]">
                      {JSON.stringify(asset.meta ?? {}, null, 2)}
                    </pre>
                  </details>
                )}
              </div>

              <div className="md:col-span-6 space-y-3">
                <div className="rounded-xl border border-white/10 bg-black/25 p-3">
                  <div className="text-xs font-medium text-white/70 mb-2">Setup snapshot</div>
                  {setup ? (
                    <div className="grid grid-cols-2 gap-2">
                      <MiniStat label="Status" value={setup.status} />
                      <MiniStat label="Score" value={`${fmt(setup.score, 0)}%`} />
                      <MiniStat label="Zone" value={setup.zone_type ?? '—'} />
                      <MiniStat label="PA" value={setup.pa_pattern ? prettyPattern(setup.pa_pattern) : '—'} />
                      <MiniStat label="RR" value={setup.rr !== undefined ? fmt(setup.rr, 2) : '—'} />
                      <MiniStat label="Last analysis" value={asset.last_analysis_at ? fmtDate(asset.last_analysis_at) : '—'} />
                    </div>
                  ) : (
                    <div className="text-sm text-white/60">Aucune info setup.</div>
                  )}

                  <div className="mt-3">
                    <div className="flex items-center justify-between text-[11px] text-white/55 mb-1">
                      <span>Score</span>
                      <span className="text-white/70">{fmt(score, 0)}%</span>
                    </div>
                    <ScoreBar value={score} />
                  </div>
                </div>

                <div className="rounded-xl border border-white/10 bg-black/25 p-3">
                  <div className="text-xs font-medium text-white/70 mb-2">Utilities</div>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => copyToClipboard(symbol)}
                      className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition"
                    >
                      Copy symbol
                    </button>
                    <button
                      onClick={() => copyToClipboard(String(price ?? '—'))}
                      className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition"
                    >
                      Copy price
                    </button>
                  </div>
                </div>

                <details className="rounded-xl border border-white/10 bg-black/25 p-3">
                  <summary className="cursor-pointer text-xs text-white/70 hover:text-white/85 transition">
                    Raw asset JSON
                  </summary>
                  <pre className="mt-2 rounded-xl border border-white/10 bg-black/30 p-3 text-xs text-white/75 overflow-auto max-h-[260px]">
                    {JSON.stringify(asset, null, 2)}
                  </pre>
                </details>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/* ──────────────────────────────────────────────────────────────
   UI Helpers
────────────────────────────────────────────────────────────── */

function cn(...classes: Array<string | undefined | null | false>) {
  return classes.filter(Boolean).join(' ');
}

function fmt(n: number | undefined, digits = 2) {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits }).format(n);
}

function fmtDate(iso?: string) {
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

function prettyPattern(p: PAPattern) {
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

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2">
      <div className="text-[11px] text-white/55">{label}</div>
      <div className="text-xs font-medium text-white/85 truncate">{value}</div>
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