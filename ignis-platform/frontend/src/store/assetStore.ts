/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

/* ──────────────────────────────────────────────────────────────
   Types (alignés avec backend + useAssets.ts)
────────────────────────────────────────────────────────────── */

export type SetupStatus = 'VALID' | 'PENDING' | 'INVALID' | 'WATCH' | 'EXPIRED';
export type ZoneType    = 'DEMAND' | 'SUPPLY' | 'FLIPPY_D' | 'FLIPPY_S' | 'HIDDEN_D' | 'HIDDEN_S';
export type PAPattern   = 'ACCU' | 'THREE_DRIVES' | 'FTL' | 'PATTERN_69' | 'HIDDEN_SDE' | 'NONE';
export type AssetClass  = 'CRYPTO' | 'STOCK' | 'FOREX' | 'COMMODITY' | 'INDEX' | 'ETF' | 'OTHER' | string;

export interface AssetSetupMini {
  status:       SetupStatus;
  score:        number;
  zone_type?:   ZoneType;
  pa_pattern?:  PAPattern;
  rr?:          number;
}

export interface AssetResponse {
  symbol:           string;
  asset_class:      string;
  name:             string;
  exchange:         string;
  active:           boolean;
  last_price?:      number;
  last_analysis_at?: string;
  setup?:           AssetSetupMini;
  meta?:            any;
  created_at:       string;
  updated_at:       string;
}

export interface AssetStatsResponse {
  total:         number;
  active:        number;
  by_class:      Record<string, number>;
  with_analysis: number;
  valid_setups:  number;
  pending_setups: number;
}

export interface AssetCreatePayload {
  symbol:      string;
  asset_class?: AssetClass;
  name?:       string;
  exchange?:   string;
  active?:     boolean;
}

export interface AssetPatchPayload {
  name?:     string;
  exchange?: string;
  active?:   boolean;
  meta?:     any;
}

export interface AssetFilters {
  asset_class?: AssetClass | 'ALL';
  active?:      boolean | 'ALL';
  q?:           string;
}

/* ──────────────────────────────────────────────────────────────
   State
────────────────────────────────────────────────────────────── */

interface AssetStore {
  // Data
  assets:     AssetResponse[];
  stats:      AssetStatsResponse | null;
  total:      number;

  // UI state
  filters:    AssetFilters;
  page:       number;
  pageSize:   number;

  // Loading
  loading:    boolean;
  loadingStats: boolean;
  error:      string | null;

  // Optimistic selected asset
  selected:   AssetResponse | null;

  // Actions — setters
  setAssets:  (assets: AssetResponse[], total?: number) => void;
  setStats:   (stats: AssetStatsResponse) => void;
  setFilters: (filters: Partial<AssetFilters>) => void;
  setPage:    (page: number) => void;
  setLoading: (v: boolean) => void;
  setLoadingStats: (v: boolean) => void;
  setError:   (err: string | null) => void;
  setSelected: (asset: AssetResponse | null) => void;

  // Actions — data mutations (optimistic)
  upsertAsset: (asset: AssetResponse) => void;
  removeAsset: (symbol: string) => void;
  patchAsset:  (symbol: string, patch: Partial<AssetResponse>) => void;

  // Live price update (from WebSocket)
  updatePrice: (symbol: string, price: number) => void;

  // Reset
  reset: () => void;
}

/* ──────────────────────────────────────────────────────────────
   Defaults
────────────────────────────────────────────────────────────── */

const DEFAULT_FILTERS: AssetFilters = {
  asset_class: 'ALL',
  active: true,
  q: '',
};

/* ──────────────────────────────────────────────────────────────
   Store
────────────────────────────────────────────────────────────── */

export const useAssetStore = create<AssetStore>()(
  subscribeWithSelector((set, get) => ({
    // Data
    assets:   [],
    stats:    null,
    total:    0,

    // UI
    filters:  { ...DEFAULT_FILTERS },
    page:     1,
    pageSize: 60,

    // Loading
    loading:      false,
    loadingStats: false,
    error:        null,

    selected: null,

    /* ── Setters ────────────────────────────────────────────── */

    setAssets: (assets, total) =>
      set({ assets, total: total ?? assets.length }),

    setStats: (stats) =>
      set({ stats }),

    setFilters: (filters) =>
      set((s) => ({ filters: { ...s.filters, ...filters }, page: 1 })),

    setPage: (page) =>
      set({ page }),

    setLoading: (v) =>
      set({ loading: v }),

    setLoadingStats: (v) =>
      set({ loadingStats: v }),

    setError: (err) =>
      set({ error: err }),

    setSelected: (asset) =>
      set({ selected: asset }),

    /* ── Data mutations ─────────────────────────────────────── */

    upsertAsset: (asset) =>
      set((s) => {
        const idx = s.assets.findIndex((a) => a.symbol === asset.symbol);
        if (idx === -1) {
          return { assets: [asset, ...s.assets], total: s.total + 1 };
        }
        const next = [...s.assets];
        next[idx] = asset;
        return { assets: next };
      }),

    removeAsset: (symbol) =>
      set((s) => ({
        assets: s.assets.filter((a) => a.symbol !== symbol),
        total:  Math.max(0, s.total - 1),
        selected: s.selected?.symbol === symbol ? null : s.selected,
      })),

    patchAsset: (symbol, patch) =>
      set((s) => {
        const idx = s.assets.findIndex((a) => a.symbol === symbol);
        if (idx === -1) return {};
        const next = [...s.assets];
        next[idx] = { ...next[idx], ...patch };
        return {
          assets: next,
          selected:
            s.selected?.symbol === symbol
              ? { ...s.selected, ...patch }
              : s.selected,
        };
      }),

    /* ── Live price update (WS) ─────────────────────────────── */

    updatePrice: (symbol, price) =>
      set((s) => {
        const idx = s.assets.findIndex((a) => a.symbol === symbol);
        if (idx === -1) return {};
        const next = [...s.assets];
        next[idx] = { ...next[idx], last_price: price };
        return {
          assets: next,
          selected:
            s.selected?.symbol === symbol
              ? { ...s.selected, last_price: price }
              : s.selected,
        };
      }),

    /* ── Reset ──────────────────────────────────────────────── */

    reset: () =>
      set({
        assets:       [],
        stats:        null,
        total:        0,
        filters:      { ...DEFAULT_FILTERS },
        page:         1,
        loading:      false,
        loadingStats: false,
        error:        null,
        selected:     null,
      }),
  }))
);

/* ──────────────────────────────────────────────────────────────
   Selectors (stable refs — évite re-renders inutiles)
────────────────────────────────────────────────────────────── */

export const selectAssets       = (s: AssetStore) => s.assets;
export const selectStats        = (s: AssetStore) => s.stats;
export const selectAssetFilters = (s: AssetStore) => s.filters;
export const selectAssetLoading = (s: AssetStore) => s.loading;
export const selectAssetError   = (s: AssetStore) => s.error;
export const selectSelected     = (s: AssetStore) => s.selected;