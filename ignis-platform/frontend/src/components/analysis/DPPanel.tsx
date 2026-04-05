/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export type DPType = 'SDP' | 'SB_LEVEL' | 'TREND_LINE' | 'KEY_LEVEL';

export type DPResult = {
  id?: string;
  dp_type: DPType;
  price: number;
  score: number;
  timeframe?: string;
  formed_at?: number; // s or ms (backend sometimes)
  meta?: Record<string, any>;
};

type SortKey = 'score_desc' | 'score_asc' | 'price_desc' | 'price_asc' | 'recent';

type DPView = DPResult & {
  key: string; // stable key for UI selection even if id missing
};

export default function DPPanel({
  decisionPoints,
  selectedKey,
  onSelect,
  onFocusPrice,
  className,
  defaultExpanded = true,
}: {
  decisionPoints: DPResult[];
  selectedKey?: string | null;
  onSelect?: (dp: DPView) => void;
  onFocusPrice?: (price: number) => void; // optional: to sync chart crosshair/line
  className?: string;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  // internal selection if parent doesn’t control
  const [internalSelectedKey, setInternalSelectedKey] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('score_desc');

  const [typeFilter, setTypeFilter] = useState<DPType[]>([]);
  const [minScore, setMinScore] = useState<number>(0);
  const [showMeta, setShowMeta] = useState<boolean>(false);

  const list = useMemo<DPView[]>(() => {
    const dps = Array.isArray(decisionPoints) ? decisionPoints : [];
    return dps.map((dp, idx) => ({
      ...dp,
      key:
        dp.id ??
        `${dp.dp_type ?? 'DP'}|${dp.price ?? '0'}|${dp.timeframe ?? ''}|${dp.formed_at ?? ''}|${idx}`,
    }));
  }, [decisionPoints]);

  const derived = useMemo(() => {
    const byType: Record<DPType, number> = { SDP: 0, SB_LEVEL: 0, TREND_LINE: 0, KEY_LEVEL: 0 };
    let avgScore: number | undefined;

    for (const dp of list) {
      const t = dp.dp_type as DPType;
      if (byType[t] !== undefined) byType[t] += 1;
    }

    const scores = list.map((x) => x.score).filter((x) => typeof x === 'number' && Number.isFinite(x));
    if (scores.length) avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;

    const best = [...list].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0] ?? null;

    return { total: list.length, byType, avgScore, best };
  }, [list]);

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    let out = [...list];

    if (q) {
      out = out.filter((dp) => {
        const hay = `${dp.key} ${dp.dp_type} ${dp.timeframe ?? ''} ${dp.price}`.toUpperCase();
        return hay.includes(q);
      });
    }

    if (typeFilter.length) {
      const s = new Set(typeFilter);
      out = out.filter((dp) => s.has(dp.dp_type));
    }

    out = out.filter((dp) => (dp.score ?? 0) >= minScore);

    out.sort((a, b) => {
      switch (sort) {
        case 'score_desc':
          return (b.score ?? 0) - (a.score ?? 0) || (b.price ?? 0) - (a.price ?? 0);
        case 'score_asc':
          return (a.score ?? 0) - (b.score ?? 0);
        case 'price_desc':
          return (b.price ?? 0) - (a.price ?? 0);
        case 'price_asc':
          return (a.price ?? 0) - (b.price ?? 0);
        case 'recent':
          return toMs(b.formed_at) - toMs(a.formed_at) || (b.score ?? 0) - (a.score ?? 0);
        default:
          return (b.score ?? 0) - (a.score ?? 0);
      }
    });

    return out;
  }, [list, search, typeFilter, minScore, sort]);

  const effectiveSelectedKey = selectedKey ?? internalSelectedKey;

  const selected = useMemo(() => {
    if (!effectiveSelectedKey) return null;
    return list.find((x) => x.key === effectiveSelectedKey) ?? null;
  }, [list, effectiveSelectedKey]);

  const selectDP = (dp: DPView) => {
    setInternalSelectedKey(dp.key);
    onSelect?.(dp);
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
            <div className="text-sm font-semibold text-white/90">Decision Points (DP)</div>
            <div className="text-xs text-white/60 mt-1">
              Liste des points de décision: <code className="text-white/70">SDP</code>, <code className="text-white/70">SB_LEVEL</code>,{' '}
              <code className="text-white/70">TREND_LINE</code>, <code className="text-white/70">KEY_LEVEL</code>.
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70">
              {derived.total} DP
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
              <Stat label="SDP" value={String(derived.byType.SDP ?? 0)} />
              <Stat label="SB_LEVEL" value={String(derived.byType.SB_LEVEL ?? 0)} />
              <Stat label="TREND_LINE" value={String(derived.byType.TREND_LINE ?? 0)} />
              <Stat label="KEY_LEVEL" value={String(derived.byType.KEY_LEVEL ?? 0)} />
              <Stat label="Best" value={derived.best ? `${derived.best.dp_type} ${fmt(derived.best.score, 0)}%` : '—'} accent />
              <Stat label="Shown" value={String(filtered.length)} />
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-12">
              <div className="md:col-span-6">
                <label className="block text-xs text-white/60 mb-1">Search</label>
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="SDP / H4 / 65200…"
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
                  <option value="price_desc">Price ↓</option>
                  <option value="price_asc">Price ↑</option>
                  <option value="recent">Most recent</option>
                </select>
              </div>

              <div className="md:col-span-3">
                <label className="block text-xs text-white/60 mb-1">Min score</label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={minScore}
                  onChange={(e) => setMinScore(Number(e.target.value))}
                  className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
                />
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                {(['SDP', 'SB_LEVEL', 'TREND_LINE', 'KEY_LEVEL'] as DPType[]).map((t) => {
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
                    >
                      {t}
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

              <Toggle label="Show meta" value={showMeta} onChange={setShowMeta} />
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
            className="p-4"
          >
            {list.length === 0 ? (
              <div className="rounded-xl border border-white/10 bg-black/20 p-4 text-sm text-white/60">
                Aucun DP détecté.
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
                    Tip: clique un DP pour l’inspecter. Tu peux aussi copier le price et (optionnellement) focus le chart.
                  </div>

                  {filtered.map((dp) => {
                    const isSel = dp.key === effectiveSelectedKey;
                    return (
                      <motion.button
                        layout
                        key={dp.key}
                        onClick={() => selectDP(dp)}
                        className={cn(
                          'w-full text-left rounded-2xl border p-4 transition',
                          isSel ? 'border-white/20 bg-white/10' : 'border-white/10 bg-black/20 hover:bg-white/10'
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <DPTypePill type={dp.dp_type} />
                              {dp.timeframe && (
                                <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/65">
                                  {dp.timeframe}
                                </span>
                              )}
                              {dp.formed_at !== undefined && (
                                <span className="text-[11px] text-white/45 truncate">
                                  {fmtTs(dp.formed_at)}
                                </span>
                              )}
                            </div>

                            <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
                              <MiniStat label="Price" value={fmt(dp.price, 6)} />
                              <MiniStat label="Score" value={`${fmt(dp.score, 0)}%`} />
                              <MiniStat label="Meta keys" value={String(Object.keys(dp.meta ?? {}).length)} />
                              <MiniStat
                                label="Delta (sel)"
                                value={
                                  selected ? fmt(Math.abs(dp.price - (selected.price ?? dp.price)), 6) : '—'
                                }
                              />
                            </div>
                          </div>

                          <div className="text-right min-w-[120px]">
                            <div className="text-[11px] text-white/55">Score</div>
                            <div className="text-2xl font-semibold tracking-tight">{fmt(dp.score, 0)}%</div>
                            <div className="mt-2">
                              <ScoreBar value={dp.score} />
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
                        <div className="text-sm font-semibold text-white/90">Details</div>
                        <div className="text-xs text-white/60 mt-1">
                          {selected ? (
                            <>
                              <span className="text-white/80">{selected.dp_type}</span>
                              <span className="mx-2 text-white/20">·</span>
                              price <span className="text-white/80">{fmt(selected.price, 6)}</span>
                            </>
                          ) : (
                            'Sélectionne un DP dans la liste.'
                          )}
                        </div>
                      </div>

                      {selected && (
                        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70">
                          {fmt(selected.score, 0)}%
                        </span>
                      )}
                    </div>

                    {selected ? (
                      <div className="mt-4 space-y-3">
                        <div className="grid grid-cols-2 gap-2">
                          <MiniStat label="Type" value={selected.dp_type} />
                          <MiniStat label="Timeframe" value={selected.timeframe ?? '—'} />
                          <MiniStat label="Price" value={fmt(selected.price, 8)} />
                          <MiniStat label="Formed at" value={selected.formed_at !== undefined ? fmtTs(selected.formed_at) : '—'} />
                          <MiniStat label="ID/key" value={selected.key} />
                          <MiniStat label="Meta keys" value={String(Object.keys(selected.meta ?? {}).length)} />
                        </div>

                        <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                          <div className="text-xs font-medium text-white/70 mb-2">Actions</div>
                          <div className="grid grid-cols-2 gap-2">
                            <button
                              onClick={() => copyToClipboard(String(selected.price))}
                              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition"
                            >
                              Copy price
                            </button>
                            <button
                              onClick={() => onFocusPrice?.(selected.price)}
                              disabled={!onFocusPrice}
                              className={cn(
                                'rounded-xl border px-3 py-2 text-xs transition',
                                onFocusPrice
                                  ? 'border-[#378ADD]/25 bg-[#378ADD]/10 text-sky-200 hover:bg-[#378ADD]/15'
                                  : 'border-white/10 bg-white/5 text-white/40'
                              )}
                              title={onFocusPrice ? 'Focus chart on this price' : 'onFocusPrice not provided'}
                            >
                              Focus chart
                            </button>
                          </div>

                          <div className="mt-3">
                            <div className="flex items-center justify-between text-[11px] text-white/55 mb-1">
                              <span>Score</span>
                              <span className="text-white/70">{fmt(selected.score, 0)}%</span>
                            </div>
                            <ScoreBar value={selected.score} />
                          </div>
                        </div>

                        {showMeta && (
                          <details className="rounded-xl border border-white/10 bg-black/30 p-3" open>
                            <summary className="cursor-pointer text-xs text-white/70 hover:text-white/85 transition">
                              Meta JSON
                            </summary>
                            <pre className="mt-2 rounded-xl border border-white/10 bg-black/40 p-3 text-xs text-white/75 overflow-auto max-h-[320px]">
                              {JSON.stringify(selected.meta ?? {}, null, 2)}
                            </pre>
                          </details>
                        )}

                        <details className="rounded-xl border border-white/10 bg-black/30 p-3">
                          <summary className="cursor-pointer text-xs text-white/70 hover:text-white/85 transition">
                            Raw DP JSON
                          </summary>
                          <pre className="mt-2 rounded-xl border border-white/10 bg-black/40 p-3 text-xs text-white/75 overflow-auto max-h-[320px]">
                            {JSON.stringify(stripKey(selected), null, 2)}
                          </pre>
                        </details>
                      </div>
                    ) : (
                      <div className="mt-4 rounded-xl border border-white/10 bg-black/30 p-4 text-sm text-white/60">
                        Clique un DP à gauche pour afficher ses détails.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   UI bits
────────────────────────────────────────────────────────────── */

function DPTypePill({ type }: { type: DPType }) {
  const cls =
    type === 'SDP'
      ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200'
      : type === 'SB_LEVEL'
        ? 'border-orange-500/25 bg-orange-500/10 text-orange-200'
        : type === 'TREND_LINE'
          ? 'border-sky-500/25 bg-sky-500/10 text-sky-200'
          : 'border-violet-500/25 bg-violet-500/10 text-violet-200';

  return (
    <span className={cn('rounded-full border px-2.5 py-1 text-[11px] font-medium', cls)}>
      {type}
    </span>
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

/* ──────────────────────────────────────────────────────────────
   Utils
────────────────────────────────────────────────────────────── */

function cn(...classes: Array<string | undefined | null | false>) {
  return classes.filter(Boolean).join(' ');
}

function fmt(n: number | undefined, digits = 2) {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits }).format(n);
}

function toMs(ts?: number) {
  if (ts === undefined || ts === null) return 0;
  return ts < 10_000_000_000 ? ts * 1000 : ts;
}

function fmtTs(ts: number) {
  return new Date(toMs(ts)).toLocaleString('fr-FR', { hour12: false });
}

function stripKey(dp: DPView) {
  // keep raw clean when showing JSON
  const { key, ...rest } = dp;
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