/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';

type AssetStatsResponse = {
  total: number;
  active: number;
  by_class: Record<string, number>;
  with_analysis: number;
  valid_setups: number;
  pending_setups: number;
};

type AlertStatsResponse = {
  total?: number;
  sent?: number;
  failed?: number;
  queued?: number;
  by_type?: Record<string, number>;
  by_priority?: Record<string, number>;
};

type AIStatusResponse = {
  ollama_online: boolean;
  model: string;
  host: string;
  version?: string;
  models_available?: any;
};

const API_DEFAULT =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:8000/api/v1';

function cn(...classes: Array<string | undefined | null | false>) {
  return classes.filter(Boolean).join(' ');
}

function fmt(n: number | undefined, digits = 0) {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits }).format(n);
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function pct(n: number, digits = 0) {
  return `${fmt(n, digits)}%`;
}

function timeAgo(ms: number) {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

export default function MarketOverview({
  apiBase = API_DEFAULT,
  className,
  autoRefreshMs = 30_000,
  showAI = true,
  showAlerts = true,
}: {
  apiBase?: string;
  className?: string;
  autoRefreshMs?: number;
  showAI?: boolean;
  showAlerts?: boolean;
}) {
  const [assetStats, setAssetStats] = useState<AssetStatsResponse | null>(null);
  const [alertStats, setAlertStats] = useState<AlertStatsResponse | null>(null);
  const [aiStatus, setAiStatus] = useState<AIStatusResponse | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);

  const [showRaw, setShowRaw] = useState(false);

  const fetchAll = useCallback(async () => {
    setError(null);
    setLoading(true);

    try {
      const reqs: Array<Promise<Response>> = [
        fetch(`${apiBase}/assets/stats`, { method: 'GET' }),
      ];

      if (showAlerts) reqs.push(fetch(`${apiBase}/alerts/stats`, { method: 'GET' }));
      if (showAI) reqs.push(fetch(`${apiBase}/ai/status`, { method: 'GET' }));

      const res = await Promise.all(reqs);

      // assets/stats is always first
      const a0 = res[0];
      if (!a0.ok) {
        const txt = await a0.text().catch(() => '');
        throw new Error(`assets/stats HTTP ${a0.status} — ${txt || 'Erreur'}`);
      }
      const a0json = (await a0.json()) as AssetStatsResponse;
      setAssetStats(a0json);

      let idx = 1;

      if (showAlerts) {
        const a1 = res[idx++];
        if (a1 && a1.ok) setAlertStats(await a1.json());
        else if (a1) {
          // soft-fail alerts
          setAlertStats(null);
        }
      }

      if (showAI) {
        const a2 = res[idx++];
        if (a2 && a2.ok) setAiStatus(await a2.json());
        else setAiStatus(null);
      }

      setLastUpdatedAt(Date.now());
    } catch (e: any) {
      setError(e?.message ?? 'Erreur inconnue');
    } finally {
      setLoading(false);
    }
  }, [apiBase, showAI, showAlerts]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    if (!autoRefreshMs || autoRefreshMs < 5000) return;
    const t = setInterval(() => fetchAll(), autoRefreshMs);
    return () => clearInterval(t);
  }, [autoRefreshMs, fetchAll]);

  const derived = useMemo(() => {
    const s = assetStats;
    if (!s) {
      return {
        coveragePct: 0,
        validPct: 0,
        pendingPct: 0,
        otherAnalyzed: 0,
        byClassRows: [] as Array<{ k: string; v: number; p: number }>,
      };
    }

    const active = s.active ?? 0;
    const withAnalysis = s.with_analysis ?? 0;

    const coveragePct = active > 0 ? (withAnalysis / active) * 100 : 0;

    const valid = s.valid_setups ?? 0;
    const pending = s.pending_setups ?? 0;

    // “Other analyzed” = analysed but neither valid nor pending (invalid/watch/expired/etc)
    const otherAnalyzed = Math.max(0, withAnalysis - valid - pending);

    const validPct = withAnalysis > 0 ? (valid / withAnalysis) * 100 : 0;
    const pendingPct = withAnalysis > 0 ? (pending / withAnalysis) * 100 : 0;

    const byClass = s.by_class ?? {};
    const totalByClass = Object.values(byClass).reduce((a, b) => a + (Number(b) || 0), 0) || 0;

    const byClassRows = Object.entries(byClass)
      .map(([k, v]) => {
        const vv = Number(v) || 0;
        const p = totalByClass > 0 ? (vv / totalByClass) * 100 : 0;
        return { k, v: vv, p };
      })
      .sort((a, b) => b.v - a.v);

    return {
      coveragePct,
      validPct,
      pendingPct,
      otherAnalyzed,
      byClassRows,
    };
  }, [assetStats]);

  const pulseText = useMemo(() => {
    if (!assetStats) return '—';
    const cov = derived.coveragePct;
    const valid = assetStats.valid_setups ?? 0;
    const pending = assetStats.pending_setups ?? 0;

    if (cov < 40) {
      return `Couverture faible (${pct(cov, 0)}). Lance des refresh pour alimenter l’analyse.`;
    }
    if (valid >= pending * 2 && valid >= 5) {
      return `Bon pipeline: beaucoup de setups VALID (${valid}) vs PENDING (${pending}). Priorise l’exécution/gestion.`;
    }
    if (pending > valid) {
      return `Marché en “préparation”: plus de PENDING (${pending}) que de VALID (${valid}). Attends confirmations (SDP/PA).`;
    }
    return `Couverture correcte (${pct(cov, 0)}). Continue la surveillance et le scan multi-symbols.`;
  }, [assetStats, derived.coveragePct]);

  const alertsQuick = useMemo(() => {
    if (!alertStats) return null;
    return {
      total: alertStats.total,
      sent: alertStats.sent,
      failed: alertStats.failed,
      queued: alertStats.queued,
      topPriority: topEntry(alertStats.by_priority),
      topType: topEntry(alertStats.by_type),
    };
  }, [alertStats]);

  return (
    <div
      className={cn(
        'rounded-2xl border border-white/10 bg-white/5 backdrop-blur-[20px] shadow-[0_25px_80px_rgba(0,0,0,0.55)] overflow-hidden',
        className
      )}
    >
      {/* Header */}
      <div className="border-b border-white/10 bg-black/20 px-5 py-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-base font-semibold text-white/90">Market overview</div>
            <div className="text-xs text-white/60 mt-1">
              Vue d’ensemble: couverture analyse, distribution classes, pipeline setups, santé alerting/IA.
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70">
              {lastUpdatedAt ? `updated ${timeAgo(Date.now() - lastUpdatedAt)} ago` : '—'}
            </span>

            <button
              onClick={() => setShowRaw((p) => !p)}
              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition"
            >
              {showRaw ? 'Hide JSON' : 'JSON'}
            </button>

            <button
              onClick={fetchAll}
              className="rounded-xl border border-white/10 bg-gradient-to-b from-[#E85D1A]/80 to-[#E85D1A]/25 px-4 py-2 text-xs font-medium text-white hover:from-[#E85D1A]/90 hover:to-[#E85D1A]/30 transition disabled:opacity-60"
              disabled={loading}
            >
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-4 rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            {error}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="p-5 space-y-5">
        {/* KPIs */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
          <Stat label="Assets total" value={assetStats ? String(assetStats.total) : '—'} />
          <Stat label="Active" value={assetStats ? String(assetStats.active) : '—'} />
          <Stat label="With analysis" value={assetStats ? String(assetStats.with_analysis) : '—'} />
          <Stat label="Coverage" value={assetStats ? pct(derived.coveragePct, 0) : '—'} accent />
          <Stat label="Valid setups" value={assetStats ? String(assetStats.valid_setups) : '—'} className="text-emerald-200" />
          <Stat label="Pending setups" value={assetStats ? String(assetStats.pending_setups) : '—'} className="text-sky-200" />
        </div>

        {/* Pulse */}
        <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-white/90">Pulse</div>
              <div className="text-xs text-white/60 mt-1">
                Interprétation rapide basée sur les stats (couverture + VALID/PENDING).
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Link
                href="/scanner"
                className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition"
              >
                Open scanner →
              </Link>
              <Link
                href="/settings"
                className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition"
              >
                Settings →
              </Link>
            </div>
          </div>

          <div className="mt-3 text-sm text-white/80 leading-relaxed">
            {pulseText}
          </div>
        </div>

        {/* Charts row */}
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
          {/* By class distribution */}
          <div className="xl:col-span-7">
            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-white/90">Distribution by asset class</div>
                  <div className="text-xs text-white/60 mt-1">
                    Répartition des assets dans la DB (source: <code className="text-white/70">/assets/stats</code>).
                  </div>
                </div>
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70">
                  {derived.byClassRows.length} classes
                </span>
              </div>

              <div className="mt-4 space-y-2">
                {derived.byClassRows.length === 0 ? (
                  <div className="rounded-xl border border-white/10 bg-black/30 p-4 text-sm text-white/60">
                    — aucune donnée.
                  </div>
                ) : (
                  derived.byClassRows.slice(0, 10).map((r, idx) => (
                    <BarRow
                      key={r.k}
                      label={r.k}
                      value={r.v}
                      percent={r.p}
                      color={classColor(r.k, idx)}
                    />
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Setup pipeline donut */}
          <div className="xl:col-span-5 space-y-5">
            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-white/90">Setup pipeline</div>
                  <div className="text-xs text-white/60 mt-1">
                    Ratio VALID / PENDING / other (parmi <code className="text-white/70">with_analysis</code>).
                  </div>
                </div>
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70">
                  analyzed {assetStats ? assetStats.with_analysis : '—'}
                </span>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-12">
                <div className="md:col-span-5 flex items-center justify-center">
                  <Donut
                    segments={buildPipelineSegments(assetStats)}
                    size={118}
                    stroke={12}
                  />
                </div>

                <div className="md:col-span-7 space-y-2">
                  <LegendRow color="#1D9E75" label="VALID" value={assetStats ? String(assetStats.valid_setups) : '—'} />
                  <LegendRow color="#378ADD" label="PENDING" value={assetStats ? String(assetStats.pending_setups) : '—'} />
                  <LegendRow color="#A1A1AA" label="OTHER" value={assetStats ? String(derived.otherAnalyzed) : '—'} />

                  <div className="mt-2 rounded-xl border border-white/10 bg-black/30 p-3">
                    <div className="text-[11px] text-white/55">Rates</div>
                    <div className="mt-1 text-xs text-white/80">
                      VALID: <span className="text-emerald-200 font-semibold">{assetStats ? pct(derived.validPct, 0) : '—'}</span>
                      <span className="mx-2 text-white/20">·</span>
                      PENDING: <span className="text-sky-200 font-semibold">{assetStats ? pct(derived.pendingPct, 0) : '—'}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Health row: Alerts + AI */}
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-1">
              {showAlerts && (
                <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-semibold text-white/90">Alerting</div>
                      <div className="text-xs text-white/60 mt-1">
                        Santé du pipeline alertes.
                      </div>
                    </div>
                    <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70">
                      /alerts/stats
                    </span>
                  </div>

                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <MiniStat label="Total" value={alertsQuick?.total !== undefined ? String(alertsQuick.total) : '—'} />
                    <MiniStat label="Queued" value={alertsQuick?.queued !== undefined ? String(alertsQuick.queued) : '—'} />
                    <MiniStat label="Sent" value={alertsQuick?.sent !== undefined ? String(alertsQuick.sent) : '—'} />
                    <MiniStat label="Failed" value={alertsQuick?.failed !== undefined ? String(alertsQuick.failed) : '—'} />
                  </div>

                  <div className="mt-3 text-[11px] text-white/55">
                    Top priority: <span className="text-white/75">{alertsQuick?.topPriority ?? '—'}</span>
                    <span className="mx-2 text-white/20">·</span>
                    Top type: <span className="text-white/75">{alertsQuick?.topType ?? '—'}</span>
                  </div>
                </div>
              )}

              {showAI && (
                <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-semibold text-white/90">IGNIS AI</div>
                      <div className="text-xs text-white/60 mt-1">
                        Status Ollama + modèle actif.
                      </div>
                    </div>
                    <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70">
                      /ai/status
                    </span>
                  </div>

                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <MiniStat
                      label="Online"
                      value={aiStatus ? String(aiStatus.ollama_online) : '—'}
                      valueClass={aiStatus?.ollama_online ? 'text-emerald-200' : 'text-rose-200'}
                    />
                    <MiniStat label="Model" value={aiStatus?.model ?? '—'} />
                    <MiniStat label="Host" value={aiStatus?.host ?? '—'} />
                    <MiniStat label="Version" value={aiStatus?.version ?? '—'} />
                  </div>

                  <div className="mt-3 flex items-center justify-between gap-2">
                    <Link
                      href="/ai"
                      className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition"
                    >
                      Open AI →
                    </Link>

                    <div className="text-[11px] text-white/50">
                      {aiStatus?.ollama_online ? 'AI ready.' : 'AI offline.'}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Raw JSON */}
        <AnimatePresence initial={false}>
          {showRaw && (
            <motion.div
              key="raw"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="rounded-2xl border border-white/10 bg-black/20 p-4"
            >
              <div className="text-xs font-medium text-white/70 mb-2">Raw JSON</div>
              <pre className="rounded-xl border border-white/10 bg-black/30 p-3 text-xs text-white/75 overflow-auto max-h-[520px]">
                {JSON.stringify({ assetStats, alertStats, aiStatus }, null, 2)}
              </pre>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Footer */}
      <div className="border-t border-white/10 bg-black/15 px-5 py-4 flex items-center justify-between gap-3">
        <div className="text-[11px] text-white/50">
          Source: <span className="text-white/60">{apiBase}</span>
          <span className="mx-2 text-white/20">·</span>
          Auto refresh: <span className="text-white/60">{autoRefreshMs ? `${Math.round(autoRefreshMs / 1000)}s` : 'off'}</span>
        </div>

        <Link
          href="/settings"
          className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition"
        >
          Manage assets →
        </Link>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Sub components
────────────────────────────────────────────────────────────── */

function Stat({
  label,
  value,
  accent,
  className,
}: {
  label: string;
  value: string;
  accent?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('rounded-xl border border-white/10 bg-black/20 px-3 py-2', accent && 'bg-gradient-to-b from-white/10 to-black/20')}>
      <div className="text-[11px] text-white/55">{label}</div>
      <div className={cn('text-sm font-semibold text-white/90 truncate', className)}>{value}</div>
    </div>
  );
}

function MiniStat({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2">
      <div className="text-[11px] text-white/55">{label}</div>
      <div className={cn('text-xs font-medium text-white/85 truncate', valueClass)}>{value}</div>
    </div>
  );
}

function BarRow({
  label,
  value,
  percent,
  color,
}: {
  label: string;
  value: number;
  percent: number;
  color: string;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/25 p-3">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
          <div className="text-xs font-semibold text-white/85 truncate">{label}</div>
        </div>
        <div className="text-[11px] text-white/60">
          {fmt(value, 0)} <span className="text-white/35">·</span> {pct(percent, 0)}
        </div>
      </div>

      <div className="h-2 rounded-full border border-white/10 bg-white/5 overflow-hidden">
        <div
          className="h-full rounded-full"
          style={{
            width: `${clamp(percent, 0, 100)}%`,
            background: `linear-gradient(90deg, ${rgba(color, 0.75)} 0%, ${rgba(color, 0.18)} 100%)`,
          }}
        />
      </div>
    </div>
  );
}

function LegendRow({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/25 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
        <div className="text-xs text-white/80">{label}</div>
      </div>
      <div className="text-xs font-semibold text-white/90">{value}</div>
    </div>
  );
}

type DonutSeg = { label: string; value: number; color: string };

function Donut({
  segments,
  size = 120,
  stroke = 12,
}: {
  segments: DonutSeg[];
  size?: number;
  stroke?: number;
}) {
  const total = segments.reduce((a, b) => a + (Number(b.value) || 0), 0) || 1;

  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;

  // build arcs by strokeDasharray
  let acc = 0;

  return (
    <div className="relative">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {/* bg ring */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth={stroke}
        />

        {segments.map((s, i) => {
          const val = clamp((Number(s.value) || 0) / total, 0, 1);
          const dash = val * c;
          const gap = 3; // small gap between segments
          const dashAdj = Math.max(0, dash - gap);

          const offset = acc * c;
          acc += val;

          return (
            <circle
              key={`${s.label}-${i}`}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={rgba(s.color, 0.85)}
              strokeWidth={stroke}
              strokeDasharray={`${dashAdj} ${c - dashAdj}`}
              strokeDashoffset={-offset}
              strokeLinecap="round"
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          );
        })}
      </svg>

      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="text-[11px] text-white/55">Analyzed</div>
        <div className="text-sm font-semibold text-white/90">{fmt(total, 0)}</div>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Logic helpers
────────────────────────────────────────────────────────────── */

function buildPipelineSegments(stats: AssetStatsResponse | null): DonutSeg[] {
  const analyzed = stats?.with_analysis ?? 0;
  const valid = stats?.valid_setups ?? 0;
  const pending = stats?.pending_setups ?? 0;
  const other = Math.max(0, analyzed - valid - pending);

  return [
    { label: 'VALID', value: valid, color: '#1D9E75' },
    { label: 'PENDING', value: pending, color: '#378ADD' },
    { label: 'OTHER', value: other, color: '#A1A1AA' },
  ];
}

function topEntry(map?: Record<string, number>) {
  if (!map) return null;
  const entries = Object.entries(map).map(([k, v]) => [k, Number(v) || 0] as const);
  if (!entries.length) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return `${entries[0][0]} (${entries[0][1]})`;
}

function classColor(k: string, idx: number) {
  const key = k.toUpperCase();
  if (key.includes('CRYPTO')) return '#E85D1A';
  if (key.includes('STOCK')) return '#378ADD';
  if (key.includes('FOREX')) return '#1D9E75';
  if (key.includes('INDEX')) return '#A78BFA';
  if (key.includes('ETF')) return '#22C55E';
  if (key.includes('COMMOD')) return '#F59E0B';

  const palette = ['#E85D1A', '#378ADD', '#1D9E75', '#A78BFA', '#F59E0B', '#EF4444', '#10B981'];
  return palette[idx % palette.length];
}

function rgba(hex: string, a: number) {
  const h = hex.replace('#', '').trim();
  if (h.length !== 6) return `rgba(255,255,255,${a})`;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}