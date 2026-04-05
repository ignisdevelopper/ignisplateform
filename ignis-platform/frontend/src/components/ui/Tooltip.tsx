'use client';

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

/**
 * Tooltip (toolti.tsx)
 * - Glass tooltip (dark-only)
 * - Placement: top | bottom | left | right
 * - Trigger: hover + focus
 * - Smart positioning: clamps to viewport
 * - Optional: delay, disabled, maxWidth
 *
 * Usage:
 *  <Tooltip content="Clear cache">
 *    <button>Clear</button>
 *  </Tooltip>
 */

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

export default function Tooltip({
  children,
  content,
  placement = 'top',
  disabled = false,
  delayMs = 250,
  maxWidth = 340,
  offset = 10,
  showArrow = true,
  className,
}: {
  children: React.ReactElement;
  content: React.ReactNode;

  placement?: TooltipPlacement;
  disabled?: boolean;

  delayMs?: number;
  maxWidth?: number;
  offset?: number;

  showArrow?: boolean;

  className?: string;
}) {
  const id = useId();
  const anchorRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  const hasContent = useMemo(() => content !== null && content !== undefined && content !== '', [content]);

  // Delay timer
  const tRef = useRef<any>(null);

  const close = () => {
    if (tRef.current) clearTimeout(tRef.current);
    tRef.current = null;
    setOpen(false);
  };

  const openWithDelay = () => {
    if (disabled || !hasContent) return;
    if (tRef.current) clearTimeout(tRef.current);
    tRef.current = setTimeout(() => setOpen(true), delayMs);
  };

  const computePosition = () => {
    const el = anchorRef.current;
    const tip = tipRef.current;
    if (!el || !tip) return;

    const r = el.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let x = 0;
    let y = 0;

    if (placement === 'top') {
      x = r.left + r.width / 2 - tr.width / 2;
      y = r.top - tr.height - offset;
    } else if (placement === 'bottom') {
      x = r.left + r.width / 2 - tr.width / 2;
      y = r.bottom + offset;
    } else if (placement === 'left') {
      x = r.left - tr.width - offset;
      y = r.top + r.height / 2 - tr.height / 2;
    } else {
      x = r.right + offset;
      y = r.top + r.height / 2 - tr.height / 2;
    }

    // clamp to viewport with padding
    const pad = 8;
    x = Math.max(pad, Math.min(vw - tr.width - pad, x));
    y = Math.max(pad, Math.min(vh - tr.height - pad, y));

    setPos({ x, y });
  };

  // Recompute when open
  useEffect(() => {
    if (!open) return;
    computePosition();

    const onScroll = () => computePosition();
    const onResize = () => computePosition();

    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, placement, offset]);

  // Cleanup delay
  useEffect(() => () => {
    if (tRef.current) clearTimeout(tRef.current);
  }, []);

  // Clone child to inject handlers + aria
  const child = useMemo(() => {
    const props: any = {
      ref: (node: HTMLElement | null) => {
        anchorRef.current = node;

        // forward existing ref if any (rare)
        const anyChild: any = children as any;
        const r = anyChild?.ref;
        if (typeof r === 'function') r(node);
        else if (r && typeof r === 'object') r.current = node;
      },
      onMouseEnter: (e: any) => {
        children.props?.onMouseEnter?.(e);
        openWithDelay();
      },
      onMouseLeave: (e: any) => {
        children.props?.onMouseLeave?.(e);
        close();
      },
      onFocus: (e: any) => {
        children.props?.onFocus?.(e);
        setOpen(true);
      },
      onBlur: (e: any) => {
        children.props?.onBlur?.(e);
        close();
      },
      'aria-describedby': open ? id : undefined,
    };

    return React.cloneElement(children, props);
  }, [children, id, open]);

  if (disabled || !hasContent) return child;

  return (
    <>
      {child}

      <AnimatePresence>
        {open && (
          <motion.div
            ref={tipRef}
            id={id}
            role="tooltip"
            initial={{ opacity: 0, y: placement === 'top' ? -6 : 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: placement === 'top' ? -6 : 6, scale: 0.98 }}
            transition={{ duration: 0.14, ease: 'easeOut' }}
            className={cn(
              'fixed z-[200] rounded-2xl border border-white/10',
              'bg-black/60 text-white/85 backdrop-blur-[18px]',
              'shadow-[0_20px_70px_rgba(0,0,0,0.65)]',
              className
            )}
            style={{
              left: pos?.x ?? -9999,
              top: pos?.y ?? -9999,
              maxWidth,
              pointerEvents: 'none',
              padding: '10px 12px',
            }}
            onAnimationComplete={() => {
              // after first paint, compute again (ensures proper rect with content)
              computePosition();
            }}
          >
            <div className="text-xs leading-relaxed whitespace-pre-wrap">
              {content}
            </div>

            {showArrow && <Arrow placement={placement} />}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

/* ──────────────────────────────────────────────────────────────
   Arrow
────────────────────────────────────────────────────────────── */

function Arrow({ placement }: { placement: TooltipPlacement }) {
  // Arrow uses CSS borders (simple and fast)
  const base = 'absolute h-0 w-0 border-[7px] border-transparent';

  if (placement === 'top') {
    return <div className={cn(base, 'left-1/2 -translate-x-1/2 -bottom-[14px] border-t-black/60')} />;
  }
  if (placement === 'bottom') {
    return <div className={cn(base, 'left-1/2 -translate-x-1/2 -top-[14px] border-b-black/60')} />;
  }
  if (placement === 'left') {
    return <div className={cn(base, '-right-[14px] top-1/2 -translate-y-1/2 border-l-black/60')} />;
  }
  return <div className={cn(base, '-left-[14px] top-1/2 -translate-y-1/2 border-r-black/60')} />;
}

/* ──────────────────────────────────────────────────────────────
   Utils
────────────────────────────────────────────────────────────── */

function cn(...classes: Array<string | undefined | null | false>) {
  return classes.filter(Boolean).join(' ');
}