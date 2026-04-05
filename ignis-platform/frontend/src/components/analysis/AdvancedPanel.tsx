/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

type AdvancedPanelProps = {
  advanced: any; // backend AdvancedPatternResult (structure variable) → rendu robuste
  className?: string;
  defaultExpanded?: boolean;
};

type NormalizedPattern = {
  key: string;
  label: string;
  detected: boolean;
  score?: number;
  confidence?: number;
  direction?: string;
  timeframe?: string;
  formed_at?: string | number;
  notes?: string;
  items?: any[]; // list of detections
  raw: any;
};

function cn(...classes: Array<string | undefined | null | false>) {
  return classes.filter(Boolean).join(' ');
}

function toTitleCase(s: string) {
  return s
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function prettyLabel(key: string) {
  // handle some known names nicely
  const map: Record<string, string> = {
    over_under: 'Over / Under',
    iou: 'IOU',
    flag_limit: 'Flag Limit',
    counter_attack: 'Counter Attack',
    hidden_sde: 'Hidden SDE',
  };
  const k = key.toLowerCase();
  return map[k] ?? toTitleCase(k);
}

function fmt(n: number | undefined, digits = 2) {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits }).format(n);
}

function fmtPct(n: number | undefined, digits = 0) {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  // accepte 0..1 ou 0..100
  const val = n <= 1 ? n * 100 : n;
  return `${fmt(val, digits)}%`;
}

function fmtTs(ts?: string | number) {
  if (ts === undefined || ts === null) return '—';
  if (typeof ts === 'string') {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? ts : d.toLocaleString('fr-FR', { hour12: false });
  }
  // number: seconds or ms
  const ms = ts < 10_000_000_000 ? ts * 1000 : ts;
  return new Date(ms).toLocaleString('fr-FR', { hour12: false });
}

function scoreGradient(score?: number) {
  const s = Math.max(0, Math.min(100, score ?? 0));
  if (s >= 85) return 'from-emerald-400/45 to-emerald-700/10';
  if (s >= 70) return 'from-orange-400/45 to-orange-700/10';
  if (s >= 55) return 'from-amber-400/45 to-amber-700/10';
  return 'from-rose-400/45 to-rose-700/10';
}

function detectedPill(detected: boolean) {
  return detected
    ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200'
    : 'border-white/10 bg-white/5 text-white/60';
}

function pickNumber(obj: any, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

function pickString(obj: any, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

function inferDetected(raw: any): boolean {
  if (raw === null || raw === undefined) return false;
  if (typeof raw === 'boolean') return raw;

  if (Array.isArray(raw)) return raw.length > 0;

  if (typeof raw === 'object') {
    const d =
      raw.detected ??
      raw.found ??
      raw.valid ??
      raw.is_valid ??
      raw.signal ??
      raw.has_signal ??
      raw.triggered;
    if (typeof d === 'boolean') return d;

    const count = raw.count ?? raw.hits ?? raw.signals_count ?? raw.detections;
    if (typeof count === 'number') return count > 0;

    // if object has a score and it's non-zero, sometimes that implies detection
    const sc = pickNumber(raw, ['score', 'pattern_score', 'confidence', 'strength']);
    if (typeof sc === 'number') return sc > 0;
  }

  return false;
}

function normalizeAdvanced(advanced: any): NormalizedPattern[] {
  if (!advanced || typeof advanced !== 'object') return [];

  const entries = Object.entries(advanced) as Array<[string, any]>;

  return entries.map(([key, raw]) => {
    // Many backends return:
    // - { detected, score, ... }
    // - or arrays of detections
    // - or nested objects with "results"/"items"
    const label = prettyLabel(key);

    let items: any[] | undefined;

    if (Array.isArray(raw)) {
      items = raw;
    } else if (raw && typeof raw === 'object') {
      if (Array.isArray(raw.items)) items = raw.items;
      else if (Array.isArray(raw.results)) items = raw.results;
      else if (Array.isArray(raw.detections)) items = raw.detections;
      else if (Array.isArray(raw.patterns)) items = raw.patterns;
      else if (Array.isArray(raw.signals)) items = raw.signals;
    }

    const detected = inferDetected(items ?? raw);

    // score/confidence: try top-level first, then best from first item
    const scoreTop = pickNumber(raw, ['score', 'pattern_score', 'total_score', 'advanced_score']);
    const confTop = pickNumber(raw, ['confidence', 'conf', 'probability', 'strength']);

    const firstItem = Array.isArray(items) ? items[0] : undefined;
    const scoreItem = pickNumber(firstItem, ['score', 'pattern_score', 'confidence', 'strength']);
    const confItem = pickNumber(firstItem, ['confidence', 'conf', 'probability', 'strength']);

    const direction =
      pickString(raw, ['direction', 'bias', 'side']) ??
      pickString(firstItem, ['direction', 'bias', 'side']);

    const timeframe =
      pickString(raw, ['timeframe', 'tf']) ??
      pickString(firstItem, ['timeframe', 'tf']);

    const formed_at =
      raw?.formed_at ?? raw?.timestamp ?? raw?.time ?? firstItem?.formed_at ?? firstItem?.timestamp;

    const notes =
      pickString(raw, ['notes', 'reason', 'comment', 'message']) ??
      pickString(firstItem, ['notes', 'reason', 'comment', 'message']);

    return {
      key,
      label,
      detected,
      score: scoreTop ?? scoreItem,
      confidence: confTop ?? confItem,
      direction,
      timeframe,
      formed_at,
      notes,
      items,
      raw,
    };
  });
}

/* ──────────────────────────────────────────────────────────────
   Component
────────────────────────────────────────────────────────────── */

export default function AdvancedPannel({
  advanced,
  className,
  defaultExpanded = true,
}: AdvancedPanelProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [search, setSearch] = useState('');
  const [showRaw, setShowRaw] = useState(false);
  const [expandAllItems, setExpandAllItems] = useState(false);

  const patterns = useMemo(() => normalizeAdvanced(advanced), [advanced]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return patterns;
    return patterns.filter((p) => {
      const hay = `${p.key} ${p.label} ${p.direction ?? ''} ${p.timeframe ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [patterns, search]);

  const detectedCount = useMemo(
    () => patterns.filter((p) => p.detected).length,
    [patterns]
  );

  const avgScore = useMemo(() => {
    const scores = patterns.map((p) => p.score).filter((x): x is number => typeof x === 'number');
    if (!scores.length) return undefined;
    return scores.reduce((a, b) => a + b, 0) / scores.length;
  }, [patterns]);

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
            <div className="text-sm font-semibold text-white/90">Advanced patterns</div>
            <div className="text-xs text-white/60 mt-1">
              Rendu “best-effort” de <code className="text-white/70">analysis.advanced</code> (Over/Under, IOU, Flag Limit, Counter Attack…)
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70">
              {detectedCount}/{patterns.length} detected
            </span>
            <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70">
              avg score {avgScore !== undefined ? fmt(avgScore, 1) : '—'}
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
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-12">
            <div className="md:col-span-6">
              <label className="block text-xs text-white/60 mb-1">Search</label>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="over, iou, bullish, H4…"
                className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
              />
            </div>

            <div className="md:col-span-6 flex flex-wrap items-end justify-end gap-2">
              <Toggle
                label="Expand all items"
                value={expandAllItems}
                onChange={setExpandAllItems}
              />
              <Toggle
                label="Show raw JSON"
                value={showRaw}
                onChange={setShowRaw}
              />
            </div>
          </div>
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
            className="p-4 space-y-3"
          >
            {!patterns.length && (
              <div className="rounded-xl border border-white/10 bg-black/20 p-4 text-sm text-white/60">
                Aucun champ <code>advanced</code> exploitable dans cette analyse.
              </div>
            )}

            {patterns.length > 0 && filtered.length === 0 && (
              <div className="rounded-xl border border-white/10 bg-black/20 p-4 text-sm text-white/60">
                Aucun résultat pour “{search}”.
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {filtered.map((p) => (
                <PatternCard
                  key={p.key}
                  pattern={p}
                  expandItems={expandAllItems}
                />
              ))}
            </div>

            {showRaw && (
              <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <div className="text-xs font-medium text-white/70 mb-2">Raw advanced JSON</div>
                <pre className="rounded-xl border border-white/10 bg-black/30 p-3 text-xs text-white/75 overflow-auto max-h-[420px]">
                  {JSON.stringify(advanced ?? null, null, 2)}
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
   Sub-components
────────────────────────────────────────────────────────────── */

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
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

function PatternCard({
  pattern,
  expandItems,
}: {
  pattern: NormalizedPattern;
  expandItems: boolean;
}) {
  const [open, setOpen] = useState<boolean>(false);

  const items = pattern.items ?? [];

  const subtitle = useMemo(() => {
    const bits: string[] = [];
    if (pattern.timeframe) bits.push(pattern.timeframe);
    if (pattern.direction) bits.push(String(pattern.direction).toUpperCase());
    if (pattern.formed_at) bits.push(fmtTs(pattern.formed_at));
    return bits.join(' · ');
  }, [pattern.timeframe, pattern.direction, pattern.formed_at]);

  return (
    <div
      className={cn(
        'rounded-2xl border border-white/10 bg-gradient-to-b p-4 shadow-[0_18px_60px_rgba(0,0,0,0.45)]',
        scoreGradient(pattern.score ?? (pattern.detected ? 70 : 0))
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="text-sm font-semibold text-white/90 truncate">{pattern.label}</div>
            <span className={cn('rounded-full border px-2.5 py-1 text-[11px] font-medium', detectedPill(pattern.detected))}>
              {pattern.detected ? 'DETECTED' : 'NO'}
            </span>
          </div>
          <div className="text-xs text-white/60 mt-1 truncate">
            {subtitle || <span className="text-white/45">—</span>}
          </div>
        </div>

        <div className="text-right">
          <div className="text-[11px] text-white/55">Score</div>
          <div className="text-xl font-semibold tracking-tight">{pattern.score !== undefined ? fmt(pattern.score, 0) : '—'}</div>
          <div className="text-[11px] text-white/55">
            conf {pattern.confidence !== undefined ? fmtPct(pattern.confidence, 0) : '—'}
          </div>
        </div>
      </div>

      {pattern.notes && (
        <div className="mt-3 rounded-xl border border-white/10 bg-black/20 p-3">
          <div className="text-[11px] uppercase tracking-wide text-white/45">Notes</div>
          <div className="mt-1 text-xs text-white/75 whitespace-pre-wrap">{pattern.notes}</div>
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2">
        <MiniStat label="Key" value={pattern.key} />
        <MiniStat label="Detections" value={String(items.length)} />
      </div>

      <div className="mt-4 flex items-center justify-between gap-2">
        <button
          onClick={() => setOpen((p) => !p)}
          className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-white/85 hover:bg-white/10 transition"
          disabled={items.length === 0}
          title={items.length === 0 ? 'Aucun item dans ce pattern' : 'Voir détails'}
        >
          {open || expandItems ? 'Hide details' : 'Show details'}
        </button>

        <details>
          <summary className="cursor-pointer text-xs text-white/60 hover:text-white/80 transition">
            Raw
          </summary>
          <pre className="mt-2 rounded-xl border border-white/10 bg-black/30 p-3 text-xs text-white/75 overflow-auto max-h-[260px]">
            {JSON.stringify(pattern.raw ?? null, null, 2)}
          </pre>
        </details>
      </div>

      <AnimatePresence initial={false}>
        {(open || expandItems) && items.length > 0 && (
          <motion.div
            key="items"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="mt-3 space-y-2"
          >
            {items.slice(0, 8).map((it, idx) => (
              <div key={idx} className="rounded-xl border border-white/10 bg-black/20 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-white/85 truncate">
                      Detection #{idx + 1}
                      {it?.name ? <span className="text-white/45 font-normal"> · {String(it.name)}</span> : null}
                    </div>
                    <div className="text-[11px] text-white/55 mt-1">
                      {it?.timeframe ? `TF ${it.timeframe}` : 'TF —'}
                      <span className="mx-2 text-white/25">·</span>
                      {it?.formed_at || it?.timestamp ? `at ${fmtTs(it.formed_at ?? it.timestamp)}` : 'at —'}
                      <span className="mx-2 text-white/25">·</span>
                      {it?.direction ? `dir ${String(it.direction).toUpperCase()}` : 'dir —'}
                    </div>
                  </div>

                  <div className="text-right">
                    <div className="text-[11px] text-white/55">Score</div>
                    <div className="text-sm font-semibold text-white/90">
                      {pickNumber(it, ['score', 'pattern_score', 'strength', 'confidence']) !== undefined
                        ? fmt(pickNumber(it, ['score', 'pattern_score', 'strength', 'confidence'])!, 0)
                        : '—'}
                    </div>
                  </div>
                </div>

                {/* common fields snapshot */}
                <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
                  <MiniStat label="Price" value={pickNumber(it, ['price', 'level', 'entry']) !== undefined ? fmt(pickNumber(it, ['price', 'level', 'entry'])!, 4) : '—'} />
                  <MiniStat label="Top" value={pickNumber(it, ['top', 'zone_top']) !== undefined ? fmt(pickNumber(it, ['top', 'zone_top'])!, 4) : '—'} />
                  <MiniStat label="Bot" value={pickNumber(it, ['bot', 'zone_bot']) !== undefined ? fmt(pickNumber(it, ['bot', 'zone_bot'])!, 4) : '—'} />
                  <MiniStat label="RR" value={pickNumber(it, ['rr', 'risk_reward']) !== undefined ? fmt(pickNumber(it, ['rr', 'risk_reward'])!, 2) : '—'} />
                </div>

                <details className="mt-2">
                  <summary className="cursor-pointer text-[11px] text-white/60 hover:text-white/80 transition">
                    JSON
                  </summary>
                  <pre className="mt-2 rounded-xl border border-white/10 bg-black/30 p-3 text-xs text-white/75 overflow-auto max-h-[220px]">
                    {JSON.stringify(it ?? null, null, 2)}
                  </pre>
                </details>
              </div>
            ))}

            {items.length > 8 && (
              <div className="text-[11px] text-white/50">
                +{items.length - 8} autres détections (non affichées).
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
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