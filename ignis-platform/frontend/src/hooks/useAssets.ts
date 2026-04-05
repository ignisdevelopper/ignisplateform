/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/* ──────────────────────────────────────────────────────────────
   Types (alignés avec ton schema)
────────────────────────────────────────────────────────────── */

export type SetupStatus = 'VALID' | 'PENDING' | 'INVALID' | 'WATCH' | 'EXPIRED';
export type ZoneType = 'DEMAND' | 'SUPPLY' | 'FLIPPY_D' | 'FLIPPY_S' | 'HIDDEN_D' | 'HIDDEN_S';
export type PAPattern = 'ACCU' | 'THREE_DRIVES' | 'FTL' | 'PATTERN_69' | 'HIDDEN_SDE' | 'NONE';

export type AssetResponse = {
  symbol: string;
  asset_class: string;
  name: string;
  exchange: string;
  active: boolean;

  last_price?: number;
  last_analysis_at?: string;

  setup?: {
    status: SetupStatus;
    score: number;
    zone_type?: ZoneType;
    pa_pattern?: PAPattern;
    rr?: number;
  };

  meta?: any;

  created_at: string;
  updated_at: string;
};

export type AssetsListResponse = {
  total: number;
  assets: AssetResponse[];
  page?: number;
  page_size?: number;
};

export type AssetStatsResponse = {
  total: number;
  active: number;
  by_class: Record<string, number>;
  with_analysis: number;
  valid_setups: number;
  pending_setups: number;
};

export type AssetClass = 'CRYPTO' | 'STOCK' | 'FOREX' | 'COMMODITY' | 'INDEX' | 'ETF' | 'OTHER' | string;

export type AssetsQuery = {
  asset_class?: AssetClass | 'ALL';
  active?: boolean | 'ALL';
  limit?: number;
  offset?: number;
};

export type CreateAssetPayload = {
  symbol: string;
  asset_class?: AssetClass; // default backend CRYPTO
  name?: string;
  exchange?: string;
  active?: boolean;
};

export type PatchAssetPayload = {
  name?: string;
  exchange?: string;
  active?: boolean;
  meta?: any;
};

export type UseAssetsOptions = {
  apiBase?: string;

  /** initial query */
  initialQuery?: AssetsQuery;

  /** auto fetch on mount */
  auto?: boolean;

  /** polling interval for list refresh (0 = off) */
  pollMs?: number;

  /** optimistic updates */
  optimistic?: boolean;

  /** called after list changes */
  onChange?: (assets: AssetResponse[]) => void;
};

export type UseAssetsReturn = {
  // query state
  query: Required<AssetsQuery>;
  setQuery: (patch: Partial<AssetsQuery>) => void;
  resetQuery: () => void;

  // data state
  assets: AssetResponse[];
  total: number;
  loading: boolean;
  error: string | null;

  stats: AssetStatsResponse | null;
  statsLoading: boolean;
  statsError: string | null;

  // derived
  page: number;
  pageCount: number;

  byStatus: Record<string, number>;
  avgScore: number | null;

  // actions
  reload: () => Promise<void>;
  reloadStats: () => Promise<void>;
  reloadAll: () => Promise<void>;

  getAsset: (symbol: string) => Promise<AssetResponse | null>;

  createAsset: (payload: CreateAssetPayload) => Promise<AssetResponse | null>;
  patchAsset: (symbol: string, payload: PatchAssetPayload) => Promise<AssetResponse | null>;
  deleteAsset: (symbol: string) => Promise<boolean>;

  refreshAsset: (symbol: string, timeframe?: string, force?: boolean) => Promise<boolean>;

  /** local-only convenience */
  upsertLocal: (asset: AssetResponse) => void;
  removeLocal: (symbol: string) => void;
};

/* ──────────────────────────────────────────────────────────────
   Defaults
────────────────────────────────────────────────────────────── */

const API_BASE_DEFAULT =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:8000/api/v1';

function normSymbol(s: string) {
  return (s ?? '').trim().toUpperCase();
}

function safeNum(n: any, fallback: number) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function normalizeQuery(q?: AssetsQuery): Required<AssetsQuery> {
  return {
    asset_class: q?.asset_class ?? 'CRYPTO',
    active: q?.active ?? true,
    limit: safeNum(q?.limit, 50),
    offset: safeNum(q?.offset, 0),
  };
}

/* ──────────────────────────────────────────────────────────────
   Hook
────────────────────────────────────────────────────────────── */

export function useassets(options: UseAssetsOptions = {}): UseAssetsReturn {
  const {
    apiBase = API_BASE_DEFAULT,
    initialQuery,
    auto = true,
    pollMs = 0,
    optimistic = true,
    onChange,
  } = options;

  const initial = useMemo(() => normalizeQuery(initialQuery), [initialQuery]);

  const [query, setQueryState] = useState<Required<AssetsQuery>>(initial);

  const [assets, setAssets] = useState<AssetResponse[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const [stats, setStats] = useState<AssetStatsResponse | null>(null);
  const [statsLoading, setStatsLoading] = useState<boolean>(false);
  const [statsError, setStatsError] = useState<string | null>(null);

  // request cancellation / race guard
  const reqIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const setQuery = useCallback((patch: Partial<AssetsQuery>) => {
    setQueryState((prev) => {
      const next = { ...prev, ...patch };

      // normalize some values
      next.limit = safeNum(next.limit, 50);
      next.offset = Math.max(0, safeNum(next.offset, 0));
      return next;
    });
  }, []);

  const resetQuery = useCallback(() => {
    setQueryState(initial);
  }, [initial]);

  const page = useMemo(() => Math.floor(query.offset / query.limit) + 1, [query.offset, query.limit]);
  const pageCount = useMemo(() => Math.max(1, Math.ceil(total / query.limit)), [total, query.limit]);

  const byStatus = useMemo(() => {
    const out: Record<string, number> = {};
    for (const a of assets) {
      const s = a.setup?.status ?? 'NO_SETUP';
      out[s] = (out[s] ?? 0) + 1;
    }
    return out;
  }, [assets]);

  const avgScore = useMemo(() => {
    const scores = assets.map((a) => a.setup?.score).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
    if (!scores.length) return null;
    return scores.reduce((acc, n) => acc + n, 0) / scores.length;
  }, [assets]);

  const reload = useCallback(async () => {
    setError(null);
    setLoading(true);

    // cancel previous
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const reqId = ++reqIdRef.current;

    try {
      const url = new URL(`${apiBase}/assets`);
      if (query.asset_class && query.asset_class !== 'ALL') url.searchParams.set('asset_class', String(query.asset_class));
      if (query.active !== 'ALL') url.searchParams.set('active', String(query.active));
      url.searchParams.set('limit', String(query.limit));
      url.searchParams.set('offset', String(query.offset));

      const res = await fetch(url.toString(), { method: 'GET', signal: controller.signal });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${t || 'Erreur /assets'}`);
      }

      const data = (await res.json()) as AssetsListResponse;

      if (reqId !== reqIdRef.current) return;

      setAssets(data.assets ?? []);
      setTotal(Number(data.total ?? (data.assets?.length ?? 0)));
      onChange?.(data.assets ?? []);
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      setError(e?.message ?? 'Erreur inconnue');
    } finally {
      if (reqId === reqIdRef.current) setLoading(false);
    }
  }, [apiBase, query.asset_class, query.active, query.limit, query.offset, onChange]);

  const reloadStats = useCallback(async () => {
    setStatsError(null);
    setStatsLoading(true);
    try {
      const res = await fetch(`${apiBase}/assets/stats`, { method: 'GET' });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${t || 'Erreur /assets/stats'}`);
      }
      const data = (await res.json()) as AssetStatsResponse;
      setStats(data);
    } catch (e: any) {
      setStatsError(e?.message ?? 'Erreur stats');
    } finally {
      setStatsLoading(false);
    }
  }, [apiBase]);

  const reloadAll = useCallback(async () => {
    await Promise.all([reload(), reloadStats()]);
  }, [reload, reloadStats]);

  // initial fetch
  useEffect(() => {
    if (!auto) return;
    reload();
    reloadStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // refetch on query changes
  useEffect(() => {
    if (!auto) return;
    reload();
  }, [auto, reload]);

  // polling
  useEffect(() => {
    if (!auto) return;
    if (!pollMs || pollMs < 2000) return;
    const t = setInterval(() => reload(), pollMs);
    return () => clearInterval(t);
  }, [auto, pollMs, reload]);

  /* ──────────────────────────────────────────────────────────────
     CRUD actions
  ─────────────────────────────────────────────────────────────── */

  const getAsset = useCallback(async (symbol: string) => {
    setError(null);
    try {
      const s = normSymbol(symbol);
      const res = await fetch(`${apiBase}/assets/${encodeURIComponent(s)}`, { method: 'GET' });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${t || 'Erreur /assets/{symbol}'}`);
      }
      return (await res.json()) as AssetResponse;
    } catch (e: any) {
      setError(e?.message ?? 'Erreur getAsset');
      return null;
    }
  }, [apiBase]);

  const upsertLocal = useCallback((asset: AssetResponse) => {
    setAssets((prev) => {
      const s = normSymbol(asset.symbol);
      const idx = prev.findIndex((x) => normSymbol(x.symbol) === s);
      if (idx === -1) return [asset, ...prev];
      const next = [...prev];
      next[idx] = asset;
      return next;
    });
  }, []);

  const removeLocal = useCallback((symbol: string) => {
    const s = normSymbol(symbol);
    setAssets((prev) => prev.filter((x) => normSymbol(x.symbol) !== s));
  }, []);

  const createAsset = useCallback(async (payload: CreateAssetPayload) => {
    setError(null);

    const body = {
      symbol: normSymbol(payload.symbol),
      asset_class: payload.asset_class ?? 'CRYPTO',
      name: payload.name ?? undefined,
      exchange: payload.exchange ?? undefined,
      active: payload.active ?? true,
    };

    if (!body.symbol) {
      setError('Symbol requis.');
      return null;
    }

    // optimistic insert
    const optimisticAsset: AssetResponse | null =
      optimistic
        ? ({
            symbol: body.symbol,
            asset_class: body.asset_class,
            name: body.name ?? '',
            exchange: body.exchange ?? '',
            active: body.active ?? true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          } as any)
        : null;

    if (optimisticAsset) {
      upsertLocal(optimisticAsset);
      setTotal((t) => t + 1);
    }

    try {
      const res = await fetch(`${apiBase}/assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${t || 'Erreur create asset'}`);
      }

      const created = (await res.json()) as AssetResponse;

      // reconcile
      upsertLocal(created);
      await reloadStats();

      return created;
    } catch (e: any) {
      setError(e?.message ?? 'Erreur create');
      if (optimisticAsset) {
        // rollback
        removeLocal(optimisticAsset.symbol);
        setTotal((t) => Math.max(0, t - 1));
      }
      return null;
    }
  }, [apiBase, optimistic, upsertLocal, removeLocal, reloadStats]);

  const patchAsset = useCallback(async (symbol: string, payload: PatchAssetPayload) => {
    setError(null);
    const s = normSymbol(symbol);
    if (!s) {
      setError('Symbol invalide.');
      return null;
    }

    // optimistic patch
    let prevSnapshot: AssetResponse | null = null;
    if (optimistic) {
      setAssets((prev) => {
        const idx = prev.findIndex((x) => normSymbol(x.symbol) === s);
        if (idx === -1) return prev;
        prevSnapshot = prev[idx];
        const next = [...prev];
        next[idx] = { ...next[idx], ...payload, updated_at: new Date().toISOString() } as any;
        return next;
      });
    }

    try {
      const res = await fetch(`${apiBase}/assets/${encodeURIComponent(s)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${t || 'Erreur patch asset'}`);
      }

      const updated = (await res.json()) as AssetResponse;

      upsertLocal(updated);
      await reloadStats();

      return updated;
    } catch (e: any) {
      setError(e?.message ?? 'Erreur patch');
      if (optimistic && prevSnapshot) upsertLocal(prevSnapshot);
      return null;
    }
  }, [apiBase, optimistic, upsertLocal, reloadStats]);

  const deleteAsset = useCallback(async (symbol: string) => {
    setError(null);
    const s = normSymbol(symbol);
    if (!s) {
      setError('Symbol invalide.');
      return false;
    }

    // optimistic remove
    let prevSnapshot: AssetResponse | null = null;
    if (optimistic) {
      const found = assets.find((a) => normSymbol(a.symbol) === s) ?? null;
      prevSnapshot = found;
      removeLocal(s);
      setTotal((t) => Math.max(0, t - 1));
    }

    try {
      const res = await fetch(`${apiBase}/assets/${encodeURIComponent(s)}`, { method: 'DELETE' });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${t || 'Erreur delete asset'}`);
      }

      await reloadStats();
      return true;
    } catch (e: any) {
      setError(e?.message ?? 'Erreur delete');
      // rollback
      if (optimistic && prevSnapshot) {
        upsertLocal(prevSnapshot);
        setTotal((t) => t + 1);
      }
      return false;
    }
  }, [apiBase, optimistic, assets, removeLocal, upsertLocal, reloadStats]);

  const refreshAsset = useCallback(async (symbol: string, timeframe = 'H4', force = false) => {
    setError(null);
    const s = normSymbol(symbol);
    if (!s) {
      setError('Symbol invalide.');
      return false;
    }

    try {
      const res = await fetch(`${apiBase}/assets/${encodeURIComponent(s)}/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeframe, force }),
      });

      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${t || 'Erreur refresh asset'}`);
      }

      // refresh list and stats (setup may change)
      await reloadAll();
      return true;
    } catch (e: any) {
      setError(e?.message ?? 'Erreur refresh');
      return false;
    }
  }, [apiBase, reloadAll]);

  return {
    query,
    setQuery,
    resetQuery,

    assets,
    total,
    loading,
    error,

    stats,
    statsLoading,
    statsError,

    page,
    pageCount,

    byStatus,
    avgScore,

    reload,
    reloadStats,
    reloadAll,

    getAsset,

    createAsset,
    patchAsset,
    deleteAsset,

    refreshAsset,

    upsertLocal,
    removeLocal,
  };
}