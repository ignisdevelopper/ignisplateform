/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useCallback, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

type SetupStatus = 'VALID' | 'PENDING' | 'INVALID' | 'WATCH' | 'EXPIRED' | string;

export type IgnisReportData = {
  symbol: string;
  timeframe: string;
  higher_tf?: string;

  report?: string;
  summary?: string;

  setup_status?: SetupStatus;
  score?: number;

  generated_at?: string;
  model?: string;
};

type TabKey = 'report' | 'summary' | 'insights' | 'raw';

export default function IgnisReport({
  data,
  loading,
  error,

  title = 'IGNIS AI Report',
  subtitle = 'Rapport IA (Ollama) + résumé + insights actionnables',

  defaultTab = 'report',
  defaultShowToc = true,

  onGenerate,
  onSummarize,

  className,
}: {
  data?: Partial<IgnisReportData> | null;
  loading?: boolean;
  error?: string | null;

  title?: string;
  subtitle?: string;

  defaultTab?: TabKey;
  defaultShowToc?: boolean;

  onGenerate?: () => void;
  onSummarize?: () => void;

  className?: string;
}) {
  const [tab, setTab] = useState<TabKey>(defaultTab);
  const [showToc, setShowToc] = useState(defaultShowToc);
  const [search, setSearch] = useState('');
  const [wrap, setWrap] = useState(true);

  const symbol = (data?.symbol ?? '—').toUpperCase();
  const timeframe = data?.timeframe ?? '—';

  const report = data?.report ?? '';
  const summary = data?.summary ?? '';

  const score = typeof data?.score === 'number' && Number.isFinite(data.score) ? data.score : undefined;
  const setupStatus = data?.setup_status ?? undefined;

  const metaLine = useMemo(() => {
    const bits: string[] = [];
    if (data?.model) bits.push(`model: ${data.model}`);
    if (data?.generated_at) bits.push(`generated: ${fmtDate(data.generated_at)}`);
    if (data?.higher_tf) bits.push(`HTF: ${data.higher_tf}`);
    return bits.join(' · ');
  }, [data?.model, data?.generated_at, data?.higher_tf]);

  const statusCls = useMemo(() => (setupStatus ? statusPill(setupStatus) : 'border-white/10 bg-white/5 text-white/70'), [setupStatus]);

  const toc = useMemo(() => extractHeadings(report), [report]);

  const filteredReport = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return report;
    // Keep original report, but we highlight in the renderer; still return full text
    return report;
  }, [report, search]);

  const insights = useMemo(() => {
    return buildInsights({ report, summary, score, setupStatus });
  }, [report, summary, score, setupStatus]);

  const copyReport = useCallback(async () => {
    const payload =
      `IGNIS AI REPORT\n` +
      `Symbol: ${symbol} · TF: ${timeframe}\n` +
      (metaLine ? `${metaLine}\n` : '') +
      `\n---\n\n` +
      (report || '—');
    await copyToClipboard(payload);
  }, [symbol, timeframe, metaLine, report]);

  const downloadMd = useCallback(() => {
    const md =
      `# IGNIS AI Report\n\n` +
      `- **Symbol**: ${symbol}\n` +
      `- **Timeframe**: ${timeframe}\n` +
      (data?.higher_tf ? `- **Higher TF**: ${data.higher_tf}\n` : '') +
      (data?.model ? `- **Model**: ${data.model}\n` : '') +
      (data?.generated_at ? `- **Generated**: ${fmtDate(data.generated_at)}\n` : '') +
      (setupStatus ? `- **Setup**: ${setupStatus}\n` : '') +
      (score !== undefined ? `- **Score**: ${Math.round(score)}%\n` : '') +
      `\n---\n\n` +
      (summary ? `## Summary\n\n${summary}\n\n---\n\n` : '') +
      (report || '—');

    downloadText(`ignis-report_${symbol}_${timeframe}.md`, md);
  }, [symbol, timeframe, data?.higher_tf, data?.model, data?.generated_at, setupStatus, score, summary, report]);

  const downloadTxt = useCallback(() => {
    const txt =
      `IGNIS AI REPORT\n\n` +
      `Symbol: ${symbol}\n` +
      `Timeframe: ${timeframe}\n` +
      (data?.higher_tf ? `Higher TF: ${data.higher_tf}\n` : '') +
      (data?.model ? `Model: ${data.model}\n` : '') +
      (data?.generated_at ? `Generated: ${fmtDate(data.generated_at)}\n` : '') +
      (setupStatus ? `Setup: ${setupStatus}\n` : '') +
      (score !== undefined ? `Score: ${Math.round(score)}%\n` : '') +
      `\n` +
      (summary ? `SUMMARY:\n${summary}\n\n` : '') +
      `REPORT:\n${report || '—'}\n`;

    downloadText(`ignis-report_${symbol}_${timeframe}.txt`, txt);
  }, [symbol, timeframe, data?.higher_tf, data?.model, data?.generated_at, setupStatus, score, summary, report]);

  return (
    <div
      className={cn(
        'rounded-2xl border border-white/10 bg-white/5 backdrop-blur-[20px] shadow-[0_25px_80px_rgba(0,0,0,0.55)] overflow-hidden',
        className
      )}
    >
      {/* Header */}
      <div className="border-b border-white/10 bg-black/20 px-5 py-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-base font-semibold text-white/90">{title}</div>

              <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/70">
                {symbol} · {timeframe}
              </span>

              {setupStatus && (
                <span className={cn('rounded-full border px-2.5 py-1 text-[11px] font-medium', statusCls)}>
                  {String(setupStatus).toUpperCase()}
                </span>
              )}

              {score !== undefined && (
                <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/75">
                  score {Math.round(score)}%
                </span>
              )}

              {loading && (
                <span className="rounded-full border border-sky-500/20 bg-sky-500/10 px-2.5 py-1 text-[11px] text-sky-200">
                  generating…
                </span>
              )}
            </div>

            <div className="text-xs text-white/60 mt-1">{subtitle}</div>
            {metaLine && <div className="text-[11px] text-white/45 mt-1 truncate">{metaLine}</div>}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={onGenerate}
              disabled={!onGenerate || loading}
              className={cn(
                'rounded-xl border px-3 py-2 text-xs font-medium transition',
                onGenerate && !loading
                  ? 'border-[#E85D1A]/25 bg-[#E85D1A]/10 text-orange-200 hover:bg-[#E85D1A]/15'
                  : 'border-white/10 bg-white/5 text-white/40'
              )}
            >
              Generate report
            </button>

            <button
              onClick={onSummarize}
              disabled={!onSummarize || loading}
              className={cn(
                'rounded-xl border px-3 py-2 text-xs font-medium transition',
                onSummarize && !loading
                  ? 'border-[#378ADD]/25 bg-[#378ADD]/10 text-sky-200 hover:bg-[#378ADD]/15'
                  : 'border-white/10 bg-white/5 text-white/40'
              )}
            >
              Summarize
            </button>

            <button
              onClick={copyReport}
              disabled={!report}
              className={cn(
                'rounded-xl border px-3 py-2 text-xs transition',
                report
                  ? 'border-white/10 bg-white/5 text-white/80 hover:bg-white/10'
                  : 'border-white/10 bg-white/5 text-white/40'
              )}
              title="Copy report"
            >
              Copy
            </button>

            <button
              onClick={downloadMd}
              disabled={!report}
              className={cn(
                'rounded-xl border px-3 py-2 text-xs transition',
                report
                  ? 'border-white/10 bg-white/5 text-white/80 hover:bg-white/10'
                  : 'border-white/10 bg-white/5 text-white/40'
              )}
              title="Download markdown"
            >
              .md
            </button>

            <button
              onClick={downloadTxt}
              disabled={!report}
              className={cn(
                'rounded-xl border px-3 py-2 text-xs transition',
                report
                  ? 'border-white/10 bg-white/5 text-white/80 hover:bg-white/10'
                  : 'border-white/10 bg-white/5 text-white/40'
              )}
              title="Download text"
            >
              .txt
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <TabButton active={tab === 'report'} onClick={() => setTab('report')}>
            Report
          </TabButton>
          <TabButton active={tab === 'summary'} onClick={() => setTab('summary')}>
            Summary
          </TabButton>
          <TabButton active={tab === 'insights'} onClick={() => setTab('insights')}>
            Insights
          </TabButton>
          <TabButton active={tab === 'raw'} onClick={() => setTab('raw')}>
            Raw
          </TabButton>

          <span className="mx-1 text-white/20">·</span>

          <ToggleButton label="TOC" value={showToc} onClick={() => setShowToc((p) => !p)} />
          <ToggleButton label="Wrap" value={wrap} onClick={() => setWrap((p) => !p)} />

          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search in report…"
                className="w-[260px] max-w-[60vw] rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-xs text-white/85 outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
              />
              {search.trim() && (
                <button
                  onClick={() => setSearch('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-white/70 hover:bg-white/10 transition"
                  title="Clear search"
                  type="button"
                >
                  ×
                </button>
              )}
            </div>
          </div>
        </div>

        {error && (
          <div className="mt-4 rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            {error}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="p-5">
        <AnimatePresence mode="wait" initial={false}>
          {tab === 'summary' && (
            <motion.div
              key="summary"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-4"
            >
              {!summary && (
                <div className="rounded-2xl border border-white/10 bg-black/20 p-5 text-sm text-white/70">
                  Aucun résumé disponible. Clique “Summarize”.
                </div>
              )}

              {summary && (
                <div className="rounded-2xl border border-white/10 bg-black/20 p-5">
                  <div className="text-xs font-medium text-white/70 mb-2">Summary</div>
                  <div className="text-sm text-white/85 whitespace-pre-wrap leading-relaxed">
                    {summary}
                  </div>
                </div>
              )}

              {insights?.takeaways?.length > 0 && (
                <div className="rounded-2xl border border-white/10 bg-black/20 p-5">
                  <div className="text-xs font-medium text-white/70 mb-2">Quick takeaways</div>
                  <ul className="space-y-2">
                    {insights.takeaways.slice(0, 10).map((t, i) => (
                      <li key={i} className="flex items-start gap-3">
                        <span className="mt-1 h-1.5 w-1.5 rounded-full bg-[#E85D1A]" />
                        <span className="text-sm text-white/85 leading-relaxed">{t}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </motion.div>
          )}

          {tab === 'insights' && (
            <motion.div
              key="insights"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-4"
            >
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
                <div className="lg:col-span-7 space-y-4">
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-5">
                    <div className="text-xs font-medium text-white/70 mb-2">Trade plan (extracted)</div>

                    {insights.plan ? (
                      <div className="grid grid-cols-2 gap-2">
                        <MiniStat label="Side" value={insights.plan.side ?? '—'} />
                        <MiniStat label="Entry" value={insights.plan.entry !== undefined ? fmt(insights.plan.entry, 6) : '—'} />
                        <MiniStat label="Stop" value={insights.plan.sl !== undefined ? fmt(insights.plan.sl, 6) : '—'} />
                        <MiniStat label="Target" value={insights.plan.tp !== undefined ? fmt(insights.plan.tp, 6) : '—'} />
                        <MiniStat label="RR" value={insights.plan.rr !== undefined ? fmt(insights.plan.rr, 2) : '—'} />
                        <MiniStat label="Confidence" value={insights.plan.confidence !== undefined ? `${Math.round(insights.plan.confidence)}%` : '—'} />
                      </div>
                    ) : (
                      <div className="text-sm text-white/65">
                        Aucun plan détectable automatiquement (c’est normal si le rapport ne contient pas de chiffres).
                      </div>
                    )}

                    {insights.planNotes?.length ? (
                      <div className="mt-4 rounded-xl border border-white/10 bg-black/30 p-4">
                        <div className="text-[11px] uppercase tracking-wide text-white/45 mb-2">Notes</div>
                        <ul className="space-y-2">
                          {insights.planNotes.slice(0, 8).map((n, i) => (
                            <li key={i} className="text-sm text-white/80 leading-relaxed">
                              {n}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>

                  <div className="rounded-2xl border border-white/10 bg-black/20 p-5">
                    <div className="text-xs font-medium text-white/70 mb-2">Checklist (heuristic)</div>
                    <div className="grid grid-cols-1 gap-2">
                      {insights.checks.map((c, i) => (
                        <div
                          key={i}
                          className={cn(
                            'flex items-center justify-between gap-3 rounded-xl border px-4 py-3',
                            c.ok ? 'border-emerald-500/20 bg-emerald-500/10' : 'border-rose-500/20 bg-rose-500/10'
                          )}
                        >
                          <div className="text-sm text-white/85">{c.label}</div>
                          <span className={cn('rounded-full border px-2.5 py-1 text-[11px] font-medium', c.ok ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200' : 'border-rose-500/25 bg-rose-500/10 text-rose-200')}>
                            {c.ok ? 'OK' : 'NO'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="lg:col-span-5 space-y-4">
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-5">
                    <div className="text-xs font-medium text-white/70 mb-2">Score</div>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-[11px] text-white/55">Global</div>
                        <div className="text-3xl font-semibold text-white/90">
                          {score !== undefined ? `${Math.round(score)}%` : '—'}
                        </div>
                        <div className="text-[11px] text-white/55 mt-1">
                          {setupStatus ? `status: ${String(setupStatus).toUpperCase()}` : 'status: —'}
                        </div>
                      </div>

                      <div className={cn('rounded-2xl border px-3 py-2', statusCls)}>
                        <div className="text-[11px] opacity-80">Setup</div>
                        <div className="text-sm font-semibold">{setupStatus ? String(setupStatus).toUpperCase() : '—'}</div>
                      </div>
                    </div>

                    <div className="mt-3">
                      <div className="flex items-center justify-between mb-1">
                        <div className="text-[11px] text-white/55">Strength</div>
                        <div className="text-[11px] text-white/70">{score !== undefined ? `${Math.round(score)}%` : '—'}</div>
                      </div>
                      <ScoreBar value={score ?? 0} />
                    </div>
                  </div>

                  <div className="rounded-2xl border border-white/10 bg-black/20 p-5">
                    <div className="text-xs font-medium text-white/70 mb-2">Extracted keywords</div>
                    {insights.keywords.length ? (
                      <div className="flex flex-wrap gap-2">
                        {insights.keywords.slice(0, 18).map((k) => (
                          <span key={k} className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/70">
                            {k}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div className="text-sm text-white/60">—</div>
                    )}
                  </div>

                  {insights.risks.length ? (
                    <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-5">
                      <div className="text-xs font-medium text-amber-200 mb-2">Risks / warnings</div>
                      <ul className="space-y-2">
                        {insights.risks.slice(0, 10).map((r, i) => (
                          <li key={i} className="text-sm text-amber-100/90 leading-relaxed">
                            {r}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-5">
                      <div className="text-xs font-medium text-white/70 mb-2">Risks / warnings</div>
                      <div className="text-sm text-white/60">Aucun risque évident détecté automatiquement.</div>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          )}

          {tab === 'raw' && (
            <motion.div
              key="raw"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-4"
            >
              <div className="rounded-2xl border border-white/10 bg-black/20 p-5">
                <div className="text-xs font-medium text-white/70 mb-2">Raw (as received)</div>
                <pre className="rounded-2xl border border-white/10 bg-black/30 p-4 text-xs text-white/75 overflow-auto max-h-[650px]">
                  {JSON.stringify(data ?? null, null, 2)}
                </pre>
              </div>
            </motion.div>
          )}

          {tab === 'report' && (
            <motion.div
              key="report"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="grid grid-cols-1 gap-4 lg:grid-cols-12"
            >
              {/* TOC */}
              <AnimatePresence initial={false}>
                {showToc && (
                  <motion.div
                    key="toc"
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -10 }}
                    className="lg:col-span-4"
                  >
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-white/90">Table of contents</div>
                          <div className="text-xs text-white/60 mt-1">
                            Headings extraits du report.
                          </div>
                        </div>
                        <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/70">
                          {toc.length}
                        </span>
                      </div>

                      <div className="mt-3 space-y-1 max-h-[520px] overflow-auto pr-1">
                        {toc.length === 0 ? (
                          <div className="text-sm text-white/60">— aucun heading détecté.</div>
                        ) : (
                          toc.map((h, idx) => (
                            <button
                              key={`${h.text}-${idx}`}
                              type="button"
                              onClick={() => {
                                const el = document.getElementById(h.anchor);
                                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                              }}
                              className={cn(
                                'w-full text-left rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 transition px-3 py-2',
                                h.level === 1 ? 'text-sm font-semibold text-white/85' : 'text-xs text-white/70'
                              )}
                              style={{ paddingLeft: `${12 + (h.level - 1) * 10}px` }}
                              title={h.text}
                            >
                              {h.text}
                            </button>
                          ))
                        )}
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Report content */}
              <div className={cn(showToc ? 'lg:col-span-8' : 'lg:col-span-12')}>
                <div className="rounded-2xl border border-white/10 bg-black/20 p-5">
                  {!report && (
                    <div className="rounded-2xl border border-white/10 bg-black/30 p-5 text-sm text-white/70">
                      Aucun rapport disponible. Clique “Generate report”.
                    </div>
                  )}

                  {report && (
                    <div className={cn('text-white/85', wrap ? 'whitespace-pre-wrap' : 'whitespace-pre')}>
                      <MarkdownLite text={filteredReport} highlight={search.trim()} />
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Markdown-lite renderer (safe, no deps)
   Supports:
   - headings: #, ##, ###, ####
   - bullets: -, *, 1.
   - code blocks: ``` ... ```
   - inline code: `code`
   - bold: **bold**
   - highlight: simple case-insensitive substring highlight
────────────────────────────────────────────────────────────── */

function MarkdownLite({ text, highlight }: { text: string; highlight?: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  const hl = (highlight ?? '').trim();

  return (
    <div className="space-y-3">
      {blocks.map((b, i) => {
        if (b.type === 'code') {
          return (
            <pre
              key={i}
              className="rounded-2xl border border-white/10 bg-black/40 p-4 text-xs text-white/80 overflow-auto"
            >
              <code>{b.text}</code>
            </pre>
          );
        }

        if (b.type === 'heading') {
          const Tag =
            b.level === 1 ? 'h2' :
            b.level === 2 ? 'h3' :
            b.level === 3 ? 'h4' : 'h5';

          return (
            <div key={i}>
              <div id={b.anchor} />
              <Tag className={cn(
                'font-semibold text-white/95 tracking-tight',
                b.level === 1 ? 'text-xl mt-2' : b.level === 2 ? 'text-lg mt-2' : 'text-base mt-2'
              )}>
                {renderInline(b.text, hl)}
              </Tag>
            </div>
          );
        }

        if (b.type === 'list') {
          return (
            <ul key={i} className="space-y-2 pl-5 list-disc">
              {b.items.map((it, idx) => (
                <li key={idx} className="text-sm text-white/85 leading-relaxed">
                  {renderInline(it, hl)}
                </li>
              ))}
            </ul>
          );
        }

        // paragraph
        return (
          <p key={i} className="text-sm text-white/85 leading-relaxed">
            {renderInline(b.text, hl)}
          </p>
        );
      })}
    </div>
  );
}

type Block =
  | { type: 'heading'; level: 1 | 2 | 3 | 4; text: string; anchor: string }
  | { type: 'code'; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'p'; text: string };

function parseBlocks(text: string): Block[] {
  const lines = (text ?? '').replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // code block
    if (line.trim().startsWith('```')) {
      const fence = line.trim();
      const lang = fence.replace(/```/g, '').trim(); // unused
      i++;
      const codeLines: string[] = [];
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      // consume closing fence if present
      if (i < lines.length && lines[i].trim().startsWith('```')) i++;

      blocks.push({ type: 'code', text: codeLines.join('\n') });
      continue;
    }

    // heading
    const mH = line.match(/^(#{1,4})\s+(.*)$/);
    if (mH) {
      const level = clamp(mH[1].length, 1, 4) as 1 | 2 | 3 | 4;
      const t = (mH[2] ?? '').trim();
      const anchor = `ignis-h-${slug(t)}-${blocks.length}`;
      blocks.push({ type: 'heading', level, text: t, anchor });
      i++;
      continue;
    }

    // list
    const isList = /^(\s*[-*]\s+|\s*\d+\.\s+)/.test(line);
    if (isList) {
      const items: string[] = [];
      while (i < lines.length && /^(\s*[-*]\s+|\s*\d+\.\s+)/.test(lines[i])) {
        items.push(lines[i].replace(/^(\s*[-*]\s+|\s*\d+\.\s+)/, '').trim());
        i++;
      }
      blocks.push({ type: 'list', items });
      continue;
    }

    // blank line => skip
    if (!line.trim()) {
      i++;
      continue;
    }

    // paragraph: collect until blank line
    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !lines[i].trim().startsWith('```') && !/^(#{1,4})\s+/.test(lines[i]) && !/^(\s*[-*]\s+|\s*\d+\.\s+)/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'p', text: para.join('\n').trim() });
  }

  return blocks;
}

function renderInline(text: string, highlight?: string) {
  // inline parsing:
  // - split by backticks for inline code
  // - then inside non-code segments, handle **bold** and highlight
  const parts = splitInlineCode(text);

  return parts.map((p, idx) => {
    if (p.type === 'code') {
      return (
        <code
          key={idx}
          className="rounded-md border border-white/10 bg-black/40 px-1.5 py-0.5 text-[12px] text-white/85"
        >
          {p.value}
        </code>
      );
    }

    // normal text -> parse bold -> highlight
    const boldParts = splitBold(p.value);
    return (
      <React.Fragment key={idx}>
        {boldParts.map((bp, j) => {
          const node = bp.bold ? <strong key={j} className="text-white/95">{bp.value}</strong> : <span key={j}>{bp.value}</span>;
          return wrapHighlight(node, bp.value, highlight, `${idx}-${j}`);
        })}
      </React.Fragment>
    );
  });
}

function splitInlineCode(s: string): Array<{ type: 'text' | 'code'; value: string }> {
  const out: Array<{ type: 'text' | 'code'; value: string }> = [];
  const chunks = s.split('`');
  for (let i = 0; i < chunks.length; i++) {
    out.push({ type: i % 2 === 1 ? 'code' : 'text', value: chunks[i] });
  }
  return out.filter((x) => x.value !== '');
}

function splitBold(s: string): Array<{ bold: boolean; value: string }> {
  // split by **...**
  const out: Array<{ bold: boolean; value: string }> = [];
  const re = /\*\*(.+?)\*\*/g;

  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push({ bold: false, value: s.slice(last, m.index) });
    out.push({ bold: true, value: m[1] ?? '' });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ bold: false, value: s.slice(last) });
  return out.filter((x) => x.value !== '');
}

function wrapHighlight(node: React.ReactNode, rawText: string, highlight?: string, key?: string) {
  const h = (highlight ?? '').trim();
  if (!h) return node;
  // we only highlight on plain string nodes; if rawText doesn't include it, no highlight wrapper
  if (!rawText.toLowerCase().includes(h.toLowerCase())) return node;

  // Instead of attempting to split React nodes, we return a mark background around that span.
  // This is a "good enough" highlight: if the substring exists in this chunk, mark the whole chunk.
  return (
    <mark
      key={key}
      className="rounded-md bg-[#E85D1A]/25 px-1 text-white/95"
      style={{ boxShadow: '0 0 0 1px rgba(232,93,26,0.18) inset' }}
    >
      {node}
    </mark>
  );
}

/* ──────────────────────────────────────────────────────────────
   Insights extraction (heuristics)
────────────────────────────────────────────────────────────── */

function buildInsights(opts: {
  report: string;
  summary: string;
  score?: number;
  setupStatus?: SetupStatus;
}) {
  const { report, summary, score, setupStatus } = opts;

  const text = `${summary}\n\n${report}`.trim();

  const plan = extractTradePlan(text);
  const planNotes = extractPlanNotes(text);

  const keywords = extractKeywords(text);

  const risks = extractRisks(text, score, setupStatus);

  const takeaways = extractTakeaways(text);

  const checks = [
    { label: 'Report present', ok: !!report.trim() },
    { label: 'Summary present', ok: !!summary.trim() },
    { label: 'Trade plan detected', ok: !!plan },
    { label: 'RR detected', ok: !!(plan?.rr !== undefined) },
    { label: 'Entry/SL/TP detected', ok: !!(plan?.entry !== undefined && plan?.sl !== undefined && plan?.tp !== undefined) },
    { label: 'Score high (>= 75)', ok: score !== undefined ? score >= 75 : false },
  ];

  return { plan, planNotes, keywords, risks, takeaways, checks };
}

function extractTradePlan(text: string): null | {
  side?: 'LONG' | 'SHORT';
  entry?: number;
  sl?: number;
  tp?: number;
  rr?: number;
  confidence?: number;
} {
  if (!text) return null;

  const side =
    /(\bLONG\b|\bBUY\b|\bBULLISH\b)/i.test(text)
      ? 'LONG'
      : /(\bSHORT\b|\bSELL\b|\bBEARISH\b)/i.test(text)
        ? 'SHORT'
        : undefined;

  const entry = pickNumberByLabels(text, ['entry', 'entrée', 'buy', 'sell']);
  const sl = pickNumberByLabels(text, ['sl', 'stop', 'stop loss', 'stop-loss', 'invalid', 'invalidation']);
  const tp = pickNumberByLabels(text, ['tp', 'target', 'take profit', 'take-profit', 'objectif']);
  const rr = pickNumberByLabels(text, ['rr', 'risk reward', 'risk/reward']);

  // confidence sometimes as %
  const conf = pickPercentByLabels(text, ['confidence', 'confiance', 'probability', 'probabilité']);

  if (side || entry !== undefined || sl !== undefined || tp !== undefined || rr !== undefined || conf !== undefined) {
    return { side, entry, sl, tp, rr, confidence: conf };
  }
  return null;
}

function extractPlanNotes(text: string): string[] {
  // look for lines containing "if", "wait", "confirmation", "risk"
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const picks = lines.filter((l) =>
    /(confirmation|confirmer|attendre|wait|risk|risque|invalidation|invalid|trigger|condition|si\s)/i.test(l)
  );
  return uniq(picks).slice(0, 12);
}

function extractRisks(text: string, score?: number, setupStatus?: SetupStatus): string[] {
  const risks: string[] = [];

  if (setupStatus && String(setupStatus).toUpperCase() === 'INVALID') {
    risks.push('Le setup est INVALID côté moteur: éviter de forcer une entrée.');
  }
  if (setupStatus && String(setupStatus).toUpperCase() === 'PENDING') {
    risks.push('Le setup est PENDING: attendre la confirmation requise avant entrée.');
  }
  if (score !== undefined && score < 55) {
    risks.push('Score global faible (<55): confluence limitée.');
  }

  // heuristics from text
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const l of lines) {
    if (/(risk|risque|danger|attention|warning|faible|invalid|invalidation|low liquidity|spread|news|volatil)/i.test(l)) {
      // avoid very long lines
      risks.push(l.length > 220 ? `${l.slice(0, 220)}…` : l);
    }
  }

  return uniq(risks).slice(0, 12);
}

function extractTakeaways(text: string): string[] {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  // prioritize bullet-like lines
  const bullets = lines
    .filter((l) => /^[-*•]/.test(l) || /^(takeaway|key point|important|à retenir)/i.test(l))
    .map((l) => l.replace(/^[-*•]\s*/, '').trim());

  const condensed = bullets.length ? bullets : lines;

  return uniq(condensed)
    .filter((l) => l.length >= 12)
    .slice(0, 14);
}

function extractKeywords(text: string): string[] {
  const dict = [
    'SDE', 'SDP', 'FTB', 'FLIPPY', 'BASE', 'RBR', 'DBD', 'RBD', 'DBR',
    'BOS', 'CHOCH', 'BREAK', 'RETEST', 'ENGULF', 'LIQUIDITY', 'SWEEP',
    'TREND', 'STRUCTURE', 'SUPPLY', 'DEMAND', 'RISK', 'RR', 'TP', 'SL',
  ];

  const found: string[] = [];
  for (const k of dict) {
    const re = new RegExp(`\\b${escapeReg(k)}\\b`, 'i');
    if (re.test(text)) found.push(k);
  }
  return found;
}

function pickNumberByLabels(text: string, labels: string[]): number | undefined {
  // try patterns like "entry: 12345" or "Entry = 12345" or "entry 12345"
  const numRe = /(-?\d+(?:[.,]\d+)?)/;

  for (const label of labels) {
    const re = new RegExp(`\\b${escapeReg(label)}\\b\\s*[:=]?\\s*${numRe.source}`, 'i');
    const m = text.match(re);
    if (m && m[1]) return toNumber(m[1]);
  }
  return undefined;
}

function pickPercentByLabels(text: string, labels: string[]): number | undefined {
  for (const label of labels) {
    const re = new RegExp(`\\b${escapeReg(label)}\\b\\s*[:=]?\\s*(\\d+(?:[.,]\\d+)?)\\s*%`, 'i');
    const m = text.match(re);
    if (m && m[1]) return clamp(toNumber(m[1]), 0, 100);
  }
  return undefined;
}

function toNumber(s: string) {
  return Number(String(s).replace(',', '.'));
}

function uniq<T>(arr: T[]) {
  return Array.from(new Set(arr));
}

/* ──────────────────────────────────────────────────────────────
   TOC extraction
────────────────────────────────────────────────────────────── */

function extractHeadings(report: string): Array<{ level: number; text: string; anchor: string }> {
  const lines = (report ?? '').replace(/\r\n/g, '\n').split('\n');
  const out: Array<{ level: number; text: string; anchor: string }> = [];
  let idx = 0;

  for (const l of lines) {
    const m = l.match(/^(#{1,4})\s+(.*)$/);
    if (!m) continue;
    const level = clamp(m[1].length, 1, 4);
    const text = (m[2] ?? '').trim();
    if (!text) continue;
    out.push({ level, text, anchor: `ignis-h-${slug(text)}-${idx++}` });
  }
  return out.slice(0, 80);
}

function slug(s: string) {
  return (s ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 60);
}

/* ──────────────────────────────────────────────────────────────
   UI bits
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
  const s = String(status ?? '').toUpperCase();
  if (s === 'VALID') return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200';
  if (s === 'PENDING') return 'border-sky-500/25 bg-sky-500/10 text-sky-200';
  if (s === 'WATCH') return 'border-amber-500/25 bg-amber-500/10 text-amber-200';
  if (s === 'EXPIRED') return 'border-zinc-500/25 bg-zinc-500/10 text-zinc-200';
  return 'border-rose-500/25 bg-rose-500/10 text-rose-200';
}

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
      type="button"
    >
      {children}
    </button>
  );
}

function ToggleButton({ label, value, onClick }: { label: string; value: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-medium transition',
        value ? 'border-[#E85D1A]/30 bg-[#E85D1A]/10 text-white' : 'border-white/10 bg-white/5 text-white/70 hover:bg-white/10'
      )}
    >
      <span>{label}</span>
      <span className={cn('h-2.5 w-2.5 rounded-full', value ? 'bg-[#E85D1A]' : 'bg-white/30')} />
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

function ScoreBar({ value }: { value: number }) {
  const v = clamp(value ?? 0, 0, 100);
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

function escapeReg(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ──────────────────────────────────────────────────────────────
   Download helpers
────────────────────────────────────────────────────────────── */

function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

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