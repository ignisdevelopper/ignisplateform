'use client';

import React, { useEffect, useId } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | '2xl';

export default function Modal({
  open,
  onClose,

  title,
  subtitle,

  size = 'lg',

  children,
  footer,

  closeOnBackdrop = true,
  closeOnEsc = true,

  showCloseButton = true,

  className,
}: {
  open: boolean;
  onClose: () => void;

  title?: React.ReactNode;
  subtitle?: React.ReactNode;

  size?: ModalSize;

  children: React.ReactNode;
  footer?: React.ReactNode;

  closeOnBackdrop?: boolean;
  closeOnEsc?: boolean;

  showCloseButton?: boolean;

  className?: string;
}) {
  const titleId = useId();
  const subtitleId = useId();

  // ESC to close
  useEffect(() => {
    if (!open || !closeOnEsc) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, closeOnEsc, onClose]);

  // lock body scroll
  useEffect(() => {
    if (!open) return;

    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          aria-modal="true"
          role="dialog"
          aria-labelledby={title ? titleId : undefined}
          aria-describedby={subtitle ? subtitleId : undefined}
        >
          {/* Backdrop */}
          <motion.div
            className="absolute inset-0 bg-black/65"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => {
              if (!closeOnBackdrop) return;
              onClose();
            }}
          />

          {/* Panel */}
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.985 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className={cn(
              'relative w-full rounded-3xl border border-white/10',
              'bg-[#0A0A0F]/70 backdrop-blur-[22px]',
              'shadow-[0_30px_110px_rgba(0,0,0,0.75)]',
              sizeClass(size),
              className
            )}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            {(title || subtitle || showCloseButton) && (
              <div className="border-b border-white/10 bg-black/20 px-6 py-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    {title && (
                      <div id={titleId} className="text-base font-semibold text-white/90">
                        {title}
                      </div>
                    )}
                    {subtitle && (
                      <div id={subtitleId} className="text-xs text-white/60 mt-1">
                        {subtitle}
                      </div>
                    )}
                  </div>

                  {showCloseButton && (
                    <button
                      type="button"
                      onClick={onClose}
                      className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition"
                      title="Close"
                    >
                      Close
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Content */}
            <div className="px-6 py-5">
              {children}
            </div>

            {/* Footer */}
            {footer && (
              <div className="border-t border-white/10 bg-black/15 px-6 py-5 flex items-center justify-end gap-2">
                {footer}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ──────────────────────────────────────────────────────────────
   Helpers
────────────────────────────────────────────────────────────── */

function cn(...classes: Array<string | undefined | null | false>) {
  return classes.filter(Boolean).join(' ');
}

function sizeClass(size: ModalSize) {
  switch (size) {
    case 'sm':
      return 'max-w-sm';
    case 'md':
      return 'max-w-lg';
    case 'lg':
      return 'max-w-2xl';
    case 'xl':
      return 'max-w-4xl';
    case '2xl':
      return 'max-w-6xl';
    default:
      return 'max-w-2xl';
  }
}