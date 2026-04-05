/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

export type PAPattern = 'ACCU' | 'THREE_DRIVES' | 'FTL' | 'PATTERN_69' | 'HIDDEN_SDE' | 'NONE';

export type PAResult = {
  id?: string;
  pattern: PAPattern;
  score: number;
  formed_at?: number; // seconds or ms (sometimes)
  timeframe?: string;
  meta?: Record<string, any>;
};

type SortKey = 'score_desc' | 'score_asc' | 'recent' | 'pattern_then_score';

type PAView = PAResult & {
  key: string;
};

export default function PAPanel({
  paPatterns,
  selectedKey,
  onSelect,
  onFocusTime,
  onFocusPrice,
  className,
  defaultExpanded = true,
}: {
  paPatterns: PAResult[];
  selectedKey?: string | null;
  onSelect?: (pa: PAView) => void;
  onFocusTime?: (timestamp: number) => void;
  onFocusPrice?: (price: number) => void; // if meta has price-levels
  className?: string;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  // internal selection (if parent not controlling)
  const [internalSelectedKey, setInternalSelectedKey] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('score_desc');
  const [patternFilter, setPatternFilter] = useState<PAPattern[]>([]);
  const [minScore, setMinScore] = useState<number>(0);

  const [showMeta, setShowMeta] = useState<boolean>(true);
  const [showRaw, setShowRaw] = useState<boolean>(false);

  const list = useMemo<PAView[]>(() => {
    const arr = Array.isArray(paPatterns) ? paPatterns : [];
    return arr.map((p, idx) => ({
      ...p,
      key: p.id ?? `${p.pattern}|${p.score}|${p.timeframe ?? ''}|${p.formed_at ?? ''}|${idx}`,
    }));
  }, [paPatterns]);

  const derived = useMemo(() => {
    const total = list.length;

    const byPattern: Record<PAPattern, number> = {
      ACCU: 0,
      THREE_DRIVES: 0,
      FTL: 0,
      PATTERN_69: 0,
      HIDDEN_SDE: 0,
      NONE: 0,
    };

    for (const p of list) {
      const k = (p.pattern ?? 'NONE') as PAPattern;
      if (byPattern[k] !== undefined) byPattern[k] += 1;
    }

    const scores = list.map((x) => x.score).filter((x) => typeof x === 'number' && Number.isFinite(x));
    const avgScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : undefined;

    const best = [...list].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0] ?? null;

    return { total, byPattern, avgScore, best };
  }, [list]);

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    let out = [...list];

    if (q) {
      out = out.filter((p) => {
        const hay = `${p.key} ${p.pattern} ${p.timeframe ?? ''} ${p.score} ${fmtTs(p.formed_at)}`.toUpperCase();
        return hay.includes(q);
      });
    }

    if (patternFilter.length) {
      const set = new Set(patternFilter);
      out = out.filter((p) => set.has(p.pattern));
    }

    out = out.filter((p) => (p.score ?? 0) >= minScore);

    out.sort((a, b) => {
      switch (sort) {
        case 'score_desc':
          return (b.score ?? 0) - (a.score ?? 0) || (toMs(b.formed_at) - toMs(a.formed_at));
        case 'score_asc':
          return (a.score ?? 0) - (b.score ?? 0);
        case 'recent':
          return toMs(b.formed_at) - toMs(a.formed_at) || (b.score ?? 0) - (a.score ?? 0);
        case 'pattern_then_score': {
          const paRank = (x: PAPattern) =>
            x === 'ACCU' ? 0 :
            x === 'FTL' ? 1 :
            x === 'PATTERN_69' ? 2 :
            x === 'THREE_DRIVES' ? 3 :
            x === 'HIDDEN_SDE' ? 4 : 5;
          return paRank(a.pattern) - paRank(b.pattern) || (b.score ?? 0) - (a.score ?? 0);
        }
        default:
          return (b.score ?? 0) - (a.score ?? 0);
      }
    });

    return out;
  }, [list, search, patternFilter, minScore, sort]);

  const effectiveSelectedKey = selectedKey ?? internalSelectedKey;

  const selected = useMemo(() => {
    if (!effectiveSelectedKey) return null;
    return list.find((x) => x.key === effectiveSelectedKey) ?? null;
  }, [list, effectiveSelectedKey]);

  const selectPA = (p: PAView) => {
    setInternalSelectedKey(p.key);
    onSelect?.(p);
  };

  const metaInsights = useMemo(() => {
    if (!selected?.meta || typeof selected.meta !== 'object') return [];

    // pick some common meta fields if present, otherwise show “top keys”
    const m = selected.meta;

    const candidates: Array<[string, any]> = [
      ['direction', m.direction ?? m.bias ?? m.side],
      ['entry', m.entry ?? m.entry_price],
      ['level', m.level ?? m.price],
      ['break_level', m.break_level ?? m.sb_level],
      ['target', m.target ?? m.tp],
      ['stop', m.stop ?? m.sl],
      ['rr', m.rr ?? m.risk_reward],
      ['note', m.note ?? m.reason ?? m.comment],
    ].filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '');

    if (candidates.length) return candidates.map(([k, v]) => ({ k, v }));

    // fallback: show first keys
    return Object.entries(m).slice(0, 10).map(([k, v]) => ({ k, v }));
  }, [selected]);

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
            <div className="text-sm font-semibold text-white/90">Price Action (PA)</div>
            <div className="text-xs text-white/60 mt-1">
              Patterns détectés (ACCU, 3 Drives, FTL, Pattern69, HiddenSDE…) + score + meta.
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70">
              {derived.total} patterns
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
              <Stat label="ACCU" value={String(derived.byPattern.ACCU ?? 0)} />
              <Stat label="FTL" value={String(derived.byPattern.FTL ?? 0)} />
              <Stat label="Pattern69" value={String(derived.byPattern.PATTERN_69 ?? 0)} />
              <Stat label="3 Drives" value={String(derived.byPattern.THREE_DRIVES ?? 0)} />
              <Stat label="HiddenSDE" value={String(derived.byPattern.HIDDEN_SDE ?? 0)} />
              <Stat label="Shown" value={String(filtered.length)} accent />
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-12">
              <div className="md:col-span-6">
                <label className="block text-xs text-white/60 mb-1">Search</label>
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="FTL / H4 / 2026 / 85…"
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
                  <option value="pattern_then_score">Pattern → Score</option>
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
                {(['ACCU', 'FTL', 'PATTERN_69', 'THREE_DRIVES', 'HIDDEN_SDE', 'NONE'] as PAPattern[]).map((p) => {
                  const on = patternFilter.includes(p);
                  return (
                    <button
                      key={p}
                      onClick={() => setPatternFilter((prev) => (on ? prev.filter((x) => x !== p) : [...prev, p]))}
                      className={cn(
                        'rounded-full border px-3 py-1.5 text-xs font-medium transition',
                        on
                          ? 'border-[#378ADD]/25 bg-[#378ADD]/10 text-sky-200'
                          : 'border-white/10 bg-white/5 text-white/65 hover:bg-white/10'
                      )}
                      title={`Filter ${p}`}
                    >
                      {prettyPattern(p)}
                    </button>
                  );
                })}

                {patternFilter.length > 0 && (
                  <button
                    onClick={() => setPatternFilter([])}
                    className="rounded-full border border-white/10 bg-black/20 px-3 py-1.5 text-xs text-white/70 hover:bg-white/10 transition"
                  >
                    Clear filters
                  </button>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                <Toggle label="Show meta" value={showMeta} onChange={setShowMeta} />
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
            {list.length === 0 ? (
              <div className="rounded-xl border border-white/10 bg-black/20 p-4 text-sm text-white/60">
                Aucun pattern PA détecté.
              </div>
            ) : filtered.length === 0 ? (
              <div className="rounded-xl border border-white/10 bg-black/20 p-4 text-sm text-white/60">
                Aucun résultat avec ces filtres.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
                {/* List */}
                <div className="xl:col-span-7 space-y-2">
                  <div className="text-[11px] text-white/50">
                    Tip: clique une ligne pour voir détails. “Focus time” dépend de ton chart (prop <code>onFocusTime</code>).
                  </div>

                  {filtered.map((p) => {
                    const isSel = p.key === effectiveSelectedKey;
                    return (
                      <motion.button
                        layout
                        key={p.key}
                        onClick={() => selectPA(p)}
                        className={cn(
                          'w-full text-left rounded-2xl border p-4 transition bg-gradient-to-b shadow-[0_18px_60px_rgba(0,0,0,0.45)]',
                          scoreGradient(p.score),
                          isSel ? 'border-white/20' : 'border-white/10 hover:bg-white/10'
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <PatternPill pattern={p.pattern} />
                              {p.timeframe && (
                                <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/65">
                                  {p.timeframe}
                                </span>
                              )}
                              {p.formed_at !== undefined && (
                                <span className="text-[11px] text-white/45 truncate">
                                  {fmtTs(p.formed_at)}
                                </span>
                              )}
                            </div>

                            <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
                              <MiniStat label="Score" value={`${fmt(p.score, 0)}%`} />
                              <MiniStat label="Meta keys" value={String(Object.keys(p.meta ?? {}).length)} />
                              <MiniStat
                                label="Direction"
                                value={String(p.meta?.direction ?? p.meta?.bias ?? p.meta?.side ?? '—')}
                              />
                              <MiniStat
                                label="Key"
                                value={p.id ? 'id' : 'generated'}
                              />
                            </div>
                          </div>

                          <div className="text-right min-w-[120px]">
                            <div className="text-[11px] text-white/55">Score</div>
                            <div className="text-2xl font-semibold tracking-tight">{fmt(p.score, 0)}%</div>
                            <div className="mt-2">
                              <ScoreBar value={p.score} />
                            </div>
                          </div>
                        </div>
                      </motion.button>
                    );
                  })}
                </div>

                {/* Details */}
                <div className="xl:col-span-5">
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-white/90">Details</div>
                        <div className="text-xs text-white/60 mt-1">
                          {selected ? (
                            <>
                              <span className="text-white/80">{prettyPattern(selected.pattern)}</span>
                              <span className="mx-2 text-white/20">·</span>
                              score <span className="text-white/80">{fmt(selected.score, 0)}%</span>
                            </>
                          ) : (
                            'Sélectionne un pattern PA.'
                          )}
                        </div>
                      </div>

                      {selected && (
                        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70">
                          {selected.timeframe ?? '—'}
                        </span>
                      )}
                    </div>

                    {selected ? (
                      <div className="mt-4 space-y-3">
                        <div className="grid grid-cols-2 gap-2">
                          <MiniStat label="Pattern" value={prettyPattern(selected.pattern)} />
                          <MiniStat label="Timeframe" value={selected.timeframe ?? '—'} />
                          <MiniStat label="Score" value={`${fmt(selected.score, 0)}%`} />
                          <MiniStat label="Formed" value={selected.formed_at !== undefined ? fmtTs(selected.formed_at) : '—'} />
                          <MiniStat label="ID" value={selected.id ?? '—'} />
                          <MiniStat label="Key" value={selected.key} />
                        </div>

                        <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                          <div className="text-xs font-medium text-white/70 mb-2">Actions</div>
                          <div className="grid grid-cols-2 gap-2">
                            <button
                              onClick={() => copyToClipboard(prettyPattern(selected.pattern))}
                              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition"
                            >
                              Copy pattern
                            </button>
                            <button
                              onClick={() => copyToClipboard(String(selected.score))}
                              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition"
                            >
                              Copy score
                            </button>
                          </div>

                          <div className="mt-2 grid grid-cols-2 gap-2">
                            <button
                              onClick={() => selected.formed_at !== undefined && onFocusTime?.(normalizeTsToSeconds(selected.formed_at))}
                              disabled={!onFocusTime || selected.formed_at === undefined}
                              className={cn(
                                'rounded-xl border px-3 py-2 text-xs transition',
                                onFocusTime && selected.formed_at !== undefined
                                  ? 'border-[#E85D1A]/25 bg-[#E85D1A]/10 text-orange-200 hover:bg-[#E85D1A]/15'
                                  : 'border-white/10 bg-white/5 text-white/40'
                              )}
                              title={!onFocusTime ? 'onFocusTime non fourni' : 'Focus chart time'}
                            >
                              Focus time
                            </button>

                            <button
                              onClick={() => {
                                const price =
                                  pickNumber(selected.meta, ['price', 'level', 'entry', 'entry_price', 'break_level', 'sb_level']) ??
                                  undefined;
                                if (price !== undefined) onFocusPrice?.(price);
                              }}
                              disabled={!onFocusPrice || pickNumber(selected.meta, ['price', 'level', 'entry', 'entry_price', 'break_level', 'sb_level']) === undefined}
                              className={cn(
                                'rounded-xl border px-3 py-2 text-xs transition',
                                onFocusPrice && pickNumber(selected.meta, ['price', 'level', 'entry', 'entry_price', 'break_level', 'sb_level']) !== undefined
                                  ? 'border-[#378ADD]/25 bg-[#378ADD]/10 text-sky-200 hover:bg-[#378ADD]/15'
                                  : 'border-white/10 bg-white/5 text-white/40'
                              )}
                              title={!onFocusPrice ? 'onFocusPrice non fourni' : 'Focus chart price (si dispo en meta)'}
                            >
                              Focus price
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
                          <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                            <div className="text-xs font-medium text-white/70 mb-2">Meta</div>

                            {metaInsights.length === 0 ? (
                              <div className="text-xs text-white/55">—</div>
                            ) : (
                              <div className="grid grid-cols-1 gap-2">
                                {metaInsights.map(({ k, v }) => (
                                  <div key={k} className="flex items-start justify-between gap-3 rounded-lg border border-white/10 bg-white/5 px-3 py-2">
                                    <div className="text-[11px] text-white/55">{k}</div>
                                    <div className="text-xs text-white/80 text-right break-all">
                                      {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}

                            <details className="mt-3">
                              <summary className="cursor-pointer text-xs text-white/60 hover:text-white/80 transition">
                                Full meta JSON
                              </summary>
                              <pre className="mt-2 rounded-xl border border-white/10 bg-black/40 p-3 text-xs text-white/75 overflow-auto max-h-[320px]">
                                {JSON.stringify(selected.meta ?? {}, null, 2)}
                              </pre>
                            </details>
                          </div>
                        )}

                        <details className="rounded-xl border border-white/10 bg-black/30 p-3">
                          <summary className="cursor-pointer text-xs text-white/70 hover:text-white/85 transition">
                            Raw PA JSON
                          </summary>
                          <pre className="mt-2 rounded-xl border border-white/10 bg-black/40 p-3 text-xs text-white/75 overflow-auto max-h-[320px]">
                            {JSON.stringify(stripKey(selected), null, 2)}
                          </pre>
                        </details>
                      </div>
                    ) : (
                      <div className="mt-4 rounded-xl border border-white/10 bg-black/30 p-4 text-sm text-white/60">
                        Clique un pattern à gauche pour voir son détail.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {showRaw && (
              <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <div className="text-xs font-medium text-white/70 mb-2">Raw pa_patterns JSON</div>
                <pre className="rounded-xl border border-white/10 bg-black/30 p-3 text-xs text-white/75 overflow-auto max-h-[520px]">
                  {JSON.stringify(paPatterns ?? [], null, 2)}
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
   UI bits + utils
────────────────────────────────────────────────────────────── */

function cn(...classes: Array<string | undefined | null | false>) {
  return classes.filter(Boolean).join(' ');
}

function prettyPattern(p: PAPattern) {
  if (p === 'THREE_DRIVES') return '3 Drives';
  if (p === 'PATTERN_69') return 'Pattern 69';
  if (p === 'HIDDEN_SDE') return 'Hidden SDE';
  return p;
}

function PatternPill({ pattern }: { pattern: PAPattern }) {
  const cls =
    pattern === 'ACCU'
      ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200'
      : pattern === 'FTL'
        ? 'border-orange-500/25 bg-orange-500/10 text-orange-200'
        : pattern === 'PATTERN_69'
          ? 'border-sky-500/25 bg-sky-500/10 text-sky-200'
          : pattern === 'THREE_DRIVES'
            ? 'border-violet-500/25 bg-violet-500/10 text-violet-200'
            : pattern === 'HIDDEN_SDE'
              ? 'border-teal-500/25 bg-teal-500/10 text-teal-200'
              : 'border-white/10 bg-white/5 text-white/70';

  return (
    <span className={cn('rounded-full border px-2.5 py-1 text-[11px] font-medium', cls)}>
      {prettyPattern(pattern)}
    </span>
  );
}

function scoreGradient(score: number) {
  const s = Math.max(0, Math.min(100, score ?? 0));
  if (s >= 85) return 'from-emerald-400/45 to-emerald-700/10';
  if (s >= 70) return 'from-orange-400/45 to-orange-700/10';
  if (s >= 55) return 'from-amber-400/45 to-amber-700/10';
  return 'from-rose-400/45 to-rose-700/10';
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

function fmt(n: number | undefined, digits = 2) {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits }).format(n);
}

function toMs(ts?: number) {
  if (ts === undefined || ts === null) return 0;
  return ts < 10_000_000_000 ? ts * 1000 : ts;
}

function normalizeTsToSeconds(ts: number) {
  // chart systems often want seconds
  return ts < 10_000_000_000 ? ts : Math.floor(ts / 1000);
}

function fmtTs(ts?: number) {
  if (ts === undefined || ts === null) return '—';
  return new Date(toMs(ts)).toLocaleString('fr-FR', { hour12: false });
}

function stripKey(p: PAView) {
  const { key, ...rest } = p;
  return rest;
}

function pickNumber(obj: any, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
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