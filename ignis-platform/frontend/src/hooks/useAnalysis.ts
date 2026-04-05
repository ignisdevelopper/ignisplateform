/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/* ──────────────────────────────────────────────────────────────
   Types (alignés avec ton schema)
────────────────────────────────────────────────────────────── */

export type SetupStatus = 'VALID' | 'PENDING' | 'INVALID' | 'WATCH' | 'EXPIRED';
export type ZoneType = 'DEMAND' | 'SUPPLY' | 'FLIPPY_D' | 'FLIPPY_S' | 'HIDDEN_D' | 'HIDDEN_S';
export type PAPattern = 'ACCU' | 'THREE_DRIVES' | 'FTL' | 'PATTERN_69' | 'HIDDEN_SDE' | 'NONE';
export type SwingType = 'HH' | 'HL' | 'LH' | 'LL';

export type Timeframe = 'M1'|'M5'|'M15'|'M30'|'H1'|'H2'|'H4'|'H8'|'D1'|'W1'|'MN1';

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
   Hook API
────────────────────────────────────────────────────────────── */

export type AnalysisRequest = {
  symbol: string;
  timeframe: Timeframe;
  higher_tf?: Timeframe | string;

  candle_limit?: number;      // default backend: 500
  force_refresh?: boolean;    // default: false
  include_ltf?: boolean;      // default: false
  include_ai?: boolean;       // default: false
};

export type WsStatus = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED';

export type UseAnalysisOptions = {
  apiBase?: string;
  wsUrl?: string;

  /** initial state */
  symbol?: string;
  timeframe?: Timeframe;
  higherTf?: Timeframe | '' | string;

  candleLimit?: number;
  forceRefresh?: boolean;
  includeLtf?: boolean;
  includeAi?: boolean;

  /** auto-run on mount */
  auto?: boolean;

  /**
   * If true, try WS first (if connected), else fallback HTTP.
   * If false, always use HTTP unless you call analyzeWs() explicitly.
   */
  preferWs?: boolean;

  /**
   * Create internal WS connection (default true).
   * If you already have a global WS manager, set false and call analyzeWs()
   * with your own WebSocket elsewhere, or provide wsExternal.
   */
  wsEnabled?: boolean;

  /** Optional external WebSocket (singleton from app) */
  wsExternal?: WebSocket | null;

  /** Reconnect strategy for internal WS */
  wsAutoReconnect?: boolean;
};

export type UseAnalysisReturn = {
  // state
  symbol: string;
  timeframe: Timeframe;
  higherTf: string | undefined;

  candleLimit: number;
  forceRefresh: boolean;
  includeLtf: boolean;
  includeAi: boolean;

  analysis: AnalysisResponse | null;
  loading: boolean;
  error: string | null;

  // ws
  wsStatus: WsStatus;

  // setters
  setSymbol: (s: string) => void;
  setTimeframe: (tf: Timeframe) => void;
  setHigherTf: (tf: string | undefined) => void;

  setCandleLimit: (n: number) => void;
  setForceRefresh: (v: boolean) => void;
  setIncludeLtf: (v: boolean) => void;
  setIncludeAi: (v: boolean) => void;

  // actions
  analyze: (override?: Partial<AnalysisRequest> & { via?: 'auto'|'http'|'ws' }) => Promise<AnalysisResponse | null>;
  analyzeHttp: (override?: Partial<AnalysisRequest>) => Promise<AnalysisResponse | null>;
  analyzeWs: (override?: Partial<AnalysisRequest>) => Promise<AnalysisResponse | null>;

  clearCache: (symbol?: string, timeframe?: string) => Promise<void>;
  cancel: () => void;

  /** useful derived */
  bestZone: SDZoneResult | null;
  setupStatus: SetupStatus | null;
  setupScore: number | null;
};

/* ──────────────────────────────────────────────────────────────
   Implementation
────────────────────────────────────────────────────────────── */

const API_BASE_DEFAULT =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:8000/api/v1';

const WS_URL_DEFAULT =
  process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:8000/ws';

function normSymbol(s: string) {
  return (s ?? '').trim().toUpperCase();
}

export function useanalysis(options: UseAnalysisOptions = {}): UseAnalysisReturn {
  const {
    apiBase = API_BASE_DEFAULT,
    wsUrl = WS_URL_DEFAULT,

    symbol: initialSymbol = 'BTCUSDT',
    timeframe: initialTimeframe = 'H4',
    higherTf: initialHigherTf = 'D1',

    candleLimit: initialCandleLimit = 500,
    forceRefresh: initialForceRefresh = false,
    includeLtf: initialIncludeLtf = false,
    includeAi: initialIncludeAi = false,

    auto = false,
    preferWs = false,

    wsEnabled = true,
    wsExternal = null,
    wsAutoReconnect = true,
  } = options;

  const [symbol, setSymbol] = useState<string>(normSymbol(initialSymbol) || 'BTCUSDT');
  const [timeframe, setTimeframe] = useState<Timeframe>(initialTimeframe);
  const [higherTf, setHigherTf] = useState<string | undefined>(
    initialHigherTf ? String(initialHigherTf) : undefined
  );

  const [candleLimit, setCandleLimit] = useState<number>(initialCandleLimit);
  const [forceRefresh, setForceRefresh] = useState<boolean>(initialForceRefresh);
  const [includeLtf, setIncludeLtf] = useState<boolean>(initialIncludeLtf);
  const [includeAi, setIncludeAi] = useState<boolean>(initialIncludeAi);

  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // request lifecycle (avoid race)
  const reqIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  // WS
  const [wsStatus, setWsStatus] = useState<WsStatus>('DISCONNECTED');
  const wsInternalRef = useRef<WebSocket | null>(null);
  const wsPendingRef = useRef<{
    reqId: number;
    symbol: string;
    timeframe: string;
    resolve: (v: AnalysisResponse | null) => void;
    reject: (e: Error) => void;
    timeout: any;
  } | null>(null);

  const effectiveWs = wsExternal ?? wsInternalRef.current;

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;

    // cancel pending ws request
    if (wsPendingRef.current) {
      try {
        clearTimeout(wsPendingRef.current.timeout);
      } catch {}
      wsPendingRef.current.reject(new Error('WS request cancelled'));
      wsPendingRef.current = null;
    }

    setLoading(false);
  }, []);

  const buildRequest = useCallback(
    (override?: Partial<AnalysisRequest>): AnalysisRequest => {
      return {
        symbol: normSymbol(override?.symbol ?? symbol),
        timeframe: (override?.timeframe ?? timeframe) as Timeframe,
        higher_tf: override?.higher_tf ?? (higherTf || undefined),

        candle_limit: override?.candle_limit ?? candleLimit,
        force_refresh: override?.force_refresh ?? forceRefresh,
        include_ltf: override?.include_ltf ?? includeLtf,
        include_ai: override?.include_ai ?? includeAi,
      };
    },
    [symbol, timeframe, higherTf, candleLimit, forceRefresh, includeLtf, includeAi]
  );

  const analyzeHttp = useCallback(
    async (override?: Partial<AnalysisRequest>) => {
      setError(null);

      const req = buildRequest(override);

      // cancel any in-flight
      cancel();

      const reqId = ++reqIdRef.current;
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      try {
        const res = await fetch(`${apiBase}/analysis/analyze`, {
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

        // ignore stale responses
        if (reqId !== reqIdRef.current) return null;

        setAnalysis(data);
        return data;
      } catch (e: any) {
        if (e?.name === 'AbortError') return null;
        setError(e?.message ?? 'Erreur inconnue');
        return null;
      } finally {
        if (reqId === reqIdRef.current) setLoading(false);
      }
    },
    [apiBase, buildRequest, cancel]
  );

  // Internal WS connection (optional)
  useEffect(() => {
    if (!wsEnabled) return;
    if (wsExternal) return; // parent provides WS
    if (modeIsHttpOnly(preferWs, wsEnabled) && false) return;

    let alive = true;
    let retry = 0;
    let retryTimer: any = null;

    const connectWs = () => {
      if (!alive) return;

      setWsStatus('CONNECTING');
      const ws = new WebSocket(wsUrl);
      wsInternalRef.current = ws;

      ws.onopen = () => {
        if (!alive) return;
        retry = 0;
        setWsStatus('CONNECTED');
        try {
          ws.send(JSON.stringify({ type: 'ping' }));
        } catch {}
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);

          if (msg?.type === 'analysis_ready') {
            const data = msg?.data as AnalysisResponse;

            // resolve matching pending request
            const pending = wsPendingRef.current;
            if (pending) {
              const same =
                normSymbol(data?.symbol) === pending.symbol &&
                String(data?.timeframe) === pending.timeframe;

              if (same) {
                clearTimeout(pending.timeout);
                wsPendingRef.current = null;
                setAnalysis(data);
                setLoading(false);
                pending.resolve(data);
              }
            } else {
              // still accept unsolicited analysis_ready
              setAnalysis(data);
            }
          }
        } catch {
          // ignore
        }
      };

      ws.onclose = () => {
        if (!alive) return;
        setWsStatus('DISCONNECTED');

        // reject pending ws request
        if (wsPendingRef.current) {
          const p = wsPendingRef.current;
          wsPendingRef.current = null;
          try {
            clearTimeout(p.timeout);
          } catch {}
          p.reject(new Error('WS disconnected'));
          setLoading(false);
        }

        if (!wsAutoReconnect) return;

        const delay = Math.min(2500 + retry * 1200, 12_000);
        retry += 1;
        retryTimer = setTimeout(connectWs, delay);
      };

      ws.onerror = () => {
        // onclose handles it
      };
    };

    connectWs();

    return () => {
      alive = false;
      if (retryTimer) clearTimeout(retryTimer);
      try {
        wsInternalRef.current?.close();
      } catch {}
      wsInternalRef.current = null;
      setWsStatus('DISCONNECTED');
    };
  }, [wsEnabled, wsExternal, wsUrl, wsAutoReconnect]);

  const analyzeWs = useCallback(
    async (override?: Partial<AnalysisRequest>) => {
      setError(null);

      const ws = effectiveWs;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        setError('WebSocket non connecté (readyState != OPEN).');
        return null;
      }

      const req = buildRequest(override);
      const reqId = ++reqIdRef.current;

      // cancel in-flight HTTP
      abortRef.current?.abort();
      abortRef.current = null;

      // cancel previous pending ws
      if (wsPendingRef.current) {
        try {
          clearTimeout(wsPendingRef.current.timeout);
        } catch {}
        wsPendingRef.current.reject(new Error('Superseded by new WS request'));
        wsPendingRef.current = null;
      }

      setLoading(true);

      return await new Promise<AnalysisResponse | null>((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (wsPendingRef.current?.reqId === reqId) {
            wsPendingRef.current = null;
            setLoading(false);
            setError('Timeout WS: analysis_ready non reçu.');
            resolve(null);
          }
        }, 18_000);

        wsPendingRef.current = {
          reqId,
          symbol: normSymbol(req.symbol),
          timeframe: String(req.timeframe),
          resolve,
          reject: (e) => {
            if (wsPendingRef.current?.reqId === reqId) {
              wsPendingRef.current = null;
              setError(e.message);
            }
            resolve(null);
          },
          timeout,
        };

        try {
          // backend expects: {type:"request_analysis",symbol,timeframe}
          ws.send(JSON.stringify({ type: 'request_analysis', symbol: req.symbol, timeframe: req.timeframe }));
        } catch (e: any) {
          clearTimeout(timeout);
          wsPendingRef.current = null;
          setLoading(false);
          setError(e?.message ?? 'Erreur WS send');
          resolve(null);
        }
      });
    },
    [effectiveWs, buildRequest]
  );

  const analyze = useCallback(
    async (override?: Partial<AnalysisRequest> & { via?: 'auto' | 'http' | 'ws' }) => {
      const via = override?.via ?? 'auto';

      if (via === 'http') return await analyzeHttp(override);
      if (via === 'ws') return await analyzeWs(override);

      // auto
      if (preferWs && effectiveWs && effectiveWs.readyState === WebSocket.OPEN) {
        const data = await analyzeWs(override);
        if (data) return data;
        // fallback to http if ws fails
      }
      return await analyzeHttp(override);
    },
    [analyzeHttp, analyzeWs, preferWs, effectiveWs]
  );

  const clearCache = useCallback(
    async (sym?: string, tf?: string) => {
      setError(null);
      const s = normSymbol(sym ?? symbol);
      const t = String(tf ?? timeframe);

      try {
        const url = `${apiBase}/analysis/cache/${encodeURIComponent(s)}?timeframe=${encodeURIComponent(t)}`;
        const res = await fetch(url, { method: 'DELETE' });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status} — ${txt || 'Erreur clear cache'}`);
        }
      } catch (e: any) {
        setError(e?.message ?? 'Erreur clear cache');
      }
    },
    [apiBase, symbol, timeframe]
  );

  // auto run on mount
  useEffect(() => {
    if (!auto) return;
    analyze({ via: 'auto' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // derived
  const bestZone = useMemo(() => {
    const zs = analysis?.sd_zones ?? [];
    if (!zs.length) return null;
    return zs.slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0] ?? null;
  }, [analysis?.sd_zones]);

  const setupStatus = useMemo(() => analysis?.setup?.status ?? null, [analysis?.setup?.status]);
  const setupScore = useMemo(() => (analysis ? analysis.setup?.score ?? null : null), [analysis]);

  return {
    symbol,
    timeframe,
    higherTf,

    candleLimit,
    forceRefresh,
    includeLtf,
    includeAi,

    analysis,
    loading,
    error,

    wsStatus,

    setSymbol: (s) => setSymbol(normSymbol(s)),
    setTimeframe,
    setHigherTf: (tf) => setHigherTf(tf ? String(tf) : undefined),

    setCandleLimit,
    setForceRefresh,
    setIncludeLtf,
    setIncludeAi,

    analyze,
    analyzeHttp,
    analyzeWs,

    clearCache,
    cancel,

    bestZone,
    setupStatus,
    setupScore,
  };
}

/* ──────────────────────────────────────────────────────────────
   Internal helpers
────────────────────────────────────────────────────────────── */

function modeIsHttpOnly(_preferWs: boolean, _wsEnabled: boolean) {
  return false;
}