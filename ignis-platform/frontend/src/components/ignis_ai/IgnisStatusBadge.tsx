'use client';

import React, { useMemo } from 'react';

export type IgnisStatusKind =
  | 'WS'
  | 'API'
  | 'OLLAMA'
  | 'TELEGRAM'
  | 'CACHE'
  | 'DB'
  | 'ANALYSIS'
  | 'ALERTS';

export type IgnisStatusState =
  | 'ONLINE'
  | 'OFFLINE'
  | 'CONNECTING'
  | 'DEGRADED'
  | 'UNKNOWN';

export type IgnisStatusBadgeVariant = 'glass' | 'soft' | 'solid';

export default function IgnisStatusBadge({
  kind,
  state,
  label,
  subtitle,

  variant = 'glass',
  size = 'md',

  pulse,
  dot,
  icon,

  className,
  title,
}: {
  kind: IgnisStatusKind;
  state: IgnisStatusState;

  /** optional override label (otherwise uses kind) */
  label?: string;

  /** optional small text on right */
  subtitle?: string;

  variant?: IgnisStatusBadgeVariant;
  size?: 'sm' | 'md' | 'lg';

  /** if true, dot pulses */
  pulse?: boolean;

  /** show dot (default true) */
  dot?: boolean;

  /** custom icon (left) */
  icon?: React.ReactNode;

  className?: string;
  title?: string;
}) {
  const k = label ?? kind;
  const palette = useMemo(() => statePalette(state), [state]);

  const pad =
    size === 'sm'
      ? 'px-2.5 py-1 text-[11px]'
      : size === 'lg'
        ? 'px-3.5 py-2 text-sm'
        : 'px-3 py-1.5 text-xs';

  const bg =
    variant === 'solid'
      ? palette.bgSolid
      : variant === 'soft'
        ? palette.bgSoft
        : palette.bgGlass;

  const border = palette.border;
  const text = palette.text;

  const showDot = dot ?? true;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 rounded-2xl border font-medium',
        pad,
        border,
        bg,
        text,
        variant === 'glass' && 'backdrop-blur-[14px]',
        className
      )}
      title={title ?? `${kind}: ${state}`}
      aria-label={`ignis-status-${kind}-${state}`}
    >
      {icon && <span className="text-white/85">{icon}</span>}

      {showDot && (
        <span className="relative inline-flex">
          <span
            className={cn(
              'h-2.5 w-2.5 rounded-full',
              palette.dot
            )}
          />
          {(pulse ?? (state === 'CONNECTING')) && (
            <span
              className={cn(
                'absolute inset-0 rounded-full',
                palette.pulse
              )}
            />
          )}
        </span>
      )}

      <span className="tracking-wide">{k}</span>

      <span className="text-white/35">·</span>

      <span className="font-semibold">{state}</span>

      {subtitle && (
        <>
          <span className="text-white/20">·</span>
          <span className="text-white/70">{subtitle}</span>
        </>
      )}
    </span>
  );
}

/* ──────────────────────────────────────────────────────────────
   Helpers
────────────────────────────────────────────────────────────── */

function cn(...classes: Array<string | undefined | null | false>) {
  return classes.filter(Boolean).join(' ');
}

function statePalette(state: IgnisStatusState) {
  switch (state) {
    case 'ONLINE':
      return {
        border: 'border-emerald-500/20',
        bgSolid: 'bg-emerald-500/25',
        bgSoft: 'bg-emerald-500/10',
        bgGlass: 'bg-emerald-500/10',
        text: 'text-emerald-100',
        dot: 'bg-emerald-400 shadow-[0_0_0_6px_rgba(16,185,129,0.12)]',
        pulse: 'animate-ping bg-emerald-400/30',
      };
    case 'CONNECTING':
      return {
        border: 'border-sky-500/20',
        bgSolid: 'bg-sky-500/25',
        bgSoft: 'bg-sky-500/10',
        bgGlass: 'bg-sky-500/10',
        text: 'text-sky-100',
        dot: 'bg-sky-400 shadow-[0_0_0_6px_rgba(56,189,248,0.12)]',
        pulse: 'animate-ping bg-sky-400/30',
      };
    case 'DEGRADED':
      return {
        border: 'border-amber-500/20',
        bgSolid: 'bg-amber-500/25',
        bgSoft: 'bg-amber-500/10',
        bgGlass: 'bg-amber-500/10',
        text: 'text-amber-100',
        dot: 'bg-amber-400 shadow-[0_0_0_6px_rgba(245,158,11,0.12)]',
        pulse: 'animate-ping bg-amber-400/30',
      };
    case 'OFFLINE':
      return {
        border: 'border-rose-500/20',
        bgSolid: 'bg-rose-500/25',
        bgSoft: 'bg-rose-500/10',
        bgGlass: 'bg-rose-500/10',
        text: 'text-rose-100',
        dot: 'bg-rose-400 shadow-[0_0_0_6px_rgba(244,63,94,0.12)]',
        pulse: 'animate-ping bg-rose-400/30',
      };
    case 'UNKNOWN':
    default:
      return {
        border: 'border-white/10',
        bgSolid: 'bg-white/10',
        bgSoft: 'bg-white/5',
        bgGlass: 'bg-white/5',
        text: 'text-white/75',
        dot: 'bg-white/35 shadow-[0_0_0_6px_rgba(255,255,255,0.06)]',
        pulse: 'animate-ping bg-white/15',
      };
  }
}