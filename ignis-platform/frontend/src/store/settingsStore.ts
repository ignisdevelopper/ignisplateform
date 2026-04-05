/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { create } from 'zustand';
import { subscribeWithSelector, persist } from 'zustand/middleware';

/* ──────────────────────────────────────────────────────────────
   Types
────────────────────────────────────────────────────────────── */

export type Timeframe = 'M1'|'M5'|'M15'|'M30'|'H1'|'H2'|'H4'|'H8'|'D1'|'W1'|'MN1';

export interface TelegramSettings {
  botToken:   string;
  chatIds:    string;   // comma-separated
  enabled:    boolean;
}

export interface OllamaSettings {
  host:        string;
  model:       string;
  temperature: number;
  stream:      boolean;
  language:    'fr' | 'en';
}

export interface AlertSettings {
  minPriority:  'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  pollMs:       number;
  maxHistory:   number;
  wsEnabled:    boolean;
}

export interface AnalysisSettings {
  defaultTimeframe:  Timeframe;
  defaultHigherTf:   Timeframe;
  candleLimit:       number;
  includeAi:         boolean;
  includeLtf:        boolean;
  forceRefresh:      boolean;
}

export interface ScannerSettings {
  defaultTimeframes: Timeframe[];
  minScore:          number;
  candleLimit:       number;
}

export interface UISettings {
  sidebarCollapsed:  boolean;
  chartHeight:       number;
  showMinimap:       boolean;
  animationsEnabled: boolean;
}

/* ──────────────────────────────────────────────────────────────
   State
────────────────────────────────────────────────────────────── */

interface SettingsStore {
  telegram:  TelegramSettings;
  ollama:    OllamaSettings;
  alerts:    AlertSettings;
  analysis:  AnalysisSettings;
  scanner:   ScannerSettings;
  ui:        UISettings;

  // Transient state (non-persisted)
  saved:     boolean;
  saving:    boolean;
  error:     string | null;

  // Actions
  setTelegram:  (patch: Partial<TelegramSettings>) => void;
  setOllama:    (patch: Partial<OllamaSettings>)   => void;
  setAlerts:    (patch: Partial<AlertSettings>)    => void;
  setAnalysis:  (patch: Partial<AnalysisSettings>) => void;
  setScanner:   (patch: Partial<ScannerSettings>)  => void;
  setUI:        (patch: Partial<UISettings>)       => void;

  setSaving:   (v: boolean)       => void;
  setSaved:    (v: boolean)       => void;
  setError:    (err: string|null) => void;

  toggleSidebar: () => void;
  resetAll:      () => void;
}

/* ──────────────────────────────────────────────────────────────
   Defaults
────────────────────────────────────────────────────────────── */

const DEFAULTS = {
  telegram: {
    botToken: '',
    chatIds:  '',
    enabled:  false,
  } satisfies TelegramSettings,

  ollama: {
    host:        'http://localhost:11434',
    model:       'llama3.1',
    temperature: 0.35,
    stream:      true,
    language:    'fr',
  } satisfies OllamaSettings,

  alerts: {
    minPriority: 'MEDIUM',
    pollMs:      30_000,
    maxHistory:  100,
    wsEnabled:   true,
  } satisfies AlertSettings,

  analysis: {
    defaultTimeframe: 'H4',
    defaultHigherTf:  'D1',
    candleLimit:       500,
    includeAi:         false,
    includeLtf:        false,
    forceRefresh:      false,
  } satisfies AnalysisSettings,

  scanner: {
    defaultTimeframes: ['H4', 'D1'] as Timeframe[],
    minScore:           60,
    candleLimit:        300,
  } satisfies ScannerSettings,

  ui: {
    sidebarCollapsed:  false,
    chartHeight:       420,
    showMinimap:       false,
    animationsEnabled: true,
  } satisfies UISettings,
} as const;

/* ──────────────────────────────────────────────────────────────
   Store (persisté dans localStorage)
────────────────────────────────────────────────────────────── */

export const useSettingsStore = create<SettingsStore>()(
  subscribeWithSelector(
    persist(
      (set) => ({
        telegram: { ...DEFAULTS.telegram },
        ollama:   { ...DEFAULTS.ollama   },
        alerts:   { ...DEFAULTS.alerts   },
        analysis: { ...DEFAULTS.analysis },
        scanner:  { ...DEFAULTS.scanner  },
        ui:       { ...DEFAULTS.ui       },

        // Transient (non-persisté via partialize)
        saved:   false,
        saving:  false,
        error:   null,

        /* ── Setters ─────────────────────────────────────────── */

        setTelegram: (patch) =>
          set((s) => ({ telegram: { ...s.telegram, ...patch }, saved: false })),

        setOllama: (patch) =>
          set((s) => ({ ollama: { ...s.ollama, ...patch }, saved: false })),

        setAlerts: (patch) =>
          set((s) => ({ alerts: { ...s.alerts, ...patch }, saved: false })),

        setAnalysis: (patch) =>
          set((s) => ({ analysis: { ...s.analysis, ...patch }, saved: false })),

        setScanner: (patch) =>
          set((s) => ({ scanner: { ...s.scanner, ...patch }, saved: false })),

        setUI: (patch) =>
          set((s) => ({ ui: { ...s.ui, ...patch } })),

        setSaving: (v) => set({ saving: v }),
        setSaved:  (v) => set({ saved: v }),
        setError:  (err) => set({ error: err }),

        toggleSidebar: () =>
          set((s) => ({ ui: { ...s.ui, sidebarCollapsed: !s.ui.sidebarCollapsed } })),

        resetAll: () =>
          set({
            telegram: { ...DEFAULTS.telegram },
            ollama:   { ...DEFAULTS.ollama   },
            alerts:   { ...DEFAULTS.alerts   },
            analysis: { ...DEFAULTS.analysis },
            scanner:  { ...DEFAULTS.scanner  },
            ui:       { ...DEFAULTS.ui       },
            saved:    false,
            saving:   false,
            error:    null,
          }),
      }),
      {
        name: 'ignis-settings-v1',
        // Ne persiste pas les états transients
        partialize: (s) => ({
          telegram: s.telegram,
          ollama:   s.ollama,
          alerts:   s.alerts,
          analysis: s.analysis,
          scanner:  s.scanner,
          ui:       s.ui,
        }),
      }
    )
  )
);

/* ──────────────────────────────────────────────────────────────
   Selectors
────────────────────────────────────────────────────────────── */

export const selectTelegramSettings = (s: SettingsStore) => s.telegram;
export const selectOllamaSettings   = (s: SettingsStore) => s.ollama;
export const selectAlertSettings    = (s: SettingsStore) => s.alerts;
export const selectAnalysisSettings = (s: SettingsStore) => s.analysis;
export const selectScannerSettings  = (s: SettingsStore) => s.scanner;
export const selectUISettings       = (s: SettingsStore) => s.ui;
export const selectSidebarCollapsed = (s: SettingsStore) => s.ui.sidebarCollapsed;