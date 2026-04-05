/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

export type ZoneType = 'DEMAND' | 'SUPPLY' | 'FLIPPY_D' | 'FLIPPY_S' | 'HIDDEN_D' | 'HIDDEN_S';
export type BaseType = 'RBR' | 'DBD' | 'RBD' | 'DBR';

export type BaseResult = {
  id: string;
  base_type: BaseType;
  zone_top: number;
  zone_bot: number;
  score: number;

  is_solid: boolean;
  is_weakening: boolean;
  is_hidden: boolean;

  touch_count: number;
  candle_count: number;

  formed_at: number; // sec or ms
  timeframe: string;

  engulfment_ratio: number;
};

export type SDZoneResult = {
  id: string;
  zone_type: ZoneType;
  base: BaseResult;

  zone_top: number;
  zone_bot: number;

  sde_confirmed: boolean;
  sde_score: number;

  sgb_created: boolean;
  sdp_validated: boolean;
  sdp_head?: number;

  ftb_count: number;
  is_ftb_valid: boolean;

  is_flippy: boolean;
  is_failed: boolean;

  formed_at: number; // sec or ms
  timeframe: string;
  score: number;
};

type SortKey = 'score_desc' | 'score_asc' | 'recent' | 'distance_to_price' | 'ftb_desc';

export default function FlippyZone({
  zones,
  currentPrice,
  selectedZoneId,
  onSelectZone,
  onFocusZone,
  onFocusPrice,
  className,
  defaultExpanded = true,

  /** If true: only FLIPPY_* / is_flippy zones are listed. */
  flippyOnly = true,
}: {
  zones: SDZoneResult[];
  currentPrice?: number | null;

  selectedZoneId?: string | null;
  onSelectZone?: (z: SDZoneResult) => void;

  /** Typically: chartRef.current?.focusZone(z) */
  onFocusZone?: (z: SDZoneResult) => void;

  /** Typically: chartRef.current?.focusPrice(price) */
  onFocusPrice?: (price: number, label?: string) => void;

  className?: string;
  defaultExpanded?: boolean;
  flippyOnly?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  // internal selection if parent doesn't control
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('score_desc');

  const [minScore, setMinScore] = useState(0);
  const [hideFailed, setHideFailed] = useState(true);
  const [confirmedOnly, setConfirmedOnly] = useState(false);
  const [ftbOnly, setFtbOnly] = useState(false);

  const [showRaw, setShowRaw] = useState(false);

  const effectiveSelectedId = selectedZoneId ?? internalSelectedId;

  const flippyZones = useMemo(() => {
    const list = Array.isArray(zones) ? zones : [];
    if (!flippyOnly) return list;
    return list.filter((z) => z.is_flippy || z.zone_type === 'FLIPPY_D' || z.zone_type === 'FLIPPY_S');
  }, [zones, flippyOnly]);

  const derived = useMemo(() => {
    const list = flippyZones;
    const total = list.length;

    let bullish = 0;
    let bearish = 0;
    let failed = 0;
    let confirmed = 0;

    for (const z of list) {
      const dir = flippyDirection(z);
      if (dir === 'BULLISH') bullish += 1;
      if (dir === 'BEARISH') bearish += 1;
      if (z.is_failed) failed += 1;
      if (z.sde_confirmed && z.sdp_validated) confirmed += 1;
    }

    const avgScore = total
      ? list.reduce((acc, z) => acc + (z.score ?? 0), 0) / total
      : undefined;

    const best = [...list].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0] ?? null;

    return { total, bullish, bearish, failed, confirmed, avgScore, best };
  }, [flippyZones]);

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    let list = [...flippyZones];

    if (q) {
      list = list.filter((z) => {
        const hay = `${z.id} ${z.zone_type} ${z.timeframe} ${z.base?.base_type ?? ''}`.toUpperCase();
        return hay.includes(q);
      });
    }

    list = list.filter((z) => (z.score ?? 0) >= minScore);

    if (hideFailed) list = list.filter((z) => !z.is_failed);
    if (confirmedOnly) list = list.filter((z) => z.sde_confirmed && z.sdp_validated);
    if (ftbOnly) list = list.filter((z) => z.is_ftb_valid);

    list.sort((a, b) => {
      switch (sort) {
        case 'score_desc':
          return (b.score ?? 0) - (a.score ?? 0) || (b.sde_score ?? 0) - (a.sde_score ?? 0);
        case 'score_asc':
          return (a.score ?? 0) - (b.score ?? 0);
        case 'recent':
          return toMs(b.formed_at) - toMs(a.formed_at) || (b.score ?? 0) - (a.score ?? 0);
        case 'ftb_desc':
          return (b.ftb_count ?? 0) - (a.ftb_count ?? 0) || (b.score ?? 0) - (a.score ?? 0);
        case 'distance_to_price': {
          const p = currentPrice ?? NaN;
          const da = Number.isFinite(p) ? zoneDistanceToPrice(a, p) : Number.POSITIVE_INFINITY;
          const db = Number.isFinite(p) ? zoneDistanceToPrice(b, p) : Number.POSITIVE_INFINITY;
          return da - db || (b.score ?? 0) - (a.score ?? 0);
        }
        default:
          return (b.score ?? 0) - (a.score ?? 0);
      }
    });

    return list;
  }, [
    flippyZones,
    search,
    minScore,
    hideFailed,
    confirmedOnly,
    ftbOnly,
    sort,
    currentPrice,
  ]);

  const selected = useMemo(() => {
    if (!effectiveSelectedId) return null;
    return flippyZones.find((z) => z.id === effectiveSelectedId) ?? null;
  }, [flippyZones, effectiveSelectedId]);

  const selectZone = (z: SDZoneResult) => {
    setInternalSelectedId(z.id);
    onSelectZone?.(z);
  };

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
          <div className="min-w-0">
            <div className="text-sm font-semibold text-white/90">Flippy zones</div>
            <div className="text-xs text-white/60 mt-1">
              Une zone “flippy” = zone qui a changé de rôle (résistance → support ou inverse).
              Cette vue isole ces zones pour mieux trader les retests.
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70">
              {derived.total} flippy
            </span>
            <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70">
              avg {derived.avgScore !== undefined ? `${fmt(derived.avgScore, 1)}%` : '—'}
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
            <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-6">
              <Stat label="Bullish" value={String(derived.bullish)} accent="green" />
              <Stat label="Bearish" value={String(derived.bearish)} accent="rose" />
              <Stat label="Confirmed" value={String(derived.confirmed)} accent />
              <Stat label="Failed" value={String(derived.failed)} />
              <Stat label="Shown" value={String(filtered.length)} />
              <Stat label="Sort" value={sortLabel(sort)} />
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-12">
              <div className="md:col-span-6">
                <label className="block text-xs text-white/60 mb-1">Search</label>
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="FLIPPY / H4 / RBR…"
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
                  <option value="score_desc">Score ↓</option>
                  <option value="score_asc">Score ↑</option>
                  <option value="recent">Most recent</option>
                  <option value="ftb_desc">FTB count ↓</option>
                  <option value="distance_to_price">Distance to price</option>
                </select>
              </div>

              <div className="md:col-span-3">
                <label className="block text-xs text-white/60 mb-1">Min score</label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={minScore}
                  onChange={(e) => setMinScore(Number(e.target.value || 0))}
                  className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
                />
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                <Toggle label="Hide failed" value={hideFailed} onChange={setHideFailed} />
                <Toggle label="Confirmed only" value={confirmedOnly} onChange={setConfirmedOnly} />
                <Toggle label="FTB only" value={ftbOnly} onChange={setFtbOnly} />
                <Toggle label="Raw JSON" value={showRaw} onChange={setShowRaw} />
              </div>

              <div className="text-[11px] text-white/45">
                Distance = 0 si le prix est déjà dans la zone.
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
            {flippyZones.length === 0 ? (
              <div className="rounded-xl border border-white/10 bg-black/20 p-4 text-sm text-white/60">
                Aucune flippy zone détectée pour ce timeframe.
              </div>
            ) : filtered.length === 0 ? (
              <div className="rounded-xl border border-white/10 bg-black/20 p-4 text-sm text-white/60">
                Aucun résultat avec ces filtres.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
                {/* list */}
                <div className="xl:col-span-7 space-y-2">
                  <div className="text-[11px] text-white/50">
                    Tip: clique une zone pour afficher le détail et “Focus zone” sur le chart (si branché).
                  </div>

                  {filtered.map((z) => {
                    const isSel = z.id === effectiveSelectedId;
                    const dir = flippyDirection(z);
                    const dist =
                      currentPrice !== undefined && currentPrice !== null
                        ? zoneDistanceToPrice(z, currentPrice)
                        : undefined;

                    return (
                      <motion.button
                        layout
                        key={z.id}
                        onClick={() => selectZone(z)}
                        className={cn(
                          'w-full text-left rounded-2xl border p-4 transition shadow-[0_18px_60px_rgba(0,0,0,0.45)]',
                          isSel ? 'border-white/20 bg-white/10' : 'border-white/10 bg-black/20 hover:bg-white/10'
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <FlippyTypePill zone={z} />

                              <span className={cn('rounded-full border px-2.5 py-1 text-[11px] font-medium', dirPill(dir))}>
                                {dir}
                              </span>

                              <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/70">
                                {z.timeframe}
                              </span>

                              <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/70">
                                Base {z.base?.base_type ?? '—'}
                              </span>

                              {z.is_failed && (
                                <span className="rounded-full border border-rose-500/25 bg-rose-500/10 px-2.5 py-1 text-[11px] text-rose-200">
                                  Failed
                                </span>
                              )}

                              <span className="text-[11px] text-white/45 truncate">
                                {fmtTs(z.formed_at)}
                              </span>
                            </div>

                            <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
                              <MiniStat label="Top" value={fmt(z.zone_top, 6)} />
                              <MiniStat label="Bot" value={fmt(z.zone_bot, 6)} />
                              <MiniStat label="Score" value={`${fmt(z.score, 0)}%`} />
                              <MiniStat label="Touches" value={String(z.base?.touch_count ?? 0)} />
                            </div>

                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <Badge ok={z.sde_confirmed} label={`SDE ${fmt(z.sde_score, 0)}%`} />
                              <Badge ok={z.sdp_validated} label="SDP" />
                              <Badge ok={z.is_ftb_valid} label={`FTB ${z.ftb_count}`} />
                              {dist !== undefined && Number.isFinite(dist) && (
                                <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/65">
                                  Δ {fmt(dist, 6)}
                                </span>
                              )}
                            </div>
                          </div>

                          <div className="text-right min-w-[120px]">
                            <div className="text-[11px] text-white/55">Strength</div>
                            <div className="text-2xl font-semibold tracking-tight">{fmt(z.score, 0)}%</div>
                            <div className="mt-2">
                              <ScoreBar value={z.score} color={zoneColor(z.zone_type)} />
                            </div>
                          </div>
                        </div>
                      </motion.button>
                    );
                  })}
                </div>

                {/* details */}
                <div className="xl:col-span-5">
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-white/90">Selected flippy</div>
                        <div className="text-xs text-white/60 mt-1">
                          {selected ? (
                            <>
                              <span className="text-white/85">{zoneLabel(selected.zone_type)}</span>
                              <span className="mx-2 text-white/20">·</span>
                              score <span className="text-white/85">{fmt(selected.score, 0)}%</span>
                            </>
                          ) : (
                            'Sélectionne une flippy zone.'
                          )}
                        </div>
                      </div>

                      {selected && (
                        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70">
                          {selected.timeframe}
                        </span>
                      )}
                    </div>

                    {selected ? (
                      <div className="mt-4 space-y-3">
                        <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                          <div className="text-xs font-medium text-white/70 mb-2">Interpretation</div>
                          <div className="text-xs text-white/75 leading-relaxed">
                            {flippyDirection(selected) === 'BULLISH' ? (
                              <>
                                Zone qui a basculé en <span className="text-white/90 font-semibold">support (Demand)</span>.
                                Les meilleurs trades se font souvent sur retest propre + confirmation (SDE/SDP/structure).
                              </>
                            ) : (
                              <>
                                Zone qui a basculé en <span className="text-white/90 font-semibold">résistance (Supply)</span>.
                                Cherche un retest avec rejet clair + alignement structure.
                              </>
                            )}
                            {selected.is_failed ? (
                              <span className="block mt-2 text-rose-200/90">
                                Attention: zone marquée “failed” par le moteur → qualité potentiellement compromise.
                              </span>
                            ) : null}
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                          <MiniStat label="Type" value={zoneLabel(selected.zone_type)} />
                          <MiniStat label="Direction" value={flippyDirection(selected)} />
                          <MiniStat label="Top" value={fmt(selected.zone_top, 8)} />
                          <MiniStat label="Bot" value={fmt(selected.zone_bot, 8)} />
                          <MiniStat label="SDE" value={selected.sde_confirmed ? `OK · ${fmt(selected.sde_score, 0)}%` : 'NO'} />
                          <MiniStat label="SDP" value={selected.sdp_validated ? 'OK' : 'NO'} />
                          <MiniStat label="FTB" value={`${selected.ftb_count} · ${selected.is_ftb_valid ? 'valid' : 'no'}`} />
                          <MiniStat label="Formed" value={fmtTs(selected.formed_at)} />
                        </div>

                        <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                          <div className="text-xs font-medium text-white/70 mb-2">Base confluence</div>
                          <div className="grid grid-cols-2 gap-2">
                            <MiniStat label="Base type" value={selected.base?.base_type ?? '—'} />
                            <MiniStat label="Base score" value={`${fmt(selected.base?.score ?? 0, 0)}%`} />
                            <MiniStat label="Solid" value={selected.base?.is_solid ? 'Oui' : 'Non'} />
                            <MiniStat label="Weakening" value={selected.base?.is_weakening ? 'Oui' : 'Non'} />
                            <MiniStat label="Touches" value={String(selected.base?.touch_count ?? 0)} />
                            <MiniStat label="Engulf" value={fmt(selected.base?.engulfment_ratio ?? 0, 2)} />
                          </div>
                        </div>

                        <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                          <div className="text-xs font-medium text-white/70 mb-2">Actions</div>

                          <div className="grid grid-cols-2 gap-2">
                            <button
                              onClick={() => copyToClipboard(String(selected.zone_top))}
                              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition"
                            >
                              Copy top
                            </button>
                            <button
                              onClick={() => copyToClipboard(String(selected.zone_bot))}
                              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition"
                            >
                              Copy bot
                            </button>

                            <button
                              onClick={() => onFocusZone?.(selected)}
                              disabled={!onFocusZone}
                              className={cn(
                                'rounded-xl border px-3 py-2 text-xs transition',
                                onFocusZone
                                  ? 'border-[#378ADD]/25 bg-[#378ADD]/10 text-sky-200 hover:bg-[#378ADD]/15'
                                  : 'border-white/10 bg-white/5 text-white/40'
                              )}
                            >
                              Focus zone
                            </button>

                            <button
                              onClick={() => {
                                const mid = (selected.zone_top + selected.zone_bot) / 2;
                                onFocusPrice?.(mid, 'Flippy MID');
                              }}
                              disabled={!onFocusPrice}
                              className={cn(
                                'rounded-xl border px-3 py-2 text-xs transition',
                                onFocusPrice
                                  ? 'border-[#E85D1A]/25 bg-[#E85D1A]/10 text-orange-200 hover:bg-[#E85D1A]/15'
                                  : 'border-white/10 bg-white/5 text-white/40'
                              )}
                              title="Focus sur le milieu de zone (pratique pour se repérer)"
                            >
                              Focus mid
                            </button>
                          </div>

                          {typeof selected.sdp_head === 'number' && Number.isFinite(selected.sdp_head) && (
                            <div className="mt-2">
                              <button
                                onClick={() => onFocusPrice?.(selected.sdp_head!, 'SDP HEAD')}
                                disabled={!onFocusPrice}
                                className={cn(
                                  'w-full rounded-xl border px-3 py-2 text-xs transition',
                                  onFocusPrice
                                    ? 'border-white/10 bg-white/5 text-white/80 hover:bg-white/10'
                                    : 'border-white/10 bg-white/5 text-white/40'
                                )}
                              >
                                Focus SDP head: {fmt(selected.sdp_head, 6)}
                              </button>
                            </div>
                          )}

                          <div className="mt-3">
                            <div className="flex items-center justify-between text-[11px] text-white/55 mb-1">
                              <span>Zone score</span>
                              <span className="text-white/70">{fmt(selected.score, 0)}%</span>
                            </div>
                            <ScoreBar value={selected.score} color={zoneColor(selected.zone_type)} />
                          </div>
                        </div>

                        <details className="rounded-xl border border-white/10 bg-black/30 p-3">
                          <summary className="cursor-pointer text-xs text-white/70 hover:text-white/85 transition">
                            Raw zone JSON
                          </summary>
                          <pre className="mt-2 rounded-xl border border-white/10 bg-black/40 p-3 text-xs text-white/75 overflow-auto max-h-[320px]">
                            {JSON.stringify(selected, null, 2)}
                          </pre>
                        </details>
                      </div>
                    ) : (
                      <div className="mt-4 rounded-xl border border-white/10 bg-black/30 p-4 text-sm text-white/60">
                        Clique une zone à gauche pour afficher ses détails.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {showRaw && (
              <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <div className="text-xs font-medium text-white/70 mb-2">Raw flippy zones JSON</div>
                <pre className="rounded-xl border border-white/10 bg-black/30 p-3 text-xs text-white/75 overflow-auto max-h-[520px]">
                  {JSON.stringify(flippyZones ?? [], null, 2)}
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
   Helpers / UI
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

function sortLabel(k: SortKey) {
  switch (k) {
    case 'score_desc': return 'Score ↓';
    case 'score_asc': return 'Score ↑';
    case 'recent': return 'Recent';
    case 'distance_to_price': return 'Distance';
    case 'ftb_desc': return 'FTB ↓';
  }
}

function zoneLabel(t: ZoneType) {
  switch (t) {
    case 'DEMAND': return 'Demand';
    case 'SUPPLY': return 'Supply';
    case 'FLIPPY_D': return 'Flippy Demand';
    case 'FLIPPY_S': return 'Flippy Supply';
    case 'HIDDEN_D': return 'Hidden Demand';
    case 'HIDDEN_S': return 'Hidden Supply';
    default: return t;
  }
}

function zoneColor(t: ZoneType) {
  const map: Record<ZoneType, string> = {
    DEMAND: '#1D9E75',
    SUPPLY: '#E24B4A',
    FLIPPY_D: '#378ADD',
    FLIPPY_S: '#E85D1A',
    HIDDEN_D: '#2AD4A5',
    HIDDEN_S: '#FF6B6A',
  };
  return map[t] ?? '#A1A1AA';
}

function flippyDirection(z: SDZoneResult): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
  // convention UI:
  // FLIPPY_D => flipped to demand (bullish)
  // FLIPPY_S => flipped to supply (bearish)
  if (z.zone_type === 'FLIPPY_D') return 'BULLISH';
  if (z.zone_type === 'FLIPPY_S') return 'BEARISH';

  // fallback: infer from zone_type if engine uses is_flippy with DEMAND/SUPPLY
  if (z.is_flippy && z.zone_type === 'DEMAND') return 'BULLISH';
  if (z.is_flippy && z.zone_type === 'SUPPLY') return 'BEARISH';
  return 'NEUTRAL';
}

function dirPill(dir: 'BULLISH' | 'BEARISH' | 'NEUTRAL') {
  if (dir === 'BULLISH') return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200';
  if (dir === 'BEARISH') return 'border-rose-500/25 bg-rose-500/10 text-rose-200';
  return 'border-white/10 bg-white/5 text-white/70';
}

function zoneDistanceToPrice(z: SDZoneResult, price: number) {
  const hi = Math.max(z.zone_top, z.zone_bot);
  const lo = Math.min(z.zone_top, z.zone_bot);
  if (price >= lo && price <= hi) return 0;
  return Math.min(Math.abs(price - lo), Math.abs(price - hi));
}

function FlippyTypePill({ zone }: { zone: SDZoneResult }) {
  const c = zoneColor(zone.zone_type);
  return (
    <span
      className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-medium text-white/85"
      style={{ boxShadow: `0 0 0 1px ${hexToRgba(c, 0.35)} inset` }}
    >
      <span className="inline-block h-2 w-2 rounded-full mr-2 align-middle" style={{ backgroundColor: c }} />
      {zoneLabel(zone.zone_type)}
    </span>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: 'green' | 'rose' | boolean;
}) {
  const cls =
    accent === 'green'
      ? 'border-emerald-500/15 bg-emerald-500/10'
      : accent === 'rose'
        ? 'border-rose-500/15 bg-rose-500/10'
        : accent
          ? 'bg-gradient-to-b from-white/10 to-black/20'
          : 'border-white/10 bg-black/20';

  return (
    <div className={cn('rounded-xl border px-3 py-2', cls)}>
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

function Badge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={cn(
        'rounded-full border px-2.5 py-1 text-[11px] font-medium',
        ok ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200' : 'border-white/10 bg-white/5 text-white/70'
      )}
    >
      {label}
    </span>
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

function ScoreBar({ value, color }: { value: number; color: string }) {
  const v = Math.max(0, Math.min(100, value ?? 0));
  return (
    <div className="h-2 rounded-full border border-white/10 bg-white/5 overflow-hidden">
      <div
        className="h-full rounded-full"
        style={{
          width: `${v}%`,
          background: `linear-gradient(90deg, ${hexToRgba(color, 0.65)} 0%, ${hexToRgba(color, 0.18)} 100%)`,
        }}
      />
    </div>
  );
}

function hexToRgba(hex: string, a: number) {
  const h = hex.replace('#', '').trim();
  if (h.length !== 6) return `rgba(255,255,255,${a})`;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
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