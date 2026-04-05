/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';

import AssetCard, { type AssetResponse } from './assetcard';

type SetupStatus = 'VALID' | 'PENDING' | 'INVALID' | 'WATCH' | 'EXPIRED';
type AssetClass = 'CRYPTO' | 'STOCK' | 'FOREX' | 'COMMODITY' | 'INDEX' | 'ETF' | 'OTHER';

type SortKey =
  | 'score_desc'
  | 'score_asc'
  | 'symbol_asc'
  | 'last_analysis_desc'
  | 'price_desc'
  | 'price_asc';

export default function WatchlistPanel({
  title = 'Watchlist',
  subtitle = 'Assets DB + setups + actions rapides',
  assets,
  total,
  loading,
  error,

  livePrices,

  selectedSymbol,
  onSelectSymbol,

  // filters external (optional controlled)
  defaultAssetClass = 'ALL',
  defaultActiveOnly = true,
  defaultStatusFilter = 'ALL',

  // pagination external
  page,
  pageCount,
  onPrevPage,
  onNextPage,

  onRefreshAsset,
  onToggleActive,
  onDeleteAsset,
  onEditAsset,

  showMetaByDefault = false,
  className,
}: {
  title?: string;
  subtitle?: string;

  assets: AssetResponse[];
  total?: number;
  loading?: boolean;
  error?: string | null;

  /** live override from WS: { BTCUSDT: 67321.5 } */
  livePrices?: Record<string, number>;

  selectedSymbol?: string | null;
  onSelectSymbol?: (symbol: string) => void;

  defaultAssetClass?: AssetClass | 'ALL';
  defaultActiveOnly?: boolean;
  defaultStatusFilter?: SetupStatus | 'ALL';

  /** optional pagination UI */
  page?: number;       // 1-based
  pageCount?: number;  // total pages
  onPrevPage?: () => void;
  onNextPage?: () => void;

  /** actions */
  onRefreshAsset?: (symbol: string) => void; // POST /assets/{symbol}/refresh
  onToggleActive?: (symbol: string, nextActive: boolean) => void; // PATCH /assets/{symbol}
  onDeleteAsset?: (symbol: string) => void; // DELETE /assets/{symbol}
  onEditAsset?: (asset: AssetResponse) => void; // open modal

  showMetaByDefault?: boolean;

  className?: string;
}) {
  const [query, setQuery] = useState('');
  const [assetClass, setAssetClass] = useState<AssetClass | 'ALL'>(defaultAssetClass);
  const [activeOnly, setActiveOnly] = useState<boolean>(defaultActiveOnly);
  const [statusFilter, setStatusFilter] = useState<SetupStatus | 'ALL'>(defaultStatusFilter);

  const [sort, setSort] = useState<SortKey>('score_desc');
  const [view, setView] = useState<'grid' | 'list'>('grid');

  const [showMeta, setShowMeta] = useState<boolean>(showMetaByDefault);
  const [pinFirst, setPinFirst] = useState<boolean>(true);

  const stats = useMemo(() => {
    const list = assets ?? [];
    let valid = 0, pending = 0, watch = 0, invalid = 0, expired = 0, noSetup = 0;
    let active = 0;

    for (const a of list) {
      if (a.active) active += 1;

      const s = a.setup?.status;
      if (!s) { noSetup += 1; continue; }
      if (s === 'VALID') valid += 1;
      else if (s === 'PENDING') pending += 1;
      else if (s === 'WATCH') watch += 1;
      else if (s === 'EXPIRED') expired += 1;
      else invalid += 1;
    }

    const avgScore = (() => {
      const scores = list.map(x => x.setup?.score).filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
      if (!scores.length) return undefined;
      return scores.reduce((a, b) => a + b, 0) / scores.length;
    })();

    const pinned = list.filter(isPinned).length;

    return { valid, pending, watch, invalid, expired, noSetup, active, avgScore, pinned };
  }, [assets]);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    let list = [...(assets ?? [])];

    if (assetClass !== 'ALL') {
      list = list.filter(a => String(a.asset_class).toUpperCase() === assetClass);
    }

    if (activeOnly) {
      list = list.filter(a => !!a.active);
    }

    if (statusFilter !== 'ALL') {
      list = list.filter(a => (a.setup?.status ?? 'INVALID') === statusFilter);
    }

    if (q) {
      list = list.filter(a => {
        const hay = `${a.symbol} ${a.name ?? ''} ${a.exchange ?? ''} ${a.asset_class ?? ''} ${a.setup?.status ?? ''}`.toUpperCase();
        return hay.includes(q);
      });
    }

    // sorting
    list.sort((a, b) => {
      // pin first (optional)
      if (pinFirst) {
        const ap = isPinned(a) ? 1 : 0;
        const bp = isPinned(b) ? 1 : 0;
        if (ap !== bp) return bp - ap; // pinned first
      }

      switch (sort) {
        case 'score_desc':
          return (b.setup?.score ?? -1) - (a.setup?.score ?? -1) || a.symbol.localeCompare(b.symbol);
        case 'score_asc':
          return (a.setup?.score ?? 9999) - (b.setup?.score ?? 9999) || a.symbol.localeCompare(b.symbol);
        case 'symbol_asc':
          return a.symbol.localeCompare(b.symbol);
        case 'last_analysis_desc': {
          const at = a.last_analysis_at ? new Date(a.last_analysis_at).getTime() : 0;
          const bt = b.last_analysis_at ? new Date(b.last_analysis_at).getTime() : 0;
          return bt - at || (b.setup?.score ?? -1) - (a.setup?.score ?? -1);
        }
        case 'price_desc': {
          const ap = livePrices?.[a.symbol] ?? a.last_price ?? -Infinity;
          const bp = livePrices?.[b.symbol] ?? b.last_price ?? -Infinity;
          return bp - ap || a.symbol.localeCompare(b.symbol);
        }
        case 'price_asc': {
          const ap = livePrices?.[a.symbol] ?? a.last_price ?? Infinity;
          const bp = livePrices?.[b.symbol] ?? b.last_price ?? Infinity;
          return ap - bp || a.symbol.localeCompare(b.symbol);
        }
        default:
          return (b.setup?.score ?? -1) - (a.setup?.score ?? -1);
      }
    });

    return list;
  }, [assets, query, assetClass, activeOnly, statusFilter, sort, pinFirst, livePrices]);

  const gridCols =
    view === 'grid'
      ? 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3'
      : 'grid-cols-1';

  return (
    <div
      className={cn(
        'rounded-2xl border border-white/10 bg-white/5 backdrop-blur-[20px] shadow-[0_25px_80px_rgba(0,0,0,0.55)] overflow-hidden',
        className
      )}
    >
      {/* Header */}
      <div className="border-b border-white/10 bg-black/20 px-5 py-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-base font-semibold text-white/90">{title}</div>
            <div className="text-xs text-white/60 mt-1">{subtitle}</div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/settings"
              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition"
              title="Gérer les assets (CRUD)"
            >
              Manage assets →
            </Link>

            <button
              type="button"
              onClick={() => setView(v => (v === 'grid' ? 'list' : 'grid'))}
              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition"
            >
              View: {view === 'grid' ? 'Grid' : 'List'}
            </button>

            <ToggleButton label="Pinned first" value={pinFirst} onClick={() => setPinFirst(p => !p)} />
            <ToggleButton label="Meta" value={showMeta} onClick={() => setShowMeta(p => !p)} />
          </div>
        </div>

        {/* Top stats */}
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-8">
          <Stat label="Shown" value={String(filtered.length)} accent />
          <Stat label="Total page" value={total !== undefined ? String(total) : '—'} />
          <Stat label="Active (in page)" value={String(stats.active)} />
          <Stat label="Pinned" value={String(stats.pinned)} />
          <Stat label="Avg score" value={stats.avgScore !== undefined ? `${fmt(stats.avgScore, 1)}%` : '—'} />
          <Stat label="VALID" value={String(stats.valid)} className="text-emerald-200" />
          <Stat label="PENDING" value={String(stats.pending)} className="text-sky-200" />
          <Stat label="NO_SETUP" value={String(stats.noSetup)} />
        </div>

        {(error || loading) && (
          <div className="mt-4">
            {loading && (
              <div className="rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white/70">
                Loading assets…
              </div>
            )}
            {error && (
              <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                {error}
              </div>
            )}
          </div>
        )}

        {/* Controls */}
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-12">
          <div className="md:col-span-5">
            <label className="block text-xs text-white/60 mb-1">Search</label>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="BTC, Binance, VALID…"
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
            />
          </div>

          <div className="md:col-span-2">
            <label className="block text-xs text-white/60 mb-1">Class</label>
            <select
              value={assetClass}
              onChange={(e) => setAssetClass(e.target.value as any)}
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
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
          </div>

          <div className="md:col-span-2">
            <label className="block text-xs text-white/60 mb-1">Status</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as any)}
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
            >
              <option value="ALL">ALL</option>
              <option value="VALID">VALID</option>
              <option value="PENDING">PENDING</option>
              <option value="WATCH">WATCH</option>
              <option value="INVALID">INVALID</option>
              <option value="EXPIRED">EXPIRED</option>
            </select>
          </div>

          <div className="md:col-span-3 flex flex-wrap items-end justify-end gap-2">
            <button
              type="button"
              onClick={() => setActiveOnly((p) => !p)}
              className={cn(
                'rounded-xl border px-3 py-2 text-sm font-medium transition',
                activeOnly
                  ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200'
                  : 'border-zinc-500/25 bg-zinc-500/10 text-zinc-200'
              )}
              title="Filtre actifs"
            >
              active: {activeOnly ? 'true' : 'false'}
            </button>

            <div className="min-w-[180px]">
              <label className="block text-xs text-white/60 mb-1">Sort</label>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
              >
                <option value="score_desc">Score ↓</option>
                <option value="score_asc">Score ↑</option>
                <option value="symbol_asc">Symbol A→Z</option>
                <option value="last_analysis_desc">Last analysis ↓</option>
                <option value="price_desc">Price ↓</option>
                <option value="price_asc">Price ↑</option>
              </select>
            </div>
          </div>
        </div>

        {/* Pagination (optional) */}
        {(onPrevPage || onNextPage) && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-white/50">
              Page: <span className="text-white/70">{page ?? '—'}</span>
              <span className="mx-2 text-white/20">·</span>
              Total pages: <span className="text-white/70">{pageCount ?? '—'}</span>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onPrevPage}
                disabled={!onPrevPage}
                className={cn(
                  'rounded-xl border px-3 py-2 text-xs transition',
                  onPrevPage ? 'border-white/10 bg-white/5 text-white/80 hover:bg-white/10' : 'border-white/10 bg-white/5 text-white/40'
                )}
              >
                Prev
              </button>
              <button
                type="button"
                onClick={onNextPage}
                disabled={!onNextPage}
                className={cn(
                  'rounded-xl border px-3 py-2 text-xs transition',
                  onNextPage ? 'border-white/10 bg-white/5 text-white/80 hover:bg-white/10' : 'border-white/10 bg-white/5 text-white/40'
                )}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="p-5">
        {/* Skeletons */}
        {loading && (!assets || assets.length === 0) && (
          <div className={cn('grid gap-3', gridCols)}>
            {Array.from({ length: view === 'grid' ? 6 : 4 }).map((_, i) => (
              <div
                key={i}
                className="rounded-2xl border border-white/10 bg-black/20 p-4 animate-pulse"
              >
                <div className="h-4 w-40 rounded bg-white/10" />
                <div className="mt-2 h-3 w-64 rounded bg-white/10" />
                <div className="mt-4 h-8 w-full rounded bg-white/10" />
                <div className="mt-3 h-2 w-full rounded bg-white/10" />
              </div>
            ))}
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="rounded-2xl border border-white/10 bg-black/20 p-5">
            <div className="text-sm text-white/70">Aucun asset ne correspond aux filtres.</div>
            <div className="text-xs text-white/50 mt-1">
              Astuce: enlève le filtre status, ou passe active=false, ou ajoute des assets dans Settings.
            </div>
          </div>
        )}

        <div className={cn('grid gap-3', gridCols)}>
          <AnimatePresence initial={false}>
            {filtered.map((a) => {
              const sel = !!selectedSymbol && a.symbol.toUpperCase() === selectedSymbol.toUpperCase();
              const lp = livePrices?.[a.symbol.toUpperCase()] ?? livePrices?.[a.symbol] ?? null;

              return (
                <motion.div
                  key={a.symbol}
                  layout
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                >
                  <AssetCard
                    asset={a}
                    compact={view === 'list'}
                    selected={sel}
                    livePrice={lp}
                    showMeta={showMeta}
                    onSelect={() => onSelectSymbol?.(a.symbol)}
                    onRefreshAnalysis={onRefreshAsset}
                    onToggleActive={onToggleActive}
                    onDelete={onDeleteAsset}
                    onEdit={onEditAsset}
                  />
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      </div>

      {/* Footer */}
      <div className="border-t border-white/10 bg-black/15 px-5 py-4 flex items-center justify-between gap-3">
        <div className="text-[11px] text-white/50">
          Tip: “Pinned” utilise <code className="text-white/70">asset.meta.pinned</code> (ou <code className="text-white/70">meta.watch</code>).
        </div>

        <button
          type="button"
          onClick={() => {
            setQuery('');
            setAssetClass(defaultAssetClass);
            setActiveOnly(defaultActiveOnly);
            setStatusFilter(defaultStatusFilter);
            setSort('score_desc');
          }}
          className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/75 hover:bg-white/10 transition"
        >
          Reset filters
        </button>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Helpers / UI
────────────────────────────────────────────────────────────── */

function cn(...classes: Array<string | undefined | null | false>) {
  return classes.filter(Boolean).join(' ');
}

function fmt(n: number | undefined, digits = 2) {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits }).format(n);
}

function Stat({ label, value, accent, className }: { label: string; value: string; accent?: boolean; className?: string }) {
  return (
    <div className={cn('rounded-xl border border-white/10 bg-black/20 px-3 py-2', accent && 'bg-gradient-to-b from-white/10 to-black/20')}>
      <div className="text-[11px] text-white/55">{label}</div>
      <div className={cn('text-sm font-semibold text-white/90 truncate', className)}>{value}</div>
    </div>
  );
}

function ToggleButton({ label, value, onClick }: { label: string; value: boolean; onClick: () => void }) {
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
      <span className={cn('h-2.5 w-2.5 rounded-full', value ? 'bg-[#E85D1A]' : 'bg-white/30')} />
    </button>
  );
}

function isPinned(a: AssetResponse) {
  const m = a.meta;
  if (!m) return false;
  if (typeof m === 'object') {
    return !!(m.pinned ?? m.watch ?? m.favorite ?? m.fav);
  }
  return false;
}