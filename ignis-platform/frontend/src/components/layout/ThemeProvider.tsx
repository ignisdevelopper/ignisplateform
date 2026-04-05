'use client';

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

/**
 * ThemeProvider (dark-only)
 * - Pas de light mode, mais un “design system” centralisé via CSS variables
 * - Permet d’ajuster (optionnel) l’accent (orange/blue/green) et le blur (perf)
 * - Expose un hook useIgnisTheme()
 *
 * Usage (dans app/layout.tsx):
 *   import ThemeProvider from '@/components/layout/themeprovider';
 *   ...
 *   <ThemeProvider>{children}</ThemeProvider>
 */

export type IgnisAccent = 'orange' | 'blue' | 'green';

export type IgnisThemeTokens = {
  // Core
  bg: string;
  card: string;
  card2: string;
  border: string;
  text: string;
  muted: string;

  // Brand
  orange: string;
  blue: string;
  green: string;
  red: string;

  // Effects
  blurPx: number;
  radiusPx: number;

  // Selected accent
  accent: IgnisAccent;
  accentColor: string;
};

export type IgnisThemeContextValue = {
  tokens: IgnisThemeTokens;

  accent: IgnisAccent;
  setAccent: (a: IgnisAccent) => void;

  blurEnabled: boolean;
  setBlurEnabled: (v: boolean) => void;

  /** Convenience: re-apply CSS vars (rarely needed) */
  apply: () => void;
};

const STORAGE_KEY = 'ignis_theme_v1';

const DEFAULTS = {
  bg: '#0A0A0F',
  card: 'rgba(255,255,255,0.05)',
  card2: 'rgba(0,0,0,0.25)',
  border: 'rgba(255,255,255,0.10)',
  text: 'rgba(255,255,255,0.92)',
  muted: 'rgba(255,255,255,0.60)',

  orange: '#E85D1A',
  blue: '#378ADD',
  green: '#1D9E75',
  red: '#E24B4A',

  blurPx: 20,
  radiusPx: 18,
} as const;

function accentToColor(accent: IgnisAccent) {
  if (accent === 'blue') return DEFAULTS.blue;
  if (accent === 'green') return DEFAULTS.green;
  return DEFAULTS.orange;
}

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function applyCssVars(tokens: IgnisThemeTokens, blurEnabled: boolean) {
  const root = document.documentElement;

  // enforce dark-only
  root.classList.add('dark');
  root.style.colorScheme = 'dark';

  root.style.setProperty('--ignis-bg', tokens.bg);
  root.style.setProperty('--ignis-card', tokens.card);
  root.style.setProperty('--ignis-card-2', tokens.card2);
  root.style.setProperty('--ignis-border', tokens.border);
  root.style.setProperty('--ignis-text', tokens.text);
  root.style.setProperty('--ignis-muted', tokens.muted);

  root.style.setProperty('--ignis-orange', tokens.orange);
  root.style.setProperty('--ignis-blue', tokens.blue);
  root.style.setProperty('--ignis-green', tokens.green);
  root.style.setProperty('--ignis-red', tokens.red);

  root.style.setProperty('--ignis-accent', tokens.accentColor);

  root.style.setProperty('--ignis-radius', `${tokens.radiusPx}px`);
  root.style.setProperty('--ignis-blur', blurEnabled ? `${tokens.blurPx}px` : '0px');

  // helper flags (optional)
  root.dataset.ignisTheme = 'dark';
  root.dataset.ignisAccent = tokens.accent;
  root.dataset.ignisBlur = blurEnabled ? 'on' : 'off';
}

const IgnisThemeContext = createContext<IgnisThemeContextValue | null>(null);

export default function ThemeProvider({
  children,
  defaultAccent = 'orange',
  defaultBlurEnabled = true,
}: {
  children: React.ReactNode;
  defaultAccent?: IgnisAccent;
  defaultBlurEnabled?: boolean;
}) {
  const persisted = useMemo(() => safeParse<{ accent?: IgnisAccent; blurEnabled?: boolean }>(
    typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
  ), []);

  const [accent, setAccent] = useState<IgnisAccent>(persisted?.accent ?? defaultAccent);
  const [blurEnabled, setBlurEnabled] = useState<boolean>(
    persisted?.blurEnabled ?? defaultBlurEnabled
  );

  const tokens = useMemo<IgnisThemeTokens>(() => {
    const accentColor = accentToColor(accent);

    return {
      bg: DEFAULTS.bg,
      card: DEFAULTS.card,
      card2: DEFAULTS.card2,
      border: DEFAULTS.border,
      text: DEFAULTS.text,
      muted: DEFAULTS.muted,

      orange: DEFAULTS.orange,
      blue: DEFAULTS.blue,
      green: DEFAULTS.green,
      red: DEFAULTS.red,

      blurPx: DEFAULTS.blurPx,
      radiusPx: DEFAULTS.radiusPx,

      accent,
      accentColor,
    };
  }, [accent]);

  const apply = useMemo(() => {
    return () => {
      if (typeof document === 'undefined') return;
      applyCssVars(tokens, blurEnabled);
    };
  }, [tokens, blurEnabled]);

  // Apply on mount + whenever tokens change
  useEffect(() => {
    apply();
  }, [apply]);

  // Persist
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ accent, blurEnabled }));
    } catch {
      // ignore
    }
  }, [accent, blurEnabled]);

  const value = useMemo<IgnisThemeContextValue>(() => {
    return {
      tokens,
      accent,
      setAccent,
      blurEnabled,
      setBlurEnabled,
      apply,
    };
  }, [tokens, accent, blurEnabled, apply]);

  return <IgnisThemeContext.Provider value={value}>{children}</IgnisThemeContext.Provider>;
}

export function useIgnisTheme() {
  const ctx = useContext(IgnisThemeContext);
  if (!ctx) throw new Error('useIgnisTheme must be used within <ThemeProvider>');
  return ctx;
}