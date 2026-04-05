/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

/* ──────────────────────────────────────────────────────────────
   Types (alignés avec ton schema)
────────────────────────────────────────────────────────────── */

export type Timeframe = 'M1'|'M5'|'M15'|'M30'|'H1'|'H2'|'H4'|'H8'|'D1'|'W1'|'MN1';
export type SetupStatus = 'VALID' | 'PENDING' | 'INVALID' | 'WATCH' | 'EXPIRED';
export type ZoneType = 'DEMAND' | 'SUPPLY' | 'FLIPPY_D' | 'FLIPPY_S' | 'HIDDEN_D' | 'HIDDEN_S';
export type PAPattern = 'ACCU' | 'THREE_DRIVES' | 'FTL' | 'PATTERN_69' | 'HIDDEN_SDE' | 'NONE';
export type SwingType = 'HH' | 'HL' | 'LH' | 'LL';

export type WsStatus = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED';

export interface CandleSchema {
  open_time: number;
  close_time?: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface BaseResult {
  id: string;
  base_type: 'RBR'|'DBD'|'RBD'|'DBR';
  zone_top: number;
  zone_bot: number;
  score: number;
  is_solid: boolean;
  is_weakening: boolean;
  is_hidden: boolean;
  touch_count: number;
  candle_count: number;
  formed_at: number;
  timeframe: string;
  engulfment_ratio: number;
}

export interface SDZoneResult {
  id: string;
  zone_type: ZoneType;
  base: BaseResult;
  zone_top: number;
  zone_bot: number;
  sde_confirmed: boolean;
  sde_score: number;
  sgb_created: boolean;
  sdp_validated: boolean;
  sdp_head?: number;
  ftb_count: number;
  is_ftb_valid: boolean;
  is_flippy: boolean;
  is_failed: boolean;
  formed_at: number;
  timeframe: string;
  score: number;
}

export interface PAResult {
  id?: string;
  pattern: PAPattern;
  score: number;
  formed_at?: number;
  timeframe?: string;
  meta?: Record<string, any>;
}

export interface DPResult {
  id?: string;
  dp_type: 'SDP' | 'SB_LEVEL' | 'TREND_LINE' | 'KEY_LEVEL';
  price: number;
  score: number;
  timeframe?: string;
  formed_at?: number;
  meta?: Record<string, any>;
}

export interface KeyLevelResult {
  id?: string;
  price: number;
  kind?: string;
  score?: number;
  timeframe?: string;
  formed_at?: number;
  meta?: Record<string, any>;
}

export interface AnalysisResponse {
  symbol: string;
  timeframe: string;
  higher_tf?: string;

  analyzed_at: string;
  candles_used: number;
  duration_ms: number;
  from_cache: boolean;

  market_structure: {
    phase: string;
    trend: string;
    swing_points: { timestamp: number; price: number; swing_type: SwingType; index: number }[];
    last_hh?: number;
    last_hl?: number;
    last_lh?: number;
    last_ll?: number;
    structure_breaks: object[];
    htf_phase?: string;
    htf_bias?: string;
  };

  bases: BaseResult[];
  sd_zones: SDZoneResult[];
  pa_patterns: PAResult[];
  advanced: any;

  decision_points: DPResult[];
  key_levels: KeyLevelResult[];

  sl_tp?: {
    entry: number;
    stop_loss: number;
    take_profit: number;
    rr: number;
    risk_pips: number;
    reward_pips: number;
    position: 'LONG'|'SHORT';
  };

  setup: {
    status: SetupStatus;
    score: number;
    score_breakdown: {
      base_score: number;
      sde_score: number;
      sdp_score: number;
      pa_score: number;
      dp_score: number;
      kl_score: number;
      structure_score: number;
      total: number;
    };
    checklist: Record<string, boolean>;
    invalidation_reason?: string;
    pending_step?: string;
  };

  candles?: CandleSchema[];
  ai_report?: string;
  ai_summary?: string;
}

/* ──────────────────────────────────────────────────────────────
   Store shape
────────────────────────────────────────────────────────────── */

export type AnalysisRequest = {
  symbol: string;
  timeframe: Timeframe;
  higher_tf?: string;

  candle_limit: number;
  force_refresh: boolean;
  include_ltf: boolean;
  include_ai: boolean;
};

export type AnalysisCache = Record<string, AnalysisResponse>; // key = SYMBOL|TF

export type AnalysisStoreState = {
  /* endpoints */
  apiBase: string;
  wsUrl: string;

  /* request params */
  request: AnalysisRequest;

  /* data */
  analysis: AnalysisResponse | null;
  cache: AnalysisCache;

  /* selection */
  selectedZoneId: string | null;
  selectedSwingKey: string | null;

  /* states */
  loading: boolean;
  error: string | null;

  /* ws */
  wsEnabled: boolean;
  wsAutoReconnect: boolean;
  preferWs: boolean;
  wsStatus: WsStatus;
  lastWsAnalysisKey: string | null;

  /* actions */
  init: (cfg: Partial<{
    apiBase: string;
    wsUrl: string;
    wsEnabled: boolean;
    wsAutoReconnect: boolean;
    preferWs: boolean;
    request: Partial<AnalysisRequest>;
  }> & { connectWs?: boolean }) => void;

  setRequest: (patch: Partial<AnalysisRequest>) => void;
  setSymbol: (symbol: string) => void;
  setTimeframe: (timeframe: Timeframe) => void;
  setHigherTf: (higher_tf?: string) => void;

  setSelectedZoneId: (id: string | null) => void;
  setSelectedSwingKey: (key: string | null) => void;
  selectBestZone: () => void;

  /** HTTP analyze (full params) */
  analyzeHttp: (override?: Partial<AnalysisRequest>) => Promise<AnalysisResponse | null>;

  /**
   * WS analyze (backend protocol only supports symbol+timeframe).
   * NOTE: candle_limit/include_ai/... are NOT sent via WS.
   * Use it mainly for "quick analyze" or real-time pipelines.
   */
  analyzeWs: (override?: Partial<Pick<AnalysisRequest, 'symbol' | 'timeframe'>>) => Promise<AnalysisResponse | null>;

  /** Auto = prefer WS if connected and preferWs=true, else HTTP */
  analyzeAuto: (override?: Partial<AnalysisRequest>) => Promise<AnalysisResponse | null>;

  /** backend cache clear */
  clearBackendCache: (symbol?: string, timeframe?: string) => Promise<boolean>;

  /** local cache ops */
  cachePut: (data: AnalysisResponse) => void;
  cacheRemove: (symbol: string, timeframe: string) => void;
  cacheClear: () => void;

  /** WS lifecycle */
  connectWs: () => void;
  disconnectWs: () => void;

  /**
   * If you already use a singleton WS manager elsewhere:
   * forward its messages into the store using handleWsMessage(msg).
   */
  handleWsMessage: (msg: any) => void;

  /** cancel in-flight (HTTP abort or WS pending) */
  cancel: () => void;
};

/* ──────────────────────────────────────────────────────────────
   Defaults
────────────────────────────────────────────────────────────── */

const API_BASE_DEFAULT =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:8000/api/v1';

const WS_URL_DEFAULT =
  process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:8000/ws';

const defaultRequest: AnalysisRequest = {
  symbol: 'BTCUSDT',
  timeframe: 'H4',
  higher_tf: 'D1',

  candle_limit: 500,
  force_refresh: false,
  include_ltf: false,
  include_ai: false,
};

function keyOf(symbol: string, timeframe: string) {
  return `${normSymbol(symbol)}|${String(timeframe).trim()}`;
}

function normSymbol(s: string) {
  return (s ?? '').trim().toUpperCase();
}

function safeBool(v: any, fallback: boolean) {
  return typeof v === 'boolean' ? v : fallback;
}

function safeNum(v: any, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/* ──────────────────────────────────────────────────────────────
   Store implementation
────────────────────────────────────────────────────────────── */

export const useAnalysisStore = create<AnalysisStoreState>()(
  subscribeWithSelector((set, get) => {
    // non-react internals
    let abortCtrl: AbortController | null = null;

    let ws: WebSocket | null = null;
    let reconnectAttempt = 0;
    let reconnectTimer: any = null;

    let wsPending:
      | null
      | {
          key: string;
          resolve: (v: AnalysisResponse | null) => void;
          reject: (e: Error) => void;
          timeout: any;
        } = null;

    const clearReconnect = () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
    };

    const wsSetStatus = (status: WsStatus) => set({ wsStatus: status });

    const wsHardClose = () => {
      clearReconnect();
      reconnectAttempt = 0;

      // reject pending
      if (wsPending) {
        try { clearTimeout(wsPending.timeout); } catch {}
        wsPending.reject(new Error('WS disconnected'));
        wsPending = null;
      }

      try { ws?.close(); } catch {}
      ws = null;
      wsSetStatus('DISCONNECTED');
    };

    const scheduleReconnect = () => {
      clearReconnect();

      const st = get();
      if (!st.wsEnabled || !st.wsAutoReconnect) return;

      reconnectAttempt += 1;
      const delay = Math.min(2500 + reconnectAttempt * 1200, 12_000);

      reconnectTimer = setTimeout(() => {
        get().connectWs();
      }, delay);
    };

    const ingestAnalysis = (data: AnalysisResponse) => {
      // cache it
      get().cachePut(data);

      // if it matches current request key => set as current
      const st = get();
      const currKey = keyOf(st.request.symbol, st.request.timeframe);

      const incomingKey = keyOf(data.symbol, data.timeframe);
      set({ lastWsAnalysisKey: incomingKey });

      if (incomingKey === currKey) {
        set({ analysis: data, loading: false, error: null });

        // auto-select best zone if selection empty or invalid
        set((prev) => {
          const zones = data.sd_zones ?? [];
          const best = zones.slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
          const stillExists = prev.selectedZoneId ? zones.some((z) => z.id === prev.selectedZoneId) : false;

          return {
            selectedZoneId: stillExists ? prev.selectedZoneId : (best?.id ?? null),
          } as any;
        });
      }

      // resolve pending if matches
      if (wsPending && wsPending.key === incomingKey) {
        try { clearTimeout(wsPending.timeout); } catch {}
        wsPending.resolve(data);
        wsPending = null;
      }
    };

    const connectWsInternal = () => {
      const st = get();
      if (!st.wsEnabled) return;

      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
      }

      clearReconnect();
      wsSetStatus('CONNECTING');

      try {
        ws = new WebSocket(st.wsUrl);

        ws.onopen = () => {
          reconnectAttempt = 0;
          wsSetStatus('CONNECTED');
          try { ws?.send(JSON.stringify({ type: 'ping' })); } catch {}
        };

        ws.onmessage = (evt) => {
          // forward to generic handler
          try {
            const msg = JSON.parse(String(evt.data ?? ''));
            get().handleWsMessage(msg);
          } catch {
            // ignore
          }
        };

        ws.onerror = () => {
          set({ error: 'WebSocket error' });
        };

        ws.onclose = () => {
          wsSetStatus('DISCONNECTED');
          scheduleReconnect();
        };
      } catch (e: any) {
        wsSetStatus('DISCONNECTED');
        set({ error: e?.message ?? 'WS connect failed' });
        scheduleReconnect();
      }
    };

    return {
      apiBase: API_BASE_DEFAULT,
      wsUrl: WS_URL_DEFAULT,

      request: { ...defaultRequest },

      analysis: null,
      cache: {},

      selectedZoneId: null,
      selectedSwingKey: null,

      loading: false,
      error: null,

      wsEnabled: false,
      wsAutoReconnect: true,
      preferWs: true,
      wsStatus: 'DISCONNECTED',
      lastWsAnalysisKey: null,

      init: (cfg) => {
        set((prev) => ({
          apiBase: cfg.apiBase ?? prev.apiBase,
          wsUrl: cfg.wsUrl ?? prev.wsUrl,
          wsEnabled: cfg.wsEnabled ?? prev.wsEnabled,
          wsAutoReconnect: cfg.wsAutoReconnect ?? prev.wsAutoReconnect,
          preferWs: cfg.preferWs ?? prev.preferWs,
          request: {
            ...prev.request,
            ...(cfg.request ?? {}),
            symbol: cfg.request?.symbol ? normSymbol(cfg.request.symbol) : prev.request.symbol,
            candle_limit: safeNum(cfg.request?.candle_limit ?? prev.request.candle_limit, prev.request.candle_limit),
            force_refresh: safeBool(cfg.request?.force_refresh, prev.request.force_refresh),
            include_ltf: safeBool(cfg.request?.include_ltf, prev.request.include_ltf),
            include_ai: safeBool(cfg.request?.include_ai, prev.request.include_ai),
          },
        }));

        if (cfg.connectWs) connectWsInternal();
      },

      setRequest: (patch) => {
        set((prev) => ({
          request: {
            ...prev.request,
            ...patch,
            symbol: patch.symbol ? normSymbol(patch.symbol) : prev.request.symbol,
            candle_limit: patch.candle_limit !== undefined ? safeNum(patch.candle_limit, prev.request.candle_limit) : prev.request.candle_limit,
            force_refresh: patch.force_refresh !== undefined ? !!patch.force_refresh : prev.request.force_refresh,
            include_ltf: patch.include_ltf !== undefined ? !!patch.include_ltf : prev.request.include_ltf,
            include_ai: patch.include_ai !== undefined ? !!patch.include_ai : prev.request.include_ai,
          },
        }));
      },

      setSymbol: (symbol) => {
        set((prev) => ({ request: { ...prev.request, symbol: normSymbol(symbol) } }));
      },

      setTimeframe: (timeframe) => {
        set((prev) => ({ request: { ...prev.request, timeframe } }));
      },

      setHigherTf: (higher_tf) => {
        set((prev) => ({ request: { ...prev.request, higher_tf } }));
      },

      setSelectedZoneId: (id) => set({ selectedZoneId: id }),
      setSelectedSwingKey: (key) => set({ selectedSwingKey: key }),

      selectBestZone: () => {
        const a = get().analysis;
        if (!a?.sd_zones?.length) {
          set({ selectedZoneId: null });
          return;
        }
        const best = a.sd_zones.slice().sort((x, y) => (y.score ?? 0) - (x.score ?? 0))[0];
        set({ selectedZoneId: best?.id ?? null });
      },

      analyzeHttp: async (override) => {
        const st = get();
        set({ error: null });

        // cancel previous
        get().cancel();

        const req: AnalysisRequest = {
          ...st.request,
          ...(override ?? {}),
          symbol: normSymbol((override?.symbol ?? st.request.symbol) as string),
        };

        const controller = new AbortController();
        abortCtrl = controller;

        set({ loading: true });

        try {
          const res = await fetch(`${st.apiBase}/analysis/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req),
            signal: controller.signal,
          });

          if (!res.ok) {
            const t = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status} — ${t || 'Erreur /analysis/analyze'}`);
          }

          const data = (await res.json()) as AnalysisResponse;

          // ingest like WS
          ingestAnalysis(data);

          return data;
        } catch (e: any) {
          if (e?.name === 'AbortError') return null;
          set({ error: e?.message ?? 'Erreur analyse HTTP' });
          return null;
        } finally {
          abortCtrl = null;
          set({ loading: false });
        }
      },

      analyzeWs: async (override) => {
        const st = get();
        set({ error: null });

        if (!st.wsEnabled) {
          set({ error: 'WS disabled (wsEnabled=false). Active-le ou utilise analyzeHttp().' });
          return null;
        }

        // ensure connected
        connectWsInternal();

        if (!ws || ws.readyState !== WebSocket.OPEN) {
          set({ error: 'WS not connected (readyState != OPEN).' });
          return null;
        }

        // cancel HTTP
        abortCtrl?.abort();
        abortCtrl = null;

        // cancel previous pending ws
        if (wsPending) {
          try { clearTimeout(wsPending.timeout); } catch {}
          wsPending.reject(new Error('Superseded by new WS request'));
          wsPending = null;
        }

        const sym = normSymbol(override?.symbol ?? st.request.symbol);
        const tf = String(override?.timeframe ?? st.request.timeframe);
        const k = keyOf(sym, tf);

        set({ loading: true });

        return await new Promise<AnalysisResponse | null>((resolve) => {
          const timeout = setTimeout(() => {
            if (wsPending?.key === k) {
              wsPending = null;
              set({ loading: false, error: 'Timeout WS: analysis_ready non reçu.' });
              resolve(null);
            }
          }, 18_000);

          wsPending = {
            key: k,
            resolve: (v) => resolve(v),
            reject: (e) => {
              set({ error: e.message, loading: false });
              resolve(null);
            },
            timeout,
          };

          try {
            ws.send(JSON.stringify({ type: 'request_analysis', symbol: sym, timeframe: tf }));
          } catch (e: any) {
            clearTimeout(timeout);
            wsPending = null;
            set({ loading: false, error: e?.message ?? 'WS send error' });
            resolve(null);
          }
        });
      },

      analyzeAuto: async (override) => {
        const st = get();

        const wantsWs = st.preferWs && st.wsEnabled && st.wsStatus === 'CONNECTED';
        if (wantsWs) {
          const wsRes = await get().analyzeWs({
            symbol: override?.symbol,
            timeframe: override?.timeframe as any,
          });
          if (wsRes) return wsRes;
          // fallback HTTP if ws fails
        }
        return await get().analyzeHttp(override);
      },

      clearBackendCache: async (symbol, timeframe) => {
        const st = get();
        set({ error: null });

        const sym = normSymbol(symbol ?? st.request.symbol);
        const tf = String(timeframe ?? st.request.timeframe);

        try {
          const url = `${st.apiBase}/analysis/cache/${encodeURIComponent(sym)}?timeframe=${encodeURIComponent(tf)}`;
          const res = await fetch(url, { method: 'DELETE' });

          if (!res.ok) {
            const t = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status} — ${t || 'Erreur clear cache'}`);
          }

          // remove local too
          get().cacheRemove(sym, tf);
          return true;
        } catch (e: any) {
          set({ error: e?.message ?? 'Erreur clear cache' });
          return false;
        }
      },

      cachePut: (data) => {
        const k = keyOf(data.symbol, data.timeframe);

        set((prev) => {
          const next = { ...(prev.cache ?? {}) };
          next[k] = data;
          return { cache: next } as any;
        });
      },

      cacheRemove: (symbol, timeframe) => {
        const k = keyOf(symbol, timeframe);
        set((prev) => {
          const next = { ...(prev.cache ?? {}) };
          delete next[k];

          // if current analysis matches removed, keep analysis but it is no longer cached locally
          return { cache: next } as any;
        });
      },

      cacheClear: () => set({ cache: {} }),

      connectWs: () => connectWsInternal(),

      disconnectWs: () => {
        wsHardClose();
      },

      handleWsMessage: (msg) => {
        if (!msg || typeof msg !== 'object') return;

        // only handle analysis_ready; ignore others
        if (msg.type === 'analysis_ready' && msg.data) {
          ingestAnalysis(msg.data as AnalysisResponse);
          return;
        }

        // (optional) handle pong
        if (msg.type === 'pong') return;
      },

      cancel: () => {
        // abort HTTP
        abortCtrl?.abort();
        abortCtrl = null;

        // reject pending WS
        if (wsPending) {
          try { clearTimeout(wsPending.timeout); } catch {}
          wsPending.reject(new Error('Cancelled'));
          wsPending = null;
        }

        set({ loading: false });
      },
    };
  })
);

/* ──────────────────────────────────────────────────────────────
   Selectors (optionnels)
────────────────────────────────────────────────────────────── */

export const selectAnalysis = (s: AnalysisStoreState) => s.analysis;
export const selectAnalysisLoading = (s: AnalysisStoreState) => s.loading;
export const selectAnalysisError = (s: AnalysisStoreState) => s.error;
export const selectWsStatus = (s: AnalysisStoreState) => s.wsStatus;

export const selectBestZone = (s: AnalysisStoreState) => {
  const zs = s.analysis?.sd_zones ?? [];
  if (!zs.length) return null;
  return zs.slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0] ?? null;
};

export const selectSetupMini = (s: AnalysisStoreState) => {
  const setup = s.analysis?.setup;
  if (!setup) return null;
  return { status: setup.status, score: setup.score };
};