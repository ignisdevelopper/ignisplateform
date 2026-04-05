'use client';

import React from 'react';
import { motion } from 'framer-motion';

/**
 * IgnisTypingIndicator
 * - Indicateur "typing" style glass / liquid
 * - Utilisable dans chat IA (streaming) ou notifications
 *
 * Props:
 * - active: affiche/masque
 * - label: texte optionnel
 * - variant: ai | ws | system (couleur)
 * - size: sm | md | lg
 */

export type IgnisTypingVariant = 'ai' | 'ws' | 'system' | 'neutral';

export default function IgnisTypingIndicator({
  active = true,
  label = 'IGNIS is typing…',
  variant = 'ai',
  size = 'md',
  className,
}: {
  active?: boolean;
  label?: string;
  variant?: IgnisTypingVariant;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  if (!active) return null;

  const pal = palette(variant);

  const pad =
    size === 'sm'
      ? 'px-3 py-2 text-xs'
      : size === 'lg'
        ? 'px-4 py-3 text-sm'
        : 'px-3.5 py-2.5 text-sm';

  const dotSize =
    size === 'sm' ? 5 : size === 'lg' ? 7 : 6;

  return (
    <div
      className={[
        'inline-flex items-center gap-3 rounded-2xl border backdrop-blur-[18px]',
        'shadow-[0_18px_60px_rgba(0,0,0,0.45)]',
        pad,
        pal.border,
        pal.bg,
        pal.text,
        className ?? '',
      ].join(' ')}
      style={{ boxShadow: `0 0 0 1px ${pal.ring} inset` }}
      aria-label="typing-indicator"
    >
      <span className="relative inline-flex items-center gap-1.5">
        <Dot i={0} size={dotSize} color={pal.dot} />
        <Dot i={1} size={dotSize} color={pal.dot} />
        <Dot i={2} size={dotSize} color={pal.dot} />
      </span>

      <span className="font-medium">{label}</span>

      <span
        className="ml-1 h-2.5 w-2.5 rounded-full"
        style={{ backgroundColor: pal.accent }}
        aria-hidden
      />
    </div>
  );
}

function Dot({ i, size, color }: { i: number; size: number; color: string }) {
  return (
    <motion.span
      className="inline-block rounded-full"
      style={{
        width: size,
        height: size,
        backgroundColor: color,
        boxShadow: '0 0 0 6px rgba(255,255,255,0.04)',
      }}
      animate={{
        y: [0, -6, 0],
        opacity: [0.55, 1, 0.55],
      }}
      transition={{
        duration: 0.85,
        repeat: Infinity,
        delay: i * 0.12,
        ease: 'easeInOut',
      }}
    />
  );
}

function palette(variant: IgnisTypingVariant) {
  switch (variant) {
    case 'ai':
      return {
        border: 'border-[#378ADD]/20',
        bg: 'bg-[#378ADD]/10',
        text: 'text-sky-100',
        ring: 'rgba(55,138,221,0.18)',
        dot: 'rgba(255,255,255,0.88)',
        accent: '#378ADD',
      };
    case 'ws':
      return {
        border: 'border-emerald-500/20',
        bg: 'bg-emerald-500/10',
        text: 'text-emerald-100',
        ring: 'rgba(16,185,129,0.18)',
        dot: 'rgba(255,255,255,0.88)',
        accent: '#1D9E75',
      };
    case 'system':
      return {
        border: 'border-[#E85D1A]/20',
        bg: 'bg-[#E85D1A]/10',
        text: 'text-orange-100',
        ring: 'rgba(232,93,26,0.18)',
        dot: 'rgba(255,255,255,0.90)',
        accent: '#E85D1A',
      };
    case 'neutral':
    default:
      return {
        border: 'border-white/10',
        bg: 'bg-white/5',
        text: 'text-white/80',
        ring: 'rgba(255,255,255,0.08)',
        dot: 'rgba(255,255,255,0.85)',
        accent: '#A1A1AA',
      };
  }
}