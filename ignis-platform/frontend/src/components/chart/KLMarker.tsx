/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

export type KeyLevelResult = {
  id?: string;
  price: number;
  kind?: string;        // backend: "kind" peut varier (SR, pivot, range, session, etc.)
  score?: number;       // parfois absent
  timeframe?: string;
  formed_at?: number;   // sec ou ms
  meta?: Record<string, any>;
};

export type KLMarkerProps = {
  kl: KeyLevelResult;

  /** If provided => marker is positioned absolutely (useful for chart overlay) */
  y?: number;
  x?: number;

  /** Which side the marker label should stick to */
  side?: 'left' | 'right';

  selected?: boolean;
  compact?: boolean;

  currentPrice?: number | null;

  /** interactions */
  onSelect?: (kl: KeyLevelResult) => void;
  onFocusPrice?: (price: number, kl: KeyLevelResult) => void;

  /** display */
  showMetaPreview?: boolean;
  showActions?: boolean;

  className?: string;
};

export default function KLMarker({
  kl,
  y,
  x,
  side = 'right',
  selected = false,
  compact = false,
  currentPrice,

  onSelect,
  onFocusPrice,

  showMetaPreview = true,
  showActions = true,

  className,
}: KLMarkerProps) {
  const [open, setOpen] = useState(false);

  const color = useMemo(() => klKindColor(kl.kind), [kl.kind]);
  const pillCls = useMemo(() => klKindPill(kl.kind), [kl.kind]);

  const dist = useMemo(() => {
    if (currentPrice === undefined || currentPrice === null) return undefined;
    if (!Number.isFinite(currentPrice) || !Number.isFinite(kl.price)) return undefined;
    return Math.abs(currentPrice - kl.price);
  }, [currentPrice, kl.price]);

  const metaPreview = useMemo(() => {
    if (!showMetaPreview) return null;
    const m = kl.meta ?? {};
    const reason = pickString(m, ['reason', 'notes', 'comment', 'message']);
    const src = pickString(m, ['source', 'src', 'origin']);
    const touches = pickNumber(m, ['touches', 'touch_count', 'hits']);
    const strength = pickNumber(m, ['confidence', 'strength']);
    return { reason, src, touches, strength };
  }, [kl.meta, showMetaPreview]);

  const absolute = typeof y === 'number' || typeof x === 'number';
  const top = typeof y === 'number' ? `${y}px` : undefined;
  const left = typeof x === 'number' ? `${x}px` : undefined;

  const markerPositionStyle: React.CSSProperties | undefined = absolute
    ? {
        position: 'absolute',
        top,
        left,
        ...(side === 'right' ? { right: 12 } : { left: 12 }),
        transform: 'translateY(-50%)',
        zIndex: selected ? 40 : 30,
        pointerEvents: 'auto',
      }
    : undefined;

  const title = `${kl.kind ?? 'Key level'} · ${fmt(kl.price, 6)}${kl.score !== undefined ? ` · ${fmt(kl.score, 0)}%` : ''}`;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.18 }}
      className={cn(absolute ? '' : 'relative', className)}
      style={markerPositionStyle}
      title={title}
    >
      {/* Connector */}
      {absolute && (
        <div
          className={cn(
            'absolute top-1/2 -translate-y-1/2 h-[2px] w-6',
            side === 'right' ? 'right-0 translate-x-full' : 'left-0 -translate-x-full'
          )}
          style={{
            background: `linear-gradient(${side === 'right' ? '90deg' : '270deg'}, ${hexToRgba(
              color,
              0.72
            )} 0%, rgba(255,255,255,0.0) 100%)`,
          }}
        />
      )}

      <button
        type="button"
        onClick={() => {
          onSelect?.(kl);
          setOpen((p) => !p);
        }}
        className={cn(
          'group w-full text-left rounded-2xl border backdrop-blur-[16px] transition',
          selected
            ? 'border-white/20 bg-white/10 shadow-[0_16px_55px_rgba(0,0,0,0.55)]'
            : 'border-white/10 bg-black/30 hover:bg-white/10 hover:border-white/15',
          compact ? 'px-3 py-2' : 'px-3.5 py-3'
        )}
        style={{
          boxShadow: selected ? `0 0 0 1px ${hexToRgba(color, 0.22)} inset` : undefined,
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={cn('rounded-full border px-2.5 py-1 text-[11px] font-medium', pillCls)}>
                {prettyKind(kl.kind)}
              </span>

              {kl.timeframe && (
                <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/70">
                  {kl.timeframe}
                </span>
              )}

              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: color }}
                aria-hidden="true"
              />
            </div>

            <div className={cn('mt-2 flex flex-wrap items-center gap-2', compact ? 'text-xs' : 'text-sm')}>
              <div className="font-semibold text-white/90">
                {fmt(kl.price, compact ? 4 : 6)}
              </div>

              {kl.score !== undefined && (
                <>
                  <span className="text-white/30">·</span>
                  <div className="text-white/75">
                    score <span className="text-white/90 font-semibold">{fmt(kl.score, 0)}%</span>
                  </div>
                </>
              )}

              {dist !== undefined && (
                <>
                  <span className="text-white/30">·</span>
                  <div className="text-white/65">Δ {fmt(dist, 6)}</div>
                </>
              )}
            </div>

            {!compact && metaPreview && (metaPreview.src || metaPreview.touches !== undefined || metaPreview.strength !== undefined) && (
              <div className="mt-1 text-[11px] text-white/55 truncate">
                {metaPreview.src ? `src ${metaPreview.src}` : 'src —'}
                {metaPreview.touches !== undefined ? <span className="text-white/35"> · touches {fmt(metaPreview.touches, 0)}</span> : null}
                {metaPreview.strength !== undefined ? <span className="text-white/35"> · conf {fmtPct(metaPreview.strength, 0)}</span> : null}
              </div>
            )}
          </div>

          <div className="min-w-[96px] text-right">
            <div className="text-[11px] text-white/55">Strength</div>
            <div className="mt-1">
              <ScoreBar value={kl.score ?? 0} color={color} />
            </div>
          </div>
        </div>

        <AnimatePresence initial={false}>
          {open && !compact && (
            <motion.div
              key="open"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="mt-3 space-y-3"
              onClick={(e) => e.stopPropagation()}
            >
              {metaPreview?.reason && (
                <div className="rounded-xl border border-white/10 bg-black/25 p-3">
                  <div className="text-[11px] uppercase tracking-wide text-white/45">Notes</div>
                  <div className="mt-1 text-xs text-white/75 whitespace-pre-wrap leading-relaxed">
                    {metaPreview.reason}
                  </div>
                </div>
              )}

              {showActions && (
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => copyToClipboard(String(kl.price))}
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition"
                  >
                    Copy price
                  </button>

                  <button
                    type="button"
                    onClick={() => onFocusPrice?.(kl.price, kl)}
                    disabled={!onFocusPrice}
                    className={cn(
                      'rounded-xl border px-3 py-2 text-xs font-medium transition',
                      onFocusPrice
                        ? 'border-[#378ADD]/25 bg-[#378ADD]/10 text-sky-200 hover:bg-[#378ADD]/15'
                        : 'border-white/10 bg-white/5 text-white/40'
                    )}
                    title={!onFocusPrice ? 'onFocusPrice non fourni' : 'Focus chart on this key level'}
                  >
                    Focus chart
                  </button>
                </div>
              )}

              <details className="rounded-xl border border-white/10 bg-black/25 p-3">
                <summary className="cursor-pointer text-xs text-white/60 hover:text-white/80 transition">
                  Raw JSON
                </summary>
                <pre className="mt-2 rounded-xl border border-white/10 bg-black/35 p-3 text-xs text-white/75 overflow-auto max-h-[240px]">
                  {JSON.stringify(kl, null, 2)}
                </pre>
              </details>
            </motion.div>
          )}
        </AnimatePresence>
      </button>
    </motion.div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Helpers
────────────────────────────────────────────────────────────── */

function cn(...classes: Array<string | undefined | null | false>) {
  return classes.filter(Boolean).join(' ');
}

function fmt(n: number | undefined, digits = 2) {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits }).format(n);
}

function fmtPct(n: number, digits = 0) {
  const val = n <= 1 ? n * 100 : n;
  return `${fmt(val, digits)}%`;
}

function ScoreBar({ value, color }: { value: number; color: string }) {
  const v = Math.max(0, Math.min(100, value ?? 0));
  return (
    <div className="h-2 rounded-full border border-white/10 bg-white/5 overflow-hidden">
      <div
        className="h-full rounded-full"
        style={{
          width: `${v}%`,
          background: `linear-gradient(90deg, ${hexToRgba(color, 0.75)} 0%, ${hexToRgba(color, 0.18)} 100%)`,
        }}
      />
    </div>
  );
}

function prettyKind(kind?: string) {
  if (!kind) return 'Key level';
  const k = kind.trim();
  if (!k) return 'Key level';
  // quick prettify: S_R -> S/R
  return k.replace(/_/g, ' ').replace(/\bS\s*\/\s*R\b/i, 'S/R');
}

function klKindColor(kind?: string) {
  const k = (kind ?? '').toLowerCase();

  if (k.includes('support') || k.includes('demand')) return '#1D9E75';
  if (k.includes('resist') || k.includes('supply')) return '#E24B4A';

  // pivot / sr / range / session -> blue accent
  if (k.includes('pivot') || k.includes('sr') || k.includes('s/r') || k.includes('range') || k.includes('session')) {
    return '#378ADD';
  }

  return '#378ADD';
}

function klKindPill(kind?: string) {
  const k = (kind ?? '').toLowerCase();

  if (k.includes('support') || k.includes('demand')) {
    return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200';
  }
  if (k.includes('resist') || k.includes('supply')) {
    return 'border-rose-500/25 bg-rose-500/10 text-rose-200';
  }

  return 'border-sky-500/25 bg-sky-500/10 text-sky-200';
}

function pickString(obj: any, keys: string[]) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

function pickNumber(obj: any, keys: string[]) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
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