'use client';

import React from 'react';
import { motion } from 'framer-motion';

export type CardVariant = 'glass' | 'soft' | 'solid' | 'outline';
export type CardRadius = 'xl' | '2xl' | '3xl';

export default function Card({
  children,
  title,
  subtitle,
  right,
  footer,

  variant = 'glass',
  radius = '2xl',
  padding = 'md',
  hover = false,
  interactive = false,

  onClick,
  className,
}: {
  children: React.ReactNode;

  /** Optional header */
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  right?: React.ReactNode;

  /** Optional footer */
  footer?: React.ReactNode;

  variant?: CardVariant;
  radius?: CardRadius;
  padding?: 'none' | 'sm' | 'md' | 'lg';

  /** Adds subtle hover lift */
  hover?: boolean;

  /** Makes the whole card clickable */
  interactive?: boolean;

  onClick?: () => void;
  className?: string;
}) {
  const isClickable = interactive || !!onClick;

  const radiusCls =
    radius === '3xl' ? 'rounded-3xl'
      : radius === 'xl' ? 'rounded-xl'
      : 'rounded-2xl';

  const padCls =
    padding === 'none' ? 'p-0'
      : padding === 'sm' ? 'p-3'
      : padding === 'lg' ? 'p-6'
      : 'p-5';

  const base = [
    radiusCls,
    'border',
    variantBorder(variant),
    variantBg(variant),
    variantText(variant),
    variant === 'glass' ? 'backdrop-blur-[20px]' : '',
    'shadow-[0_25px_80px_rgba(0,0,0,0.55)]',
    isClickable ? 'cursor-pointer' : '',
    isClickable ? 'transition' : '',
    hover ? 'hover:shadow-[0_30px_95px_rgba(0,0,0,0.62)]' : '',
    isClickable ? 'hover:bg-white/10' : '',
  ].filter(Boolean).join(' ');

  const Root: any = hover ? motion.div : 'div';

  const motionProps = hover
    ? {
        whileHover: { y: -2 },
        transition: { duration: 0.16, ease: 'easeOut' },
      }
    : {};

  return (
    <Root
      className={cn(base, className)}
      onClick={isClickable ? onClick : undefined}
      {...motionProps}
    >
      {(title || subtitle || right) && (
        <div className={cn('border-b border-white/10 bg-black/15', padCls)}>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              {title && (
                <div className="text-base font-semibold text-white/90 truncate">
                  {title}
                </div>
              )}
              {subtitle && (
                <div className="text-xs text-white/60 mt-1">
                  {subtitle}
                </div>
              )}
            </div>

            {right && <div className="shrink-0">{right}</div>}
          </div>
        </div>
      )}

      <div className={padCls}>
        {children}
      </div>

      {footer && (
        <div className={cn('border-t border-white/10 bg-black/10', padCls)}>
          {footer}
        </div>
      )}
    </Root>
  );
}

/* ──────────────────────────────────────────────────────────────
   Helpers
────────────────────────────────────────────────────────────── */

function cn(...classes: Array<string | undefined | null | false>) {
  return classes.filter(Boolean).join(' ');
}

function variantBg(variant: CardVariant) {
  switch (variant) {
    case 'solid':
      return 'bg-[#0A0A0F]';
    case 'soft':
      return 'bg-black/20';
    case 'outline':
      return 'bg-transparent';
    case 'glass':
    default:
      return 'bg-white/5';
  }
}

function variantBorder(variant: CardVariant) {
  switch (variant) {
    case 'outline':
      return 'border-white/10';
    case 'solid':
      return 'border-white/10';
    case 'soft':
      return 'border-white/10';
    case 'glass':
    default:
      return 'border-white/10';
  }
}

function variantText(_variant: CardVariant) {
  return 'text-white';
}