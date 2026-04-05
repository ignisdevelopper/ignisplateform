/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export type SwingType = 'HH' | 'HL' | 'LH' | 'LL';

export type SwingPoint = {
  timestamp: number; // seconds or ms
  price: number;
  swing_type: SwingType;
  index: number;
};

export type MarketStructure = {
  phase: string;
  trend: string;
  swing_points: SwingPoint[];

  last_hh?: number;
  last_hl?: number;
  last_lh?: number;
  last_ll?: number;

  structure_breaks: object[]; // backend: object[]
  htf_phase?: string;
  htf_bias?: string;
};

type SortKey = 'recent' | 'oldest' | 'price_desc' | 'price_asc' | 'type_then_recent';

type NormalizedBreak = {
  key: string;
  kind: string;
  direction?: string;
  timestamp?: number | string;
  price?: number;
  timeframe?: string;
  reason?: string;
  raw: any;
};

export default function MarketStructurePanel({
  marketStructure,
  currentPrice,
  className,
  defaultExpanded = true,
  selectedSwingKey,
  onSelectSwing,
  onFocusPrice,
  onFocusTime,
}: {
  marketStructure?: MarketStructure | null;
  currentPrice?: number | null;
  className?: string;
  defaultExpanded?: boolean;

  selectedSwingKey?: string | null;
  onSelectSwing?: (sp: SwingPoint & { key: string }) => void;
  onFocusPrice?: (price: number) => void;
  onFocusTime?: (timestamp: number) => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('type_then_recent');
  const [typeFilter, setTypeFilter] = useState<SwingType[]>([]);
  const [minIndex, setMinIndex] = useState<number>(0);

  const [showBreaks, setShowBreaks] = useState(true);
  const [showRaw, setShowRaw] = useState(false);

  const swings = marketStructure?.swing_points ?? [];

  const swingsWithKey = useMemo(() => {
    return swings.map((sp, i) => ({
      ...sp,
      key: `${sp.swing_type}|${sp.timestamp}|${sp.price}|${sp.index}|${i}`,
    }));
  }, [swings]);

  const derived = useMemo(() => {
    const counts: Record<SwingType, number> = { HH: 0, HL: 0, LH: 0, LL: 0 };
    for (const sp of swings) counts[sp.swing_type] = (counts[sp.swing_type] ?? 0) + 1;

    const last = (t: SwingType) =>
      [...swings].reverse().find((x) => x.swing_type === t) ?? null;

    const lastHH = last('HH');
    const lastHL = last('HL');
    const lastLH = last('LH');
    const lastLL = last('LL');

    // crude “bias” guess from trend + last swings
    const trend = (marketStructure?.trend ?? '').toUpperCase();
    const bias =
      trend.includes('BULL') || trend.includes('UP')
        ? 'BULLISH'
        : trend.includes('BEAR') || trend.includes('DOWN')
          ? 'BEARISH'
          : marketStructure?.htf_bias
            ? String(marketStructure.htf_bias).toUpperCase()
            : 'NEUTRAL';

    return {
      counts,
      lastHH,
      lastHL,
      lastLH,
      lastLL,
      bias,
      total: swings.length,
    };
  }, [swings, marketStructure?.trend, marketStructure?.htf_bias]);

  const filteredSwings = useMemo(() => {
    const q = search.trim().toUpperCase();
    let list = [...swingsWithKey];

    if (q) {
      list = list.filter((sp) => {
        const hay = `${sp.swing_type} ${sp.index} ${sp.price} ${fmtTs(sp.timestamp)}`.toUpperCase();
        return hay.includes(q);
      });
    }

    if (typeFilter.length) {
      const set = new Set(typeFilter);
      list = list.filter((sp) => set.has(sp.swing_type));
    }

    list = list.filter((sp) => sp.index >= minIndex);

    list.sort((a, b) => {
      switch (sort) {
        case 'recent':
          return toMs(b.timestamp) - toMs(a.timestamp);
        case 'oldest':
          return toMs(a.timestamp) - toMs(b.timestamp);
        case 'price_desc':
          return (b.price ?? 0) - (a.price ?? 0);
        case 'price_asc':
          return (a.price ?? 0) - (b.price ?? 0);
        case 'type_then_recent': {
          const rank = (t: SwingType) => (t === 'HH' ? 0 : t === 'HL' ? 1 : t === 'LH' ? 2 : 3);
          return rank(a.swing_type) - rank(b.swing_type) || (toMs(b.timestamp) - toMs(a.timestamp));
        }
        default:
          return toMs(b.timestamp) - toMs(a.timestamp);
      }
    });

    return list;
  }, [swingsWithKey, search, typeFilter, minIndex, sort]);

  const normalizedBreaks = useMemo(() => {
    const raw = (marketStructure?.structure_breaks ?? []) as any[];
    return normalizeBreaks(raw);
  }, [marketStructure?.structure_breaks]);

  const effectiveSelectedKey = selectedSwingKey;
  const selected = useMemo(() => {
    if (!effectiveSelectedKey) return null;
    return swingsWithKey.find((x) => x.key === effectiveSelectedKey) ?? null;
  }, [swingsWithKey, effectiveSelectedKey]);

  const ms = marketStructure;

  return (
    <div
      className={cn(
        'rounded-2xl border border-white/10 bg-white/5 backdrop-blur-[20px] shadow-[0_25px_80px_rgba(0,0,0,0.55)] overflow-hidden',
        className
      )}
    >
      {/* Header */}
      <div className="border-b border-white/10 bg-black/20 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-white/90">Market structure</div>
            <div className="text-xs text-white/60 mt-1">
              Phase/trend + swings + breaks. Clique un swing pour inspecter, copier, ou focus le chart.
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className={cn('rounded-full border px-3 py-1 text-xs font-medium', biasPill(derived.bias))}>
              {derived.bias}
            </span>
            <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70">
              {derived.total} swings
            </span>
            <button
              onClick={() => setExpanded((p) => !p)}
              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition"
            >
              {expanded ? 'Collapse' : 'Expand'}
            </button>
          </div>
        </div>

        {expanded && (
          <>
            {/* Overview */}
            <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-6">
              <Stat label="Phase" value={ms?.phase ?? '—'} />
              <Stat label="Trend" value={ms?.trend ?? '—'} />
              <Stat label="HTF Phase" value={ms?.htf_phase ?? '—'} />
              <Stat label="HTF Bias" value={ms?.htf_bias ?? '—'} />
              <Stat label="Breaks" value={String((ms?.structure_breaks ?? []).length)} accent />
              <Stat label="Price" value={currentPrice !== null && currentPrice !== undefined ? fmt(currentPrice, 6) : '—'} />
            </div>

            {/* Quick last pivots */}
            <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
              <PivotCard title="Last HH" sp={derived.lastHH} />
              <PivotCard title="Last HL" sp={derived.lastHL} />
              <PivotCard title="Last LH" sp={derived.lastLH} />
              <PivotCard title="Last LL" sp={derived.lastLL} />
            </div>

            {/* Controls */}
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-12">
              <div className="md:col-span-6">
                <label className="block text-xs text-white/60 mb-1">Search</label>
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="HH / 65000 / 2026-…"
                  className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
                />
              </div>

              <div className="md:col-span-3">
                <label className="block text-xs text-white/60 mb-1">Sort</label>
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value as SortKey)}
                  className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                >
                  <option value="type_then_recent">Type → Recent</option>
                  <option value="recent">Recent</option>
                  <option value="oldest">Oldest</option>
                  <option value="price_desc">Price ↓</option>
                  <option value="price_asc">Price ↑</option>
                </select>
              </div>

              <div className="md:col-span-3">
                <label className="block text-xs text-white/60 mb-1">Min index</label>
                <input
                  type="number"
                  min={0}
                  value={minIndex}
                  onChange={(e) => setMinIndex(Number(e.target.value || 0))}
                  className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
                />
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                {(['HH', 'HL', 'LH', 'LL'] as SwingType[]).map((t) => {
                  const on = typeFilter.includes(t);
                  return (
                    <button
                      key={t}
                      onClick={() =>
                        setTypeFilter((prev) => (on ? prev.filter((x) => x !== t) : [...prev, t]))
                      }
                      className={cn(
                        'rounded-full border px-3 py-1.5 text-xs font-medium transition',
                        on
                          ? swingTypePill(t)
                          : 'border-white/10 bg-white/5 text-white/65 hover:bg-white/10'
                      )}
                    >
                      {t} <span className="text-white/45 font-normal">({derived.counts[t] ?? 0})</span>
                    </button>
                  );
                })}

                {typeFilter.length > 0 && (
                  <button
                    onClick={() => setTypeFilter([])}
                    className="rounded-full border border-white/10 bg-black/20 px-3 py-1.5 text-xs text-white/70 hover:bg-white/10 transition"
                  >
                    Clear types
                  </button>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                <Toggle label="Show breaks" value={showBreaks} onChange={setShowBreaks} />
                <Toggle label="Raw JSON" value={showRaw} onChange={setShowRaw} />
              </div>
            </div>
          </>
        )}
      </div>

      {/* Body */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="body"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            className="p-4 space-y-4"
          >
            {/* Breaks */}
            {showBreaks && (
              <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold text-white/90">Structure breaks</div>
                    <div className="text-xs text-white/60 mt-1">
                      Rendu robuste de <code className="text-white/70">structure_breaks</code> (format backend variable).
                    </div>
                  </div>
                  <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70">
                    {normalizedBreaks.length}
                  </span>
                </div>

                <div className="mt-3 space-y-2">
                  {normalizedBreaks.length === 0 ? (
                    <div className="rounded-xl border border-white/10 bg-black/30 p-3 text-sm text-white/60">
                      Aucun break détecté.
                    </div>
                  ) : (
                    normalizedBreaks.slice(0, 12).map((b) => (
                      <div key={b.key} className="rounded-xl border border-white/10 bg-black/30 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-white/90 truncate">
                              {b.kind}
                              {b.direction ? (
                                <span className="text-white/45 font-normal"> · {String(b.direction).toUpperCase()}</span>
                              ) : null}
                            </div>
                            <div className="text-[11px] text-white/55 mt-1 truncate">
                              {b.timeframe ? `TF ${b.timeframe}` : 'TF —'}
                              <span className="mx-2 text-white/25">·</span>
                              {b.timestamp ? fmtTsAny(b.timestamp) : 'time —'}
                              <span className="mx-2 text-white/25">·</span>
                              {b.price !== undefined ? `price ${fmt(b.price, 6)}` : 'price —'}
                            </div>
                            {b.reason && (
                              <div className="text-xs text-white/70 mt-2 whitespace-pre-wrap">
                                {b.reason}
                              </div>
                            )}
                          </div>

                          <details className="min-w-[90px] text-right">
                            <summary className="cursor-pointer text-xs text-white/60 hover:text-white/80 transition">
                              JSON
                            </summary>
                            <pre className="mt-2 rounded-xl border border-white/10 bg-black/40 p-3 text-xs text-white/75 overflow-auto max-h-[220px]">
                              {JSON.stringify(b.raw ?? null, null, 2)}
                            </pre>
                          </details>
                        </div>
                      </div>
                    ))
                  )}

                  {normalizedBreaks.length > 12 && (
                    <div className="text-[11px] text-white/50">
                      +{normalizedBreaks.length - 12} autres breaks (non affichés).
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Swings list + details */}
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
              <div className="xl:col-span-7">
                <div className="rounded-2xl border border-white/10 bg-black/20 overflow-hidden">
                  <div className="border-b border-white/10 bg-black/25 px-4 py-3 flex items-center justify-between">
                    <div className="text-sm font-semibold text-white/90">Swing points</div>
                    <div className="text-xs text-white/55">
                      {filteredSwings.length} shown
                    </div>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="min-w-full text-left">
                      <thead className="bg-black/20">
                        <tr className="text-[11px] uppercase tracking-wider text-white/45">
                          <th className="px-4 py-3">Type</th>
                          <th className="px-4 py-3">Index</th>
                          <th className="px-4 py-3">Price</th>
                          <th className="px-4 py-3">Time</th>
                          <th className="px-4 py-3 text-right">Actions</th>
                        </tr>
                      </thead>

                      <tbody className="divide-y divide-white/10">
                        {swingsWithKey.length === 0 && (
                          <tr>
                            <td colSpan={5} className="px-4 py-6 text-sm text-white/60">
                              Aucun swing point.
                            </td>
                          </tr>
                        )}

                        {swingsWithKey.length > 0 && filteredSwings.length === 0 && (
                          <tr>
                            <td colSpan={5} className="px-4 py-6 text-sm text-white/60">
                              Aucun résultat avec ces filtres.
                            </td>
                          </tr>
                        )}

                        {filteredSwings.slice(0, 120).map((sp) => {
                          const isSel = sp.key === effectiveSelectedKey;
                          const delta =
                            currentPrice !== undefined && currentPrice !== null
                              ? Math.abs(currentPrice - sp.price)
                              : undefined;

                          return (
                            <tr
                              key={sp.key}
                              onClick={() => onSelectSwing?.(sp)}
                              className={cn(
                                'cursor-pointer transition',
                                isSel ? 'bg-white/10' : 'hover:bg-white/5'
                              )}
                            >
                              <td className="px-4 py-3">
                                <span className={cn('rounded-full border px-2.5 py-1 text-[11px] font-medium', swingTypePill(sp.swing_type))}>
                                  {sp.swing_type}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-sm text-white/80">{sp.index}</td>
                              <td className="px-4 py-3">
                                <div className="text-sm font-semibold text-white/90">{fmt(sp.price, 6)}</div>
                                <div className="text-[11px] text-white/50">
                                  Δ {delta !== undefined ? fmt(delta, 6) : '—'}
                                </div>
                              </td>
                              <td className="px-4 py-3 text-xs text-white/70">{fmtTs(sp.timestamp)}</td>
                              <td className="px-4 py-3 text-right" onClick={(ev) => ev.stopPropagation()}>
                                <div className="flex items-center justify-end gap-2">
                                  <button
                                    onClick={() => copyToClipboard(String(sp.price))}
                                    className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white/80 hover:bg-white/10 transition"
                                  >
                                    Copy
                                  </button>
                                  <button
                                    onClick={() => onFocusPrice?.(sp.price)}
                                    disabled={!onFocusPrice}
                                    className={cn(
                                      'rounded-lg border px-2.5 py-1.5 text-xs transition',
                                      onFocusPrice
                                        ? 'border-[#378ADD]/25 bg-[#378ADD]/10 text-sky-200 hover:bg-[#378ADD]/15'
                                        : 'border-white/10 bg-white/5 text-white/40'
                                    )}
                                  >
                                    Focus
                                  </button>
                                  <button
                                    onClick={() => onFocusTime?.(sp.timestamp)}
                                    disabled={!onFocusTime}
                                    className={cn(
                                      'rounded-lg border px-2.5 py-1.5 text-xs transition',
                                      onFocusTime
                                        ? 'border-[#E85D1A]/25 bg-[#E85D1A]/10 text-orange-200 hover:bg-[#E85D1A]/15'
                                        : 'border-white/10 bg-white/5 text-white/40'
                                    )}
                                    title="Focus time (si ton chart support)"
                                  >
                                    Time
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {filteredSwings.length > 120 && (
                    <div className="border-t border-white/10 bg-black/15 px-4 py-3 text-xs text-white/55">
                      +{filteredSwings.length - 120} swings non affichés (limite UI).
                    </div>
                  )}
                </div>
              </div>

              <div className="xl:col-span-5">
                <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-white/90">Selected swing</div>
                      <div className="text-xs text-white/60 mt-1">
                        {selected ? (
                          <>
                            <span className="text-white/85">{selected.swing_type}</span>
                            <span className="mx-2 text-white/20">·</span>
                            price <span className="text-white/85">{fmt(selected.price, 6)}</span>
                          </>
                        ) : (
                          'Clique un swing dans la table.'
                        )}
                      </div>
                    </div>

                    {selected && (
                      <span className={cn('rounded-full border px-3 py-1 text-xs font-medium', swingTypePill(selected.swing_type))}>
                        {selected.swing_type}
                      </span>
                    )}
                  </div>

                  {selected ? (
                    <div className="mt-4 space-y-3">
                      <div className="grid grid-cols-2 gap-2">
                        <MiniStat label="Type" value={selected.swing_type} />
                        <MiniStat label="Index" value={String(selected.index)} />
                        <MiniStat label="Price" value={fmt(selected.price, 8)} />
                        <MiniStat label="Time" value={fmtTs(selected.timestamp)} />
                      </div>

                      <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                        <div className="text-xs font-medium text-white/70 mb-2">Quick actions</div>
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            onClick={() => copyToClipboard(String(selected.price))}
                            className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition"
                          >
                            Copy price
                          </button>
                          <button
                            onClick={() => copyToClipboard(String(selected.timestamp))}
                            className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition"
                          >
                            Copy time
                          </button>
                        </div>

                        <div className="mt-2 grid grid-cols-2 gap-2">
                          <button
                            onClick={() => onFocusPrice?.(selected.price)}
                            disabled={!onFocusPrice}
                            className={cn(
                              'rounded-xl border px-3 py-2 text-xs transition',
                              onFocusPrice
                                ? 'border-[#378ADD]/25 bg-[#378ADD]/10 text-sky-200 hover:bg-[#378ADD]/15'
                                : 'border-white/10 bg-white/5 text-white/40'
                            )}
                          >
                            Focus chart (price)
                          </button>

                          <button
                            onClick={() => onFocusTime?.(selected.timestamp)}
                            disabled={!onFocusTime}
                            className={cn(
                              'rounded-xl border px-3 py-2 text-xs transition',
                              onFocusTime
                                ? 'border-[#E85D1A]/25 bg-[#E85D1A]/10 text-orange-200 hover:bg-[#E85D1A]/15'
                                : 'border-white/10 bg-white/5 text-white/40'
                            )}
                          >
                            Focus chart (time)
                          </button>
                        </div>
                      </div>

                      <details className="rounded-xl border border-white/10 bg-black/30 p-3">
                        <summary className="cursor-pointer text-xs text-white/70 hover:text-white/85 transition">
                          Raw JSON
                        </summary>
                        <pre className="mt-2 rounded-xl border border-white/10 bg-black/40 p-3 text-xs text-white/75 overflow-auto max-h-[280px]">
                          {JSON.stringify(stripKey(selected), null, 2)}
                        </pre>
                      </details>
                    </div>
                  ) : (
                    <div className="mt-4 rounded-xl border border-white/10 bg-black/30 p-4 text-sm text-white/60">
                      Sélectionne un point (HH/HL/LH/LL) pour afficher ses détails.
                    </div>
                  )}
                </div>
              </div>
            </div>

            {showRaw && (
              <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <div className="text-xs font-medium text-white/70 mb-2">Raw market_structure JSON</div>
                <pre className="rounded-xl border border-white/10 bg-black/30 p-3 text-xs text-white/75 overflow-auto max-h-[520px]">
                  {JSON.stringify(marketStructure ?? null, null, 2)}
                </pre>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Break normalization (format backend variable)
────────────────────────────────────────────────────────────── */

function normalizeBreaks(raw: any[]): NormalizedBreak[] {
  if (!Array.isArray(raw)) return [];

  return raw.map((b, idx) => {
    const kind =
      pickString(b, ['kind', 'type', 'break_type', 'name']) ??
      'Structure break';

    const direction = pickString(b, ['direction', 'side', 'bias']);
    const timeframe = pickString(b, ['timeframe', 'tf']);
    const reason = pickString(b, ['reason', 'message', 'notes', 'comment']);

    const timestamp = b?.timestamp ?? b?.time ?? b?.formed_at ?? b?.at;
    const price = pickNumber(b, ['price', 'level', 'break_price', 'close', 'trigger_price']);

    const key = `${kind}|${direction ?? ''}|${timeframe ?? ''}|${String(timestamp ?? '')}|${String(price ?? '')}|${idx}`;

    return {
      key,
      kind,
      direction,
      timestamp,
      price,
      timeframe,
      reason,
      raw: b,
    };
  });
}

function pickString(obj: any, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}
function pickNumber(obj: any, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

/* ──────────────────────────────────────────────────────────────
   UI Bits + utils
────────────────────────────────────────────────────────────── */

function cn(...classes: Array<string | undefined | null | false>) {
  return classes.filter(Boolean).join(' ');
}

function fmt(n: number | undefined, digits = 2) {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits }).format(n);
}

function toMs(ts: number) {
  return ts < 10_000_000_000 ? ts * 1000 : ts;
}

function fmtTs(ts: number) {
  return new Date(toMs(ts)).toLocaleString('fr-FR', { hour12: false });
}

function fmtTsAny(ts: number | string) {
  if (typeof ts === 'string') {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? ts : d.toLocaleString('fr-FR', { hour12: false });
  }
  return fmtTs(ts);
}

function swingTypePill(t: SwingType) {
  switch (t) {
    case 'HH':
      return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200';
    case 'HL':
      return 'border-teal-500/25 bg-teal-500/10 text-teal-200';
    case 'LH':
      return 'border-orange-500/25 bg-orange-500/10 text-orange-200';
    case 'LL':
      return 'border-rose-500/25 bg-rose-500/10 text-rose-200';
    default:
      return 'border-white/10 bg-white/5 text-white/70';
  }
}

function biasPill(bias: string) {
  const b = (bias ?? '').toUpperCase();
  if (b.includes('BULL')) return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200';
  if (b.includes('BEAR')) return 'border-rose-500/25 bg-rose-500/10 text-rose-200';
  return 'border-white/10 bg-white/5 text-white/70';
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={cn('rounded-xl border border-white/10 bg-black/20 px-3 py-2', accent && 'bg-gradient-to-b from-white/10 to-black/20')}>
      <div className="text-[11px] text-white/55">{label}</div>
      <div className="text-sm font-semibold text-white/90 truncate">{value}</div>
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

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={cn(
        'flex items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left transition',
        value ? 'border-[#E85D1A]/30 bg-[#E85D1A]/10' : 'border-white/10 bg-black/20 hover:bg-white/10'
      )}
    >
      <div className="text-xs font-medium text-white/85">{label}</div>
      <div className={cn('h-6 w-11 rounded-full border p-1 transition', value ? 'border-[#E85D1A]/40 bg-[#E85D1A]/25' : 'border-white/10 bg-white/5')}>
        <div className={cn('h-4 w-4 rounded-full bg-white transition', value ? 'translate-x-5' : 'translate-x-0')} />
      </div>
    </button>
  );
}

function PivotCard({ title, sp }: { title: string; sp: SwingPoint | null }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
      <div className="text-[11px] text-white/55">{title}</div>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <div className="text-sm font-semibold text-white/90">{sp ? fmt(sp.price, 6) : '—'}</div>
        <span className={cn('rounded-full border px-2.5 py-1 text-[11px] font-medium', sp ? swingTypePill(sp.swing_type) : 'border-white/10 bg-white/5 text-white/60')}>
          {sp ? sp.swing_type : '—'}
        </span>
      </div>
      <div className="mt-1 text-[11px] text-white/50 truncate">
        {sp ? fmtTs(sp.timestamp) : '—'}
      </div>
    </div>
  );
}

function stripKey(sp: SwingPoint & { key: string }) {
  const { key, ...rest } = sp;
  return rest;
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