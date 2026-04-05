/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

export type SetupStatus = 'VALID' | 'PENDING' | 'INVALID' | 'WATCH' | 'EXPIRED';

export type SetupBreakdown = {
  base_score: number;
  sde_score: number;
  sdp_score: number;
  pa_score: number;
  dp_score: number;
  kl_score: number;
  structure_score: number;
  total: number;
};

export type SetupResult = {
  status: SetupStatus;
  score: number;
  score_breakdown: SetupBreakdown;
  checklist: Record<string, boolean>;
  invalidation_reason?: string;
  pending_step?: string;
};

export type SLTP = {
  entry: number;
  stop_loss: number;
  take_profit: number;
  rr: number;
  risk_pips: number;
  reward_pips: number;
  position: 'LONG' | 'SHORT';
};

type SetupPanelTab = 'overview' | 'checklist' | 'breakdown' | 'trade';

export default function SetupPanel({
  symbol,
  timeframe,
  setup,
  slTp,
  fromCache,
  durationMs,
  analyzedAt,
  onGenerateAIReport,
  onRequestAnalyze,
  onCreateJournalTrade,
  className,
  defaultTab = 'overview',
}: {
  symbol?: string;
  timeframe?: string;

  setup?: SetupResult | null;
  slTp?: SLTP | null;

  fromCache?: boolean;
  durationMs?: number;
  analyzedAt?: string;

  /** optional action buttons */
  onGenerateAIReport?: () => void;
  onRequestAnalyze?: () => void;

  /** optional quick journal action */
  onCreateJournalTrade?: (payload: {
    symbol: string;
    timeframe: string;
    side: 'LONG' | 'SHORT';
    entry: number;
    sl?: number;
    tp?: number;
    rr?: number;
    notes?: string;
    tags?: string[];
  }) => void;

  className?: string;
  defaultTab?: SetupPanelTab;
}) {
  const [tab, setTab] = useState<SetupPanelTab>(defaultTab);
  const [showRaw, setShowRaw] = useState(false);
  const [checklistMode, setChecklistMode] = useState<'all' | 'only_failed' | 'only_ok'>('all');

  const derived = useMemo(() => {
    if (!setup) {
      return {
        okCount: 0,
        failCount: 0,
        totalChecks: 0,
        weakArea: null as null | { key: keyof SetupBreakdown; value: number },
      };
    }

    const entries = Object.entries(setup.checklist ?? {});
    const okCount = entries.filter(([, v]) => !!v).length;
    const totalChecks = entries.length;
    const failCount = totalChecks - okCount;

    const bd = setup.score_breakdown;
    const candidates: Array<[keyof SetupBreakdown, number]> = [
      ['base_score', bd?.base_score ?? 0],
      ['sde_score', bd?.sde_score ?? 0],
      ['sdp_score', bd?.sdp_score ?? 0],
      ['pa_score', bd?.pa_score ?? 0],
      ['dp_score', bd?.dp_score ?? 0],
      ['kl_score', bd?.kl_score ?? 0],
      ['structure_score', bd?.structure_score ?? 0],
    ];

    const weakArea = candidates
      .slice()
      .sort((a, b) => a[1] - b[1])[0];

    return {
      okCount,
      failCount,
      totalChecks,
      weakArea: weakArea ? { key: weakArea[0], value: weakArea[1] } : null,
    };
  }, [setup]);

  const checklistEntries = useMemo(() => {
    if (!setup?.checklist) return [];
    let entries = Object.entries(setup.checklist);

    if (checklistMode === 'only_failed') entries = entries.filter(([, v]) => !v);
    if (checklistMode === 'only_ok') entries = entries.filter(([, v]) => !!v);

    return entries.sort((a, b) => a[0].localeCompare(b[0]));
  }, [setup?.checklist, checklistMode]);

  const setupPill = useMemo(() => (setup ? statusPill(setup.status) : null), [setup]);
  const scoreGrad = useMemo(() => scoreGradient(setup?.score ?? 0), [setup?.score]);

  const tradeWarnings = useMemo(() => {
    const warnings: string[] = [];
    if (!slTp) return warnings;

    if (!Number.isFinite(slTp.rr)) warnings.push('RR non valide.');
    else if (slTp.rr < 1.2) warnings.push('RR faible (< 1.2).');
    else if (slTp.rr < 1.6) warnings.push('RR moyen (< 1.6).');

    if (slTp.entry <= 0 || slTp.stop_loss <= 0 || slTp.take_profit <= 0) {
      warnings.push('Plan de trade incomplet (entry/SL/TP).');
    }

    // sanity direction check
    if (slTp.position === 'LONG') {
      if (!(slTp.stop_loss < slTp.entry && slTp.take_profit > slTp.entry)) {
        warnings.push('Incohérence LONG: attendu SL < entry < TP.');
      }
    } else {
      if (!(slTp.stop_loss > slTp.entry && slTp.take_profit < slTp.entry)) {
        warnings.push('Incohérence SHORT: attendu TP < entry < SL.');
      }
    }

    return warnings;
  }, [slTp]);

  const actionTradePayload = useMemo(() => {
    if (!symbol || !timeframe || !slTp) return null;
    return {
      symbol: symbol.toUpperCase(),
      timeframe,
      side: slTp.position,
      entry: slTp.entry,
      sl: slTp.stop_loss,
      tp: slTp.take_profit,
      rr: slTp.rr,
      notes: buildTradeNote(setup, slTp),
      tags: buildTradeTags(setup),
    };
  }, [symbol, timeframe, slTp, setup]);

  return (
    <div
      className={cn(
        'rounded-2xl border border-white/10 bg-white/5 backdrop-blur-[20px] shadow-[0_25px_80px_rgba(0,0,0,0.55)] overflow-hidden',
        className
      )}
    >
      {/* Header */}
      <div className="border-b border-white/10 bg-black/20 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="text-sm font-semibold text-white/90">Setup</div>

              {setup && setupPill && (
                <span className={cn('rounded-full border px-2.5 py-1 text-[11px] font-medium', setupPill)}>
                  {setup.status}
                </span>
              )}

              {fromCache !== undefined && (
                <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/65">
                  {fromCache ? 'cache' : 'fresh'}
                </span>
              )}
            </div>

            <div className="text-xs text-white/60 mt-1 truncate">
              {symbol ? <span className="text-white/80">{symbol}</span> : '—'}
              {timeframe ? <span className="text-white/40"> · {timeframe}</span> : null}
              {durationMs !== undefined ? <span className="text-white/35"> · {fmt(durationMs, 0)} ms</span> : null}
              {analyzedAt ? <span className="text-white/35"> · {fmtDate(analyzedAt)}</span> : null}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowRaw((p) => !p)}
              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/75 hover:bg-white/10 transition"
              title="Afficher JSON setup"
            >
              {showRaw ? 'Hide JSON' : 'JSON'}
            </button>

            <button
              onClick={onRequestAnalyze}
              disabled={!onRequestAnalyze}
              className={cn(
                'rounded-xl border px-3 py-2 text-xs font-medium transition',
                onRequestAnalyze
                  ? 'border-[#E85D1A]/25 bg-[#E85D1A]/10 text-orange-200 hover:bg-[#E85D1A]/15'
                  : 'border-white/10 bg-white/5 text-white/40'
              )}
            >
              Re-analyze
            </button>

            <button
              onClick={onGenerateAIReport}
              disabled={!onGenerateAIReport}
              className={cn(
                'rounded-xl border px-3 py-2 text-xs font-medium transition',
                onGenerateAIReport
                  ? 'border-[#378ADD]/25 bg-[#378ADD]/10 text-sky-200 hover:bg-[#378ADD]/15'
                  : 'border-white/10 bg-white/5 text-white/40'
              )}
            >
              AI report
            </button>
          </div>
        </div>

        {/* Score block */}
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-12">
          <div className="md:col-span-5">
            <div className={cn('rounded-2xl border border-white/10 bg-gradient-to-b p-4', scoreGrad)}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-xs text-white/60">Global score</div>
                  <div className="text-3xl font-semibold tracking-tight text-white/95">
                    {setup ? `${fmt(setup.score, 0)}%` : '—'}
                  </div>
                </div>

                <div className="text-right">
                  <div className="text-xs text-white/60">Checklist</div>
                  <div className="text-sm font-semibold text-white/90">
                    {setup ? `${derived.okCount}/${derived.totalChecks}` : '—'}
                  </div>
                  <div className="text-[11px] text-white/55">
                    {setup ? `${derived.failCount} fail` : '—'}
                  </div>
                </div>
              </div>

              <div className="mt-3">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-[11px] text-white/55">Strength</div>
                  <div className="text-[11px] text-white/70">{setup ? `${fmt(setup.score, 0)}%` : '—'}</div>
                </div>
                <ScoreBar value={setup?.score ?? 0} />
              </div>

              {setup?.status === 'INVALID' && setup?.invalidation_reason && (
                <div className="mt-3 rounded-xl border border-rose-500/20 bg-rose-500/10 p-3">
                  <div className="text-[11px] uppercase tracking-wide text-rose-200/90">
                    Invalidation reason
                  </div>
                  <div className="mt-1 text-xs text-rose-100/90 whitespace-pre-wrap leading-relaxed">
                    {setup.invalidation_reason}
                  </div>
                </div>
              )}

              {setup?.status === 'PENDING' && setup?.pending_step && (
                <div className="mt-3 rounded-xl border border-sky-500/20 bg-sky-500/10 p-3">
                  <div className="text-[11px] uppercase tracking-wide text-sky-200/90">
                    Pending step
                  </div>
                  <div className="mt-1 text-xs text-sky-100/90 whitespace-pre-wrap leading-relaxed">
                    {setup.pending_step}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="md:col-span-7">
            {/* Tabs */}
            <div className="rounded-2xl border border-white/10 bg-black/20 overflow-hidden">
              <div className="flex items-center gap-1 border-b border-white/10 bg-black/25 px-2 py-2">
                <TabButton active={tab === 'overview'} onClick={() => setTab('overview')}>Overview</TabButton>
                <TabButton active={tab === 'checklist'} onClick={() => setTab('checklist')}>Checklist</TabButton>
                <TabButton active={tab === 'breakdown'} onClick={() => setTab('breakdown')}>Breakdown</TabButton>
                <TabButton active={tab === 'trade'} onClick={() => setTab('trade')}>Trade plan</TabButton>
              </div>

              <div className="p-4">
                <AnimatePresence mode="wait" initial={false}>
                  {tab === 'overview' && (
                    <motion.div
                      key="overview"
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      className="space-y-3"
                    >
                      <div className="grid grid-cols-2 gap-2">
                        <MiniStat label="Status" value={setup?.status ?? '—'} />
                        <MiniStat label="Score" value={setup ? `${fmt(setup.score, 0)}%` : '—'} />
                        <MiniStat
                          label="Weakest area"
                          value={setup && derived.weakArea ? `${prettyBreakdownKey(derived.weakArea.key)} · ${fmt(derived.weakArea.value, 0)}%` : '—'}
                        />
                        <MiniStat
                          label="Ready?"
                          value={setup ? readinessLabel(setup.status, setup.score) : '—'}
                        />
                      </div>

                      <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                        <div className="text-xs font-medium text-white/70 mb-2">Interpretation</div>
                        <div className="text-xs text-white/70 leading-relaxed">
                          {setup ? (
                            <>
                              <span className="text-white/85 font-semibold">{setup.status}</span>{' '}
                              · Score <span className="text-white/85 font-semibold">{fmt(setup.score, 0)}%</span>.
                              {setup.status === 'VALID' && (
                                <> Confluence correcte; surveille le risque (RR) et l’alignement structurel.</>
                              )}
                              {setup.status === 'PENDING' && (
                                <> Setup intéressant mais incomplet; attend la confirmation indiquée.</>
                              )}
                              {setup.status === 'WATCH' && (
                                <> Contexte à surveiller; pas forcément un déclenchement immédiat.</>
                              )}
                              {setup.status === 'INVALID' && (
                                <> Conditions non réunies; évite de forcer l’entrée.</>
                              )}
                              {setup.status === 'EXPIRED' && (
                                <> Setup expiré (timing passé); chercher une nouvelle zone/structure.</>
                              )}
                            </>
                          ) : (
                            '—'
                          )}
                        </div>
                      </div>
                    </motion.div>
                  )}

                  {tab === 'checklist' && (
                    <motion.div
                      key="checklist"
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      className="space-y-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-xs text-white/60">
                          {setup ? (
                            <>
                              OK: <span className="text-white/80">{derived.okCount}</span>
                              <span className="mx-2 text-white/20">·</span>
                              Fail: <span className="text-white/80">{derived.failCount}</span>
                              <span className="mx-2 text-white/20">·</span>
                              Total: <span className="text-white/80">{derived.totalChecks}</span>
                            </>
                          ) : '—'}
                        </div>

                        <div className="flex items-center gap-2">
                          <select
                            value={checklistMode}
                            onChange={(e) => setChecklistMode(e.target.value as any)}
                            className="rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-xs outline-none"
                          >
                            <option value="all">All</option>
                            <option value="only_failed">Only failed</option>
                            <option value="only_ok">Only OK</option>
                          </select>

                          <button
                            onClick={() => {
                              if (!setup) return;
                              const failed = Object.entries(setup.checklist ?? {}).filter(([, v]) => !v);
                              copyToClipboard(failed.map(([k]) => k).join('\n') || '—');
                            }}
                            disabled={!setup}
                            className={cn(
                              'rounded-xl border px-3 py-2 text-xs transition',
                              setup
                                ? 'border-white/10 bg-white/5 text-white/75 hover:bg-white/10'
                                : 'border-white/10 bg-white/5 text-white/40'
                            )}
                            title="Copie la liste des checks en échec"
                          >
                            Copy failed
                          </button>
                        </div>
                      </div>

                      <div className="max-h-[360px] overflow-auto pr-1 space-y-2">
                        {setup ? (
                          checklistEntries.length ? (
                            checklistEntries.map(([k, v]) => (
                              <div
                                key={k}
                                className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/20 px-3 py-2"
                              >
                                <div className="text-xs text-white/75 truncate">{k}</div>
                                <span className={cn('rounded-full border px-2.5 py-1 text-[11px] font-medium', v ? okPill() : failPill())}>
                                  {v ? 'OK' : 'NO'}
                                </span>
                              </div>
                            ))
                          ) : (
                            <div className="rounded-xl border border-white/10 bg-black/20 p-4 text-sm text-white/60">
                              Aucun item dans ce mode.
                            </div>
                          )
                        ) : (
                          <div className="rounded-xl border border-white/10 bg-black/20 p-4 text-sm text-white/60">
                            Aucune donnée setup.
                          </div>
                        )}
                      </div>
                    </motion.div>
                  )}

                  {tab === 'breakdown' && (
                    <motion.div
                      key="breakdown"
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      className="space-y-3"
                    >
                      {setup ? (
                        <>
                          <div className="text-xs text-white/60">
                            Chaque bloc représente une composante du score (0 → 100).
                          </div>

                          <div className="space-y-2">
                            <BreakdownRow label="Base" value={setup.score_breakdown.base_score} />
                            <BreakdownRow label="SDE" value={setup.score_breakdown.sde_score} />
                            <BreakdownRow label="SDP" value={setup.score_breakdown.sdp_score} />
                            <BreakdownRow label="PA" value={setup.score_breakdown.pa_score} />
                            <BreakdownRow label="DP" value={setup.score_breakdown.dp_score} />
                            <BreakdownRow label="Key levels" value={setup.score_breakdown.kl_score} />
                            <BreakdownRow label="Structure" value={setup.score_breakdown.structure_score} />
                          </div>

                          <div className="mt-2 rounded-xl border border-white/10 bg-black/20 p-3">
                            <div className="flex items-center justify-between">
                              <div className="text-xs font-medium text-white/70">Total</div>
                              <div className="text-sm font-semibold text-white/90">
                                {fmt(setup.score_breakdown.total ?? setup.score, 0)}%
                              </div>
                            </div>
                          </div>
                        </>
                      ) : (
                        <div className="rounded-xl border border-white/10 bg-black/20 p-4 text-sm text-white/60">
                          Aucune donnée breakdown.
                        </div>
                      )}
                    </motion.div>
                  )}

                  {tab === 'trade' && (
                    <motion.div
                      key="trade"
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      className="space-y-3"
                    >
                      {!slTp ? (
                        <div className="rounded-xl border border-white/10 bg-black/20 p-4 text-sm text-white/60">
                          Aucun plan SL/TP disponible dans l’analyse (<code>sl_tp</code> absent).
                        </div>
                      ) : (
                        <>
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="text-sm font-semibold text-white/90">Trade plan</div>
                              <div className="text-xs text-white/60 mt-1">
                                Position <span className="text-white/85 font-semibold">{slTp.position}</span> · RR{' '}
                                <span className="text-white/85 font-semibold">{fmt(slTp.rr, 2)}</span>
                              </div>
                            </div>

                            <span className={cn('rounded-full border px-3 py-1 text-xs font-medium', sidePill(slTp.position))}>
                              {slTp.position}
                            </span>
                          </div>

                          <div className="grid grid-cols-2 gap-2">
                            <MiniStat label="Entry" value={fmt(slTp.entry, 8)} />
                            <MiniStat label="Stop loss" value={fmt(slTp.stop_loss, 8)} />
                            <MiniStat label="Take profit" value={fmt(slTp.take_profit, 8)} />
                            <MiniStat label="RR" value={fmt(slTp.rr, 2)} />
                            <MiniStat label="Risk (pips)" value={fmt(slTp.risk_pips, 2)} />
                            <MiniStat label="Reward (pips)" value={fmt(slTp.reward_pips, 2)} />
                          </div>

                          {tradeWarnings.length > 0 && (
                            <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-3">
                              <div className="text-[11px] uppercase tracking-wide text-amber-200/90">Warnings</div>
                              <ul className="mt-2 space-y-1 text-xs text-amber-100/90 list-disc pl-4">
                                {tradeWarnings.map((w, i) => <li key={i}>{w}</li>)}
                              </ul>
                            </div>
                          )}

                          <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                            <div className="text-xs font-medium text-white/70 mb-2">Actions</div>

                            <div className="grid grid-cols-2 gap-2">
                              <button
                                onClick={() => copyToClipboard(buildTradeNote(setup, slTp))}
                                className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition"
                              >
                                Copy plan
                              </button>

                              <button
                                onClick={() => {
                                  const s = symbol?.toUpperCase() ?? '';
                                  const tf = timeframe ?? '';
                                  if (!onCreateJournalTrade || !actionTradePayload || !s || !tf) return;
                                  onCreateJournalTrade(actionTradePayload);
                                }}
                                disabled={!onCreateJournalTrade || !actionTradePayload}
                                className={cn(
                                  'rounded-xl border px-3 py-2 text-xs font-medium transition',
                                  onCreateJournalTrade && actionTradePayload
                                    ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/15'
                                    : 'border-white/10 bg-white/5 text-white/40'
                                )}
                                title={!onCreateJournalTrade ? 'onCreateJournalTrade non fourni' : 'Créer une entrée journal (parent handler)'}
                              >
                                Add to Journal
                              </button>

                              <button
                                onClick={() => copyToClipboard(`${slTp.entry}`)}
                                className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition"
                              >
                                Copy entry
                              </button>

                              <button
                                onClick={() => copyToClipboard(`${slTp.stop_loss}`)}
                                className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition"
                              >
                                Copy SL
                              </button>
                            </div>
                          </div>
                        </>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>

                {showRaw && (
                  <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-3">
                    <div className="text-xs font-medium text-white/70 mb-2">Raw setup JSON</div>
                    <pre className="rounded-xl border border-white/10 bg-black/30 p-3 text-xs text-white/75 overflow-auto max-h-[260px]">
                      {JSON.stringify({ setup, slTp }, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   UI Bits
────────────────────────────────────────────────────────────── */

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
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

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2">
      <div className="text-[11px] text-white/55">{label}</div>
      <div className="text-xs font-medium text-white/85 truncate">{value}</div>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className={cn('rounded-xl border border-white/10 bg-black/20 px-3 py-2', accent && 'bg-gradient-to-b from-white/10 to-black/20')}>
      <div className="text-[11px] text-white/55">{label}</div>
      <div className="text-sm font-semibold text-white/90 truncate">{value}</div>
    </div>
  );
}

function BreakdownRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/20 p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs text-white/70">{label}</div>
        <div className="text-xs font-semibold text-white/85">{fmt(value, 0)}%</div>
      </div>
      <ScoreBar value={value} />
    </div>
  );
}

function ScoreBar({ value }: { value: number }) {
  const v = Math.max(0, Math.min(100, value ?? 0));
  const grad =
    v >= 85
      ? 'from-emerald-400/60 to-emerald-700/10'
      : v >= 70
        ? 'from-orange-400/60 to-orange-700/10'
        : v >= 55
          ? 'from-amber-400/60 to-amber-700/10'
          : 'from-rose-400/60 to-rose-700/10';

  return (
    <div className="h-2 rounded-full border border-white/10 bg-white/5 overflow-hidden">
      <div className={cn('h-full rounded-full bg-gradient-to-r', grad)} style={{ width: `${v}%` }} />
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Styling helpers
────────────────────────────────────────────────────────────── */

function cn(...classes: Array<string | undefined | null | false>) {
  return classes.filter(Boolean).join(' ');
}

function fmt(n: number | undefined, digits = 2) {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits }).format(n);
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('fr-FR', { hour12: false });
}

function statusPill(status: SetupStatus) {
  switch (status) {
    case 'VALID':
      return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200';
    case 'PENDING':
      return 'border-sky-500/25 bg-sky-500/10 text-sky-200';
    case 'WATCH':
      return 'border-amber-500/25 bg-amber-500/10 text-amber-200';
    case 'INVALID':
      return 'border-rose-500/25 bg-rose-500/10 text-rose-200';
    case 'EXPIRED':
      return 'border-zinc-500/25 bg-zinc-500/10 text-zinc-200';
    default:
      return 'border-white/10 bg-white/5 text-white/70';
  }
}

function sidePill(side: 'LONG' | 'SHORT') {
  return side === 'LONG'
    ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200'
    : 'border-rose-500/25 bg-rose-500/10 text-rose-200';
}

function okPill() {
  return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200';
}
function failPill() {
  return 'border-rose-500/25 bg-rose-500/10 text-rose-200';
}

function scoreGradient(score: number) {
  const s = Math.max(0, Math.min(100, score ?? 0));
  if (s >= 85) return 'from-emerald-400/45 to-emerald-700/10';
  if (s >= 70) return 'from-orange-400/45 to-orange-700/10';
  if (s >= 55) return 'from-amber-400/45 to-amber-700/10';
  return 'from-rose-400/45 to-rose-700/10';
}

function prettyBreakdownKey(k: keyof SetupBreakdown) {
  const map: Record<string, string> = {
    base_score: 'Base',
    sde_score: 'SDE',
    sdp_score: 'SDP',
    pa_score: 'PA',
    dp_score: 'DP',
    kl_score: 'Key Levels',
    structure_score: 'Structure',
    total: 'Total',
  };
  return map[String(k)] ?? String(k);
}

function readinessLabel(status: SetupStatus, score: number) {
  if (status === 'VALID' && score >= 75) return 'Trade-ready';
  if (status === 'VALID') return 'Valid (soft)';
  if (status === 'PENDING') return 'Wait confirm';
  if (status === 'WATCH') return 'Watch';
  if (status === 'EXPIRED') return 'Expired';
  return 'No trade';
}

function buildTradeNote(setup?: SetupResult | null, slTp?: SLTP | null) {
  const lines: string[] = [];
  if (setup) lines.push(`Setup: ${setup.status} · score ${fmt(setup.score, 0)}%`);
  if (slTp) {
    lines.push(`Plan: ${slTp.position} · entry ${slTp.entry} · SL ${slTp.stop_loss} · TP ${slTp.take_profit} · RR ${fmt(slTp.rr, 2)}`);
  }
  if (setup?.status === 'PENDING' && setup.pending_step) lines.push(`Pending: ${setup.pending_step}`);
  if (setup?.status === 'INVALID' && setup.invalidation_reason) lines.push(`Invalid: ${setup.invalidation_reason}`);
  return lines.join('\n');
}

function buildTradeTags(setup?: SetupResult | null) {
  if (!setup) return [];
  const tags: string[] = ['ignis'];
  tags.push(`setup_${setup.status.toLowerCase()}`);
  if (setup.score >= 80) tags.push('high_score');
  else if (setup.score >= 60) tags.push('mid_score');
  else tags.push('low_score');
  return tags;
}

/* ──────────────────────────────────────────────────────────────
   Clipboard
────────────────────────────────────────────────────────────── */

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const el = document.createElement('textarea');
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
  }
}