/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * src/lib/api.ts
 * IGNIS Frontend API client (typed-ish)
 * - Centralise toutes les calls HTTP vers FastAPI (/api/v1)
 * - Gestion d'erreurs robuste (ApiError)
 * - Timeout + AbortController
 * - Helpers querystring
 * - SSE helper (pour /ai/chat/stream)
 */

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export class ApiError extends Error {
  name = 'ApiError';

  status: number;
  url: string;
  method: HttpMethod;
  details: any;

  constructor(args: { status: number; url: string; method: HttpMethod; message: string; details?: any }) {
    super(args.message);
    this.status = args.status;
    this.url = args.url;
    this.method = args.method;
    this.details = args.details;
  }
}

/* ──────────────────────────────────────────────────────────────
   Base config
────────────────────────────────────────────────────────────── */

export const API_BASE =
  (process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:8000/api/v1');

export type RequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** default true: disable caching for dynamic trading data */
  noStore?: boolean;
};

const DEFAULT_TIMEOUT_MS = 18_000;

/* ──────────────────────────────────────────────────────────────
   TypeScript models (alignés avec ton doc)
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

export interface AssetResponse {
  symbol: string;
  asset_class: string;
  name: string;
  exchange: string;
  active: boolean;
  last_price?: number;
  last_analysis_at?: string;
  setup?: { status: SetupStatus; score: number; zone_type?: ZoneType; pa_pattern?: PAPattern; rr?: number };
  meta?: any;
  created_at: string;
  updated_at: string;
}

export interface AssetsListResponse {
  total: number;
  assets: AssetResponse[];
  page?: number;
  page_size?: number;
}

export interface AssetStatsResponse {
  total: number;
  active: number;
  by_class: Record<string, number>;
  with_analysis: number;
  valid_setups: number;
  pending_setups: number;
}

export interface AlertResponse {
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
}

export interface AIStatusResponse {
  ollama_online: boolean;
  model: string;
  host: string;
  version?: string;
  models_available?: any;
}

export interface AIModelsResponse {
  models: { name: string; size?: number; modified_at?: string }[];
}

export interface AIChatResponse {
  response: string;
  model: string;
  symbol: string;
  timeframe: string;
  tokens_used?: number;
}

export interface AIReportResponse {
  symbol: string;
  timeframe: string;
  report: string;
  summary?: string;
  setup_status?: string;
  score?: number;
  generated_at?: string;
  model?: string;
}

export interface AISummarizeResponse {
  symbol: string;
  timeframe: string;
  summary: string;
  generated_at?: string;
}

export interface JournalEntryResponse {
  id: string;
  symbol: string;
  timeframe: string;
  side: 'LONG'|'SHORT';
  status: 'OPEN'|'CLOSED'|'CANCELLED';
  entry: number;
  sl?: number;
  tp?: number;
  rr?: number;
  size?: number;
  setup_id?: string;
  setup_score?: number;
  opened_at?: string;
  closed_at?: string;
  exit_price?: number;
  pnl?: number;
  pnl_pct?: number;
  notes: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface JournalStatsResponse {
  total: number;
  open: number;
  closed: number;
  win_rate: number;
  total_pnl: number;
  avg_rr: number;
  best_trade?: any;
  worst_trade?: any;
  by_symbol: Record<string, any>;
}

/* ──────────────────────────────────────────────────────────────
   Querystring helpers
────────────────────────────────────────────────────────────── */

export function qs(params: Record<string, any> = {}) {
  const sp = new URLSearchParams();

  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;

    // arrays => comma-separated by convention in your API (timeframes=H1,H4)
    if (Array.isArray(v)) {
      if (!v.length) continue;
      sp.set(k, v.join(','));
      continue;
    }

    sp.set(k, String(v));
  }

  const s = sp.toString();
  return s ? `?${s}` : '';
}

/* ──────────────────────────────────────────────────────────────
   Low-level request
────────────────────────────────────────────────────────────── */

async function readBody(res: Response) {
  const ct = res.headers.get('content-type')?.toLowerCase() ?? '';
  if (ct.includes('application/json')) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
  // text fallback
  try {
    return await res.text();
  } catch {
    return null;
  }
}

export async function request<T>(
  path: string,
  method: HttpMethod,
  body?: any,
  opts: RequestOptions = {}
): Promise<T> {
  const url = `${API_BASE}${path.startsWith('/') ? '' : '/'}${path}`;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const signal = opts.signal;

  // propagate external abort to internal controller
  const abortListener = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abortListener, { once: true });
  }

  const timer = timeoutMs
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;

  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.headers ?? {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      cache: opts.noStore ?? true ? 'no-store' : 'default',
    });

    if (!res.ok) {
      const details = await readBody(res);
      const msg =
        typeof details === 'string'
          ? details
          : details?.detail
            ? String(details.detail)
            : `HTTP ${res.status}`;

      throw new ApiError({
        status: res.status,
        url,
        method,
        message: msg,
        details,
      });
    }

    // Some endpoints might return empty body
    const ct = res.headers.get('content-type')?.toLowerCase() ?? '';
    if (ct.includes('application/json')) return (await res.json()) as T;

    // text endpoints (rare)
    const txt = await res.text();
    return txt as unknown as T;
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      throw new ApiError({
        status: 0,
        url,
        method,
        message: `Request aborted/timeout (${timeoutMs}ms)`,
        details: { timeoutMs },
      });
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', abortListener);
  }
}

export const apiHttp = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>(path, 'GET', undefined, opts),
  post: <T>(path: string, body?: any, opts?: RequestOptions) => request<T>(path, 'POST', body, opts),
  patch: <T>(path: string, body?: any, opts?: RequestOptions) => request<T>(path, 'PATCH', body, opts),
  del: <T>(path: string, opts?: RequestOptions) => request<T>(path, 'DELETE', undefined, opts),
};

/* ──────────────────────────────────────────────────────────────
   SSE streaming helper (text/event-stream)
────────────────────────────────────────────────────────────── */

export type SSECallbacks = {
  onToken?: (token: string) => void;
  onEvent?: (evt: { raw: string; data: string }) => void;
};

function tryExtractToken(data: string): string | null {
  const s = data ?? '';
  if (!s.trim()) return null;

  // raw token
  if (!s.trim().startsWith('{') && !s.trim().startsWith('[')) return s;

  try {
    const obj = JSON.parse(s);
    if (typeof obj === 'string') return obj;

    if (typeof obj?.token === 'string') return obj.token;
    if (typeof obj?.delta === 'string') return obj.delta;
    if (typeof obj?.content === 'string') return obj.content;
    if (typeof obj?.response === 'string') return obj.response;
    if (typeof obj?.text === 'string') return obj.text;

    const c = obj?.choices?.[0]?.delta?.content;
    if (typeof c === 'string') return c;

    return null;
  } catch {
    return s;
  }
}

export async function postSSE(
  path: string,
  body: any,
  callbacks: SSECallbacks = {},
  opts: RequestOptions = {}
): Promise<{ fullText: string }> {
  const url = `${API_BASE}${path.startsWith('/') ? '' : '/'}${path}`;

  const controller = new AbortController();
  const signal = opts.signal;

  const abortListener = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abortListener, { once: true });
  }

  const timeoutMs = opts.timeoutMs ?? 0; // often we don't want a hard timeout on streaming
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.headers ?? {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!res.ok) {
      const details = await readBody(res);
      const msg =
        typeof details === 'string'
          ? details
          : details?.detail
            ? String(details.detail)
            : `HTTP ${res.status}`;

      throw new ApiError({ status: res.status, url, method: 'POST', message: msg, details });
    }

    if (!res.body) {
      throw new ApiError({
        status: 0,
        url,
        method: 'POST',
        message: 'Streaming not supported: Response.body is null',
      });
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');

    let buffer = '';
    let done = false;
    let fullText = '';

    while (!done) {
      const chunk = await reader.read();
      done = chunk.done;
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !done });

      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        const lines = part.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;

          const data = trimmed.replace(/^data:\s?/, '');
          callbacks.onEvent?.({ raw: part, data });

          if (data === '[DONE]') return { fullText };

          const token = tryExtractToken(data);
          if (token) {
            fullText += token;
            callbacks.onToken?.(token);
          }
        }
      }
    }

    return { fullText };
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      throw new ApiError({
        status: 0,
        url,
        method: 'POST',
        message: 'SSE aborted/timeout',
        details: { timeoutMs },
      });
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', abortListener);
  }
}

/* ──────────────────────────────────────────────────────────────
   High-level API (domain)
────────────────────────────────────────────────────────────── */

export const api = {
  /* ── ANALYSIS ─────────────────────────────────────────────── */
  analysis: {
    analyze: (req: {
      symbol: string;
      timeframe: Timeframe | string;
      higher_tf?: Timeframe | string;
      candle_limit?: number;
      force_refresh?: boolean;
      include_ltf?: boolean;
      include_ai?: boolean;
    }, opts?: RequestOptions) =>
      apiHttp.post<AnalysisResponse>('/analysis/analyze', req, opts),

    analyzeGet: (params: { symbol: string; timeframe: string }, opts?: RequestOptions) =>
      apiHttp.get<AnalysisResponse>(`/analysis/analyze${qs(params)}`, opts),

    multi: (req: { symbols: string[]; timeframe: string; candle_limit?: number; valid_only?: boolean }, opts?: RequestOptions) =>
      apiHttp.post<any>('/analysis/multi', req, opts),

    scan: (req: {
      symbols: string[];
      timeframes: string[];
      min_score?: number;
      status_filter?: string[];
      pa_filter?: string[];
      candle_limit?: number;
    }, opts?: RequestOptions) =>
      apiHttp.post<any>('/analysis/scan', req, opts),

    mtf: (symbol: string, params: { timeframes: string[]; candle_limit?: number }, opts?: RequestOptions) =>
      apiHttp.get<any>(`/analysis/mtf/${encodeURIComponent(symbol)}${qs({ ...params, timeframes: params.timeframes })}`, opts),

    history: (symbol: string, params: { timeframe: string; limit?: number }, opts?: RequestOptions) =>
      apiHttp.get<any>(`/analysis/history/${encodeURIComponent(symbol)}${qs(params)}`, opts),

    backtest: (req: {
      symbol: string;
      timeframe: string;
      start_ts: number;
      end_ts: number;
      candle_limit?: number;
      min_score?: number;
      zone_types?: string[];
    }, opts?: RequestOptions) =>
      apiHttp.post<any>('/analysis/backtest', req, opts),

    clearCache: (symbol: string, timeframe: string, opts?: RequestOptions) =>
      apiHttp.del<any>(`/analysis/cache/${encodeURIComponent(symbol)}${qs({ timeframe })}`, opts),

    clearCacheAll: (opts?: RequestOptions) =>
      apiHttp.del<any>('/analysis/cache', opts),
  },

  /* ── ASSETS ──────────────────────────────────────────────── */
  assets: {
    list: (params: { asset_class?: string; active?: boolean; limit?: number; offset?: number } = {}, opts?: RequestOptions) =>
      apiHttp.get<AssetsListResponse>(`/assets${qs(params)}`, opts),

    get: (symbol: string, opts?: RequestOptions) =>
      apiHttp.get<AssetResponse>(`/assets/${encodeURIComponent(symbol)}`, opts),

    create: (body: { symbol: string; asset_class?: string; name?: string; exchange?: string; active?: boolean }, opts?: RequestOptions) =>
      apiHttp.post<AssetResponse>('/assets', body, opts),

    patch: (symbol: string, body: { name?: string; exchange?: string; active?: boolean; meta?: any }, opts?: RequestOptions) =>
      apiHttp.patch<AssetResponse>(`/assets/${encodeURIComponent(symbol)}`, body, opts),

    del: (symbol: string, opts?: RequestOptions) =>
      apiHttp.del<any>(`/assets/${encodeURIComponent(symbol)}`, opts),

    stats: (opts?: RequestOptions) =>
      apiHttp.get<AssetStatsResponse>('/assets/stats', opts),

    refresh: (symbol: string, body: { timeframe?: string; force?: boolean } = {}, opts?: RequestOptions) =>
      apiHttp.post<any>(`/assets/${encodeURIComponent(symbol)}/refresh`, body, opts),
  },

  /* ── ALERTS ──────────────────────────────────────────────── */
  alerts: {
    list: (params: { limit?: number; offset?: number; priority?: string; alert_type?: string; symbol?: string } = {}, opts?: RequestOptions) =>
      apiHttp.get<any>(`/alerts${qs(params)}`, opts),

    get: (alertId: string, opts?: RequestOptions) =>
      apiHttp.get<AlertResponse>(`/alerts/${encodeURIComponent(alertId)}`, opts),

    bySymbol: (symbol: string, params: { limit?: number } = {}, opts?: RequestOptions) =>
      apiHttp.get<any>(`/alerts/symbol/${encodeURIComponent(symbol)}${qs(params)}`, opts),

    emit: (body: {
      alert_type: string;
      symbol: string;
      timeframe: string;
      title: string;
      message: string;
      priority?: string;
      payload?: any;
      channels?: string[];
    }, opts?: RequestOptions) =>
      apiHttp.post<any>('/alerts/emit', body, opts),

    test: (body: { channel?: string; symbol?: string; message?: string } = {}, opts?: RequestOptions) =>
      apiHttp.post<any>('/alerts/test', body, opts),

    stats: (opts?: RequestOptions) =>
      apiHttp.get<any>('/alerts/stats', opts),

    deadLetter: (opts?: RequestOptions) =>
      apiHttp.get<any>('/alerts/dead-letter', opts),

    clearDeadLetter: (opts?: RequestOptions) =>
      apiHttp.del<any>('/alerts/dead-letter', opts),

    filters: (opts?: RequestOptions) =>
      apiHttp.get<any>('/alerts/filters', opts),
  },

  /* ── IGNIS AI ─────────────────────────────────────────────── */
  ai: {
    status: (opts?: RequestOptions) =>
      apiHttp.get<AIStatusResponse>('/ai/status', opts),

    models: (opts?: RequestOptions) =>
      apiHttp.get<AIModelsResponse>('/ai/models', opts),

    chat: (body: {
      symbol: string;
      timeframe: string;
      messages: { role: string; content: string }[];
      model?: string;
      temperature?: number;
      stream?: false;
    }, opts?: RequestOptions) =>
      apiHttp.post<AIChatResponse>('/ai/chat', body, opts),

    chatStream: async (body: {
      symbol: string;
      timeframe: string;
      messages: { role: string; content: string }[];
      model?: string;
      temperature?: number;
      stream?: true;
    }, callbacks: SSECallbacks = {}, opts?: RequestOptions) => {
      return await postSSE('/ai/chat/stream', { ...body, stream: true }, callbacks, opts);
    },

    report: (body: {
      symbol: string;
      timeframe: string;
      higher_tf?: string;
      force_analysis?: boolean;
      report_type?: string;
      language?: string;
    }, opts?: RequestOptions) =>
      apiHttp.post<AIReportResponse>('/ai/report', body, opts),

    summarize: (body: { symbol: string; timeframe: string; max_words?: number }, opts?: RequestOptions) =>
      apiHttp.post<AISummarizeResponse>('/ai/summarize', body, opts),
  },

  /* ── JOURNAL ──────────────────────────────────────────────── */
  journal: {
    list: (params: { status?: string; symbol?: string; limit?: number; offset?: number } = {}, opts?: RequestOptions) =>
      apiHttp.get<any>(`/journal${qs(params)}`, opts),

    stats: (params: { symbol?: string } = {}, opts?: RequestOptions) =>
      apiHttp.get<JournalStatsResponse>(`/journal/stats${qs(params)}`, opts),

    create: (body: {
      symbol: string;
      timeframe?: string;
      side: 'LONG'|'SHORT';
      entry: number;
      sl?: number;
      tp?: number;
      rr?: number;
      size?: number;
      setup_id?: string;
      setup_score?: number;
      opened_at?: string;
      notes?: string;
      tags?: string[];
    }, opts?: RequestOptions) =>
      apiHttp.post<JournalEntryResponse>('/journal', body, opts),

    get: (entryId: string, opts?: RequestOptions) =>
      apiHttp.get<JournalEntryResponse>(`/journal/${encodeURIComponent(entryId)}`, opts),

    patch: (entryId: string, body: { sl?: number; tp?: number; notes?: string; tags?: string[]; status?: string }, opts?: RequestOptions) =>
      apiHttp.patch<JournalEntryResponse>(`/journal/${encodeURIComponent(entryId)}`, body, opts),

    close: (entryId: string, body: { exit_price: number; closed_at?: string; notes?: string }, opts?: RequestOptions) =>
      apiHttp.post<JournalEntryResponse>(`/journal/${encodeURIComponent(entryId)}/close`, body, opts),

    del: (entryId: string, opts?: RequestOptions) =>
      apiHttp.del<any>(`/journal/${encodeURIComponent(entryId)}`, opts),
  },
};

/* ──────────────────────────────────────────────────────────────
   Convenience: common helpers
────────────────────────────────────────────────────────────── */

export function isApiError(e: any): e is ApiError {
  return e && typeof e === 'object' && e.name === 'ApiError' && typeof e.status === 'number';
}

export function prettyApiError(e: any) {
  if (!isApiError(e)) return String(e?.message ?? e ?? 'Unknown error');

  const base = `${e.method} ${e.url} → ${e.status}`;
  const msg = e.message ? `: ${e.message}` : '';
  const details =
    e.details && typeof e.details === 'object'
      ? (e.details.detail ? ` (detail: ${String(e.details.detail)})` : '')
      : '';
  return `${base}${msg}${details}`;
}