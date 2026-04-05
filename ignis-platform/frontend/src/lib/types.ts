/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * src/lib/types.ts
 * Types centralisés IGNIS (API responses + enums + WS messages)
 *
 * Objectif:
 * - Unifier les types entre pages/components/hooks
 * - Rester compatible avec les petites variations de shape côté backend
 */

/* ──────────────────────────────────────────────────────────────
   Base JSON helpers
────────────────────────────────────────────────────────────── */

export type ISODateString = string;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [k: string]: JsonValue };

/* ──────────────────────────────────────────────────────────────
   Enums (literals)
────────────────────────────────────────────────────────────── */

export const TIMEFRAMES = [
  'M1',
  'M5',
  'M15',
  'M30',
  'H1',
  'H2',
  'H4',
  'H8',
  'D1',
  'W1',
  'MN1',
] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const ZONE_TYPES = ['DEMAND', 'SUPPLY', 'FLIPPY_D', 'FLIPPY_S', 'HIDDEN_D', 'HIDDEN_S'] as const;
export type ZoneType = (typeof ZONE_TYPES)[number];

export const BASE_TYPES = ['RBR', 'DBD', 'RBD', 'DBR'] as const;
export type BaseType = (typeof BASE_TYPES)[number];

export const PA_PATTERNS = ['ACCU', 'THREE_DRIVES', 'FTL', 'PATTERN_69', 'HIDDEN_SDE', 'NONE'] as const;
export type PAPattern = (typeof PA_PATTERNS)[number];

export const SETUP_STATUS = ['VALID', 'PENDING', 'INVALID', 'WATCH', 'EXPIRED'] as const;
export type SetupStatus = (typeof SETUP_STATUS)[number];

export const DP_TYPES = ['SDP', 'SB_LEVEL', 'TREND_LINE', 'KEY_LEVEL'] as const;
export type DPType = (typeof DP_TYPES)[number];

export const MARKET_PHASES = ['RALLY', 'DROP', 'BASE', 'CHOP'] as const;
export type MarketPhase = (typeof MARKET_PHASES)[number];

export type SwingType = 'HH' | 'HL' | 'LH' | 'LL';

export type TradeSide = 'LONG' | 'SHORT';
export type TradeStatus = 'OPEN' | 'CLOSED' | 'CANCELLED';

export type AlertPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | string;

/* ──────────────────────────────────────────────────────────────
   Generic list/pagination shapes (backend may vary)
────────────────────────────────────────────────────────────── */

export type Paginated<T> = {
  total: number;
  items: T[];
  page?: number;
  page_size?: number;
  limit?: number;
  offset?: number;
};

export type ApiMaybeList<T> =
  | T[]
  | { items: T[]; total?: number; page?: number; page_size?: number }
  | { results: T[]; total?: number }
  | { alerts: T[]; total?: number }
  | { assets: T[]; total?: number }
  | { entries: T[]; total?: number };

/* ──────────────────────────────────────────────────────────────
   Core market data types
────────────────────────────────────────────────────────────── */

export interface CandleSchema {
  open_time: number; // sec or ms
  close_time?: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  source?: string;
}

export interface SwingPoint {
  timestamp: number; // sec or ms
  price: number;
  swing_type: SwingType;
  index: number;
}

/* ──────────────────────────────────────────────────────────────
   Analysis types
────────────────────────────────────────────────────────────── */

export interface BaseResult {
  id: string;
  base_type: BaseType;

  zone_top: number;
  zone_bot: number;

  score: number;

  is_solid: boolean;
  is_weakening: boolean;
  is_hidden: boolean;

  touch_count: number;
  candle_count: number;

  formed_at: number; // sec or ms
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

  formed_at: number; // sec or ms
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
  dp_type: DPType;
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

export interface SLTPPlan {
  entry: number;
  stop_loss: number;
  take_profit: number;
  rr: number;
  risk_pips: number;
  reward_pips: number;
  position: TradeSide;
}

export interface SetupScoreBreakdown {
  base_score: number;
  sde_score: number;
  sdp_score: number;
  pa_score: number;
  dp_score: number;
  kl_score: number;
  structure_score: number;
  total: number;
}

export interface SetupResult {
  status: SetupStatus;
  score: number;
  score_breakdown: SetupScoreBreakdown;
  checklist: Record<string, boolean>;
  invalidation_reason?: string;
  pending_step?: string;
}

export interface MarketStructureResult {
  phase: string;
  trend: string;
  swing_points: SwingPoint[];

  last_hh?: number;
  last_hl?: number;
  last_lh?: number;
  last_ll?: number;

  structure_breaks: object[];
  htf_phase?: string;
  htf_bias?: string;
}

export interface AnalysisResponse {
  symbol: string;
  timeframe: string;
  higher_tf?: string;

  analyzed_at: ISODateString;
  candles_used: number;
  duration_ms: number;
  from_cache: boolean;

  market_structure: MarketStructureResult;

  bases: BaseResult[];
  sd_zones: SDZoneResult[];
  pa_patterns: PAResult[];

  advanced: any;

  decision_points: DPResult[];
  key_levels: KeyLevelResult[];

  sl_tp?: SLTPPlan;

  setup: SetupResult;

  candles?: CandleSchema[];

  ai_report?: string;
  ai_summary?: string;
}

export interface AnalysisSummary {
  symbol: string;
  timeframe: string;
  analyzed_at?: ISODateString;
  from_cache?: boolean;
  setup?: { status: SetupStatus; score: number };
}

export interface ScanRequest {
  symbols: string[];
  timeframes: string[];
  min_score?: number;
  status_filter?: string[];
  pa_filter?: string[];
  candle_limit?: number;
}

export interface ScanResponse<T = any> {
  total: number;
  valid_count: number;
  pending_count: number;
  results: T[];
  duration_ms: number;
  errors?: any[];
}

/**
 * ScannerResult: backend peut varier, donc on garde un type souple.
 * Tu peux normaliser en front vers un type strict (cf ScannerResultCardModel).
 */
export type ScannerResult = Record<string, any>;

/* ──────────────────────────────────────────────────────────────
   Assets types
────────────────────────────────────────────────────────────── */

export interface AssetSetupMini {
  status: SetupStatus;
  score: number;
  zone_type?: ZoneType;
  pa_pattern?: PAPattern;
  rr?: number;
}

export interface AssetResponse {
  symbol: string;
  asset_class: string;
  name: string;
  exchange: string;
  active: boolean;

  last_price?: number;
  last_analysis_at?: ISODateString;

  setup?: AssetSetupMini;

  meta?: any;

  created_at: ISODateString;
  updated_at: ISODateString;
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

/* ──────────────────────────────────────────────────────────────
   Alerts types
────────────────────────────────────────────────────────────── */

export interface AlertResponse {
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

  created_at: ISODateString;
  sent_at?: ISODateString;
}

export type AlertEvent = AlertResponse & { timestamp?: ISODateString };

export interface AlertsStatsResponse {
  total?: number;
  sent?: number;
  failed?: number;
  queued?: number;
  by_type?: Record<string, number>;
  by_priority?: Record<string, number>;
}

export interface EmitAlertRequest {
  alert_type: string;
  symbol: string;
  timeframe: string;
  title: string;
  message: string;
  priority?: AlertPriority;
  payload?: any;
  channels?: string[];
}

export interface TestAlertRequest {
  channel?: 'WEBSOCKET' | 'TELEGRAM' | string;
  symbol?: string;
  message?: string;
}

/* ──────────────────────────────────────────────────────────────
   Journal types
────────────────────────────────────────────────────────────── */

export interface JournalEntryResponse {
  id: string;
  symbol: string;
  timeframe: string;

  side: TradeSide;
  status: TradeStatus;

  entry: number;
  sl?: number;
  tp?: number;
  rr?: number;
  size?: number;

  setup_id?: string;
  setup_score?: number;

  opened_at?: ISODateString;
  closed_at?: ISODateString;
  exit_price?: number;

  pnl?: number;
  pnl_pct?: number;

  notes: string;
  tags: string[];

  created_at: ISODateString;
  updated_at: ISODateString;
}

export interface JournalStatsResponse {
  total: number;
  open: number;
  closed: number;

  win_rate: number; // backend peut être 0..1 ou 0..100 (UI gère)
  total_pnl: number;
  avg_rr: number;

  best_trade?: any;
  worst_trade?: any;

  by_symbol: Record<string, any>;
}

export interface CreateJournalEntryRequest {
  symbol: string;
  timeframe?: string;
  side: TradeSide;
  entry: number;

  sl?: number;
  tp?: number;
  rr?: number;
  size?: number;

  setup_id?: string;
  setup_score?: number;

  opened_at?: ISODateString;

  notes?: string;
  tags?: string[];
}

export interface PatchJournalEntryRequest {
  sl?: number;
  tp?: number;
  notes?: string;
  tags?: string[];
  status?: TradeStatus;
}

export interface CloseJournalEntryRequest {
  exit_price: number;
  closed_at?: ISODateString;
  notes?: string;
}

/* ──────────────────────────────────────────────────────────────
   IGNIS AI types
────────────────────────────────────────────────────────────── */

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

export interface AIChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AIChatRequest {
  symbol: string;
  timeframe: string;
  messages: AIChatMessage[];
  model?: string;
  temperature?: number;
  stream?: boolean;
}

export interface AIChatResponse {
  response: string;
  model: string;
  symbol: string;
  timeframe: string;
  tokens_used?: number;
}

export interface AIReportRequest {
  symbol: string;
  timeframe: string;
  higher_tf?: string;
  force_analysis?: boolean;
  report_type?: 'full' | 'short' | string;
  language?: 'fr' | 'en' | string;
}

export interface AIReportResponse {
  symbol: string;
  timeframe: string;
  report: string;
  summary?: string;
  setup_status?: string;
  score?: number;
  generated_at?: ISODateString;
  model?: string;
}

export interface AISummarizeRequest {
  symbol: string;
  timeframe: string;
  max_words?: number;
}

export interface AISummarizeResponse {
  symbol: string;
  timeframe: string;
  summary: string;
  generated_at?: ISODateString;
}

/* ──────────────────────────────────────────────────────────────
   WebSocket protocol types
────────────────────────────────────────────────────────────── */

export type WsRoom = 'alerts' | 'prices' | string;

export type WsClientMessage =
  | { type: 'subscribe'; room: WsRoom }
  | { type: 'unsubscribe'; room: WsRoom }
  | { type: 'ping' }
  | { type: 'request_analysis'; symbol: string; timeframe: string }
  | { type: string; [k: string]: any };

export type WsServerMessage =
  | { type: 'alert'; data: AlertEvent }
  | { type: 'price_update'; data: { symbol: string; price: number; timestamp: ISODateString | number } }
  | { type: 'analysis_ready'; data: AnalysisResponse }
  | { type: 'pong' }
  | { type: string; data?: any; [k: string]: any };