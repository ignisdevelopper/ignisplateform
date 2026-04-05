'use client';

import React, { useMemo } from 'react';

export type BadgeTone =
  | 'default'
  | 'muted'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger'
  | 'brand'
  | 'blue'
  | 'green'
  | 'orange'
  | 'red'
  | 'zinc';

export type BadgeVariant = 'glass' | 'soft' | 'solid' | 'outline';

export type BadgeSize = 'xs' | 'sm' | 'md';

export default function Badge({
  children,
  tone = 'default',
  variant = 'glass',
  size = 'sm',
  dot,
  icon,
  rightIcon,
  onClick,
  title,
  className,
}: {
  children: React.ReactNode;

  tone?: BadgeTone;
  variant?: BadgeVariant;
  size?: BadgeSize;

  /** small dot color inherits tone unless provided */
  dot?: boolean | { color?: string };

  icon?: React.ReactNode;
  rightIcon?: React.ReactNode;

  /** if provided, renders as button */
  onClick?: () => void;

  title?: string;
  className?: string;
}) {
  const pal = useMemo(() => palette(tone), [tone]);

  const pad =
    size === 'xs'
      ? 'px-2 py-0.5 text-[10px]'
      : size === 'md'
        ? 'px-3 py-1.5 text-xs'
        : 'px-2.5 py-1 text-[11px]';

  const base =
    'inline-flex items-center gap-2 rounded-full border font-medium tracking-wide whitespace-nowrap';

  const variantCls =
    variant === 'solid'
      ? `${pal.border} ${pal.bgSolid} ${pal.textStrong}`
      : variant === 'soft'
        ? `${pal.borderSoft} ${pal.bgSoft} ${pal.text}`
        : variant === 'outline'
          ? `${pal.borderSoft} bg-transparent ${pal.text}`
          : `${pal.borderSoft} ${pal.bgGlass} ${pal.text} backdrop-blur-[14px]`;

  const clickable = !!onClick;
  const Root: any = clickable ? 'button' : 'span';

  const dotColor =
    typeof dot === 'object' && dot?.color
      ? dot.color
      : pal.dot;

  return (
    <Root
      type={clickable ? 'button' : undefined}
      onClick={onClick}
      title={title}
      className={cn(
        base,
        pad,
        variantCls,
        clickable && 'cursor-pointer hover:bg-white/10 transition',
        className
      )}
      style={
        variant === 'glass'
          ? { boxShadow: `0 0 0 1px ${pal.ring} inset` }
          : undefined
      }
    >
      {icon && <span className="text-white/85">{icon}</span>}

      {dot ? (
        <span
          className="h-2 w-2 rounded-full"
          style={{
            backgroundColor: dotColor,
            boxShadow: `0 0 0 6px ${pal.dotRing}`,
          }}
          aria-hidden
        />
      ) : null}

      <span>{children}</span>

      {rightIcon && <span className="text-white/75">{rightIcon}</span>}
    </Root>
  );
}

/* ──────────────────────────────────────────────────────────────
   Helpers
────────────────────────────────────────────────────────────── */

function cn(...classes: Array<string | undefined | null | false>) {
  return classes.filter(Boolean).join(' ');
}

function palette(tone: BadgeTone) {
  // returns CSS classes + raw colors for dot
  switch (tone) {
    case 'success':
    case 'green':
      return {
        border: 'border-emerald-500/25',
        borderSoft: 'border-emerald-500/20',
        bgSolid: 'bg-emerald-500/20',
        bgSoft: 'bg-emerald-500/10',
        bgGlass: 'bg-emerald-500/10',
        textStrong: 'text-emerald-50',
        text: 'text-emerald-100',
        dot: '#34D399',
        dotRing: 'rgba(16,185,129,0.10)',
        ring: 'rgba(16,185,129,0.16)',
      };

    case 'danger':
    case 'red':
      return {
        border: 'border-rose-500/25',
        borderSoft: 'border-rose-500/20',
        bgSolid: 'bg-rose-500/20',
        bgSoft: 'bg-rose-500/10',
        bgGlass: 'bg-rose-500/10',
        textStrong: 'text-rose-50',
        text: 'text-rose-100',
        dot: '#FB7185',
        dotRing: 'rgba(244,63,94,0.10)',
        ring: 'rgba(244,63,94,0.16)',
      };

    case 'warning':
    case 'orange':
      return {
        border: 'border-orange-500/25',
        borderSoft: 'border-orange-500/20',
        bgSolid: 'bg-orange-500/20',
        bgSoft: 'bg-orange-500/10',
        bgGlass: 'bg-orange-500/10',
        textStrong: 'text-orange-50',
        text: 'text-orange-100',
        dot: '#FB923C',
        dotRing: 'rgba(249,115,22,0.10)',
        ring: 'rgba(249,115,22,0.16)',
      };

    case 'info':
    case 'blue':
      return {
        border: 'border-sky-500/25',
        borderSoft: 'border-sky-500/20',
        bgSolid: 'bg-sky-500/20',
        bgSoft: 'bg-sky-500/10',
        bgGlass: 'bg-sky-500/10',
        textStrong: 'text-sky-50',
        text: 'text-sky-100',
        dot: '#38BDF8',
        dotRing: 'rgba(56,189,248,0.10)',
        ring: 'rgba(56,189,248,0.16)',
      };

    case 'brand':
      return {
        border: 'border-[#E85D1A]/25',
        borderSoft: 'border-[#E85D1A]/20',
        bgSolid: 'bg-[#E85D1A]/20',
        bgSoft: 'bg-[#E85D1A]/10',
        bgGlass: 'bg-[#E85D1A]/10',
        textStrong: 'text-orange-50',
        text: 'text-orange-100',
        dot: '#E85D1A',
        dotRing: 'rgba(232,93,26,0.10)',
        ring: 'rgba(232,93,26,0.16)',
      };

    case 'zinc':
    case 'muted':
      return {
        border: 'border-white/15',
        borderSoft: 'border-white/10',
        bgSolid: 'bg-white/10',
        bgSoft: 'bg-white/5',
        bgGlass: 'bg-white/5',
        textStrong: 'text-white/90',
        text: 'text-white/75',
        dot: '#A1A1AA',
        dotRing: 'rgba(161,161,170,0.10)',
        ring: 'rgba(255,255,255,0.08)',
      };

    case 'default':
    default:
      return {
        border: 'border-white/15',
        borderSoft: 'border-white/10',
        bgSolid: 'bg-white/10',
        bgSoft: 'bg-white/5',
        bgGlass: 'bg-white/5',
        textStrong: 'text-white/90',
        text: 'text-white/80',
        dot: '#E5E7EB',
        dotRing: 'rgba(255,255,255,0.08)',
        ring: 'rgba(255,255,255,0.08)',
      };
  }
}