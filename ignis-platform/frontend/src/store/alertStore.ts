/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

/* ──────────────────────────────────────────────────────────────
   Types
────────────────────────────────────────────────────────────── */

export type AlertsMode = 'http' | 'ws' | 'hybrid';
export type AlertsWsStatus = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED';

export type AlertPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | string;

export type AlertResponse = {
  id: string;
  alert_type: string;
  priority: AlertPriority;

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
  priority?: AlertPriority;
  payload?: any;
  channels?: string[];
};

export type TestAlertPayload = {
  channel?: 'WEBSOCKET' | 'TELEGRAM' | string;
  symbol?: string;
  message?: string;
};

export type AlertsCounts = {
  total: number;
  filtered: number;
  byPriority: Record<string, number>;
  byType: Record<string, number>;
  bySymbol: Record<string, number>;
};

export type AlertStoreState = {
  /* config */
  apiBase: string;
  wsUrl: string;
  mode: AlertsMode;

  /* data */
  alerts: AlertEvent[];
  filtered: AlertEvent[];
  counts: AlertsCounts;

  /* ui */
  loading: boolean;
  error: string | null;

  paused: boolean;
  limit: number;

  /* ws state */
  wsStatus: AlertsWsStatus;
  rooms: Record<string, number>; // room -> refcount
  lastPongAt: number | null;
  latencyMs: number | null;

  /* filters */
  filters: AlertsFilters;

  /* actions */
  init: (cfg: Partial<Pick<AlertStoreState, 'apiBase' | 'wsUrl' | 'mode' | 'limit'>> & { connect?: boolean }) => void;

  setPaused: (v: boolean) => void;
  setLimit: (n: number) => void;

  setFilters: (patch: Partial<AlertsFilters>) => void;
  clearFilters: () => void;

  /** HTTP */
  loadRecent: (opts?: { limit?: number; offset?: number; serverFilter?: boolean }) => Promise<void>;

  /** WS */
  connectWs: () => void;
  disconnectWs: () => void;

  subscribeRoom: (room: string) => void;
  unsubscribeRoom: (room: string) => void;

  /** Ingestion */
  pushAlert: (a: AlertEvent) => void;
  setAlerts: (list: AlertEvent[], opts?: { replace?: boolean }) => void;
  clear: () => void;

  /** Backend actions */
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

function safeUpper(s: any) {
  return String(s ?? '').trim().toUpperCase();
}

function safeTrim(s: any) {
  return String(s ?? '').trim();
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function parseAlertListResponse(data: any): AlertEvent[] {
  const list =
    (data?.alerts ?? data?.items ?? data?.results ?? data?.data ?? data) as any;

  if (Array.isArray(list)) return list as AlertEvent[];
  return [];
}

function sortNewestFirst(list: AlertEvent[]) {
  return list.slice().sort((a, b) => {
    const ta = new Date(a.created_at ?? 0).getTime() || 0;
    const tb = new Date(b.created_at ?? 0).getTime() || 0;
    return tb - ta;
  });
}

export function dedupKey(a: AlertEvent) {
  return (
    a.id ??
    `${safeUpper(a.symbol)}|${safeUpper(a.timeframe)}|${safeUpper(a.alert_type)}|${safeUpper(a.priority)}|${a.created_at ?? ''}|${a.title ?? ''}`
  );
}

function computeFiltered(alerts: AlertEvent[], filters: AlertsFilters): AlertEvent[] {
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
}

function computeCounts(alerts: AlertEvent[], filtered: AlertEvent[]): AlertsCounts {
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
}

/* ──────────────────────────────────────────────────────────────
   Store (with internal WS connection)
────────────────────────────────────────────────────────────── */

export const useAlertStore = create<AlertStoreState>()(
  subscribeWithSelector((set, get) => {
    // internal non-react state (dedupe set, ws instance, timers)
    let ws: WebSocket | null = null;
    let reconnectAttempt = 0;
    let reconnectTimer: any = null;

    let pingTimer: any = null;
    let lastPingAt: number | null = null;

    const seen = new Set<string>();

    const clearReconnect = () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
    };

    const stopPing = () => {
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = null;
      lastPingAt = null;
    };

    const startPing = () => {
      stopPing();
      // keep it modest
      pingTimer = setInterval(() => {
        const st = get();
        if (st.wsStatus !== 'CONNECTED') return;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;

        lastPingAt = Date.now();
        try {
          ws.send(JSON.stringify({ type: 'ping' }));
        } catch {
          // ignore
        }
      }, 15_000);
    };

    const setDerived = (alerts: AlertEvent[], filters: AlertsFilters) => {
      const filtered = computeFiltered(alerts, filters);
      const counts = computeCounts(alerts, filtered);
      set({ filtered, counts });
    };

    const scheduleReconnect = () => {
      clearReconnect();

      const st = get();
      // only reconnect if we still have room subscriptions and mode allows ws
      const anyRooms = Object.keys(st.rooms ?? {}).some((r) => (st.rooms[r] ?? 0) > 0);
      if (st.mode === 'http' || !anyRooms) return;

      reconnectAttempt += 1;
      const delay = clamp(2500 + reconnectAttempt * 1200, 2500, 12_000);

      reconnectTimer = setTimeout(() => {
        get().connectWs();
      }, delay);
    };

    const hardCloseWs = () => {
      stopPing();
      clearReconnect();
      reconnectAttempt = 0;

      try {
        ws?.close();
      } catch {
        // ignore
      }
      ws = null;
      set({ wsStatus: 'DISCONNECTED' });
    };

    const connectWsInternal = () => {
      const st = get();
      if (st.mode === 'http') return;

      // already open/connecting
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
      }

      clearReconnect();
      set({ wsStatus: 'CONNECTING', error: null });

      try {
        ws = new WebSocket(st.wsUrl);

        ws.onopen = () => {
          reconnectAttempt = 0;
          set({ wsStatus: 'CONNECTED', error: null });

          // (re)subscribe rooms
          for (const [room, count] of Object.entries(get().rooms ?? {})) {
            if ((count ?? 0) > 0) {
              try {
                ws?.send(JSON.stringify({ type: 'subscribe', room }));
              } catch {
                // ignore
              }
            }
          }

          // start ping loop
          startPing();
        };

        ws.onmessage = (evt) => {
          const raw = String(evt.data ?? '');
          let msg: any = null;

          try {
            msg = JSON.parse(raw);
          } catch {
            return;
          }

          if (msg?.type === 'pong') {
            const now = Date.now();
            const lat = lastPingAt ? Math.max(0, now - lastPingAt) : null;
            set({ lastPongAt: now, latencyMs: lat });
            return;
          }

          if (msg?.type === 'alert' && msg?.data) {
            const state = get();
            if (state.paused) return;

            // ingest
            state.pushAlert(msg.data as AlertEvent);
            return;
          }

          // ignore other types
        };

        ws.onerror = () => {
          set({ error: 'WebSocket error' });
          // close will follow in many cases
        };

        ws.onclose = () => {
          stopPing();
          set({ wsStatus: 'DISCONNECTED' });
          scheduleReconnect();
        };
      } catch (e: any) {
        set({ wsStatus: 'DISCONNECTED', error: e?.message ?? 'WS connect failed' });
        scheduleReconnect();
      }
    };

    return {
      apiBase: API_BASE_DEFAULT,
      wsUrl: WS_URL_DEFAULT,
      mode: 'hybrid',

      alerts: [],
      filtered: [],
      counts: { total: 0, filtered: 0, byPriority: {}, byType: {}, bySymbol: {} },

      loading: false,
      error: null,

      paused: false,
      limit: 50,

      wsStatus: 'DISCONNECTED',
      rooms: {},
      lastPongAt: null,
      latencyMs: null,

      filters: {},

      init: (cfg) => {
        set((prev) => ({
          apiBase: cfg.apiBase ?? prev.apiBase,
          wsUrl: cfg.wsUrl ?? prev.wsUrl,
          mode: cfg.mode ?? prev.mode,
          limit: typeof cfg.limit === 'number' ? cfg.limit : prev.limit,
        }));

        if (cfg.connect) {
          connectWsInternal();
        }
      },

      setPaused: (v) => set({ paused: v }),

      setLimit: (n) => {
        const next = clamp(Math.floor(n), 5, 500);
        set({ limit: next });

        // trim current alerts
        const st = get();
        const trimmed = st.alerts.slice(0, next);
        set({ alerts: trimmed });
        setDerived(trimmed, st.filters);
      },

      setFilters: (patch) => {
        const next = { ...get().filters, ...patch };
        set({ filters: next });
        setDerived(get().alerts, next);
      },

      clearFilters: () => {
        set({ filters: {} });
        setDerived(get().alerts, {});
      },

      loadRecent: async (opts) => {
        const st = get();
        if (st.mode === 'ws') return;

        const limit = opts?.limit ?? st.limit;
        const offset = opts?.offset ?? 0;
        const serverFilter = opts?.serverFilter ?? true;

        set({ loading: true, error: null });
        try {
          const url = new URL(`${st.apiBase}/alerts`);
          url.searchParams.set('limit', String(limit));
          url.searchParams.set('offset', String(offset));

          if (serverFilter) {
            // apply subset of filters server-side (symbol/type/priority)
            if (st.filters.symbol?.trim()) url.searchParams.set('symbol', safeUpper(st.filters.symbol));
            if (st.filters.alertType?.trim()) url.searchParams.set('alert_type', safeUpper(st.filters.alertType));
            if (st.filters.priority?.trim()) url.searchParams.set('priority', safeUpper(st.filters.priority));
          }

          const res = await fetch(url.toString(), { method: 'GET' });
          if (!res.ok) {
            const t = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status} — ${t || 'Erreur /alerts'}`);
          }

          const data = await res.json();
          const list = sortNewestFirst(parseAlertListResponse(data));

          // reset dedupe from list (keep stable)
          seen.clear();
          for (const a of list.slice(0, st.limit)) {
            seen.add(dedupKey(a));
          }

          const trimmed = list.slice(0, st.limit);

          set({ alerts: trimmed });
          setDerived(trimmed, st.filters);
        } catch (e: any) {
          set({ error: e?.message ?? 'Erreur loadRecent' });
        } finally {
          set({ loading: false });
        }
      },

      connectWs: () => connectWsInternal(),

      disconnectWs: () => {
        // hard stop and clear rooms? no, keep rooms (so a later connect resubscribes)
        stopPing();
        clearReconnect();
        try {
          ws?.close();
        } catch {}
        ws = null;
        set({ wsStatus: 'DISCONNECTED' });
      },

      subscribeRoom: (room) => {
        const r = safeTrim(room);
        if (!r) return;

        set((prev) => {
          const nextRooms = { ...(prev.rooms ?? {}) };
          nextRooms[r] = (nextRooms[r] ?? 0) + 1;
          return { rooms: nextRooms };
        });

        // connect if needed
        connectWsInternal();

        // send subscribe if connected and transitioned 0->1
        const count = get().rooms?.[r] ?? 0;
        if (count === 1 && ws && ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ type: 'subscribe', room: r }));
          } catch {}
        }
      },

      unsubscribeRoom: (room) => {
        const r = safeTrim(room);
        if (!r) return;

        const prevCount = get().rooms?.[r] ?? 0;
        const nextCount = Math.max(0, prevCount - 1);

        set((prev) => {
          const nextRooms = { ...(prev.rooms ?? {}) };
          if (nextCount === 0) delete nextRooms[r];
          else nextRooms[r] = nextCount;
          return { rooms: nextRooms };
        });

        // send unsubscribe if connected and transitioned to 0
        if (prevCount > 0 && nextCount === 0 && ws && ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ type: 'unsubscribe', room: r }));
          } catch {}
        }
      },

      pushAlert: (a) => {
        const st = get();
        const key = dedupKey(a);
        if (seen.has(key)) return;

        seen.add(key);

        // newest-first insert
        const merged = [a, ...st.alerts];
        const out: AlertEvent[] = [];

        // enforce dedupe + limit (keep order)
        const seenLocal = new Set<string>();
        for (const x of merged) {
          const k = dedupKey(x);
          if (seenLocal.has(k)) continue;
          seenLocal.add(k);
          out.push(x);
          if (out.length >= st.limit) break;
        }

        set({ alerts: out });
        setDerived(out, st.filters);
      },

      setAlerts: (list, opts) => {
        const st = get();
        const replace = opts?.replace ?? true;

        const normalized = sortNewestFirst(list ?? []);
        const merged = replace ? normalized : [...normalized, ...st.alerts];

        // dedupe + limit
        const out: AlertEvent[] = [];
        const seenLocal = new Set<string>();
        for (const x of merged) {
          const k = dedupKey(x);
          if (seenLocal.has(k)) continue;
          seenLocal.add(k);
          out.push(x);
          if (out.length >= st.limit) break;
        }

        // reset global seen to match
        seen.clear();
        for (const x of out) seen.add(dedupKey(x));

        set({ alerts: out });
        setDerived(out, st.filters);
      },

      clear: () => {
        seen.clear();
        set({
          alerts: [],
          filtered: [],
          counts: { total: 0, filtered: 0, byPriority: {}, byType: {}, bySymbol: {} },
          error: null,
        });
      },

      emitAlert: async (payload) => {
        const st = get();
        set({ error: null });

        const body = {
          alert_type: safeTrim(payload.alert_type),
          symbol: safeUpper(payload.symbol),
          timeframe: safeTrim(payload.timeframe),
          title: safeTrim(payload.title),
          message: safeTrim(payload.message),
          priority: payload.priority ?? 'MEDIUM',
          payload: payload.payload ?? {},
          channels: payload.channels ?? [],
        };

        if (!body.alert_type || !body.symbol || !body.timeframe) {
          set({ error: 'emitAlert: alert_type/symbol/timeframe requis.' });
          return;
        }

        const res = await fetch(`${st.apiBase}/alerts/emit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const t = await res.text().catch(() => '');
          set({ error: `HTTP ${res.status} — ${t || 'Erreur /alerts/emit'}` });
          return;
        }
      },

      testAlert: async (payload) => {
        const st = get();
        set({ error: null });

        const body = {
          channel: payload?.channel ?? 'WEBSOCKET',
          symbol: safeUpper(payload?.symbol ?? 'TEST'),
          message: payload?.message ?? undefined,
        };

        const res = await fetch(`${st.apiBase}/alerts/test`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const t = await res.text().catch(() => '');
          set({ error: `HTTP ${res.status} — ${t || 'Erreur /alerts/test'}` });
          return;
        }
      },
    };
  })
);

/* ──────────────────────────────────────────────────────────────
   Selectors (optional usage)
────────────────────────────────────────────────────────────── */

export const selectAlerts = (s: AlertStoreState) => s.filtered;
export const selectAllAlerts = (s: AlertStoreState) => s.alerts;
export const selectAlertsCounts = (s: AlertStoreState) => s.counts;
export const selectAlertsWsStatus = (s: AlertStoreState) => s.wsStatus;
export const selectAlertsLoading = (s: AlertStoreState) => s.loading;
export const selectAlertsError = (s: AlertStoreState) => s.error;

/**
 * Tip d’usage:
 *   const alerts = useAlertStore(selectAlerts);
 *   const wsStatus = useAlertStore(selectAlertsWsStatus);
 *   useEffect(()=>{ useAlertStore.getState().subscribeRoom('alerts'); return ()=>useAlertStore.getState().unsubscribeRoom('alerts'); },[])
 */