/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

type BaseType = 'RBR' | 'DBD' | 'RBD' | 'DBR';

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

type SortKey = 'score_desc' | 'score_asc' | 'recent' | 'touches_desc' | 'engulf_desc';

export default function BaseScorePanel({
  bases,
  selectedBaseId,
  onSelectBase,
  className,
  defaultExpanded = true,
}: {
  bases: BaseResult[];
  selectedBaseId?: string | null;
  onSelectBase?: (base: BaseResult) => void;
  className?: string;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('score_desc');

  const [typeFilter, setTypeFilter] = useState<BaseType[]>([]);
  const [solidOnly, setSolidOnly] = useState(false);
  const [hideWeakening, setHideWeakening] = useState(false);
  const [showHidden, setShowHidden] = useState(true);

  const derived = useMemo(() => {
    const list = Array.isArray(bases) ? bases : [];
    const byType = { RBR: 0, DBD: 0, RBD: 0, DBR: 0 } as Record<BaseType, number>;
    let solid = 0;
    let weakening = 0;
    let hidden = 0;

    for (const b of list) {
      byType[b.base_type] = (byType[b.base_type] ?? 0) + 1;
      if (b.is_solid) solid += 1;
      if (b.is_weakening) weakening += 1;
      if (b.is_hidden) hidden += 1;
    }

    const avgScore =
      list.length > 0 ? list.reduce((acc, b) => acc + (b.score ?? 0), 0) / list.length : undefined;

    const best = [...list].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0] ?? null;

    return { total: list.length, byType, solid, weakening, hidden, avgScore, best };
  }, [bases]);

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    let list = [...(bases ?? [])];

    if (q) {
      list = list.filter((b) => {
        const hay = `${b.id} ${b.base_type} ${b.timeframe}`.toUpperCase();
        return hay.includes(q);
      });
    }

    if (typeFilter.length) {
      const set = new Set(typeFilter);
      list = list.filter((b) => set.has(b.base_type));
    }

    if (solidOnly) list = list.filter((b) => !!b.is_solid);
    if (hideWeakening) list = list.filter((b) => !b.is_weakening);
    if (!showHidden) list = list.filter((b) => !b.is_hidden);

    // sorting
    list.sort((a, b) => {
      switch (sort) {
        case 'score_desc':
          return (b.score ?? 0) - (a.score ?? 0) || (b.engulfment_ratio ?? 0) - (a.engulfment_ratio ?? 0);
        case 'score_asc':
          return (a.score ?? 0) - (b.score ?? 0);
        case 'recent':
          return (toMs(b.formed_at) - toMs(a.formed_at)) || (b.score ?? 0) - (a.score ?? 0);
        case 'touches_desc':
          return (b.touch_count ?? 0) - (a.touch_count ?? 0) || (b.score ?? 0) - (a.score ?? 0);
        case 'engulf_desc':
          return (b.engulfment_ratio ?? 0) - (a.engulfment_ratio ?? 0) || (b.score ?? 0) - (a.score ?? 0);
        default:
          return (b.score ?? 0) - (a.score ?? 0);
      }
    });

    return list;
  }, [bases, search, typeFilter, solidOnly, hideWeakening, showHidden, sort]);

  const selected = useMemo(() => {
    if (!selectedBaseId) return null;
    return (bases ?? []).find((b) => b.id === selectedBaseId) ?? null;
  }, [bases, selectedBaseId]);

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
            <div className="text-sm font-semibold text-white/90">Base score</div>
            <div className="text-xs text-white/60 mt-1">
              Analyse des <code className="text-white/70">bases</code> détectées (RBR/DBD/RBD/DBR) — score, solidité, touches, engulfment.
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70">
              {derived.total} bases
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
              <Stat label="RBR" value={String(derived.byType.RBR ?? 0)} />
              <Stat label="DBD" value={String(derived.byType.DBD ?? 0)} />
              <Stat label="RBD" value={String(derived.byType.RBD ?? 0)} />
              <Stat label="DBR" value={String(derived.byType.DBR ?? 0)} />
              <Stat label="Solid" value={String(derived.solid)} accent="green" />
              <Stat label="Weakening" value={String(derived.weakening)} accent="amber" />
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-12">
              <div className="md:col-span-6">
                <label className="block text-xs text-white/60 mb-1">Search</label>
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="id / RBR / H4…"
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
                  <option value="touches_desc">Touches ↓</option>
                  <option value="engulf_desc">Engulfment ↓</option>
                </select>
              </div>

              <div className="md:col-span-3 flex flex-wrap items-end justify-end gap-2">
                <Toggle label="Solid only" value={solidOnly} onChange={setSolidOnly} />
                <Toggle label="Hide weakening" value={hideWeakening} onChange={setHideWeakening} />
                <Toggle label="Show hidden" value={showHidden} onChange={setShowHidden} />
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              {(['RBR', 'DBD', 'RBD', 'DBR'] as BaseType[]).map((t) => {
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
            {bases?.length === 0 ? (
              <div className="rounded-xl border border-white/10 bg-black/20 p-4 text-sm text-white/60">
                Aucune base détectée.
              </div>
            ) : filtered.length === 0 ? (
              <div className="rounded-xl border border-white/10 bg-black/20 p-4 text-sm text-white/60">
                Aucun résultat avec ces filtres.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
                {/* list */}
                <div className="xl:col-span-7 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="text-xs text-white/60">
                      {filtered.length} shown
                      <span className="mx-2 text-white/20">·</span>
                      best: <span className="text-white/80">{derived.best ? `${derived.best.base_type} ${fmt(derived.best.score, 0)}%` : '—'}</span>
                    </div>
                    <div className="text-[11px] text-white/50">
                      Tip: clique une base pour voir les détails.
                    </div>
                  </div>

                  <div className="space-y-2">
                    {filtered.map((b) => {
                      const isSelected = selectedBaseId === b.id;
                      return (
                        <motion.button
                          layout
                          key={b.id}
                          onClick={() => onSelectBase?.(b)}
                          className={cn(
                            'w-full text-left rounded-2xl border p-4 transition',
                            isSelected
                              ? 'border-white/20 bg-white/10'
                              : 'border-white/10 bg-black/20 hover:bg-white/10'
                          )}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <BaseTypePill type={b.base_type} />
                                {b.is_solid && (
                                  <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1 text-[11px] text-emerald-200">
                                    Solid
                                  </span>
                                )}
                                {b.is_weakening && (
                                  <span className="rounded-full border border-amber-500/25 bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-200">
                                    Weakening
                                  </span>
                                )}
                                {b.is_hidden && (
                                  <span className="rounded-full border border-sky-500/25 bg-sky-500/10 px-2.5 py-1 text-[11px] text-sky-200">
                                    Hidden
                                  </span>
                                )}
                                <span className="text-[11px] text-white/50 truncate">
                                  {b.timeframe}
                                </span>
                              </div>

                              <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
                                <MiniStat label="Top" value={fmt(b.zone_top, 6)} />
                                <MiniStat label="Bot" value={fmt(b.zone_bot, 6)} />
                                <MiniStat label="Touches" value={String(b.touch_count ?? 0)} />
                                <MiniStat label="Candles" value={String(b.candle_count ?? 0)} />
                              </div>

                              <div className="mt-2 text-[11px] text-white/50">
                                Formed: <span className="text-white/70">{fmtTs(b.formed_at)}</span>
                                <span className="mx-2 text-white/20">·</span>
                                Engulf: <span className="text-white/70">{fmt(b.engulfment_ratio, 2)}</span>
                              </div>
                            </div>

                            <div className="text-right">
                              <div className="text-[11px] text-white/55">Score</div>
                              <div className="text-2xl font-semibold tracking-tight">{fmt(b.score, 0)}%</div>
                              <div className="mt-2">
                                <ScoreBar value={b.score} />
                              </div>
                            </div>
                          </div>
                        </motion.button>
                      );
                    })}
                  </div>
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
                              Base <span className="text-white/80">{selected.base_type}</span> · <span className="text-white/80">{selected.timeframe}</span>
                            </>
                          ) : (
                            'Sélectionne une base dans la liste.'
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
                          <MiniStat label="ID" value={selected.id} />
                          <MiniStat label="Formed" value={fmtTs(selected.formed_at)} />
                          <MiniStat label="Zone top" value={fmt(selected.zone_top, 6)} />
                          <MiniStat label="Zone bot" value={fmt(selected.zone_bot, 6)} />
                          <MiniStat label="Range" value={fmt(Math.abs(selected.zone_top - selected.zone_bot), 6)} />
                          <MiniStat label="Engulf ratio" value={fmt(selected.engulfment_ratio, 2)} />
                        </div>

                        <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                          <div className="text-xs font-medium text-white/70 mb-2">Quality signals</div>

                          <div className="space-y-2">
                            <SignalRow
                              label="Solid base"
                              value={selected.is_solid}
                              hint="Solidité/clean base (qualité structurelle)."
                            />
                            <SignalRow
                              label="Weakening"
                              value={selected.is_weakening}
                              invert
                              hint="Si weakening=true, la base perd de la qualité au fil des touches."
                            />
                            <SignalRow
                              label="Hidden"
                              value={selected.is_hidden}
                              hint="Base 'hidden' / moins visible (selon moteur)."
                            />
                          </div>
                        </div>

                        <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                          <div className="text-xs font-medium text-white/70 mb-2">Stats</div>
                          <div className="grid grid-cols-2 gap-2">
                            <MiniStat label="Touches" value={String(selected.touch_count ?? 0)} />
                            <MiniStat label="Candles in base" value={String(selected.candle_count ?? 0)} />
                          </div>

                          <div className="mt-3">
                            <div className="flex items-center justify-between text-[11px] text-white/55 mb-1">
                              <span>Score</span>
                              <span className="text-white/70">{fmt(selected.score, 0)}%</span>
                            </div>
                            <ScoreBar value={selected.score} />
                          </div>

                          <div className="mt-3 grid grid-cols-2 gap-2">
                            <button
                              onClick={() => copyToClipboard(String(selected.zone_top))}
                              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition"
                              title="Copier zone_top"
                            >
                              Copy top
                            </button>
                            <button
                              onClick={() => copyToClipboard(String(selected.zone_bot))}
                              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition"
                              title="Copier zone_bot"
                            >
                              Copy bot
                            </button>
                          </div>
                        </div>

                        <details className="rounded-xl border border-white/10 bg-black/30 p-3">
                          <summary className="cursor-pointer text-xs text-white/70 hover:text-white/85 transition">
                            Raw JSON
                          </summary>
                          <pre className="mt-2 rounded-xl border border-white/10 bg-black/40 p-3 text-xs text-white/75 overflow-auto max-h-[280px]">
                            {JSON.stringify(selected, null, 2)}
                          </pre>
                        </details>
                      </div>
                    ) : (
                      <div className="mt-4 rounded-xl border border-white/10 bg-black/30 p-4 text-sm text-white/60">
                        Clique une base à gauche. Tu pourras ensuite copier top/bot et lire les signaux de qualité.
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
   UI Bits
────────────────────────────────────────────────────────────── */

function BaseTypePill({ type }: { type: BaseType }) {
  const cls =
    type === 'RBR'
      ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200'
      : type === 'DBD'
        ? 'border-rose-500/25 bg-rose-500/10 text-rose-200'
        : type === 'RBD'
          ? 'border-sky-500/25 bg-sky-500/10 text-sky-200'
          : 'border-orange-500/25 bg-orange-500/10 text-orange-200';

  return (
    <span className={cn('rounded-full border px-2.5 py-1 text-[11px] font-medium', cls)}>
      {type}
    </span>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: 'green' | 'amber' }) {
  const accentCls =
    accent === 'green'
      ? 'border-emerald-500/15 bg-emerald-500/10'
      : accent === 'amber'
        ? 'border-amber-500/15 bg-amber-500/10'
        : 'border-white/10 bg-black/20';

  return (
    <div className={cn('rounded-xl border px-3 py-2', accentCls)}>
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
      <div
        className={cn(
          'h-6 w-11 rounded-full border p-1 transition',
          value ? 'border-[#E85D1A]/40 bg-[#E85D1A]/25' : 'border-white/10 bg-white/5'
        )}
      >
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

function SignalRow({
  label,
  value,
  hint,
  invert,
}: {
  label: string;
  value: boolean;
  hint?: string;
  invert?: boolean;
}) {
  const ok = invert ? !value : value;

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-xs text-white/75 truncate">{label}</div>
        {hint && <div className="text-[11px] text-white/50 mt-0.5">{hint}</div>}
      </div>
      <span
        className={cn(
          'rounded-full border px-2.5 py-1 text-[11px] font-medium',
          ok ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200' : 'border-rose-500/25 bg-rose-500/10 text-rose-200'
        )}
      >
        {value ? 'true' : 'false'}
      </span>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Utils
────────────────────────────────────────────────────────────── */

function toMs(ts: number) {
  return ts < 10_000_000_000 ? ts * 1000 : ts;
}

function fmtTs(ts: number) {
  const ms = toMs(ts);
  return new Date(ms).toLocaleString('fr-FR', { hour12: false });
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // fallback
    const el = document.createElement('textarea');
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
  }
}