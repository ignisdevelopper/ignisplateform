/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useMemo } from 'react';

/**
 * SDZoneOverlay.tsx
 * Overlay HTML (absolute) pour zones Supply/Demand au-dessus d’un Lightweight Chart.
 *
 * Objectif:
 * - Dessiner des "bands" (rectangles) sur la hauteur correspondant à [zone_bot, zone_top]
 * - Afficher chips (zone type, score, SDE/SDP/FTB, distance au prix)
 * - Gérer sélection, click, hover
 * - Fournir un placement de labels avec anti-chevauchement simple
 *
 * Intégration typique dans TradingChart:
 * <SDZoneOverlay
 *   zones={zones}
 *   selectedZoneId={selectedZoneId}
 *   currentPrice={currentPrice}
 *   priceToY={(price) => candleSeries.priceScale().priceToCoordinate(price)}
 *   updateToken={overlayTick} // optionnel: incrémenté sur zoom/scroll
 *   onSelectZone={onZoneClick}
 * />
 */

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
  formed_at: number;
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

  formed_at: number;
  timeframe: string;
  score: number;
};

export type SDZoneOverlayProps = {
  zones: SDZoneResult[];

  /** callback price -> y coordinate in px (0 = top). Must be stable and fast. */
  priceToY: (price: number) => number | null;

  /** token to force recalculation on zoom/scroll (optional but recommended) */
  updateToken?: number;

  /** dims used for culling; if omitted we render anyway */
  height?: number;
  width?: number;

  selectedZoneId?: string | null;

  currentPrice?: number | null;

  /** if true => hide zones outside visible (approx by y coords + padding) */
  cullOutside?: boolean;

  /** show/hide chips */
  showLeftFlags?: boolean;   // SDE/SDP/FTB
  showRightLabel?: boolean;  // type + score
  showDistance?: boolean;

  /** click/hover */
  onSelectZone?: (z: SDZoneResult) => void;
  onHoverZone?: (z: SDZoneResult | null) => void;

  /** rendering options */
  paddingPx?: number;
  maxZones?: number;

  className?: string;
  style?: React.CSSProperties;
};

type RenderBand = {
  zone: SDZoneResult;
  yTop: number;
  yBot: number;
  h: number;
  inView: boolean;
  dist?: number;
};

export default function SDZoneOverlay({
  zones,
  priceToY,
  updateToken,

  height,
  width,

  selectedZoneId,
  currentPrice,

  cullOutside = true,

  showLeftFlags = true,
  showRightLabel = true,
  showDistance = true,

  onSelectZone,
  onHoverZone,

  paddingPx = 60,
  maxZones = 60,

  className,
  style,
}: SDZoneOverlayProps) {
  // (updateToken) is purposely used in deps, to let parent invalidate overlay on scale/time changes
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _tick = updateToken;

  const sortedZones = useMemo(() => {
    const list = Array.isArray(zones) ? zones : [];
    // higher score first, then most recent
    return list
      .slice()
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (toMs(b.formed_at) - toMs(a.formed_at)));
  }, [zones]);

  const bands = useMemo(() => {
    const list = sortedZones.slice(0, maxZones);

    const out: RenderBand[] = [];
    for (const z of list) {
      const hi = Math.max(z.zone_top, z.zone_bot);
      const lo = Math.min(z.zone_top, z.zone_bot);

      const yHi = priceToY(hi);
      const yLo = priceToY(lo);

      if (yHi === null || yLo === null) continue;

      const yTop = Math.min(yHi, yLo);
      const yBot = Math.max(yHi, yLo);
      const h = Math.max(2, yBot - yTop);

      const inView =
        height !== undefined
          ? !(yBot < -paddingPx || yTop > height + paddingPx)
          : true;

      const dist =
        currentPrice !== undefined && currentPrice !== null && Number.isFinite(currentPrice)
          ? zoneDistanceToPrice(z, currentPrice)
          : undefined;

      out.push({ zone: z, yTop, yBot, h, inView, dist });
    }

    return cullOutside ? out.filter((b) => b.inView) : out;
  }, [sortedZones, priceToY, height, paddingPx, currentPrice, cullOutside, maxZones, _tick]);

  // label collision avoidance (simple):
  // We compute a "chipY" per band, pushing down if too close to existing chips.
  const labelPlacements = useMemo(() => {
    const chipH = 26;     // approximated px
    const gap = 6;

    const rightUsed: Array<{ y0: number; y1: number }> = [];
    const leftUsed: Array<{ y0: number; y1: number }> = [];

    const place = (desired: number, used: Array<{ y0: number; y1: number }>) => {
      let y = desired;
      for (let iter = 0; iter < 12; iter++) {
        const y0 = y;
        const y1 = y + chipH;
        const collides = used.some((r) => !(y1 + gap < r.y0 || y0 - gap > r.y1));
        if (!collides) {
          used.push({ y0, y1 });
          return y;
        }
        y += chipH + gap;
      }
      used.push({ y0: desired, y1: desired + chipH });
      return desired;
    };

    const map: Record<string, { leftY: number; rightY: number }> = {};
    for (const b of bands) {
      const desired = b.yTop + 10;
      map[b.zone.id] = {
        leftY: place(desired, leftUsed),
        rightY: place(desired, rightUsed),
      };
    }
    return map;
  }, [bands]);

  if (!bands.length) {
    return (
      <div
        className={cn('absolute inset-0 pointer-events-none', className)}
        style={style}
      />
    );
  }

  return (
    <div
      className={cn('absolute inset-0 z-[5]', className)}
      style={{ ...style, pointerEvents: onSelectZone ? 'auto' : 'none' }}
      aria-label="SD zones overlay"
    >
      {bands.map((b) => {
        const z = b.zone;
        const selected = selectedZoneId === z.id;

        const col = zoneColor(z.zone_type);
        const bgA = selected ? 0.18 : 0.10;
        const borderA = selected ? 0.60 : 0.35;

        const inZone =
          currentPrice !== undefined &&
          currentPrice !== null &&
          Number.isFinite(currentPrice) &&
          zoneDistanceToPrice(z, currentPrice) === 0;

        const placement = labelPlacements[z.id] ?? { leftY: b.yTop + 10, rightY: b.yTop + 10 };

        // z-index: selected > high score > others
        const zIndex = selected ? 50 : clamp(Math.round(z.score ?? 0), 0, 49);

        return (
          <div
            key={z.id}
            className="absolute left-0 right-0"
            style={{
              top: `${b.yTop}px`,
              height: `${b.h}px`,
              zIndex,
              pointerEvents: onSelectZone ? 'auto' : 'none',
            }}
            onMouseEnter={() => onHoverZone?.(z)}
            onMouseLeave={() => onHoverZone?.(null)}
          >
            {/* Band area (clickable) */}
            <button
              type="button"
              className={cn(
                'absolute inset-0 rounded-xl border transition',
                selected ? 'shadow-[0_18px_70px_rgba(0,0,0,0.35)]' : ''
              )}
              style={{
                borderColor: hexToRgba(col, borderA),
                background: `linear-gradient(180deg, ${hexToRgba(col, bgA)} 0%, rgba(0,0,0,0) 100%)`,
                backdropFilter: 'blur(6px)',
                cursor: onSelectZone ? 'pointer' : 'default',
              }}
              onClick={(ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                onSelectZone?.(z);
              }}
              title={[
                `${zoneLabel(z.zone_type)} · ${fmt(z.score, 0)}%`,
                `Top ${fmt(z.zone_top, 6)} · Bot ${fmt(z.zone_bot, 6)}`,
                `SDE ${z.sde_confirmed ? 'OK' : 'NO'} · SDP ${z.sdp_validated ? 'OK' : 'NO'} · FTB ${z.ftb_count}`,
              ].join('\n')}
            />

            {/* subtle mid line */}
            <div
              className="absolute left-0 right-0"
              style={{
                top: `${b.h / 2}px`,
                height: '1px',
                background: hexToRgba(col, selected ? 0.28 : 0.16),
              }}
            />

            {/* Left flags chips */}
            {showLeftFlags && (
              <div
                className="absolute left-3 flex flex-wrap items-center gap-2"
                style={{ top: `${placement.leftY - b.yTop}px` }}
              >
                <FlagChip ok={z.sde_confirmed} label={`SDE ${fmt(z.sde_score, 0)}%`} okColor="rgba(29,158,117,1)" />
                <FlagChip ok={z.sdp_validated} label="SDP" okColor="rgba(55,138,221,1)" />
                <FlagChip ok={z.is_ftb_valid} label={`FTB ${z.ftb_count}`} okColor="rgba(232,93,26,1)" />

                {inZone && (
                  <span className="rounded-full border border-white/10 bg-black/40 px-2.5 py-1 text-[11px] text-white/85">
                    IN ZONE
                  </span>
                )}
              </div>
            )}

            {/* Right label */}
            {showRightLabel && (
              <div
                className="absolute right-3 flex items-center gap-2"
                style={{ top: `${placement.rightY - b.yTop}px` }}
              >
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: col }}
                  aria-hidden="true"
                />
                <span
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-[11px] font-medium',
                    selected ? 'bg-black/55 text-white' : 'bg-black/35 text-white/85',
                    'border-white/10'
                  )}
                  style={{ boxShadow: selected ? `0 0 0 1px ${hexToRgba(col, 0.35)} inset` : undefined }}
                >
                  {zoneLabel(z.zone_type)} · {fmt(z.score, 0)}%
                </span>

                {showDistance && b.dist !== undefined && Number.isFinite(b.dist) && (
                  <span className="rounded-full border border-white/10 bg-black/35 px-2.5 py-1 text-[11px] text-white/70">
                    Δ {fmt(b.dist, 6)}
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Optional debug corner */}
      {width !== undefined && height !== undefined && (
        <div className="pointer-events-none absolute bottom-3 left-3 rounded-xl border border-white/10 bg-black/35 px-3 py-2 text-[11px] text-white/55 backdrop-blur">
          overlay: {bands.length} zones · {width}×{height}
        </div>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   UI components
────────────────────────────────────────────────────────────── */

function FlagChip({
  ok,
  label,
  okColor,
}: {
  ok: boolean;
  label: string;
  okColor: string; // rgba(...)
}) {
  return (
    <span
      className={cn(
        'rounded-full border px-2.5 py-1 text-[11px] font-medium',
        ok ? 'text-white/90' : 'text-white/65'
      )}
      style={{
        borderColor: ok ? okColor.replace('1)', '0.35)') : 'rgba(255,255,255,0.10)',
        background: ok ? okColor.replace('1)', '0.12)') : 'rgba(0,0,0,0.25)',
      }}
    >
      {label}
    </span>
  );
}

/* ──────────────────────────────────────────────────────────────
   Utils
────────────────────────────────────────────────────────────── */

function cn(...classes: Array<string | undefined | null | false>) {
  return classes.filter(Boolean).join(' ');
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function fmt(n: number | undefined, digits = 2) {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits }).format(n);
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

function zoneDistanceToPrice(z: SDZoneResult, price: number) {
  const hi = Math.max(z.zone_top, z.zone_bot);
  const lo = Math.min(z.zone_top, z.zone_bot);
  if (price >= lo && price <= hi) return 0;
  return Math.min(Math.abs(price - lo), Math.abs(price - hi));
}

function toMs(ts: number) {
  return ts < 10_000_000_000 ? ts * 1000 : ts;
}

function hexToRgba(hex: string, a: number) {
  const h = hex.replace('#', '').trim();
  if (h.length !== 6) return `rgba(255,255,255,${a})`;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}