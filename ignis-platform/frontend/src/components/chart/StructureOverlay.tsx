/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useMemo } from 'react';

/**
 * StructureOverlay.tsx
 * Overlay HTML/SVG au-dessus d’un Lightweight Chart pour visualiser:
 * - Swing points HH/HL/LH/LL
 * - ZigZag (liaison entre swings)
 * - Structure breaks (vertical line + label, et éventuellement niveau/price)
 *
 * ⚙️ Intégration (dans TradingChart):
 * <StructureOverlay
 *   swingPoints={analysis.market_structure.swing_points}
 *   structureBreaks={analysis.market_structure.structure_breaks}
 *   timeToX={(tSec) => chart.timeScale().timeToCoordinate(tSec as any)}
 *   priceToY={(p) => candleSeries.priceScale().priceToCoordinate(p)}
 *   width={containerWidth}
 *   height={containerHeight}
 *   updateToken={overlayTick}
 *   onSelectSwing={(sp) => ...}
 * />
 */

export type SwingType = 'HH' | 'HL' | 'LH' | 'LL';

export type SwingPoint = {
  timestamp: number; // sec or ms
  price: number;
  swing_type: SwingType;
  index: number;
};

export type StructureOverlayProps = {
  swingPoints: SwingPoint[];
  structureBreaks?: any[]; // backend object[] format variable

  /** coordinate mapping from chart */
  timeToX: (timeSec: number) => number | null;
  priceToY: (price: number) => number | null;

  /** used for culling + debug */
  width?: number;
  height?: number;

  /** force recalculation on zoom/scroll */
  updateToken?: number;

  /** selection */
  selectedSwingKey?: string | null;
  onSelectSwing?: (sp: SwingPoint & { key: string }) => void;

  /** breaks interactions */
  onSelectBreak?: (b: NormalizedBreak) => void;

  /** rendering toggles */
  showZigZag?: boolean;
  showSwingLabels?: boolean;
  showSwingDots?: boolean;
  showBreaks?: boolean;

  /** style */
  zigzagOpacity?: number;
  zigzagWidth?: number;
  cullOutside?: boolean;
  paddingPx?: number;

  /** optional: show mini legend in corner */
  showLegend?: boolean;

  className?: string;
  style?: React.CSSProperties;
};

export type NormalizedBreak = {
  key: string;
  kind: string;
  direction?: string;
  timestampSec?: number;
  price?: number;
  timeframe?: string;
  reason?: string;
  raw: any;
};

type RenderSwing = SwingPoint & {
  key: string;
  x: number;
  y: number;
  inView: boolean;
};

type RenderBreak = NormalizedBreak & {
  x: number;
  y?: number;
  inView: boolean;
};

export default function StructureOverlay({
  swingPoints,
  structureBreaks = [],

  timeToX,
  priceToY,

  width,
  height,

  updateToken,

  selectedSwingKey,
  onSelectSwing,

  onSelectBreak,

  showZigZag = true,
  showSwingLabels = true,
  showSwingDots = true,
  showBreaks = true,

  zigzagOpacity = 0.75,
  zigzagWidth = 2,

  cullOutside = true,
  paddingPx = 80,

  showLegend = true,

  className,
  style,
}: StructureOverlayProps) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _tick = updateToken;

  const swingsSorted = useMemo(() => {
    const list = Array.isArray(swingPoints) ? swingPoints : [];
    // chronological order for zigzag
    return list
      .slice()
      .sort((a, b) => toMs(a.timestamp) - toMs(b.timestamp));
  }, [swingPoints]);

  const renderSwings = useMemo<RenderSwing[]>(() => {
    const out: RenderSwing[] = [];
    if (!swingsSorted.length) return out;

    for (let i = 0; i < swingsSorted.length; i++) {
      const sp = swingsSorted[i];

      const tSec = toSeconds(sp.timestamp);
      const x = timeToX(tSec);
      const y = priceToY(sp.price);

      if (x === null || y === null) continue;

      const inView =
        width !== undefined && height !== undefined
          ? !(x < -paddingPx || x > width + paddingPx || y < -paddingPx || y > height + paddingPx)
          : true;

      const key = `${sp.swing_type}|${tSec}|${sp.price}|${sp.index}|${i}`;
      out.push({ ...sp, key, x, y, inView });
    }

    return cullOutside ? out.filter((p) => p.inView) : out;
  }, [swingsSorted, timeToX, priceToY, width, height, paddingPx, cullOutside, _tick]);

  const breaksNormalized = useMemo(() => normalizeBreaks(Array.isArray(structureBreaks) ? structureBreaks : []), [structureBreaks]);

  const renderBreaks = useMemo<RenderBreak[]>(() => {
    if (!showBreaks) return [];
    const out: RenderBreak[] = [];

    for (const b of breaksNormalized) {
      const x = b.timestampSec !== undefined ? timeToX(b.timestampSec) : null;
      if (x === null || x === undefined) continue;

      const y = b.price !== undefined ? priceToY(b.price) ?? undefined : undefined;

      const inView =
        width !== undefined
          ? !(x < -paddingPx || x > width + paddingPx)
          : true;

      out.push({ ...b, x, y, inView });
    }

    return cullOutside ? out.filter((b) => b.inView) : out;
  }, [breaksNormalized, timeToX, priceToY, width, paddingPx, cullOutside, showBreaks]);

  const zigzagPath = useMemo(() => {
    if (!showZigZag) return '';
    if (renderSwings.length < 2) return '';

    // Build SVG path: M x0 y0 L x1 y1 ...
    const pts = renderSwings;
    let d = `M ${round1(pts[0].x)} ${round1(pts[0].y)}`;
    for (let i = 1; i < pts.length; i++) {
      d += ` L ${round1(pts[i].x)} ${round1(pts[i].y)}`;
    }
    return d;
  }, [renderSwings, showZigZag]);

  if ((!renderSwings.length && !renderBreaks.length) || !timeToX || !priceToY) {
    return (
      <div className={cn('absolute inset-0 pointer-events-none', className)} style={style} />
    );
  }

  return (
    <div
      className={cn('absolute inset-0 z-[6]', className)}
      style={{ ...style, pointerEvents: 'none' }}
      aria-label="Market structure overlay"
    >
      {/* ZigZag (SVG) */}
      {showZigZag && zigzagPath && (
        <svg
          className="absolute inset-0"
          width={width ?? '100%'}
          height={height ?? '100%'}
          style={{ overflow: 'visible', pointerEvents: 'none' }}
        >
          <defs>
            <linearGradient id="ignis-zigzag" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="rgba(232,93,26,0.85)" />
              <stop offset="55%" stopColor="rgba(55,138,221,0.75)" />
              <stop offset="100%" stopColor="rgba(29,158,117,0.75)" />
            </linearGradient>
          </defs>

          <path
            d={zigzagPath}
            fill="none"
            stroke="url(#ignis-zigzag)"
            strokeWidth={zigzagWidth}
            strokeOpacity={clamp(zigzagOpacity, 0, 1)}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}

      {/* Break lines */}
      {showBreaks && renderBreaks.map((b) => {
        const label = `${b.kind}${b.direction ? ` · ${String(b.direction).toUpperCase()}` : ''}${b.price !== undefined ? ` · ${fmt(b.price, 6)}` : ''}`;
        const color = breakColor(b.kind, b.direction);

        return (
          <div
            key={b.key}
            className="absolute top-0 bottom-0"
            style={{
              left: `${b.x}px`,
              width: 1,
              background: `linear-gradient(180deg, ${rgba(color, 0.55)} 0%, rgba(255,255,255,0.03) 100%)`,
              pointerEvents: onSelectBreak ? 'auto' : 'none',
            }}
            onClick={(ev) => {
              if (!onSelectBreak) return;
              ev.preventDefault();
              ev.stopPropagation();
              onSelectBreak(b);
            }}
            title={label}
          >
            {/* label */}
            <div
              className="absolute -translate-x-1/2 top-3"
              style={{ left: 0, pointerEvents: 'none' }}
            >
              <div
                className="rounded-full border border-white/10 bg-black/45 px-2.5 py-1 text-[11px] text-white/80 backdrop-blur"
                style={{ boxShadow: `0 0 0 1px ${rgba(color, 0.25)} inset` }}
              >
                {b.kind}
              </div>
            </div>

            {/* optional horizontal cross at break price */}
            {b.y !== undefined && (
              <div
                className="absolute left-0"
                style={{
                  top: `${b.y}px`,
                  height: 1,
                  width: width ?? '100%',
                  transform: 'translateX(-50%)',
                  background: rgba(color, 0.22),
                  pointerEvents: 'none',
                }}
              />
            )}
          </div>
        );
      })}

      {/* Swing dots + labels */}
      {renderSwings.map((sp) => {
        const selected = selectedSwingKey === sp.key;
        const col = swingColor(sp.swing_type);

        return (
          <div
            key={sp.key}
            className="absolute"
            style={{
              left: `${sp.x}px`,
              top: `${sp.y}px`,
              transform: 'translate(-50%, -50%)',
              pointerEvents: onSelectSwing ? 'auto' : 'none',
              zIndex: selected ? 60 : 20,
            }}
            onClick={(ev) => {
              if (!onSelectSwing) return;
              ev.preventDefault();
              ev.stopPropagation();
              onSelectSwing(sp);
            }}
            title={`${sp.swing_type} · ${fmt(sp.price, 6)} · t=${sp.timestamp}`}
          >
            {showSwingDots && (
              <div
                className={cn(
                  'rounded-full border',
                  selected ? 'border-white/25' : 'border-white/10'
                )}
                style={{
                  width: selected ? 14 : 10,
                  height: selected ? 14 : 10,
                  background: rgba(col, selected ? 0.95 : 0.80),
                  boxShadow: selected ? `0 0 0 6px ${rgba(col, 0.12)}` : `0 0 0 4px ${rgba(col, 0.08)}`,
                }}
              />
            )}

            {showSwingLabels && (
              <div
                className="absolute left-1/2"
                style={{
                  top: sp.swing_type === 'HH' || sp.swing_type === 'LH' ? -18 : 14,
                  transform: 'translateX(-50%)',
                  pointerEvents: 'none',
                }}
              >
                <div
                  className={cn(
                    'rounded-full border px-2 py-1 text-[11px] font-medium backdrop-blur',
                    selected ? 'border-white/20 bg-black/55 text-white' : 'border-white/10 bg-black/35 text-white/80'
                  )}
                  style={{
                    boxShadow: selected ? `0 0 0 1px ${rgba(col, 0.30)} inset` : undefined,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {sp.swing_type}
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* Legend */}
      {showLegend && (
        <div className="pointer-events-none absolute bottom-3 right-3 rounded-2xl border border-white/10 bg-black/35 px-3 py-2 text-[11px] text-white/60 backdrop-blur">
          <div className="text-white/75 font-medium">Structure</div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <LegendDot color={swingColor('HH')} label="HH" />
            <LegendDot color={swingColor('HL')} label="HL" />
            <LegendDot color={swingColor('LH')} label="LH" />
            <LegendDot color={swingColor('LL')} label="LL" />
            <span className="mx-1 text-white/25">·</span>
            <span>ZigZag</span>
            <span className="mx-1 text-white/25">·</span>
            <span>Breaks</span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Break normalization (backend format can vary)
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
    const timestampSec =
      timestamp !== undefined && timestamp !== null
        ? (typeof timestamp === 'string' ? dateToSec(timestamp) : toSeconds(Number(timestamp)))
        : undefined;

    const price =
      pickNumber(b, ['price', 'level', 'break_price', 'close', 'trigger_price']) ??
      undefined;

    const key = `${kind}|${direction ?? ''}|${timeframe ?? ''}|${String(timestampSec ?? '')}|${String(price ?? '')}|${idx}`;

    return {
      key,
      kind,
      direction,
      timeframe,
      timestampSec,
      price,
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
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

function dateToSec(s: string): number | undefined {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return undefined;
  return Math.floor(d.getTime() / 1000);
}

/* ──────────────────────────────────────────────────────────────
   Colors + UI helpers
────────────────────────────────────────────────────────────── */

function cn(...classes: Array<string | undefined | null | false>) {
  return classes.filter(Boolean).join(' ');
}

function fmt(n: number | undefined, digits = 2) {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits }).format(n);
}

function toSeconds(ts: number) {
  return ts < 10_000_000_000 ? Math.floor(ts) : Math.floor(ts / 1000);
}

function toMs(ts: number) {
  return ts < 10_000_000_000 ? ts * 1000 : ts;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

function rgba(hex: string, a: number) {
  // accepts #RRGGBB only
  const h = hex.replace('#', '').trim();
  if (h.length !== 6) return `rgba(255,255,255,${a})`;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function swingColor(t: SwingType) {
  // align with other components (green bullish highs, red bearish lows, etc.)
  switch (t) {
    case 'HH': return '#1D9E75';
    case 'HL': return '#2AD4A5';
    case 'LH': return '#FFB020';
    case 'LL': return '#E24B4A';
    default: return '#A1A1AA';
  }
}

function breakColor(kind: string, direction?: string) {
  const k = (kind ?? '').toLowerCase();
  const d = (direction ?? '').toLowerCase();

  if (k.includes('bos') || k.includes('break')) {
    if (d.includes('bull') || d.includes('up')) return '#1D9E75';
    if (d.includes('bear') || d.includes('down')) return '#E24B4A';
    return '#E85D1A';
  }
  if (k.includes('choch') || k.includes('change')) return '#378ADD';

  return '#E85D1A';
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      <span>{label}</span>
    </span>
  );
}