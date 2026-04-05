/**
 * src/lib/constants.ts
 * Centralise les constantes IGNIS (timeframes, enums, couleurs, defaults)
 */

export const APP = {
  name: 'IGNIS Platform',
  version: '1.0.0',
  codename: 'Phoenix',
} as const;

/* ──────────────────────────────────────────────────────────────
   Runtime URLs (override via .env)
────────────────────────────────────────────────────────────── */

export const URLS = {
  apiBase:
    (process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:8000/api/v1') as string,
  wsUrl:
    (process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:8000/ws') as string,
  backendRoot:
    ((process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:8000/api/v1')
      .replace(/\/api\/v1$/, '')) as string,
  swagger:
    (((process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:8000/api/v1')
      .replace(/\/api\/v1$/, '')) + '/docs') as string,
} as const;

/* ──────────────────────────────────────────────────────────────
   Enums / literal lists
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

export const SETUP_STATUS = ['VALID', 'PENDING', 'INVALID', 'WATCH', 'EXPIRED'] as const;
export type SetupStatus = (typeof SETUP_STATUS)[number];

export const ZONE_TYPES = ['DEMAND', 'SUPPLY', 'FLIPPY_D', 'FLIPPY_S', 'HIDDEN_D', 'HIDDEN_S'] as const;
export type ZoneType = (typeof ZONE_TYPES)[number];

export const BASE_TYPES = ['RBR', 'DBD', 'RBD', 'DBR'] as const;
export type BaseType = (typeof BASE_TYPES)[number];

export const PA_PATTERNS = ['ACCU', 'THREE_DRIVES', 'FTL', 'PATTERN_69', 'HIDDEN_SDE', 'NONE'] as const;
export type PAPattern = (typeof PA_PATTERNS)[number];

export const DP_TYPES = ['SDP', 'SB_LEVEL', 'TREND_LINE', 'KEY_LEVEL'] as const;
export type DPType = (typeof DP_TYPES)[number];

export const MARKET_PHASES = ['RALLY', 'DROP', 'BASE', 'CHOP'] as const;
export type MarketPhase = (typeof MARKET_PHASES)[number];

/* ──────────────────────────────────────────────────────────────
   Design tokens (colors)
────────────────────────────────────────────────────────────── */

export const COLORS = {
  bg: '#0A0A0F',
  card: 'rgba(255,255,255,0.05)',
  border: 'rgba(255,255,255,0.10)',
  text: 'rgba(255,255,255,0.92)',
  muted: 'rgba(255,255,255,0.60)',

  orange: '#E85D1A',
  blue: '#378ADD',
  green: '#1D9E75',
  red: '#E24B4A',
  zinc: '#A1A1AA',

  // zone colors
  zone: {
    DEMAND: '#1D9E75',
    SUPPLY: '#E24B4A',
    FLIPPY_D: '#378ADD',
    FLIPPY_S: '#E85D1A',
    HIDDEN_D: '#2AD4A5',
    HIDDEN_S: '#FF6B6A',
  } as const,
} as const;

/* ──────────────────────────────────────────────────────────────
   Defaults for UI / API calls
────────────────────────────────────────────────────────────── */

export const DEFAULTS = {
  analysis: {
    timeframe: 'H4' as Timeframe,
    higherTf: 'D1' as Timeframe,
    candleLimit: 500,
    includeAi: false,
    includeLtf: false,
    forceRefresh: false,
  },

  scanner: {
    timeframes: ['H4', 'D1'] as Timeframe[],
    candleLimit: 300,
    minScore: 60,
    statusFilter: ['VALID', 'PENDING'] as SetupStatus[],
    paFilter: [] as PAPattern[],
  },

  assets: {
    assetClass: 'CRYPTO' as const,
    activeOnly: true,
    pageSize: 60,
  },

  alerts: {
    limit: 50,
    pollMs: 30_000,
  },

  ai: {
    temperature: 0.35,
    stream: true,
    language: 'fr' as const,
  },
} as const;

/* ──────────────────────────────────────────────────────────────
   Helpers (small pure funcs)
────────────────────────────────────────────────────────────── */

export function isTimeframe(tf: string): tf is Timeframe {
  return (TIMEFRAMES as readonly string[]).includes(tf);
}

export function zoneLabel(t: ZoneType) {
  switch (t) {
    case 'DEMAND': return 'Demand';
    case 'SUPPLY': return 'Supply';
    case 'FLIPPY_D': return 'Flippy D';
    case 'FLIPPY_S': return 'Flippy S';
    case 'HIDDEN_D': return 'Hidden D';
    case 'HIDDEN_S': return 'Hidden S';
    default: return t;
  }
}

export function paLabel(p: PAPattern) {
  switch (p) {
    case 'THREE_DRIVES': return '3 Drives';
    case 'PATTERN_69': return 'Pattern 69';
    case 'HIDDEN_SDE': return 'Hidden SDE';
    default: return p;
  }
}

export function setupStatusLabel(s: SetupStatus) {
  return s;
}

export function zoneColor(t: ZoneType) {
  return COLORS.zone[t] ?? COLORS.zinc;
}

export function scoreToGradient(score: number) {
  const s = Math.max(0, Math.min(100, score ?? 0));
  if (s >= 85) return 'from-emerald-400/60 to-emerald-700/10';
  if (s >= 70) return 'from-orange-400/60 to-orange-700/10';
  if (s >= 55) return 'from-amber-400/60 to-amber-700/10';
  return 'from-rose-400/60 to-rose-700/10';
}