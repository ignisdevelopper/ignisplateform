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

  formed_at: number; // s or ms
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

  formed_at: number; // s or ms
  timeframe: string;
  score: number;
};

type SortKey =
  | 'score_desc'
  | 'score_asc'
  | 'recent'
  | 'ftb_desc'
  | 'touches_desc'
  | 'distance_to_price';

export default function SDEPanel({
  zones,
  currentPrice,
  selectedZoneId,
  onSelectZone,
  onFocusZone,
  onFocusPrice,
  className,
  defaultExpanded = true,
}: {
  zones: SDZoneResult[];
  currentPrice?: number | null;

  /** controlled selection (optional) */
  selectedZoneId?: string | null;

  /** notify selection */
  onSelectZone?: (zone: SDZoneResult) => void;

  /** allow parent chart to highlight top/bot */
  onFocusZone?: (zone: SDZoneResult) => void;

  /** allow parent chart to focus a single price (top/bot/sdp_head) */
  onFocusPrice?: (price: number) => void;

  className?: string;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  // if parent doesn't control selection
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('score_desc');

  const [typeFilter, setTypeFilter] = useState<ZoneType[]>([]);
  const [minScore, setMinScore] = useState<number>(0);

  const [sdeOnly, setSdeOnly] = useState<boolean>(false);
  const [sdpOnly, setSdpOnly] = useState<boolean>(false);
  const [ftbOnly, setFtbOnly] = useState<boolean>(false);

  const [hideFailed, setHideFailed] = useState<boolean>(true);
  const [showHidden, setShowHidden] = useState<boolean>(true);
  const [showFlippy, setShowFlippy] = useState<boolean>(true);

  const [showRaw, setShowRaw] = useState<boolean>(false);

  const effectiveSelectedId = selectedZoneId ?? internalSelectedId;

  const derived = useMemo(() => {
    const list = Array.isArray(zones) ? zones : [];
    const byType: Record<ZoneType, number> = {
      DEMAND: 0,
      SUPPLY: 0,
      FLIPPY_D: 0,
      FLIPPY_S: 0,
      HIDDEN_D: 0,
      HIDDEN_S: 0,
    };

    let sde = 0;
    let sdp = 0;
    let ftb = 0;
    let failed = 0;
    let flippy = 0;

    for (const z of list) {
      byType[z.zone_type] = (byType[z.zone_type] ?? 0) + 1;
      if (z.sde_confirmed) sde += 1;
      if (z.sdp_validated) sdp += 1;
      if (z.is_ftb_valid) ftb += 1;
      if (z.is_failed) failed += 1;
      if (z.is_flippy) flippy += 1;
    }

    const avgScore = list.length
      ? list.reduce((acc, z) => acc + (z.score ?? 0), 0) / list.length
      : undefined;

    const best = [...list].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0] ?? null;

    return { total: list.length, byType, sde, sdp, ftb, failed, flippy, avgScore, best };
  }, [zones]);

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    let list = [...(zones ?? [])];

    if (q) {
      list = list.filter((z) => {
        const hay = `${z.id} ${z.zone_type} ${z.timeframe} ${z.base?.base_type ?? ''}`.toUpperCase();
        return hay.includes(q);
      });
    }

    if (typeFilter.length) {
      const s = new Set(typeFilter);
      list = list.filter((z) => s.has(z.zone_type));
    }

    list = list.filter((z) => (z.score ?? 0) >= minScore);

    if (sdeOnly) list = list.filter((z) => !!z.sde_confirmed);
    if (sdpOnly) list = list.filter((z) => !!z.sdp_validated);
    if (ftbOnly) list = list.filter((z) => !!z.is_ftb_valid);

    if (hideFailed) list = list.filter((z) => !z.is_failed);
    if (!showFlippy) list = list.filter((z) => !z.is_flippy);
    if (!showHidden) list = list.filter((z) => !isHiddenZone(z.zone_type));

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
        case 'touches_desc':
          return (b.base?.touch_count ?? 0) - (a.base?.touch_count ?? 0) || (b.score ?? 0) - (a.score ?? 0);
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
    zones,
    search,
    typeFilter,
    minScore,
    sdeOnly,
    sdpOnly,
    ftbOnly,
    hideFailed,
    showFlippy,
    showHidden,
    sort,
    currentPrice,
  ]);

  const selected = useMemo(() => {
    if (!effectiveSelectedId) return null;
    return (zones ?? []).find((z) => z.id === effectiveSelectedId) ?? null;
  }, [zones, effectiveSelectedId]);

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
          <div>
            <div className="text-sm font-semibold text-white/90">SDE / SD Zones</div>
            <div className="text-xs text-white/60 mt-1">
              Zones Supply &amp; Demand + confirmations SDE/SDP/FTB + score + base confluence.
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70">
              {derived.total} zones
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
            {/* KPIs */}
            <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-6">
              <Stat label="SDE ok" value={`${derived.sde}`} accent="green" />
              <Stat label="SDP ok" value={`${derived.sdp}`} />
              <Stat label="FTB ok" value={`${derived.ftb}`} />
              <Stat label="Flippy" value={`${derived.flippy}`} />
              <Stat label="Failed" value={`${derived.failed}`} accent="rose" />
              <Stat label="Shown" value={`${filtered.length}`} accent />
            </div>

            {/* Controls */}
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-12">
              <div className="md:col-span-6">
                <label className="block text-xs text-white/60 mb-1">Search</label>
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="DEMAND / H4 / RBR…"
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
                  <option value="touches_desc">Touches ↓</option>
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

            {/* Type filter + toggles */}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                {(Object.keys(derived.byType) as ZoneType[]).map((t) => {
                  const on = typeFilter.includes(t);
                  return (
                    <button
                      key={t}
                      onClick={() => setTypeFilter((prev) => (on ? prev.filter((x) => x !== t) : [...prev, t]))}
                      className={cn(
                        'rounded-full border px-3 py-1.5 text-xs font-medium transition',
                        on
                          ? 'border-[#E85D1A]/30 bg-[#E85D1A]/10 text-white'
                          : 'border-white/10 bg-white/5 text-white/65 hover:bg-white/10'
                      )}
                      title={`Filter ${t}`}
                    >
                      <span
                        className="inline-block h-2 w-2 rounded-full mr-2 align-middle"
                        style={{ backgroundColor: zoneColor(t) }}
                      />
                      {zoneLabel(t)}
                      <span className="text-white/40 font-normal"> ({derived.byType[t] ?? 0})</span>
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
                <Toggle label="SDE only" value={sdeOnly} onChange={setSdeOnly} />
                <Toggle label="SDP only" value={sdpOnly} onChange={setSdpOnly} />
                <Toggle label="FTB only" value={ftbOnly} onChange={setFtbOnly} />
                <Toggle label="Hide failed" value={hideFailed} onChange={setHideFailed} />
                <Toggle label="Show hidden" value={showHidden} onChange={setShowHidden} />
                <Toggle label="Show flippy" value={showFlippy} onChange={setShowFlippy} />
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
            {zones?.length === 0 ? (
              <div className="rounded-xl border border-white/10 bg-black/20 p-4 text-sm text-white/60">
                Aucune zone S&D détectée.
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
                    Tip: clique une zone pour la sélectionner. “Focus zone” permet au chart de surligner top/bot (si branché).
                  </div>

                  {filtered.map((z) => {
                    const isSel = z.id === effectiveSelectedId;
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
                              <ZoneTypePill type={z.zone_type} />

                              <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/70">
                                {z.timeframe}
                              </span>

                              <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/70">
                                {z.base?.base_type ?? '—'}
                              </span>

                              {z.is_failed && (
                                <span className="rounded-full border border-rose-500/25 bg-rose-500/10 px-2.5 py-1 text-[11px] text-rose-200">
                                  Failed
                                </span>
                              )}

                              {z.is_flippy && (
                                <span className="rounded-full border border-[#E85D1A]/25 bg-[#E85D1A]/10 px-2.5 py-1 text-[11px] text-orange-200">
                                  Flippy
                                </span>
                              )}

                              <span className="text-[11px] text-white/45 truncate">
                                {fmtTs(z.formed_at)}
                              </span>
                            </div>

                            <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
                              <MiniStat label="Top" value={fmt(z.zone_top, 6)} />
                              <MiniStat label="Bot" value={fmt(z.zone_bot, 6)} />
                              <MiniStat label="Range" value={fmt(Math.abs(z.zone_top - z.zone_bot), 6)} />
                              <MiniStat label="Touches" value={String(z.base?.touch_count ?? 0)} />
                            </div>

                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <Badge ok={z.sde_confirmed} label={`SDE ${fmt(z.sde_score, 0)}%`} />
                              <Badge ok={z.sdp_validated} label="SDP" />
                              <Badge ok={z.is_ftb_valid} label={`FTB ${z.ftb_count}`} />
                              <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/70">
                                Base {fmt(z.base?.score ?? 0, 0)}%
                              </span>
                              {dist !== undefined && Number.isFinite(dist) && (
                                <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/65">
                                  Δ {fmt(dist, 6)}
                                </span>
                              )}
                            </div>
                          </div>

                          <div className="text-right min-w-[120px]">
                            <div className="text-[11px] text-white/55">Zone score</div>
                            <div className="text-2xl font-semibold tracking-tight">{fmt(z.score, 0)}%</div>
                            <div className="mt-2">
                              <ScoreBar value={z.score} />
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
                        <div className="text-sm font-semibold text-white/90">Selected zone</div>
                        <div className="text-xs text-white/60 mt-1">
                          {selected ? (
                            <>
                              <span className="text-white/85">{zoneLabel(selected.zone_type)}</span>
                              <span className="mx-2 text-white/20">·</span>
                              score <span className="text-white/85">{fmt(selected.score, 0)}%</span>
                            </>
                          ) : (
                            'Sélectionne une zone.'
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
                        <div className="grid grid-cols-2 gap-2">
                          <MiniStat label="Type" value={zoneLabel(selected.zone_type)} />
                          <MiniStat label="ID" value={selected.id} />
                          <MiniStat label="Top" value={fmt(selected.zone_top, 8)} />
                          <MiniStat label="Bot" value={fmt(selected.zone_bot, 8)} />
                          <MiniStat label="SDE" value={selected.sde_confirmed ? `OK · ${fmt(selected.sde_score, 0)}%` : 'NO'} />
                          <MiniStat label="SDP" value={selected.sdp_validated ? 'OK' : 'NO'} />
                          <MiniStat label="FTB" value={`${selected.ftb_count} · ${selected.is_ftb_valid ? 'valid' : 'no'}`} />
                          <MiniStat label="SGB" value={selected.sgb_created ? 'true' : 'false'} />
                        </div>

                        <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                          <div className="text-xs font-medium text-white/70 mb-2">Base confluence</div>
                          <div className="grid grid-cols-2 gap-2">
                            <MiniStat label="Base type" value={selected.base?.base_type ?? '—'} />
                            <MiniStat label="Base score" value={`${fmt(selected.base?.score ?? 0, 0)}%`} />
                            <MiniStat label="Solid" value={selected.base?.is_solid ? 'Oui' : 'Non'} />
                            <MiniStat label="Weakening" value={selected.base?.is_weakening ? 'Oui' : 'Non'} />
                            <MiniStat label="Hidden base" value={selected.base?.is_hidden ? 'Oui' : 'Non'} />
                            <MiniStat label="Touches" value={String(selected.base?.touch_count ?? 0)} />
                            <MiniStat label="Candles" value={String(selected.base?.candle_count ?? 0)} />
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
                              title={!onFocusZone ? 'onFocusZone non fourni' : 'Focus zone (top+bot) on chart'}
                            >
                              Focus zone
                            </button>

                            <button
                              onClick={() => onFocusPrice?.(selected.sdp_head ?? selected.zone_top)}
                              disabled={!onFocusPrice}
                              className={cn(
                                'rounded-xl border px-3 py-2 text-xs transition',
                                onFocusPrice
                                  ? 'border-[#E85D1A]/25 bg-[#E85D1A]/10 text-orange-200 hover:bg-[#E85D1A]/15'
                                  : 'border-white/10 bg-white/5 text-white/40'
                              )}
                              title={!onFocusPrice ? 'onFocusPrice non fourni' : 'Focus a price on chart'}
                            >
                              Focus price
                            </button>
                          </div>

                          {selected.sdp_head !== undefined && (
                            <div className="mt-2 text-[11px] text-white/55">
                              SDP head: <span className="text-white/80">{fmt(selected.sdp_head, 8)}</span>
                            </div>
                          )}

                          <div className="mt-3">
                            <div className="flex items-center justify-between text-[11px] text-white/55 mb-1">
                              <span>Zone score</span>
                              <span className="text-white/70">{fmt(selected.score, 0)}%</span>
                            </div>
                            <ScoreBar value={selected.score} />
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
                        Clique une zone à gauche pour voir les détails.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {showRaw && (
              <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <div className="text-xs font-medium text-white/70 mb-2">Raw sd_zones JSON</div>
                <pre className="rounded-xl border border-white/10 bg-black/30 p-3 text-xs text-white/75 overflow-auto max-h-[520px]">
                  {JSON.stringify(zones ?? [], null, 2)}
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

function isHiddenZone(t: ZoneType) {
  return t === 'HIDDEN_D' || t === 'HIDDEN_S';
}

function zoneLabel(t: ZoneType) {
  switch (t) {
    case 'DEMAND': return 'Demand';
    case 'SUPPLY': return 'Supply';
    case 'FLIPPY_D': return 'Flippy D';
    case 'FLIPPY_S': return 'Flippy S';
    case 'HIDDEN_D': return 'Hidden D';
    case 'HIDDEN_S': return 'Hidden S';
    default: return t;
  }
}

function zoneColor(t?: ZoneType) {
  if (!t) return 'rgba(255,255,255,0.25)';
  const map: Record<ZoneType, string> = {
    DEMAND: '#1D9E75',
    SUPPLY: '#E24B4A',
    FLIPPY_D: '#378ADD',
    FLIPPY_S: '#E85D1A',
    HIDDEN_D: '#2AD4A5',
    HIDDEN_S: '#FF6B6A',
  };
  return map[t] ?? 'rgba(255,255,255,0.25)';
}

function zoneDistanceToPrice(z: SDZoneResult, price: number) {
  const top = z.zone_top;
  const bot = z.zone_bot;
  const hi = Math.max(top, bot);
  const lo = Math.min(top, bot);

  if (price >= lo && price <= hi) return 0;
  return Math.min(Math.abs(price - lo), Math.abs(price - hi));
}

function ZoneTypePill({ type }: { type: ZoneType }) {
  const c = zoneColor(type);
  return (
    <span
      className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-medium text-white/85"
      style={{ boxShadow: `0 0 0 1px ${c} inset` }}
    >
      <span className="inline-block h-2 w-2 rounded-full mr-2 align-middle" style={{ backgroundColor: c }} />
      {zoneLabel(type)}
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
      <div className="text-sm font-semibold text-white/90">{value}</div>
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