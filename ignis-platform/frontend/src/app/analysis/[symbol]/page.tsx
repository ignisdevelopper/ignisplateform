/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';

// Lightweight Charts (TradingView)
import {
  createChart,
  CrosshairMode,
  LineStyle,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  type CandlestickData,
  type SeriesMarker,
  type PriceLine,
} from 'lightweight-charts';

/* ──────────────────────────────────────────────────────────────
   Types (reprend ton schéma - version locale pour cette page)
────────────────────────────────────────────────────────────── */

type SetupStatus = 'VALID' | 'PENDING' | 'INVALID' | 'WATCH' | 'EXPIRED';
type ZoneType = 'DEMAND' | 'SUPPLY' | 'FLIPPY_D' | 'FLIPPY_S' | 'HIDDEN_D' | 'HIDDEN_S';
type PAPattern = 'ACCU' | 'THREE_DRIVES' | 'FTL' | 'PATTERN_69' | 'HIDDEN_SDE' | 'NONE';

type SwingType = 'HH' | 'HL' | 'LH' | 'LL';

type Timeframe = 'M1'|'M5'|'M15'|'M30'|'H1'|'H2'|'H4'|'H8'|'D1'|'W1'|'MN1';

interface CandleSchema {
  open_time: number; // ms or s
  close_time?: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

interface BaseResult {
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

interface SDZoneResult {
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

interface PAResult {
  id?: string;
  pattern: PAPattern;
  score: number;
  formed_at?: number;
  timeframe?: string;
  meta?: Record<string, any>;
}

interface DPResult {
  id?: string;
  dp_type: 'SDP' | 'SB_LEVEL' | 'TREND_LINE' | 'KEY_LEVEL';
  price: number;
  score: number;
  timeframe?: string;
  formed_at?: number;
  meta?: Record<string, any>;
}

interface KeyLevelResult {
  id?: string;
  price: number;
  kind?: string;
  score?: number;
  timeframe?: string;
  formed_at?: number;
  meta?: Record<string, any>;
}

interface AnalysisResponse {
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
   Config runtime
────────────────────────────────────────────────────────────── */

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:8000/api/v1';

const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ??
  'ws://localhost:8000/ws';

const TIMEFRAMES: Timeframe[] = ['M15','M30','H1','H2','H4','H8','D1','W1','MN1'];

/* ──────────────────────────────────────────────────────────────
   UI helpers (Glass, badges, formatting)
────────────────────────────────────────────────────────────── */

function cn(...classes: Array<string | undefined | false | null>) {
  return classes.filter(Boolean).join(' ');
}

function formatNumber(n: number | undefined, digits = 2) {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits }).format(n);
}

function formatTs(ts: number | undefined) {
  if (!ts) return '—';
  const ms = ts < 10_000_000_000 ? ts * 1000 : ts; // accept seconds or ms
  return new Date(ms).toLocaleString('fr-FR', { hour12: false });
}

function statusPill(status: SetupStatus) {
  switch (status) {
    case 'VALID':
      return { label: 'VALID', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25' };
    case 'PENDING':
      return { label: 'PENDING', cls: 'bg-sky-500/15 text-sky-300 border-sky-500/25' };
    case 'WATCH':
      return { label: 'WATCH', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/25' };
    case 'INVALID':
      return { label: 'INVALID', cls: 'bg-rose-500/15 text-rose-300 border-rose-500/25' };
    case 'EXPIRED':
      return { label: 'EXPIRED', cls: 'bg-zinc-500/15 text-zinc-300 border-zinc-500/25' };
    default:
      return { label: status, cls: 'bg-zinc-500/15 text-zinc-300 border-zinc-500/25' };
  }
}

function zoneColor(zoneType: ZoneType) {
  switch (zoneType) {
    case 'DEMAND':
      return '#1D9E75';
    case 'SUPPLY':
      return '#E24B4A';
    case 'FLIPPY_D':
      return '#378ADD';
    case 'FLIPPY_S':
      return '#E85D1A';
    case 'HIDDEN_D':
      return '#2AD4A5';
    case 'HIDDEN_S':
      return '#FF6B6A';
    default:
      return '#A1A1AA';
  }
}

function zoneLabel(zoneType: ZoneType) {
  switch (zoneType) {
    case 'DEMAND': return 'Demand';
    case 'SUPPLY': return 'Supply';
    case 'FLIPPY_D': return 'Flippy D';
    case 'FLIPPY_S': return 'Flippy S';
    case 'HIDDEN_D': return 'Hidden D';
    case 'HIDDEN_S': return 'Hidden S';
    default: return zoneType;
  }
}

function scoreToGradient(score: number) {
  // 0..100 -> red..orange..green
  if (score >= 80) return 'from-emerald-400/60 to-emerald-600/20';
  if (score >= 60) return 'from-orange-400/60 to-orange-600/20';
  if (score >= 40) return 'from-amber-400/60 to-amber-600/20';
  return 'from-rose-400/60 to-rose-600/20';
}

/* ──────────────────────────────────────────────────────────────
   Chart component (candles + overlays price lines + markers)
────────────────────────────────────────────────────────────── */

type ChartOverlay = {
  zoneLines: PriceLine[];
  dpLines: PriceLine[];
  klLines: PriceLine[];
};

function TradingChart({
  candles,
  zones,
  decisionPoints,
  keyLevels,
  swingPoints,
  selectedZoneId,
  onCrosshairPrice,
}: {
  candles: CandleSchema[] | undefined;
  zones: SDZoneResult[];
  decisionPoints: DPResult[];
  keyLevels: KeyLevelResult[];
  swingPoints: AnalysisResponse['market_structure']['swing_points'];
  selectedZoneId: string | null;
  onCrosshairPrice?: (price: number | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const overlaysRef = useRef<ChartOverlay>({ zoneLines: [], dpLines: [], klLines: [] });

  const setData = useCallback(() => {
    if (!chartRef.current || !candleSeriesRef.current) return;

    const hasCandles = Array.isArray(candles) && candles.length > 0;
    if (!hasCandles) {
      candleSeriesRef.current.setData([]);
      return;
    }

    const data: CandlestickData[] = candles!.map((c) => {
      const t = (c.open_time < 10_000_000_000 ? c.open_time : Math.floor(c.open_time / 1000)) as UTCTimestamp;
      return { time: t, open: c.open, high: c.high, low: c.low, close: c.close };
    });

    candleSeriesRef.current.setData(data);

    // markers from swing points
    const markers: SeriesMarker<UTCTimestamp>[] = (swingPoints ?? []).map((sp) => {
      const t = (sp.timestamp < 10_000_000_000 ? sp.timestamp : Math.floor(sp.timestamp / 1000)) as UTCTimestamp;
      const isHigh = sp.swing_type === 'HH' || sp.swing_type === 'LH';
      const color = sp.swing_type === 'HH' ? '#1D9E75'
        : sp.swing_type === 'HL' ? '#2AD4A5'
        : sp.swing_type === 'LH' ? '#FF6B6A'
        : '#E24B4A';
      return {
        time: t,
        position: isHigh ? 'aboveBar' : 'belowBar',
        color,
        shape: isHigh ? 'arrowDown' : 'arrowUp',
        text: sp.swing_type,
      };
    });

    candleSeriesRef.current.setMarkers(markers);

    // fit content
    chartRef.current.timeScale().fitContent();
  }, [candles, swingPoints]);

  const clearOverlays = useCallback(() => {
    const series = candleSeriesRef.current;
    if (!series) return;

    for (const pl of overlaysRef.current.zoneLines) series.removePriceLine(pl);
    for (const pl of overlaysRef.current.dpLines) series.removePriceLine(pl);
    for (const pl of overlaysRef.current.klLines) series.removePriceLine(pl);

    overlaysRef.current = { zoneLines: [], dpLines: [], klLines: [] };
  }, []);

  const renderOverlays = useCallback(() => {
    const series = candleSeriesRef.current;
    if (!series) return;

    clearOverlays();

    // Zones: draw top/bottom as price lines
    const zoneLines: PriceLine[] = [];
    for (const z of zones) {
      const col = zoneColor(z.zone_type);
      const isSelected = selectedZoneId === z.id;

      const common = {
        color: col,
        lineWidth: isSelected ? 3 : 1,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
      } as const;

      zoneLines.push(
        series.createPriceLine({
          ...common,
          price: z.zone_top,
          title: `${zoneLabel(z.zone_type)} TOP · ${formatNumber(z.score, 0)}%`,
        })
      );
      zoneLines.push(
        series.createPriceLine({
          ...common,
          price: z.zone_bot,
          title: `${zoneLabel(z.zone_type)} BOT`,
        })
      );
    }

    // Decision points: dotted lines
    const dpLines: PriceLine[] = [];
    for (const dp of decisionPoints ?? []) {
      dpLines.push(
        series.createPriceLine({
          price: dp.price,
          color: 'rgba(232,93,26,0.85)',
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: `DP · ${dp.dp_type} · ${formatNumber(dp.score, 0)}%`,
        })
      );
    }

    // Key levels: dashed lines
    const klLines: PriceLine[] = [];
    for (const kl of keyLevels ?? []) {
      klLines.push(
        series.createPriceLine({
          price: kl.price,
          color: 'rgba(55,138,221,0.85)',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `KL · ${formatNumber(kl.score ?? 0, 0)}%`,
        })
      );
    }

    overlaysRef.current = { zoneLines, dpLines, klLines };
  }, [zones, decisionPoints, keyLevels, selectedZoneId, clearOverlays]);

  useEffect(() => {
    if (!containerRef.current) return;

    // Init chart
    const chart = createChart(containerRef.current, {
      height: 520,
      layout: {
        background: { type: ColorType.Solid, color: 'rgba(10,10,15,0.2)' },
        textColor: 'rgba(255,255,255,0.85)',
        fontFamily: 'system-ui, -apple-system, "SF Pro Display", "SF Pro Text", sans-serif',
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.06)' },
        horzLines: { color: 'rgba(255,255,255,0.06)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: 'rgba(255,255,255,0.15)', width: 1, style: LineStyle.Solid },
        horzLine: { color: 'rgba(255,255,255,0.15)', width: 1, style: LineStyle.Solid },
      },
      rightPriceScale: {
        borderColor: 'rgba(255,255,255,0.08)',
      },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.08)',
        rightOffset: 10,
      },
      handleScroll: true,
      handleScale: true,
    });

    const series = chart.addCandlestickSeries({
      upColor: 'rgba(29,158,117,0.95)',
      downColor: 'rgba(226,75,74,0.95)',
      borderVisible: false,
      wickUpColor: 'rgba(29,158,117,0.95)',
      wickDownColor: 'rgba(226,75,74,0.95)',
    });

    chartRef.current = chart;
    candleSeriesRef.current = series;

    const unsub = chart.subscribeCrosshairMove((param) => {
      if (!onCrosshairPrice) return;
      const price = param?.seriesData?.get(series as any)?.close;
      if (typeof price === 'number') onCrosshairPrice(price);
      else onCrosshairPrice(null);
    });

    const ro = new ResizeObserver(() => {
      if (!containerRef.current || !chartRef.current) return;
      chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
    });
    ro.observe(containerRef.current);

    return () => {
      try { unsub?.(); } catch {}
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
    };
  }, [onCrosshairPrice]);

  useEffect(() => {
    setData();
  }, [setData]);

  useEffect(() => {
    renderOverlays();
  }, [renderOverlays]);

  return (
    <div className="relative">
      <div
        ref={containerRef}
        className="w-full rounded-2xl border border-white/10 bg-white/5 backdrop-blur-[20px] shadow-[0_30px_90px_rgba(0,0,0,0.55)] overflow-hidden"
      />
      {!candles?.length && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="rounded-xl border border-white/10 bg-black/40 px-4 py-2 text-sm text-white/80 backdrop-blur-md">
            Aucun candle reçu dans la réponse d’analyse (champ <code>candles</code> vide).<br />
            Tu peux quand même lire zones/DP/KL et structure.
          </div>
        </div>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Main page
────────────────────────────────────────────────────────────── */

export default function AnalysisSymbolPage({ params }: { params: { symbol: string } }) {
  const router = useRouter();
  const symbol = decodeURIComponent(params.symbol ?? '').toUpperCase();

  // Query controls
  const [timeframe, setTimeframe] = useState<Timeframe>('H4');
  const [higherTf, setHigherTf] = useState<Timeframe | ''>('D1');
  const [candleLimit, setCandleLimit] = useState<number>(500);
  const [includeAI, setIncludeAI] = useState<boolean>(false);
  const [includeLTF, setIncludeLTF] = useState<boolean>(false);
  const [forceRefresh, setForceRefresh] = useState<boolean>(false);

  // Data
  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [aiLoading, setAiLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // UX
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<'setup'|'zones'|'structure'|'confluence'|'ai'>('setup');
  const [crosshairPrice, setCrosshairPrice] = useState<number | null>(null);

  // WebSocket state
  const wsRef = useRef<WebSocket | null>(null);
  const [wsStatus, setWsStatus] = useState<'DISCONNECTED'|'CONNECTING'|'CONNECTED'>('DISCONNECTED');

  const zonesSorted = useMemo(() => {
    const zs = analysis?.sd_zones ?? [];
    return [...zs].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }, [analysis?.sd_zones]);

  const bestZone = useMemo(() => zonesSorted[0] ?? null, [zonesSorted]);

  const selectedZone = useMemo(() => {
    if (!selectedZoneId) return null;
    return (analysis?.sd_zones ?? []).find(z => z.id === selectedZoneId) ?? null;
  }, [analysis?.sd_zones, selectedZoneId]);

  const setupPill = useMemo(() => analysis ? statusPill(analysis.setup.status) : null, [analysis]);

  const doAnalyze = useCallback(async (opts?: { viaWs?: boolean }) => {
    setError(null);

    // If WS requested and available: use WS request_analysis (backend will push analysis_ready)
    if (opts?.viaWs && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      setLoading(true);
      wsRef.current.send(JSON.stringify({
        type: 'request_analysis',
        symbol,
        timeframe,
      }));
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/analysis/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol,
          timeframe,
          higher_tf: higherTf || undefined,
          candle_limit: candleLimit,
          force_refresh: forceRefresh,
          include_ltf: includeLTF,
          include_ai: includeAI,
        }),
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${txt || 'Erreur analyse'}`);
      }

      const data = (await res.json()) as AnalysisResponse;
      setAnalysis(data);

      // auto-select best zone if none selected
      setSelectedZoneId((prev) => prev ?? (data.sd_zones?.[0]?.id ?? null));
    } catch (e: any) {
      setError(e?.message ?? 'Erreur inconnue');
    } finally {
      setLoading(false);
    }
  }, [symbol, timeframe, higherTf, candleLimit, forceRefresh, includeLTF, includeAI]);

  const clearCache = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/analysis/cache/${encodeURIComponent(symbol)}?timeframe=${encodeURIComponent(timeframe)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${txt || 'Erreur cache'}`);
      }
    } catch (e: any) {
      setError(e?.message ?? 'Erreur inconnue');
    }
  }, [symbol, timeframe]);

  const generateAIReport = useCallback(async () => {
    setError(null);
    setAiLoading(true);
    try {
      const res = await fetch(`${API_BASE}/ai/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol,
          timeframe,
          higher_tf: higherTf || undefined,
          force_analysis: false,
          report_type: 'full',
          language: 'fr',
        }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${txt || 'Erreur IA report'}`);
      }
      const data = await res.json();
      setAnalysis((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          ai_report: data.report ?? prev.ai_report,
          ai_summary: data.summary ?? prev.ai_summary,
        };
      });
      setRightTab('ai');
    } catch (e: any) {
      setError(e?.message ?? 'Erreur inconnue');
    } finally {
      setAiLoading(false);
    }
  }, [symbol, timeframe, higherTf]);

  // WebSocket connect / reconnect (simple)
  useEffect(() => {
    let alive = true;
    let ws: WebSocket | null = null;
    let retry = 0;
    let retryTimer: any = null;

    const connect = () => {
      if (!alive) return;
      setWsStatus('CONNECTING');

      ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!alive) return;
        retry = 0;
        setWsStatus('CONNECTED');
        ws?.send(JSON.stringify({ type: 'subscribe', room: 'alerts' })); // optionnel, mais utile plus tard
        ws?.send(JSON.stringify({ type: 'ping' }));
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg?.type === 'analysis_ready') {
            const data = msg?.data as AnalysisResponse;
            // Ne prendre que si c'est notre symbol+tf
            if (data?.symbol?.toUpperCase() === symbol && data?.timeframe === timeframe) {
              setAnalysis(data);
              setSelectedZoneId((prev) => prev ?? (data.sd_zones?.[0]?.id ?? null));
              setLoading(false);
            }
          }
          if (msg?.type === 'pong') {
            // noop
          }
        } catch {
          // ignore non-json
        }
      };

      ws.onclose = () => {
        if (!alive) return;
        setWsStatus('DISCONNECTED');

        const delay = Math.min(3000 + retry * 1500, 12000);
        retry += 1;
        retryTimer = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // onclose will handle retry
      };
    };

    connect();

    return () => {
      alive = false;
      if (retryTimer) clearTimeout(retryTimer);
      try { ws?.close(); } catch {}
      wsRef.current = null;
    };
  }, [symbol, timeframe]);

  // Auto-analyze on first load / when symbol changes
  useEffect(() => {
    setAnalysis(null);
    setSelectedZoneId(null);
    doAnalyze({ viaWs: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  const topStats = useMemo(() => {
    if (!analysis) return null;
    const score = analysis.setup?.score ?? 0;
    const ss = analysis.setup?.status;
    return {
      score,
      status: ss,
      fromCache: analysis.from_cache,
      duration: analysis.duration_ms,
      candlesUsed: analysis.candles_used,
      analyzedAt: analysis.analyzed_at,
      phase: analysis.market_structure?.phase,
      trend: analysis.market_structure?.trend,
    };
  }, [analysis]);

  const checklistEntries = useMemo(() => {
    const cl = analysis?.setup?.checklist ?? {};
    return Object.entries(cl).sort((a, b) => a[0].localeCompare(b[0]));
  }, [analysis?.setup?.checklist]);

  return (
    <div className="min-h-screen bg-[#0A0A0F] text-white">
      {/* background glow */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-20 left-1/3 h-[420px] w-[420px] rounded-full bg-[#E85D1A]/15 blur-[80px]" />
        <div className="absolute top-1/2 right-1/4 h-[360px] w-[360px] rounded-full bg-[#378ADD]/12 blur-[90px]" />
        <div className="absolute bottom-0 left-1/4 h-[360px] w-[360px] rounded-full bg-[#1D9E75]/10 blur-[90px]" />
      </div>

      <div className="relative mx-auto max-w-[1600px] px-6 py-6">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-5"
        >
          <div className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/5 backdrop-blur-[20px] px-5 py-4 shadow-[0_20px_70px_rgba(0,0,0,0.55)]">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <Link
                  href="/"
                  className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/85 hover:bg-white/10 transition"
                >
                  ← Dashboard
                </Link>

                <div className="flex flex-col">
                  <div className="flex items-center gap-3">
                    <h1 className="text-xl font-semibold tracking-tight">
                      Analyse — <span className="text-white">{symbol}</span>
                    </h1>

                    {analysis && setupPill && (
                      <span className={cn(
                        'rounded-full border px-3 py-1 text-xs font-medium',
                        setupPill.cls
                      )}>
                        {setupPill.label}
                      </span>
                    )}

                    <span className={cn(
                      'rounded-full border px-3 py-1 text-xs font-medium',
                      wsStatus === 'CONNECTED'
                        ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200'
                        : wsStatus === 'CONNECTING'
                          ? 'border-sky-500/20 bg-sky-500/10 text-sky-200'
                          : 'border-rose-500/20 bg-rose-500/10 text-rose-200'
                    )}>
                      WS: {wsStatus}
                    </span>
                  </div>

                  <div className="text-xs text-white/60">
                    {analysis
                      ? <>Dernière analyse: <span className="text-white/80">{new Date(analysis.analyzed_at).toLocaleString('fr-FR', { hour12: false })}</span></>
                      : 'Prêt.'}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => router.refresh()}
                  className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10 transition"
                  title="Refresh UI"
                >
                  Refresh UI
                </button>

                <button
                  onClick={() => clearCache()}
                  className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10 transition"
                  title="Supprime cache backend pour ce symbol/timeframe"
                >
                  Clear cache
                </button>

                <button
                  onClick={() => doAnalyze({ viaWs: false })}
                  className="rounded-xl border border-white/10 bg-gradient-to-b from-[#E85D1A]/90 to-[#E85D1A]/40 px-4 py-2 text-sm font-medium text-white shadow-[0_12px_40px_rgba(232,93,26,0.25)] hover:from-[#E85D1A] hover:to-[#E85D1A]/50 transition"
                  disabled={loading}
                >
                  {loading ? 'Analyse…' : 'Analyze (HTTP)'}
                </button>

                <button
                  onClick={() => doAnalyze({ viaWs: true })}
                  className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-white/85 hover:bg-white/10 transition"
                  disabled={loading || wsStatus !== 'CONNECTED'}
                  title={wsStatus !== 'CONNECTED' ? 'WS non connecté' : 'Demande analyse via WS'}
                >
                  Analyze (WS)
                </button>
              </div>
            </div>

            {/* Controls */}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
              <div className="md:col-span-2">
                <label className="block text-xs text-white/60 mb-1">Timeframe</label>
                <select
                  value={timeframe}
                  onChange={(e) => setTimeframe(e.target.value as Timeframe)}
                  className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
                >
                  {TIMEFRAMES.map(tf => (
                    <option key={tf} value={tf}>{tf}</option>
                  ))}
                </select>
              </div>

              <div className="md:col-span-2">
                <label className="block text-xs text-white/60 mb-1">Higher TF (option)</label>
                <select
                  value={higherTf}
                  onChange={(e) => setHigherTf(e.target.value as any)}
                  className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
                >
                  <option value="">—</option>
                  {TIMEFRAMES.filter(tf => ['H4','H8','D1','W1','MN1'].includes(tf)).map(tf => (
                    <option key={tf} value={tf}>{tf}</option>
                  ))}
                </select>
              </div>

              <div className="md:col-span-2">
                <label className="block text-xs text-white/60 mb-1">Candle limit</label>
                <input
                  type="number"
                  min={100}
                  max={5000}
                  value={candleLimit}
                  onChange={(e) => setCandleLimit(Number(e.target.value || 0))}
                  className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
                />
              </div>

              <div className="md:col-span-6 flex flex-wrap items-end gap-3">
                <Toggle
                  label="Force refresh"
                  hint="Ignore cache backend"
                  value={forceRefresh}
                  onChange={setForceRefresh}
                />
                <Toggle
                  label="Include LTF"
                  hint="Analyse lower TF si backend support"
                  value={includeLTF}
                  onChange={setIncludeLTF}
                />
                <Toggle
                  label="Include AI"
                  hint="Ajoute ai_report/ai_summary"
                  value={includeAI}
                  onChange={setIncludeAI}
                />
              </div>
            </div>

            {/* Top stats */}
            {analysis && topStats && (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
                <Stat label="Score" value={`${formatNumber(topStats.score, 0)}%`} accent />
                <Stat label="Phase" value={topStats.phase ?? '—'} />
                <Stat label="Trend" value={topStats.trend ?? '—'} />
                <Stat label="Candles" value={`${topStats.candlesUsed}`} />
                <Stat label="Duration" value={`${formatNumber(topStats.duration, 0)} ms`} />
                <Stat label="Cache" value={topStats.fromCache ? 'Oui' : 'Non'} />
              </div>
            )}

            {error && (
              <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                {error}
              </div>
            )}
          </div>
        </motion.div>

        {/* Main layout */}
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
          {/* Left: Chart */}
          <div className="xl:col-span-8 space-y-5">
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm text-white/70">
                  Crosshair: <span className="text-white/90">{crosshairPrice ? formatNumber(crosshairPrice, 2) : '—'}</span>
                  {selectedZone && (
                    <>
                      <span className="mx-2 text-white/30">·</span>
                      Zone sélectionnée: <span className="text-white/90">{zoneLabel(selectedZone.zone_type)}</span>
                      <span className="mx-2 text-white/30">·</span>
                      Score: <span className="text-white/90">{formatNumber(selectedZone.score, 0)}%</span>
                    </>
                  )}
                </div>

                <div className="text-xs text-white/55">
                  Tip: clique une zone à droite pour la mettre en évidence.
                </div>
              </div>

              <TradingChart
                candles={analysis?.candles}
                zones={analysis?.sd_zones ?? []}
                decisionPoints={analysis?.decision_points ?? []}
                keyLevels={analysis?.key_levels ?? []}
                swingPoints={analysis?.market_structure?.swing_points ?? []}
                selectedZoneId={selectedZoneId}
                onCrosshairPrice={setCrosshairPrice}
              />
            </motion.div>

            {/* Quick Confluence Card */}
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
              <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-[20px] p-5 shadow-[0_25px_80px_rgba(0,0,0,0.55)]">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-base font-semibold">Confluence rapide</h2>
                  {analysis?.sl_tp && (
                    <span className={cn(
                      'rounded-full border px-3 py-1 text-xs',
                      analysis.sl_tp.position === 'LONG'
                        ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200'
                        : 'border-rose-500/25 bg-rose-500/10 text-rose-200'
                    )}>
                      {analysis.sl_tp.position} · RR {formatNumber(analysis.sl_tp.rr, 2)}
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  <InfoRow
                    label="Meilleure zone"
                    value={bestZone ? `${zoneLabel(bestZone.zone_type)} · ${formatNumber(bestZone.score, 0)}%` : '—'}
                    sub={bestZone ? `Top ${formatNumber(bestZone.zone_top, 2)} / Bot ${formatNumber(bestZone.zone_bot, 2)} · FTB ${bestZone.ftb_count}` : undefined}
                  />
                  <InfoRow
                    label="Setup status"
                    value={analysis ? analysis.setup.status : '—'}
                    sub={analysis?.setup.invalidation_reason ? `Invalidation: ${analysis.setup.invalidation_reason}` : (analysis?.setup.pending_step ? `Pending: ${analysis.setup.pending_step}` : undefined)}
                  />
                  <InfoRow
                    label="Structure"
                    value={analysis ? `${analysis.market_structure.phase} · ${analysis.market_structure.trend}` : '—'}
                    sub={analysis?.market_structure.htf_bias ? `HTF bias: ${analysis.market_structure.htf_bias}` : undefined}
                  />
                </div>

                {analysis?.sl_tp && (
                  <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                    <Stat label="Entry" value={formatNumber(analysis.sl_tp.entry, 2)} />
                    <Stat label="Stop" value={formatNumber(analysis.sl_tp.stop_loss, 2)} />
                    <Stat label="Target" value={formatNumber(analysis.sl_tp.take_profit, 2)} />
                    <Stat label="Risk/Reward" value={`${formatNumber(analysis.sl_tp.risk_pips, 1)} / ${formatNumber(analysis.sl_tp.reward_pips, 1)}`} />
                  </div>
                )}
              </div>
            </motion.div>
          </div>

          {/* Right: Panels */}
          <div className="xl:col-span-4 space-y-5">
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
              <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-[20px] shadow-[0_25px_80px_rgba(0,0,0,0.55)] overflow-hidden">
                {/* tabs */}
                <div className="flex items-center gap-1 border-b border-white/10 bg-black/20 px-2 py-2">
                  <TabButton active={rightTab === 'setup'} onClick={() => setRightTab('setup')}>Setup</TabButton>
                  <TabButton active={rightTab === 'zones'} onClick={() => setRightTab('zones')}>Zones</TabButton>
                  <TabButton active={rightTab === 'structure'} onClick={() => setRightTab('structure')}>Structure</TabButton>
                  <TabButton active={rightTab === 'confluence'} onClick={() => setRightTab('confluence')}>DP/KL/PA</TabButton>
                  <TabButton active={rightTab === 'ai'} onClick={() => setRightTab('ai')}>IA</TabButton>
                </div>

                <div className="p-4">
                  <AnimatePresence mode="wait">
                    {rightTab === 'setup' && (
                      <motion.div
                        key="setup"
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                        className="space-y-4"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-sm text-white/60">Score global</div>
                            <div className="text-3xl font-semibold tracking-tight">
                              {analysis ? `${formatNumber(analysis.setup.score, 0)}%` : '—'}
                            </div>
                          </div>

                          {analysis && (
                            <div className={cn(
                              'rounded-2xl border p-3',
                              'bg-gradient-to-b',
                              scoreToGradient(analysis.setup.score),
                              'border-white/10'
                            )}>
                              <div className="text-xs text-white/70">Status</div>
                              <div className="text-sm font-semibold">{analysis.setup.status}</div>
                              <div className="text-[11px] text-white/60 mt-1">
                                {analysis.from_cache ? 'From cache' : 'Fresh'}
                                <span className="mx-2 text-white/20">·</span>
                                {formatNumber(analysis.duration_ms, 0)} ms
                              </div>
                            </div>
                          )}
                        </div>

                        <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                          <div className="text-xs font-medium text-white/70 mb-2">Score breakdown</div>
                          <div className="space-y-2">
                            <ScoreBar label="Base" value={analysis?.setup.score_breakdown.base_score ?? 0} />
                            <ScoreBar label="SDE" value={analysis?.setup.score_breakdown.sde_score ?? 0} />
                            <ScoreBar label="SDP" value={analysis?.setup.score_breakdown.sdp_score ?? 0} />
                            <ScoreBar label="PA" value={analysis?.setup.score_breakdown.pa_score ?? 0} />
                            <ScoreBar label="DP" value={analysis?.setup.score_breakdown.dp_score ?? 0} />
                            <ScoreBar label="KeyLv" value={analysis?.setup.score_breakdown.kl_score ?? 0} />
                            <ScoreBar label="Structure" value={analysis?.setup.score_breakdown.structure_score ?? 0} />
                          </div>
                        </div>

                        <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                          <div className="text-xs font-medium text-white/70 mb-2">Checklist</div>
                          <div className="grid grid-cols-1 gap-2">
                            {analysis ? checklistEntries.map(([k, v]) => (
                              <div key={k} className="flex items-center justify-between gap-3">
                                <div className="text-xs text-white/70 truncate">{k}</div>
                                <span className={cn(
                                  'rounded-full border px-2.5 py-1 text-[11px] font-medium',
                                  v
                                    ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200'
                                    : 'border-rose-500/25 bg-rose-500/10 text-rose-200'
                                )}>
                                  {v ? 'OK' : 'NO'}
                                </span>
                              </div>
                            )) : (
                              <div className="text-xs text-white/50">Aucune donnée.</div>
                            )}
                          </div>
                        </div>
                      </motion.div>
                    )}

                    {rightTab === 'zones' && (
                      <motion.div
                        key="zones"
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                        className="space-y-3"
                      >
                        <div className="flex items-center justify-between">
                          <div className="text-sm font-semibold">Zones S&D</div>
                          <div className="text-xs text-white/60">
                            {analysis ? `${analysis.sd_zones.length} zones` : '—'}
                          </div>
                        </div>

                        <div className="space-y-2">
                          {analysis?.sd_zones?.length ? zonesSorted.map((z) => {
                            const isSel = z.id === selectedZoneId;
                            const col = zoneColor(z.zone_type);

                            return (
                              <button
                                key={z.id}
                                onClick={() => setSelectedZoneId(z.id)}
                                className={cn(
                                  'w-full text-left rounded-xl border px-3 py-3 transition',
                                  isSel
                                    ? 'border-white/20 bg-white/10'
                                    : 'border-white/10 bg-black/20 hover:bg-white/10'
                                )}
                              >
                                <div className="flex items-center justify-between gap-3">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <span
                                      className="h-2.5 w-2.5 rounded-full"
                                      style={{ backgroundColor: col }}
                                    />
                                    <div className="min-w-0">
                                      <div className="text-sm font-medium truncate">
                                        {zoneLabel(z.zone_type)}
                                        <span className="text-white/40 font-normal"> · {formatNumber(z.score, 0)}%</span>
                                      </div>
                                      <div className="text-[11px] text-white/55 truncate">
                                        Top {formatNumber(z.zone_top, 2)} · Bot {formatNumber(z.zone_bot, 2)} · {z.timeframe}
                                      </div>
                                    </div>
                                  </div>

                                  <div className="flex items-center gap-2">
                                    <Badge ok={z.sde_confirmed} label={`SDE ${formatNumber(z.sde_score, 0)}%`} />
                                    <Badge ok={z.sdp_validated} label="SDP" />
                                    <Badge ok={z.is_ftb_valid} label={`FTB ${z.ftb_count}`} />
                                  </div>
                                </div>

                                <div className="mt-2 grid grid-cols-3 gap-2">
                                  <MiniStat label="Base" value={`${z.base.base_type} · ${formatNumber(z.base.score, 0)}%`} />
                                  <MiniStat label="Touches" value={`${z.base.touch_count}`} />
                                  <MiniStat label="Formed" value={formatTs(z.formed_at)} />
                                </div>
                              </button>
                            );
                          }) : (
                            <div className="rounded-xl border border-white/10 bg-black/20 p-3 text-sm text-white/60">
                              Pas de zones disponibles (ou analyse non chargée).
                            </div>
                          )}
                        </div>
                      </motion.div>
                    )}

                    {rightTab === 'structure' && (
                      <motion.div
                        key="structure"
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                        className="space-y-3"
                      >
                        <div className="text-sm font-semibold">Structure de marché</div>

                        <div className="grid grid-cols-2 gap-2">
                          <MiniStat label="Phase" value={analysis?.market_structure?.phase ?? '—'} />
                          <MiniStat label="Trend" value={analysis?.market_structure?.trend ?? '—'} />
                          <MiniStat label="HTF Phase" value={analysis?.market_structure?.htf_phase ?? '—'} />
                          <MiniStat label="HTF Bias" value={analysis?.market_structure?.htf_bias ?? '—'} />
                        </div>

                        <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                          <div className="text-xs font-medium text-white/70 mb-2">Swing points</div>
                          {analysis?.market_structure?.swing_points?.length ? (
                            <div className="max-h-[320px] overflow-auto pr-1 space-y-2">
                              {analysis.market_structure.swing_points
                                .slice()
                                .reverse()
                                .slice(0, 20)
                                .map((sp, idx) => (
                                  <div
                                    key={`${sp.timestamp}-${idx}`}
                                    className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/5 px-3 py-2"
                                  >
                                    <div className="text-xs text-white/70">
                                      <span className="font-semibold text-white/90">{sp.swing_type}</span>
                                      <span className="mx-2 text-white/20">·</span>
                                      {formatTs(sp.timestamp)}
                                    </div>
                                    <div className="text-xs text-white/85">
                                      {formatNumber(sp.price, 2)}
                                    </div>
                                  </div>
                                ))}
                            </div>
                          ) : (
                            <div className="text-xs text-white/55">Aucun swing point.</div>
                          )}
                        </div>
                      </motion.div>
                    )}

                    {rightTab === 'confluence' && (
                      <motion.div
                        key="confluence"
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                        className="space-y-4"
                      >
                        <div className="text-sm font-semibold">Confluences (PA / DP / Key levels)</div>

                        <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                          <div className="text-xs font-medium text-white/70 mb-2">PA patterns</div>
                          {analysis?.pa_patterns?.length ? (
                            <div className="space-y-2">
                              {analysis.pa_patterns
                                .slice()
                                .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
                                .slice(0, 12)
                                .map((p, idx) => (
                                  <div key={`${p.pattern}-${idx}`} className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2">
                                    <div className="text-xs text-white/75">{p.pattern}</div>
                                    <div className="text-xs text-white/85">{formatNumber(p.score, 0)}%</div>
                                  </div>
                                ))}
                            </div>
                          ) : (
                            <div className="text-xs text-white/55">Aucun pattern détecté.</div>
                          )}
                        </div>

                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                          <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                            <div className="text-xs font-medium text-white/70 mb-2">Decision points</div>
                            {analysis?.decision_points?.length ? (
                              <div className="space-y-2">
                                {analysis.decision_points
                                  .slice()
                                  .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
                                  .slice(0, 8)
                                  .map((dp, idx) => (
                                    <div key={`${dp.dp_type}-${dp.price}-${idx}`} className="rounded-lg border border-white/10 bg-white/5 px-3 py-2">
                                      <div className="flex items-center justify-between">
                                        <div className="text-xs text-white/75">{dp.dp_type}</div>
                                        <div className="text-xs text-white/85">{formatNumber(dp.score, 0)}%</div>
                                      </div>
                                      <div className="text-[11px] text-white/60 mt-1">
                                        Price: <span className="text-white/80">{formatNumber(dp.price, 2)}</span>
                                      </div>
                                    </div>
                                  ))}
                              </div>
                            ) : (
                              <div className="text-xs text-white/55">Aucun DP.</div>
                            )}
                          </div>

                          <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                            <div className="text-xs font-medium text-white/70 mb-2">Key levels</div>
                            {analysis?.key_levels?.length ? (
                              <div className="space-y-2">
                                {analysis.key_levels
                                  .slice()
                                  .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
                                  .slice(0, 8)
                                  .map((kl, idx) => (
                                    <div key={`${kl.price}-${idx}`} className="rounded-lg border border-white/10 bg-white/5 px-3 py-2">
                                      <div className="flex items-center justify-between">
                                        <div className="text-xs text-white/75">{kl.kind ?? 'Key level'}</div>
                                        <div className="text-xs text-white/85">{formatNumber(kl.score ?? 0, 0)}%</div>
                                      </div>
                                      <div className="text-[11px] text-white/60 mt-1">
                                        Price: <span className="text-white/80">{formatNumber(kl.price, 2)}</span>
                                      </div>
                                    </div>
                                  ))}
                              </div>
                            ) : (
                              <div className="text-xs text-white/55">Aucun KL.</div>
                            )}
                          </div>
                        </div>
                      </motion.div>
                    )}

                    {rightTab === 'ai' && (
                      <motion.div
                        key="ai"
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                        className="space-y-3"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-sm font-semibold">IGNIS AI</div>
                            <div className="text-xs text-white/60">
                              Résumé + rapport (Ollama). Tu peux générer un report complet à la demande.
                            </div>
                          </div>

                          <button
                            onClick={() => generateAIReport()}
                            disabled={aiLoading}
                            className="rounded-xl border border-white/10 bg-gradient-to-b from-[#378ADD]/70 to-[#378ADD]/25 px-3 py-2 text-sm font-medium text-white hover:from-[#378ADD]/80 hover:to-[#378ADD]/30 transition disabled:opacity-60"
                          >
                            {aiLoading ? 'Génération…' : 'Generate report'}
                          </button>
                        </div>

                        <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                          <div className="text-xs font-medium text-white/70 mb-2">Summary</div>
                          <div className="text-sm text-white/80 whitespace-pre-wrap leading-relaxed">
                            {analysis?.ai_summary ?? '—'}
                          </div>
                        </div>

                        <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                          <div className="text-xs font-medium text-white/70 mb-2">Full report</div>
                          <div className="text-sm text-white/80 whitespace-pre-wrap leading-relaxed">
                            {analysis?.ai_report ?? '—'}
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </motion.div>

            {/* Selected zone deep card */}
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
              <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-[20px] p-5 shadow-[0_25px_80px_rgba(0,0,0,0.55)]">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-base font-semibold">Zone sélectionnée</h3>
                  <div className="text-xs text-white/60">
                    {selectedZone ? selectedZone.id : '—'}
                  </div>
                </div>

                {selectedZone ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: zoneColor(selectedZone.zone_type) }} />
                        <div className="text-sm font-medium">
                          {zoneLabel(selectedZone.zone_type)}
                          <span className="text-white/40 font-normal"> · {selectedZone.timeframe}</span>
                        </div>
                      </div>

                      <span className="rounded-full border border-white/10 bg-black/20 px-3 py-1 text-xs text-white/70">
                        Score {formatNumber(selectedZone.score, 0)}%
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <MiniStat label="Top" value={formatNumber(selectedZone.zone_top, 2)} />
                      <MiniStat label="Bot" value={formatNumber(selectedZone.zone_bot, 2)} />
                      <MiniStat label="SDE" value={selectedZone.sde_confirmed ? `OK · ${formatNumber(selectedZone.sde_score, 0)}%` : 'NO'} />
                      <MiniStat label="SDP" value={selectedZone.sdp_validated ? 'OK' : 'NO'} />
                      <MiniStat label="FTB" value={`${selectedZone.ftb_count} · ${selectedZone.is_ftb_valid ? 'valid' : 'no'}`} />
                      <MiniStat label="Flippy/Failed" value={`${selectedZone.is_flippy ? 'flippy' : '—'} · ${selectedZone.is_failed ? 'failed' : '—'}`} />
                    </div>

                    <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                      <div className="text-xs font-medium text-white/70 mb-2">Base</div>
                      <div className="grid grid-cols-2 gap-2">
                        <MiniStat label="Type" value={selectedZone.base.base_type} />
                        <MiniStat label="Score" value={`${formatNumber(selectedZone.base.score, 0)}%`} />
                        <MiniStat label="Solid" value={selectedZone.base.is_solid ? 'Oui' : 'Non'} />
                        <MiniStat label="Weakening" value={selectedZone.base.is_weakening ? 'Oui' : 'Non'} />
                        <MiniStat label="Touches" value={`${selectedZone.base.touch_count}`} />
                        <MiniStat label="Engulf" value={formatNumber(selectedZone.base.engulfment_ratio, 2)} />
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-white/60">Clique une zone dans l’onglet “Zones”.</div>
                )}
              </div>
            </motion.div>
          </div>
        </div>

        {/* Footer small */}
        <div className="mt-6 text-xs text-white/40">
          API: <span className="text-white/60">{API_BASE}</span>
          <span className="mx-2 text-white/20">·</span>
          WS: <span className="text-white/60">{WS_URL}</span>
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Small UI components
────────────────────────────────────────────────────────────── */

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded-xl px-3 py-2 text-xs font-medium transition border',
        active
          ? 'border-white/15 bg-white/10 text-white'
          : 'border-transparent bg-transparent text-white/60 hover:bg-white/10 hover:text-white/85'
      )}
    >
      {children}
    </button>
  );
}

function Toggle({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={cn(
        'flex items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left transition',
        value ? 'border-[#E85D1A]/30 bg-[#E85D1A]/10' : 'border-white/10 bg-black/20 hover:bg-white/10'
      )}
      title={hint}
    >
      <div>
        <div className="text-xs font-medium text-white/85">{label}</div>
        {hint && <div className="text-[11px] text-white/55">{hint}</div>}
      </div>
      <div className={cn(
        'h-6 w-11 rounded-full border p-1 transition',
        value ? 'border-[#E85D1A]/40 bg-[#E85D1A]/25' : 'border-white/10 bg-white/5'
      )}>
        <div className={cn(
          'h-4 w-4 rounded-full bg-white transition',
          value ? 'translate-x-5' : 'translate-x-0'
        )} />
      </div>
    </button>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={cn(
      'rounded-xl border border-white/10 bg-black/20 px-3 py-2',
      accent && 'bg-gradient-to-b from-white/10 to-black/20'
    )}>
      <div className="text-[11px] text-white/55">{label}</div>
      <div className="text-sm font-semibold text-white/90">{value}</div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2">
      <div className="text-[11px] text-white/55">{label}</div>
      <div className="text-xs font-medium text-white/85 truncate">{value}</div>
    </div>
  );
}

function Badge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={cn(
      'rounded-full border px-2.5 py-1 text-[11px] font-medium',
      ok ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200' : 'border-white/10 bg-white/5 text-white/70'
    )}>
      {label}
    </span>
  );
}

function InfoRow({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/20 p-3">
      <div className="text-[11px] text-white/55">{label}</div>
      <div className="text-sm font-semibold text-white/90 mt-0.5">{value}</div>
      {sub && <div className="text-[11px] text-white/55 mt-1">{sub}</div>}
    </div>
  );
}

function ScoreBar({ label, value }: { label: string; value: number }) {
  const v = Math.max(0, Math.min(100, value ?? 0));
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="text-[11px] text-white/60">{label}</div>
        <div className="text-[11px] text-white/70">{formatNumber(v, 0)}%</div>
      </div>
      <div className="h-2 rounded-full border border-white/10 bg-white/5 overflow-hidden">
        <div
          className={cn('h-full rounded-full bg-gradient-to-r', scoreToGradient(v))}
          style={{ width: `${v}%` }}
        />
      </div>
    </div>
  );
}
