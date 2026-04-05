/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/* ──────────────────────────────────────────────────────────────
   Types
────────────────────────────────────────────────────────────── */

export type AlertChannel = 'WEBSOCKET' | 'TELEGRAM' | string;

export type AlertResponse = {
  id: string;
  alert_type: string;
  priority: string;
  symbol: string;
  timeframe: string;
  title: string;
  message: string;
  emoji?: string;
  payload: any;
  channels: string[];
  status: string;
  created_at: string;
  sent_at?: string;
};

export type AlertEvent = AlertResponse & { timestamp?: string };

export type AlertsMode = 'http' | 'ws' | 'hybrid';

export type AlertsWsStatus = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED';

export type AlertsFilters = {
  q?: string;
  symbol?: string;
  alertType?: string;
  priority?: string;
  channel?: string;
};

export type EmitAlertPayload = {
  alert_type: string;
  symbol: string;
  timeframe: string;
  title: string;
  message: string;
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | string;
  payload?: any;
  channels?: AlertChannel[];
};

export type TestAlertPayload = {
  channel?: AlertChannel;
  symbol?: string;
  message?: string;
};

export type UseAlertsOptions = {
  mode?: AlertsMode;

  apiBase?: string;
  wsUrl?: string;

  /** Keep at most N alerts in memory */
  limit?: number;

  /** Initial fetch limit (defaults to limit) */
  initialFetchLimit?: number;

  /** Auto fetch recent alerts via HTTP */
  autoFetch?: boolean;

  /** Polling interval (ms) for HTTP mode/hybrid. Set 0 to disable. */
  pollMs?: number;

  /** Auto connect websocket (ws/hybrid) */
  autoConnect?: boolean;

  /** Default filters */
  defaultFilters?: AlertsFilters;

  /** Merge strategy: newest-first or oldest-first */
  order?: 'newest_first' | 'oldest_first';

  /** Called when a new WS alert arrives (after dedupe) */
  onNewAlert?: (a: AlertEvent) => void;

  /**
   * Dedupe key builder; default uses a.id else composite.
   * Override if your backend emits duplicates with different ids.
   */
  dedupKey?: (a: AlertEvent) => string;

  /** If true: while paused, WS alerts are ignored (not buffered) */
  dropWhilePaused?: boolean;
};

export type UseAlertsReturn = {
  // raw
  alerts: AlertEvent[];

  // UI state
  loading: boolean;
  error: string | null;

  // ws
  wsStatus: AlertsWsStatus;
  connect: () => void;
  disconnect: () => void;

  // filtering
  filters: AlertsFilters;
  setFilters: (patch: Partial<AlertsFilters>) => void;
  clearFilters: () => void;

  filtered: AlertEvent[];
  counts: {
    total: number;
    filtered: number;
    byPriority: Record<string, number>;
    byType: Record<string, number>;
    bySymbol: Record<string, number>;
  };

  // controls
  paused: boolean;
  setPaused: (v: boolean) => void;

  // actions
  reload: () => Promise<void>;
  clear: () => void;
  push: (a: AlertEvent) => void;

  emitAlert: (payload: EmitAlertPayload) => Promise<void>;
  testAlert: (payload?: TestAlertPayload) => Promise<void>;
};

/* ──────────────────────────────────────────────────────────────
   Defaults
────────────────────────────────────────────────────────────── */

const API_BASE_DEFAULT =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:8000/api/v1';

const WS_URL_DEFAULT =
  process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:8000/ws';

function defaultDedupKey(a: AlertEvent) {
  return (
    a.id ??
    `${a.symbol ?? ''}|${a.timeframe ?? ''}|${a.alert_type ?? ''}|${a.priority ?? ''}|${a.created_at ?? ''}|${a.title ?? ''}`
  );
}

function normalizeListResponse(data: any): AlertEvent[] {
  const list =
    (data?.alerts ?? data?.items ?? data?.results ?? data?.data ?? data) as any;

  if (Array.isArray(list)) return list as AlertEvent[];
  return [];
}

function safeUpper(s: string | undefined | null) {
  return (s ?? '').trim().toUpperCase();
}

/* ──────────────────────────────────────────────────────────────
   Hook
────────────────────────────────────────────────────────────── */

export function usealerts(opts: UseAlertsOptions = {}): UseAlertsReturn {
  const {
    mode = 'hybrid',

    apiBase = API_BASE_DEFAULT,
    wsUrl = WS_URL_DEFAULT,

    limit = 50,
    initialFetchLimit = limit,

    autoFetch = true,
    pollMs = 0,

    autoConnect = true,

    defaultFilters = {},

    order = 'newest_first',

    onNewAlert,

    dedupKey = defaultDedupKey,

    dropWhilePaused = true,
  } = opts;

  const [alerts, setAlerts] = useState<AlertEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [filters, _setFilters] = useState<AlertsFilters>(defaultFilters);

  const [paused, setPaused] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const [wsStatus, setWsStatus] = useState<AlertsWsStatus>('DISCONNECTED');

  const seenRef = useRef<Set<string>>(new Set());
  const aliveRef = useRef<boolean>(true);
  const retryRef = useRef<number>(0);
  const retryTimerRef = useRef<any>(null);

  const clearRetryTimer = () => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
  };

  const setFilters = useCallback((patch: Partial<AlertsFilters>) => {
    _setFilters((prev) => ({ ...prev, ...patch }));
  }, []);

  const clearFilters = useCallback(() => {
    _setFilters({});
  }, []);

  const clear = useCallback(() => {
    seenRef.current = new Set();
    setAlerts([]);
  }, []);

  const push = useCallback(
    (a: AlertEvent) => {
      const key = dedupKey(a);
      if (seenRef.current.has(key)) return;

      seenRef.current.add(key);

      setAlerts((prev) => {
        const merged = order === 'newest_first' ? [a, ...prev] : [...prev, a];

        // dedupe again locally (in case)
        const out: AlertEvent[] = [];
        const seenLocal = new Set<string>();

        for (const x of merged) {
          const k = dedupKey(x);
          if (seenLocal.has(k)) continue;
          seenLocal.add(k);
          out.push(x);
          if (out.length >= limit) break;
        }

        return out;
      });

      onNewAlert?.(a);
    },
    [dedupKey, limit, onNewAlert, order]
  );

  const reload = useCallback(async () => {
    if (!autoFetch) return;
    if (mode === 'ws') return;

    setError(null);
    setLoading(true);

    try {
      const url = new URL(`${apiBase}/alerts`);
      url.searchParams.set('limit', String(initialFetchLimit));
      url.searchParams.set('offset', '0');

      // server-side filters (optional)
      if (filters.symbol?.trim()) url.searchParams.set('symbol', safeUpper(filters.symbol));
      if (filters.alertType?.trim()) url.searchParams.set('alert_type', safeUpper(filters.alertType));
      if (filters.priority?.trim()) url.searchParams.set('priority', safeUpper(filters.priority));

      const res = await fetch(url.toString(), { method: 'GET' });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${t || 'Erreur /alerts'}`);
      }

      const data = await res.json();
      const list = normalizeListResponse(data);

      // Sort newest-first by created_at if possible
      const sorted = list.slice().sort((a, b) => {
        const ta = new Date(a.created_at ?? 0).getTime() || 0;
        const tb = new Date(b.created_at ?? 0).getTime() || 0;
        return order === 'newest_first' ? tb - ta : ta - tb;
      });

      const trimmed = sorted.slice(0, limit);

      // reset seen to match current list
      const newSeen = new Set<string>();
      for (const a of trimmed) newSeen.add(dedupKey(a));
      seenRef.current = newSeen;

      setAlerts(trimmed);
    } catch (e: any) {
      setError(e?.message ?? 'Erreur inconnue');
    } finally {
      setLoading(false);
    }
  }, [
    apiBase,
    autoFetch,
    mode,
    initialFetchLimit,
    limit,
    dedupKey,
    filters.symbol,
    filters.alertType,
    filters.priority,
    order,
  ]);

  const disconnect = useCallback(() => {
    clearRetryTimer();
    retryRef.current = 0;

    try {
      wsRef.current?.close();
    } catch {
      // ignore
    }
    wsRef.current = null;
    setWsStatus('DISCONNECTED');
  }, []);

  const connect = useCallback(() => {
    if (mode === 'http') return;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;

    clearRetryTimer();
    setWsStatus('CONNECTING');

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      retryRef.current = 0;
      setWsStatus('CONNECTED');
      try {
        ws.send(JSON.stringify({ type: 'subscribe', room: 'alerts' }));
        ws.send(JSON.stringify({ type: 'ping' } satisfies WSIn));
      } catch {
        // ignore
      }
    };

    ws.onmessage = (evt) => {
      if (!aliveRef.current) return;

      try {
        const msg = JSON.parse(evt.data) as WSOut;
        if (msg?.type === 'alert' && msg.data) {
          if (paused && dropWhilePaused) return;
          push(msg.data as AlertEvent);
        }
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      if (!aliveRef.current) return;
      setWsStatus('DISCONNECTED');

      // reconnect with backoff (only if autoConnect)
      if (!autoConnect) return;

      const r = retryRef.current + 1;
      retryRef.current = r;
      const delay = Math.min(2500 + r * 1200, 12_000);
      retryTimerRef.current = setTimeout(() => connect(), delay);
    };

    ws.onerror = () => {
      // onclose handles retry
    };
  }, [mode, wsUrl, push, paused, dropWhilePaused, autoConnect]);

  // initial load (HTTP)
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!autoFetch) return;
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // polling
  useEffect(() => {
    if (!autoFetch) return;
    if (mode === 'ws') return;
    if (!pollMs || pollMs < 2000) return;

    const t = setInterval(() => {
      if (paused) return;
      reload();
    }, pollMs);

    return () => clearInterval(t);
  }, [autoFetch, mode, pollMs, paused, reload]);

  // ws connect
  useEffect(() => {
    if (!autoConnect) return;
    if (mode === 'http') return;
    connect();
    return () => {
      // do not disconnect if you want sticky connection even after rerender; but here we cleanup on unmount via disconnect()
    };
  }, [autoConnect, mode, connect]);

  /* ──────────────────────────────────────────────────────────────
     Derived: filtered + counts
  ─────────────────────────────────────────────────────────────── */

  const filtered = useMemo(() => {
    const q = safeUpper(filters.q);
    const sym = safeUpper(filters.symbol);
    const typ = safeUpper(filters.alertType);
    const pri = safeUpper(filters.priority);
    const ch = safeUpper(filters.channel);

    return alerts.filter((a) => {
      if (sym && safeUpper(a.symbol) !== sym) return false;
      if (typ && safeUpper(a.alert_type) !== typ) return false;
      if (pri && safeUpper(a.priority) !== pri) return false;

      if (ch) {
        const channels = (a.channels ?? []).map((c) => safeUpper(c));
        if (!channels.includes(ch)) return false;
      }

      if (q) {
        const hay = `${a.id} ${a.symbol} ${a.timeframe} ${a.alert_type} ${a.priority} ${a.title} ${a.message} ${(a.channels ?? []).join(',')}`.toUpperCase();
        if (!hay.includes(q)) return false;
      }

      return true;
    });
  }, [alerts, filters.q, filters.symbol, filters.alertType, filters.priority, filters.channel]);

  const counts = useMemo(() => {
    const byPriority: Record<string, number> = {};
    const byType: Record<string, number> = {};
    const bySymbol: Record<string, number> = {};

    for (const a of alerts) {
      const p = safeUpper(a.priority) || '—';
      const t = safeUpper(a.alert_type) || '—';
      const s = safeUpper(a.symbol) || '—';

      byPriority[p] = (byPriority[p] ?? 0) + 1;
      byType[t] = (byType[t] ?? 0) + 1;
      bySymbol[s] = (bySymbol[s] ?? 0) + 1;
    }

    return {
      total: alerts.length,
      filtered: filtered.length,
      byPriority,
      byType,
      bySymbol,
    };
  }, [alerts, filtered.length]);

  /* ──────────────────────────────────────────────────────────────
     API actions: emit / test
  ─────────────────────────────────────────────────────────────── */

  const emitAlert = useCallback(
    async (payload: EmitAlertPayload) => {
      setError(null);
      const res = await fetch(`${apiBase}/alerts/emit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...payload,
          symbol: payload.symbol?.toUpperCase(),
          priority: payload.priority ?? 'MEDIUM',
          payload: payload.payload ?? {},
          channels: payload.channels ?? [],
        }),
      });

      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${t || 'Erreur /alerts/emit'}`);
      }
    },
    [apiBase]
  );

  const testAlert = useCallback(
    async (payload: TestAlertPayload = {}) => {
      setError(null);
      const res = await fetch(`${apiBase}/alerts/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: payload.channel ?? 'WEBSOCKET',
          symbol: (payload.symbol ?? 'TEST').toUpperCase(),
          message: payload.message,
        }),
      });

      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${t || 'Erreur /alerts/test'}`);
      }
    },
    [apiBase]
  );

  return {
    alerts,

    loading,
    error,

    wsStatus,
    connect,
    disconnect,

    filters,
    setFilters,
    clearFilters,

    filtered,
    counts,

    paused,
    setPaused,

    reload,
    clear,
    push,

    emitAlert,
    testAlert,
  };
}

/* ──────────────────────────────────────────────────────────────
   WebSocket message types (internal)
────────────────────────────────────────────────────────────── */

type WSIn =
  | { type: 'subscribe'; room: 'alerts' | 'prices' }
  | { type: 'unsubscribe'; room: 'alerts' | 'prices' }
  | { type: 'ping' };

type WSOut =
  | { type: 'alert'; data: AlertEvent }
  | { type: 'pong' }
  | { type: string; data?: any };