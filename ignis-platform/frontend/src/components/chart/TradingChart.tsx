/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  type CandlestickData,
  type HistogramData,
  type IPriceLine,
  type LogicalRange,
  type Logical,
} from 'lightweight-charts';

import SDZoneOverlay, { type SDZoneResult } from './SDZoneOverlay';
import StructureOverlay, { type SwingPoint } from './StructureOverlay';
import DPMarker, { type DPResult } from './DPMarker';
import KLMarker, { type KeyLevelResult } from './KLMarker';

/* ──────────────────────────────────────────────────────────────
   Types
────────────────────────────────────────────────────────────── */

export type CandleSchema = {
  open_time: number; // sec or ms
  close_time?: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export type TradingChartTheme = {
  upColor: string;
  downColor: string;
  grid: string;
  text: string;
  border: string;

  hudBg: string;
  hudBorder: string;

  focusColor: string;
  currentPriceColor: string;

  dpColor: string;
  klColor: string;
};

export type TradingChartOverlays = {
  zones: boolean;
  structure: boolean;
  dpMarkers: boolean;
  klMarkers: boolean;
  lines: boolean; // price lines for zones/dp/kl
  volume: boolean;
};

export type TradingChartProps = {
  candles?: CandleSchema[];

  zones?: SDZoneResult[];
  swingPoints?: SwingPoint[];
  structureBreaks?: any[];

  decisionPoints?: DPResult[];
  keyLevels?: KeyLevelResult[];

  /** selection */
  selectedZoneId?: string | null;
  selectedSwingKey?: string | null;

  /** dimensions */
  height?: number;

  /** behavior */
  fitContentOnLoad?: boolean;

  /** overlays config */
  overlays?: Partial<TradingChartOverlays>;

  /** info */
  currentPrice?: number | null;

  /** events */
  onCrosshair?: (payload: {
    time: number | null; // seconds
    price: number | null;
    ohlc?: { open: number; high: number; low: number; close: number };
  }) => void;

  onZoneClick?: (zone: SDZoneResult) => void;
  onSwingClick?: (sp: SwingPoint & { key: string }) => void;

  onBreakClick?: (b: any) => void;

  /** styling */
  theme?: Partial<TradingChartTheme>;
  className?: string;
};

export type TradingChartHandle = {
  focusPrice: (price: number, opts?: { label?: string; color?: string }) => void;
  focusTime: (timestamp: number, opts?: { barsAround?: number }) => void;
  focusZone: (zone: SDZoneResult, opts?: { alsoScrollToFormedAt?: boolean }) => void;
  clearFocus: () => void;
  fit: () => void;
};

const DEFAULT_THEME: TradingChartTheme = {
  upColor: 'rgba(29,158,117,0.95)',
  downColor: 'rgba(226,75,74,0.95)',
  grid: 'rgba(255,255,255,0.06)',
  text: 'rgba(255,255,255,0.85)',
  border: 'rgba(255,255,255,0.08)',

  hudBg: 'rgba(0,0,0,0.45)',
  hudBorder: 'rgba(255,255,255,0.10)',

  focusColor: 'rgba(232,93,26,0.95)',
  currentPriceColor: 'rgba(255,255,255,0.28)',

  dpColor: 'rgba(232,93,26,0.85)',
  klColor: 'rgba(55,138,221,0.85)',
};

const DEFAULT_OVERLAYS: TradingChartOverlays = {
  zones: true,
  structure: true,
  dpMarkers: false,
  klMarkers: false,
  lines: true,
  volume: true,
};

function cn(...classes: Array<string | undefined | null | false>) {
  return classes.filter(Boolean).join(' ');
}

function toSeconds(ts: number) {
  return ts < 10_000_000_000 ? Math.floor(ts) : Math.floor(ts / 1000);
}
function toUTCTimestamp(ts: number): UTCTimestamp {
  return toSeconds(ts) as UTCTimestamp;
}
function toMs(ts: number) {
  return ts < 10_000_000_000 ? ts * 1000 : ts;
}
function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}
function fmt(n: number | undefined, digits = 2) {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits }).format(n);
}

type MarkerLayoutItem<T> = {
  item: T;
  y: number;
};

function layoutMarkers<T>(
  items: Array<{ price: number; item: T }>,
  priceToY: (price: number) => number | null,
  opts?: { minGapPx?: number; clampTop?: number; clampBottom?: number }
): Array<MarkerLayoutItem<T>> {
  const minGap = opts?.minGapPx ?? 36;

  const raw = items
    .map((x) => ({ item: x.item, y: priceToY(x.price) }))
    .filter((x): x is { item: T; y: number } => typeof x.y === 'number' && Number.isFinite(x.y))
    .sort((a, b) => a.y - b.y);

  // simple anti-overlap: push down
  const out: Array<MarkerLayoutItem<T>> = [];
  for (const r of raw) {
    let y = r.y;
    const prev = out[out.length - 1];
    if (prev && y - prev.y < minGap) y = prev.y + minGap;

    if (typeof opts?.clampTop === 'number') y = Math.max(opts.clampTop, y);
    if (typeof opts?.clampBottom === 'number') y = Math.min(opts.clampBottom, y);

    out.push({ item: r.item, y });
  }
  return out;
}

/* ──────────────────────────────────────────────────────────────
   Component
────────────────────────────────────────────────────────────── */

const TradingChart = forwardRef<TradingChartHandle, TradingChartProps>(function TradingChart(
  {
    candles = [],
    zones = [],
    swingPoints = [],
    structureBreaks = [],
    decisionPoints = [],
    keyLevels = [],

    selectedZoneId = null,
    selectedSwingKey = null,

    height = 560,
    fitContentOnLoad = true,

    overlays,
    currentPrice,

    onCrosshair,
    onZoneClick,
    onSwingClick,
    onBreakClick,

    theme,
    className,
  },
  ref
) {
  const T = useMemo(() => ({ ...DEFAULT_THEME, ...(theme ?? {}) }), [theme]);
  const O = useMemo(() => ({ ...DEFAULT_OVERLAYS, ...(overlays ?? {}) }), [overlays]);

  const chartHostRef = useRef<HTMLDivElement | null>(null);

  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);

  const zoneLinesRef = useRef<IPriceLine[]>([]);
  const dpLinesRef = useRef<IPriceLine[]>([]);
  const klLinesRef = useRef<IPriceLine[]>([]);
  const focusLineRef = useRef<IPriceLine | null>(null);
  const currentPriceLineRef = useRef<IPriceLine | null>(null);

  const [overlayTick, setOverlayTick] = useState(0);

  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: height });

  const [hud, setHud] = useState<{
    time: number | null;
    open?: number;
    high?: number;
    low?: number;
    close?: number;
  }>({ time: null });

  // store candle times (seconds) for focusTime
  const candleTimesRef = useRef<number[]>([]);

  const bumpOverlayTick = useCallback(() => setOverlayTick((t) => t + 1), []);

  const priceToY = useCallback((price: number) => {
    const s = candleSeriesRef.current;
    if (!s) return null;
    return s.priceToCoordinate(price);
  }, []);

  const timeToX = useCallback((timeSec: number) => {
    const c = chartRef.current;
    if (!c) return null;
    // LWCharts uses "Time" union; with UTCTimestamp (seconds) it works.
    return (c.timeScale() as any).timeToCoordinate(timeSec as any) as number | null;
  }, []);

  /* ──────────────────────────────────────────────────────────────
     Lines helpers
  ─────────────────────────────────────────────────────────────── */

  const clearLines = useCallback(() => {
    const s = candleSeriesRef.current;
    if (!s) return;

    for (const pl of zoneLinesRef.current) s.removePriceLine(pl);
    for (const pl of dpLinesRef.current) s.removePriceLine(pl);
    for (const pl of klLinesRef.current) s.removePriceLine(pl);

    zoneLinesRef.current = [];
    dpLinesRef.current = [];
    klLinesRef.current = [];
  }, []);

  const clearFocus = useCallback(() => {
    const s = candleSeriesRef.current;
    if (!s) return;

    if (focusLineRef.current) {
      try {
        s.removePriceLine(focusLineRef.current);
      } catch {}
      focusLineRef.current = null;
    }
    bumpOverlayTick();
  }, [bumpOverlayTick]);

  const setFocusPriceLine = useCallback(
    (price: number, opts?: { label?: string; color?: string }) => {
      const s = candleSeriesRef.current;
      if (!s) return;

      clearFocus();

      focusLineRef.current = s.createPriceLine({
        price,
        color: opts?.color ?? T.focusColor,
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: opts?.label ?? `FOCUS · ${fmt(price, 6)}`,
      });

      bumpOverlayTick();
    },
    [T.focusColor, bumpOverlayTick, clearFocus]
  );

  const setCurrentPriceLine = useCallback(
    (price: number | null | undefined) => {
      const s = candleSeriesRef.current;
      if (!s) return;

      if (currentPriceLineRef.current) {
        try {
          s.removePriceLine(currentPriceLineRef.current);
        } catch {}
        currentPriceLineRef.current = null;
      }

      if (price === null || price === undefined || !Number.isFinite(price)) return;

      currentPriceLineRef.current = s.createPriceLine({
        price,
        color: T.currentPriceColor,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: `PX · ${fmt(price, 6)}`,
      });

      bumpOverlayTick();
    },
    [T.currentPriceColor, bumpOverlayTick]
  );

  const renderPriceLines = useCallback(() => {
    const s = candleSeriesRef.current;
    if (!s) return;

    clearLines();
    if (!O.lines) return;

    // zones top/bot
    for (const z of zones ?? []) {
      const selected = selectedZoneId === z.id;
      const col = zoneTypeColor(z.zone_type);

      const common = {
        color: rgba(col, selected ? 0.95 : 0.70),
        lineWidth: selected ? 2 : 1,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
      } as const;

      zoneLinesRef.current.push(
        s.createPriceLine({
          ...common,
          price: z.zone_top,
          title: `${zoneLabel(z.zone_type)} TOP · ${fmt(z.score, 0)}%`,
        })
      );
      zoneLinesRef.current.push(
        s.createPriceLine({
          ...common,
          price: z.zone_bot,
          title: `${zoneLabel(z.zone_type)} BOT`,
        })
      );

      if (typeof z.sdp_head === 'number' && Number.isFinite(z.sdp_head)) {
        zoneLinesRef.current.push(
          s.createPriceLine({
            price: z.sdp_head,
            color: 'rgba(232,93,26,0.78)',
            lineWidth: selected ? 2 : 1,
            lineStyle: LineStyle.Dotted,
            axisLabelVisible: true,
            title: 'SDP HEAD',
          })
        );
      }
    }

    // DPs
    for (const dp of decisionPoints ?? []) {
      dpLinesRef.current.push(
        s.createPriceLine({
          price: dp.price,
          color: T.dpColor,
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: `DP · ${dp.dp_type} · ${fmt(dp.score, 0)}%`,
        })
      );
    }

    // KLs
    for (const kl of keyLevels ?? []) {
      klLinesRef.current.push(
        s.createPriceLine({
          price: kl.price,
          color: T.klColor,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `KL · ${fmt(kl.score ?? 0, 0)}%`,
        })
      );
    }

    bumpOverlayTick();
  }, [
    clearLines,
    O.lines,
    zones,
    decisionPoints,
    keyLevels,
    selectedZoneId,
    T.dpColor,
    T.klColor,
    bumpOverlayTick,
  ]);

  /* ──────────────────────────────────────────────────────────────
     Init chart
  ─────────────────────────────────────────────────────────────── */

  useEffect(() => {
    if (!chartHostRef.current) return;

    const host = chartHostRef.current;

    const chart = createChart(host, {
      height,
      layout: {
        background: { type: ColorType.Solid, color: 'rgba(10,10,15,0.18)' },
        textColor: T.text,
        fontFamily: 'system-ui, -apple-system, "SF Pro Display", "SF Pro Text", sans-serif',
      },
      grid: {
        vertLines: { color: T.grid },
        horzLines: { color: T.grid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: 'rgba(255,255,255,0.16)', width: 1, style: LineStyle.Solid },
        horzLine: { color: 'rgba(255,255,255,0.16)', width: 1, style: LineStyle.Solid },
      },
      rightPriceScale: {
        borderColor: T.border,
      },
      timeScale: {
        borderColor: T.border,
        rightOffset: 10,
      },
      handleScroll: true,
      handleScale: true,
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: T.upColor,
      downColor: T.downColor,
      borderVisible: false,
      wickUpColor: T.upColor,
      wickDownColor: T.downColor,
    });

    const volSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      color: 'rgba(255,255,255,0.20)',
    });

    // volume scale margins (bottom)
    volSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.82, bottom: 0.0 },
    });

    // main scale margins (leave room for volume)
    candleSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.08, bottom: 0.22 },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volSeries;

    // Resize
    const ro = new ResizeObserver(() => {
      if (!chartHostRef.current || !chartRef.current) return;
      const w = chartHostRef.current.clientWidth;
      const h = chartHostRef.current.clientHeight;
      setSize({ w, h });
      chartRef.current.applyOptions({ width: w, height: h });
      bumpOverlayTick();
    });

    ro.observe(host);
    // initial
    setSize({ w: host.clientWidth, h: host.clientHeight });
    chart.applyOptions({ width: host.clientWidth });

    // Repaint overlays on scroll/zoom
    const ts: any = chart.timeScale();
    const onRangeChange = () => bumpOverlayTick();

    try {
      ts.subscribeVisibleLogicalRangeChange?.(onRangeChange);
      ts.subscribeVisibleTimeRangeChange?.(onRangeChange);
    } catch {}

    // Wheel / pointer interactions can change price scale (zoom Y)
    const onWheel = () => bumpOverlayTick();
    const onPointerUp = () => bumpOverlayTick();
    host.addEventListener('wheel', onWheel, { passive: true });
    host.addEventListener('pointerup', onPointerUp, { passive: true });

    // Crosshair -> HUD + callback
    const unsubCrosshair = chart.subscribeCrosshairMove((param) => {
      if (!param || !param.time) {
        setHud({ time: null });
        onCrosshair?.({ time: null, price: null });
        return;
      }

      const t = typeof param.time === 'number' ? param.time : (param.time as any);
      const seconds = Number(t);

      const seriesData: any = param.seriesData?.get(candleSeries as any);
      const ohlc =
        seriesData && typeof seriesData.open === 'number'
          ? {
              open: seriesData.open,
              high: seriesData.high,
              low: seriesData.low,
              close: seriesData.close,
            }
          : undefined;

      setHud({ time: seconds, ...(ohlc ?? {}) });
      onCrosshair?.({ time: seconds, price: ohlc?.close ?? null, ohlc });
    });

    return () => {
      try {
      } catch {}

      try {
        ts.unsubscribeVisibleLogicalRangeChange?.(onRangeChange);
        if (typeof ts.unsubscribeVisibleTimeRangeChange === "function") ts.unsubscribeVisibleTimeRangeChange(onRangeChange);
      } catch {}

      host.removeEventListener('wheel', onWheel);
      host.removeEventListener('pointerup', onPointerUp);

      ro.disconnect();

      try {
        chart.remove();
      } catch {}

      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;

      clearLines();
      // clear focus lines
      focusLineRef.current = null;
      currentPriceLineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    height,
    T.upColor,
    T.downColor,
    T.text,
    T.grid,
    T.border,
    bumpOverlayTick,
  ]);

  // apply height changes
  useEffect(() => {
    if (!chartRef.current) return;
    chartRef.current.applyOptions({ height });
    bumpOverlayTick();
  }, [height, bumpOverlayTick]);

  /* ──────────────────────────────────────────────────────────────
     Data set (candles + volume)
  ─────────────────────────────────────────────────────────────── */

  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    const volSeries = volumeSeriesRef.current;

    if (!chart || !candleSeries || !volSeries) return;

    if (!candles?.length) {
      candleSeries.setData([]);
      volSeries.setData([]);
      candleTimesRef.current = [];
      bumpOverlayTick();
      return;
    }

    const candleData: CandlestickData[] = candles.map((c) => ({
      time: toUTCTimestamp(c.open_time),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));

    candleSeries.setData(candleData);
    candleTimesRef.current = candles.map((c) => toSeconds(c.open_time));

    if (O.volume) {
      const volData: HistogramData[] = candles.map((c) => ({
        time: toUTCTimestamp(c.open_time),
        value: c.volume ?? 0,
        color: c.close >= c.open ? 'rgba(29,158,117,0.42)' : 'rgba(226,75,74,0.42)',
      }));
      volSeries.setData(volData);

      // adjust margins for volume
      candleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.22 } });
    } else {
      volSeries.setData([]);
      candleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.10 } });
    }

    if (fitContentOnLoad) chart.timeScale().fitContent();

    bumpOverlayTick();
  }, [candles, O.volume, fitContentOnLoad, bumpOverlayTick]);

  // price lines when overlays change
  useEffect(() => {
    renderPriceLines();
  }, [renderPriceLines]);

  // current price dashed line
  useEffect(() => {
    setCurrentPriceLine(currentPrice);
  }, [currentPrice, setCurrentPriceLine]);

  /* ──────────────────────────────────────────────────────────────
     Public API (ref)
  ─────────────────────────────────────────────────────────────── */

  useImperativeHandle(
    ref,
    () => ({
      focusPrice: (price, opts) => setFocusPriceLine(price, opts),
      focusTime: (timestamp, opts) => {
        const chart = chartRef.current;
        if (!chart) return;

        const sec = toSeconds(timestamp);
        const times = candleTimesRef.current;
        if (!times.length) return;

        // nearest candle index
        let bestIdx = 0;
        let bestDist = Number.POSITIVE_INFINITY;
        for (let i = 0; i < times.length; i++) {
          const d = Math.abs(times[i] - sec);
          if (d < bestDist) {
            bestDist = d;
            bestIdx = i;
          }
        }

        const barsAround = clamp(opts?.barsAround ?? 90, 20, 420);
        const from = Math.max(0, bestIdx - barsAround);
        const to = Math.min(times.length - 1, bestIdx + Math.floor(barsAround * 0.35));

        const range: LogicalRange = { from: from as Logical, to: to as Logical };
        try {
          chart.timeScale().setVisibleLogicalRange(range);
        } catch {
          
          try {
          } catch {}
        }

        bumpOverlayTick();
      },
      focusZone: (zone, opts) => {
        const series = candleSeriesRef.current;
        if (!series) return;

        const hi = Math.max(zone.zone_top, zone.zone_bot);
        const lo = Math.min(zone.zone_top, zone.zone_bot);
        const pad = Math.max((hi - lo) * 1.35, (hi + lo) * 0.0006);

        // tighten view around zone
        try {
        } catch {}

        // focus line at mid
        const mid = (zone.zone_top + zone.zone_bot) / 2;
        setFocusPriceLine(mid, { label: `${zoneLabel(zone.zone_type)} · MID`, color: rgba(zoneTypeColor(zone.zone_type), 0.95) });

        // optionally scroll near formation time
        if (opts?.alsoScrollToFormedAt && typeof zone.formed_at === 'number') {
          const api = chartRef.current;
          if (api) {
            const sec = toSeconds(zone.formed_at);
            // set visible range around that time via focusTime logic
            const times = candleTimesRef.current;
            if (times.length) {
              let bestIdx = 0;
              let bestDist = Number.POSITIVE_INFINITY;
              for (let i = 0; i < times.length; i++) {
                const d = Math.abs(times[i] - sec);
                if (d < bestDist) {
                  bestDist = d;
                  bestIdx = i;
                }
              }
              const barsAround = 120;
              const from = Math.max(0, bestIdx - barsAround);
              const to = Math.min(times.length - 1, bestIdx + Math.floor(barsAround * 0.35));
              try {
                api.timeScale().setVisibleLogicalRange({ from, to });
              } catch {}
            }
          }
        }

        bumpOverlayTick();
      },
      clearFocus: () => clearFocus(),
      fit: () => {
        chartRef.current?.timeScale().fitContent();
        bumpOverlayTick();
      },
    }),
    [bumpOverlayTick, clearFocus, setFocusPriceLine]
  );

  /* ──────────────────────────────────────────────────────────────
     Marker layout (DP/KL)
  ─────────────────────────────────────────────────────────────── */

  const dpLayout = useMemo(() => {
    if (!O.dpMarkers) return [];
    return layoutMarkers(
      (decisionPoints ?? []).map((dp) => ({ price: dp.price, item: dp })),
      (p) => priceToY(p),
      { minGapPx: 40, clampTop: 18, clampBottom: Math.max(18, size.h - 30) }
    );
  }, [O.dpMarkers, decisionPoints, priceToY, size.h, overlayTick]);

  const klLayout = useMemo(() => {
    if (!O.klMarkers) return [];
    return layoutMarkers(
      (keyLevels ?? []).map((kl) => ({ price: kl.price, item: kl })),
      (p) => priceToY(p),
      { minGapPx: 40, clampTop: 18, clampBottom: Math.max(18, size.h - 30) }
    );
  }, [O.klMarkers, keyLevels, priceToY, size.h, overlayTick]);

  return (
    <div className={cn('relative', className)}>
      {/* Chart surface */}
      <div
        ref={chartHostRef}
        className="relative w-full rounded-2xl border border-white/10 bg-white/5 backdrop-blur-[20px] shadow-[0_30px_90px_rgba(0,0,0,0.55)] overflow-hidden"
        style={{ height }}
      >
        {/* Overlays (stack) */}
        {O.zones && (
          <SDZoneOverlay
            zones={zones}
            selectedZoneId={selectedZoneId}
            currentPrice={currentPrice}
            priceToY={priceToY}
            updateToken={overlayTick}
            width={size.w}
            height={size.h}
            cullOutside
            onSelectZone={onZoneClick}
          />
        )}

        {O.structure && (
          <StructureOverlay
            swingPoints={swingPoints}
            structureBreaks={structureBreaks}
            selectedSwingKey={selectedSwingKey}
            timeToX={timeToX}
            priceToY={priceToY}
            width={size.w}
            height={size.h}
            updateToken={overlayTick}
            onSelectSwing={onSwingClick}
            onSelectBreak={onBreakClick}
            showLegend
          />
        )}

        {/* DP markers (HTML cards positioned by y) */}
        {O.dpMarkers && dpLayout.length > 0 && (
          <div className="absolute inset-0 z-[8] pointer-events-none">
            {dpLayout.slice(0, 18).map(({ item, y }, idx) => (
              <div key={`${item.id ?? idx}`} className="pointer-events-auto">
                <DPMarker
                  dp={item}
                  y={y}
                  side="right"
                  compact
                  currentPrice={currentPrice ?? null}
                  onFocusPrice={(price) => setFocusPriceLine(price, { label: `DP · ${item.dp_type}`, color: DEFAULT_THEME.focusColor })}
                />
              </div>
            ))}
          </div>
        )}

        {/* KL markers */}
        {O.klMarkers && klLayout.length > 0 && (
          <div className="absolute inset-0 z-[8] pointer-events-none">
            {klLayout.slice(0, 18).map(({ item, y }, idx) => (
              <div key={`${item.id ?? idx}`} className="pointer-events-auto">
                <KLMarker
                  kl={item}
                  y={y}
                  side="left"
                  compact
                  currentPrice={currentPrice ?? null}
                  onFocusPrice={(price) => setFocusPriceLine(price, { label: `KL · ${item.kind ?? 'Key level'}`, color: DEFAULT_THEME.klColor })}
                />
              </div>
            ))}
          </div>
        )}

        {/* HUD (top-left) */}
        <div className="absolute left-3 top-3 z-[12] pointer-events-none">
          <div
            className="rounded-2xl border px-3 py-2 backdrop-blur-md"
            style={{ background: T.hudBg, borderColor: T.hudBorder }}
          >
            <div className="text-[11px] text-white/55">Crosshair</div>
            <div className="text-xs text-white/85">
              {hud.time ? (
                <>
                  <span className="text-white/80">
                    {new Date(hud.time * 1000).toLocaleString('fr-FR', { hour12: false })}
                  </span>
                  <span className="mx-2 text-white/20">·</span>
                  <span className="text-white/85">O {fmt(hud.open, 6)}</span>
                  <span className="mx-1 text-white/25">H</span>
                  <span className="text-white/85">{fmt(hud.high, 6)}</span>
                  <span className="mx-1 text-white/25">L</span>
                  <span className="text-white/85">{fmt(hud.low, 6)}</span>
                  <span className="mx-1 text-white/25">C</span>
                  <span className="text-white/90 font-semibold">{fmt(hud.close, 6)}</span>
                </>
              ) : (
                <span className="text-white/55">—</span>
              )}
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Chip label={`Zones ${zones.length}`} />
              <Chip label={`Swings ${swingPoints.length}`} />
              <Chip label={`DP ${decisionPoints.length}`} />
              <Chip label={`KL ${keyLevels.length}`} />
            </div>
          </div>
        </div>

        {/* Toolbar (top-right) */}
        <div className="absolute right-3 top-3 z-[12] flex items-center gap-2">
          <button
            onClick={() => chartRef.current?.timeScale().fitContent()}
            className="rounded-xl border border-white/10 bg-black/35 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition backdrop-blur"
            title="Fit content"
            type="button"
          >
            Fit
          </button>

          <button
            onClick={() => clearFocus()}
            className="rounded-xl border border-white/10 bg-black/35 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition backdrop-blur"
            title="Clear focus line"
            type="button"
          >
            Clear focus
          </button>
        </div>

        {/* Empty state */}
        {!candles?.length && (
          <div className="absolute inset-0 z-[20] flex items-center justify-center pointer-events-none">
            <div className="rounded-2xl border border-white/10 bg-black/45 px-4 py-3 text-sm text-white/80 backdrop-blur-md">
              Aucune donnée candle (champ <code>candles</code> vide).
            </div>
          </div>
        )}
      </div>

      {/* Legend footer */}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-white/45">
        <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
          Zones overlay: {O.zones ? 'ON' : 'OFF'}
        </span>
        <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
          Structure overlay: {O.structure ? 'ON' : 'OFF'}
        </span>
        <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
          Lines: {O.lines ? 'ON' : 'OFF'}
        </span>
        <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
          Volume: {O.volume ? 'ON' : 'OFF'}
        </span>
      </div>
    </div>
  );
});

export default TradingChart;

/* ──────────────────────────────────────────────────────────────
   Small UI
────────────────────────────────────────────────────────────── */

function Chip({ label }: { label: string }) {
  return (
    <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/70">
      {label}
    </span>
  );
}

/* ──────────────────────────────────────────────────────────────
   Zone helpers (local)
────────────────────────────────────────────────────────────── */

function zoneTypeColor(zoneType: SDZoneResult['zone_type']) {
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

function zoneLabel(zoneType: SDZoneResult['zone_type']) {
  switch (zoneType) {
    case 'DEMAND':
      return 'Demand';
    case 'SUPPLY':
      return 'Supply';
    case 'FLIPPY_D':
      return 'Flippy D';
    case 'FLIPPY_S':
      return 'Flippy S';
    case 'HIDDEN_D':
      return 'Hidden D';
    case 'HIDDEN_S':
      return 'Hidden S';
    default:
      return zoneType;
  }
}

function rgba(hex: string, a: number) {
  const h = hex.replace('#', '').trim();
  if (h.length !== 6) return `rgba(255,255,255,${a})`;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}