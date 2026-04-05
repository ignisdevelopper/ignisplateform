'use client';

import React, { useMemo } from 'react';

export type SetupStatus = 'VALID' | 'PENDING' | 'INVALID' | 'WATCH' | 'EXPIRED';
export type ZoneType = 'DEMAND' | 'SUPPLY' | 'FLIPPY_D' | 'FLIPPY_S' | 'HIDDEN_D' | 'HIDDEN_S';
export type PAPattern = 'ACCU' | 'THREE_DRIVES' | 'FTL' | 'PATTERN_69' | 'HIDDEN_SDE' | 'NONE';

export type SetupBadgeVariant = 'solid' | 'soft' | 'glass';

export default function SetupBadge({
  status,
  score,
  zoneType,
  paPattern,
  rr,

  variant = 'glass',
  size = 'md',

  showScore = true,
  showZone = true,
  showPA = true,
  showRR = true,

  className,
  title,
}: {
  status: SetupStatus;
  score?: number;

  zoneType?: ZoneType;
  paPattern?: PAPattern;
  rr?: number;

  variant?: SetupBadgeVariant;
  size?: 'sm' | 'md' | 'lg';

  showScore?: boolean;
  showZone?: boolean;
  showPA?: boolean;
  showRR?: boolean;

  className?: string;
  title?: string;
}) {
  const s = useMemo(() => normalizeStatus(status), [status]);
  const pal = useMemo(() => statusPalette(s), [s]);

  const pad =
    size === 'sm' ? 'px-2.5 py-1 text-[11px]'
      : size === 'lg' ? 'px-3.5 py-2 text-sm'
      : 'px-3 py-1.5 text-xs';

  const baseCls =
    variant === 'solid'
      ? `border ${pad} font-semibold`
      : variant === 'soft'
        ? `border ${pad} font-medium`
        : `border ${pad} font-medium backdrop-blur-[14px]`;

  const bg =
    variant === 'solid'
      ? pal.bgSolid
      : variant === 'soft'
        ? pal.bgSoft
        : pal.bgGlass;

  const border = pal.border;
  const text = pal.text;

  const scoreText = showScore && typeof score === 'number' ? `${Math.round(score)}%` : null;

  const zoneChip = showZone && zoneType ? (
    <span
      className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-medium', chipCls(variant))}
      style={{ boxShadow: `0 0 0 1px ${zoneColor(zoneType)} inset` }}
      title={`Zone: ${zoneType}`}
    >
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: zoneColor(zoneType) }} />
      <span className="text-white/85">{prettyZone(zoneType)}</span>
    </span>
  ) : null;

  const paChip = showPA && paPattern ? (
    <span className={cn('inline-flex items-center rounded-full border px-2 py-1 text-[11px] font-medium', chipCls(variant), 'border-[#378ADD]/25 bg-[#378ADD]/10 text-sky-200')}>
      PA {prettyPA(paPattern)}
    </span>
  ) : null;

  const rrChip = showRR && typeof rr === 'number' ? (
    <span className={cn('inline-flex items-center rounded-full border px-2 py-1 text-[11px] font-medium', chipCls(variant))}>
      RR {fmt(rr, 2)}
    </span>
  ) : null;

  return (
    <div
      className={cn(
        'inline-flex flex-wrap items-center gap-2 rounded-2xl',
        baseCls,
        border,
        bg,
        text,
        className
      )}
      title={title}
      aria-label={`setup-badge-${s}`}
    >
      <span className="inline-flex items-center gap-2">
        <span className={cn('h-2.5 w-2.5 rounded-full', pal.dot)} />
        <span className="tracking-wide">{s}</span>
        {scoreText && (
          <span className="text-white/70 font-semibold">
            {scoreText}
          </span>
        )}
      </span>

      {(zoneChip || paChip || rrChip) && (
        <span className="mx-1 h-4 w-px bg-white/10" aria-hidden />
      )}

      {zoneChip}
      {paChip}
      {rrChip}
    </div>
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

function normalizeStatus(s: string): SetupStatus {
  const v = (s ?? '').toUpperCase();
  if (v === 'VALID') return 'VALID';
  if (v === 'PENDING') return 'PENDING';
  if (v === 'WATCH') return 'WATCH';
  if (v === 'EXPIRED') return 'EXPIRED';
  return 'INVALID';
}

function statusPalette(s: SetupStatus) {
  // Glass theme tuned
  switch (s) {
    case 'VALID':
      return {
        border: 'border-emerald-500/20',
        bgSolid: 'bg-emerald-500/20',
        bgSoft: 'bg-emerald-500/10',
        bgGlass: 'bg-emerald-500/10',
        text: 'text-emerald-100',
        dot: 'bg-emerald-400 shadow-[0_0_0_6px_rgba(16,185,129,0.12)]',
      };
    case 'PENDING':
      return {
        border: 'border-sky-500/20',
        bgSolid: 'bg-sky-500/20',
        bgSoft: 'bg-sky-500/10',
        bgGlass: 'bg-sky-500/10',
        text: 'text-sky-100',
        dot: 'bg-sky-400 shadow-[0_0_0_6px_rgba(56,189,248,0.12)]',
      };
    case 'WATCH':
      return {
        border: 'border-amber-500/20',
        bgSolid: 'bg-amber-500/20',
        bgSoft: 'bg-amber-500/10',
        bgGlass: 'bg-amber-500/10',
        text: 'text-amber-100',
        dot: 'bg-amber-400 shadow-[0_0_0_6px_rgba(245,158,11,0.12)]',
      };
    case 'EXPIRED':
      return {
        border: 'border-zinc-400/20',
        bgSolid: 'bg-zinc-400/15',
        bgSoft: 'bg-zinc-400/10',
        bgGlass: 'bg-white/5',
        text: 'text-zinc-100',
        dot: 'bg-zinc-300 shadow-[0_0_0_6px_rgba(161,161,170,0.10)]',
      };
    case 'INVALID':
    default:
      return {
        border: 'border-rose-500/20',
        bgSolid: 'bg-rose-500/20',
        bgSoft: 'bg-rose-500/10',
        bgGlass: 'bg-rose-500/10',
        text: 'text-rose-100',
        dot: 'bg-rose-400 shadow-[0_0_0_6px_rgba(244,63,94,0.12)]',
      };
  }
}

function zoneColor(z: ZoneType) {
  const map: Record<ZoneType, string> = {
    DEMAND: '#1D9E75',
    SUPPLY: '#E24B4A',
    FLIPPY_D: '#378ADD',
    FLIPPY_S: '#E85D1A',
    HIDDEN_D: '#2AD4A5',
    HIDDEN_S: '#FF6B6A',
  };
  return map[z] ?? 'rgba(255,255,255,0.25)';
}

function prettyZone(z: ZoneType) {
  switch (z) {
    case 'DEMAND': return 'Demand';
    case 'SUPPLY': return 'Supply';
    case 'FLIPPY_D': return 'Flippy D';
    case 'FLIPPY_S': return 'Flippy S';
    case 'HIDDEN_D': return 'Hidden D';
    case 'HIDDEN_S': return 'Hidden S';
    default: return z;
  }
}

function prettyPA(p: PAPattern) {
  if (p === 'THREE_DRIVES') return '3 Drives';
  if (p === 'PATTERN_69') return 'Pattern 69';
  if (p === 'HIDDEN_SDE') return 'Hidden SDE';
  return p;
}

function chipCls(variant: SetupBadgeVariant) {
  if (variant === 'solid') return 'border-white/15 bg-black/20 text-white/85';
  if (variant === 'soft') return 'border-white/10 bg-black/20 text-white/80';
  return 'border-white/10 bg-black/25 text-white/80';
}