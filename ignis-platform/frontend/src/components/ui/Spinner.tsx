'use client';

import React, { useMemo } from 'react';

/**
 * Spinner (IGNIS)
 * - Dark glass friendly
 * - Variants: ring | dots
 * - Optional label
 */

export type SpinnerVariant = 'ring' | 'dots';
export type SpinnerTone = 'brand' | 'blue' | 'green' | 'red' | 'zinc' | 'white';

export default function Spinner({
  variant = 'ring',
  tone = 'brand',
  size = 'md',
  label,
  inline = true,
  className,
}: {
  variant?: SpinnerVariant;
  tone?: SpinnerTone;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  label?: string;

  /** inline = inline-flex; otherwise flex (block) */
  inline?: boolean;

  className?: string;
}) {
  const px = useMemo(() => sizePx(size), [size]);
  const border = useMemo(() => borderPx(size), [size]);

  const col = useMemo(() => toneColor(tone), [tone]);
  const muted = useMemo(() => toneMuted(tone), [tone]);

  return (
    <span
      className={[
        inline ? 'inline-flex' : 'flex',
        'items-center gap-3',
        className ?? '',
      ].join(' ')}
      aria-label="spinner"
    >
      {variant === 'ring' ? (
        <span
          className="relative inline-block animate-spin rounded-full"
          style={{
            width: px,
            height: px,
            borderWidth: border,
            borderStyle: 'solid',
            borderColor: muted,
            borderTopColor: col,
            borderRightColor: col,
            boxShadow: `0 0 0 6px ${col.replace('1)', '0.06)')}`,
          }}
        />
      ) : (
        <span className="inline-flex items-center gap-1.5" style={{ height: px }}>
          <Dot size={Math.max(3, Math.round(px * 0.22))} color={col} delay={0} />
          <Dot size={Math.max(3, Math.round(px * 0.22))} color={col} delay={0.12} />
          <Dot size={Math.max(3, Math.round(px * 0.22))} color={col} delay={0.24} />
        </span>
      )}

      {label && (
        <span className="text-sm text-white/70">
          {label}
        </span>
      )}
    </span>
  );
}

/* ──────────────────────────────────────────────────────────────
   Dots animation (no framer)
────────────────────────────────────────────────────────────── */

function Dot({ size, color, delay }: { size: number; color: string; delay: number }) {
  return (
    <span
      className="inline-block rounded-full"
      style={{
        width: size,
        height: size,
        background: color,
        animation: `ignis-bounce 0.9s ease-in-out ${delay}s infinite`,
        boxShadow: `0 0 0 6px ${color.replace('1)', '0.06)')}`,
      }}
    />
  );
}

/* ──────────────────────────────────────────────────────────────
   Helpers
────────────────────────────────────────────────────────────── */

function sizePx(size: 'xs' | 'sm' | 'md' | 'lg' | 'xl') {
  switch (size) {
    case 'xs': return 14;
    case 'sm': return 18;
    case 'md': return 22;
    case 'lg': return 28;
    case 'xl': return 36;
  }
}

function borderPx(size: 'xs' | 'sm' | 'md' | 'lg' | 'xl') {
  switch (size) {
    case 'xs': return 2;
    case 'sm': return 2.5;
    case 'md': return 3;
    case 'lg': return 3.5;
    case 'xl': return 4;
  }
}

function toneColor(t: SpinnerTone) {
  switch (t) {
    case 'brand': return 'rgba(232,93,26,1)';
    case 'blue': return 'rgba(55,138,221,1)';
    case 'green': return 'rgba(29,158,117,1)';
    case 'red': return 'rgba(226,75,74,1)';
    case 'white': return 'rgba(255,255,255,0.95)';
    case 'zinc':
    default:
      return 'rgba(161,161,170,0.95)';
  }
}

function toneMuted(t: SpinnerTone) {
  switch (t) {
    case 'brand': return 'rgba(232,93,26,0.20)';
    case 'blue': return 'rgba(55,138,221,0.20)';
    case 'green': return 'rgba(29,158,117,0.20)';
    case 'red': return 'rgba(226,75,74,0.20)';
    case 'white': return 'rgba(255,255,255,0.18)';
    case 'zinc':
    default:
      return 'rgba(255,255,255,0.12)';
  }
}

/**
 * Add this CSS once (globals.css or ignis-theme.css):
 *
 * @keyframes ignis-bounce {
 *   0%, 100% { transform: translateY(0); opacity: 0.55; }
 *   50% { transform: translateY(-5px); opacity: 1; }
 * }
 */