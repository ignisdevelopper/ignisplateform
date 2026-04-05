'use client';

import React, { useMemo } from 'react';

/**
 * ScoreBar
 * - Barre de score 0..100 avec gradient "ignis"
 * - Glass friendly (border + background)
 * - Optionnel: label + value + animation
 *
 * Usage:
 *   <ScoreBar value={analysis.setup.score} />
 *   <ScoreBar value={78} showLabel label="Setup" />
 */

export type ScoreBarVariant = 'glass' | 'soft' | 'solid' | 'minimal';

export default function ScoreBar({
  value,
  max = 100,

  label,
  showLabel = false,
  showValue = true,

  height = 8,

  variant = 'glass',
  animate = true,

  gradient = 'auto',
  color,

  className,
}: {
  value: number;
  max?: number;

  label?: string;
  showLabel?: boolean;
  showValue?: boolean;

  /** px */
  height?: number;

  variant?: ScoreBarVariant;
  animate?: boolean;

  /** auto uses score-based gradient, fixed uses brand gradient */
  gradient?: 'auto' | 'brand' | 'fixed';

  /** override fill color (disables gradient) */
  color?: string;

  className?: string;
}) {
  const v = useMemo(() => clamp(isFiniteNum(value) ? value : 0, 0, max), [value, max]);
  const pct = useMemo(() => (max > 0 ? (v / max) * 100 : 0), [v, max]);

  const fillCls = useMemo(() => {
    if (color) return '';
    if (gradient === 'brand') return 'from-[#E85D1A]/70 via-[#378ADD]/45 to-[#1D9E75]/55';
    if (gradient === 'fixed') return 'from-[#E85D1A]/70 to-[#E85D1A]/25';
    return scoreGradient(v);
  }, [v, gradient, color]);

  const wrapper = useMemo(() => variantClasses(variant), [variant]);

  return (
    <div className={cn('w-full', className)}>
      {(showLabel || showValue) && (
        <div className="mb-1 flex items-center justify-between gap-3">
          <div className="text-[11px] text-white/55">
            {showLabel ? (label ?? 'Score') : ''}
          </div>
          <div className="text-[11px] text-white/70">
            {showValue ? `${Math.round(pct)}%` : ''}
          </div>
        </div>
      )}

      <div
        className={cn(
          'w-full overflow-hidden rounded-full border',
          wrapper.border,
          wrapper.bg
        )}
        style={{ height }}
        aria-label="scorebar"
        title={`${Math.round(pct)}%`}
      >
        <div
          className={cn(
            'h-full rounded-full',
            color ? '' : 'bg-gradient-to-r',
            color ? '' : fillCls
          )}
          style={{
            width: `${pct}%`,
            backgroundColor: color,
            transition: animate ? 'width 420ms cubic-bezier(0.2, 0.9, 0.2, 1)' : undefined,
          }}
        />
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Helpers
────────────────────────────────────────────────────────────── */

function cn(...classes: Array<string | undefined | null | false>) {
  return classes.filter(Boolean).join(' ');
}

function isFiniteNum(n: any): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function scoreGradient(score: number) {
  const s = clamp(score, 0, 100);
  if (s >= 85) return 'from-emerald-400/60 to-emerald-700/10';
  if (s >= 70) return 'from-orange-400/60 to-orange-700/10';
  if (s >= 55) return 'from-amber-400/60 to-amber-700/10';
  return 'from-rose-400/60 to-rose-700/10';
}

function variantClasses(variant: ScoreBarVariant) {
  switch (variant) {
    case 'minimal':
      return {
        border: 'border-transparent',
        bg: 'bg-white/5',
      };
    case 'solid':
      return {
        border: 'border-white/10',
        bg: 'bg-black/35',
      };
    case 'soft':
      return {
        border: 'border-white/10',
        bg: 'bg-black/20',
      };
    case 'glass':
    default:
      return {
        border: 'border-white/10',
        bg: 'bg-white/5',
      };
  }
}