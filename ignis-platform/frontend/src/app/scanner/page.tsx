/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';

const API_BASE = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:8000/api/v1';
const MONO = "'IBM Plex Mono', 'JetBrains Mono', 'Fira Code', monospace";

type SetupStatus = 'VALID' | 'PENDING' | 'INVALID' | 'WATCH' | 'EXPIRED';
type PAPattern = 'ACCU' | 'THREE_DRIVES' | 'FTL' | 'PATTERN_69' | 'HIDDEN_SDE' | 'NONE';
type ZoneType = 'DEMAND' | 'SUPPLY' | 'FLIPPY_D' | 'FLIPPY_S' | 'HIDDEN_D' | 'HIDDEN_S';
type Timeframe = 'M1'|'M5'|'M15'|'M30'|'H1'|'H2'|'H4'|'H8'|'D1'|'W1'|'MN1';

interface ScanResponse { total: number; valid_count: number; pending_count: number; results: any[]; duration_ms: number; errors?: any[] }
interface AssetResponse { symbol: string; asset_class: string }
type NormalizedRow = {
  symbol: string; timeframe: string; status: SetupStatus; score: number;
  zone_type?: ZoneType; pa_pattern?: PAPattern; rr?: number;
  phase?: string; trend?: string; invalidation_reason?: string; pending_step?: string;
  from_cache?: boolean; analyzed_at?: string; raw: any;
};

function fmt(n?: number | null, d = 2) { if (n == null || Number.isNaN(n)) return '—'; return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: d }).format(n); }
function splitSymbols(s: string) { return Array.from(new Set(s.split(/[\s,;]+/g).map(x => x.trim().toUpperCase()).filter(Boolean))); }

function normalizeRow(r: any): NormalizedRow {
  return {
    symbol: (r?.symbol ?? r?.asset?.symbol ?? '—').toString().toUpperCase(),
    timeframe: (r?.timeframe ?? r?.tf ?? '—').toString(),
    status: (r?.setup?.status ?? r?.status ?? 'INVALID') as SetupStatus,
    score: Number(r?.setup?.score ?? r?.score ?? 0) || 0,
    zone_type: (r?.zone_type ?? r?.setup?.zone_type) as ZoneType | undefined,
    pa_pattern: (r?.pa_pattern ?? r?.setup?.pa_pattern) as PAPattern | undefined,
    rr: r?.rr != null ? Number(r.rr) : r?.setup?.rr != null ? Number(r.setup.rr) : undefined,
    phase: r?.market_structure?.phase ?? r?.phase,
    trend: r?.market_structure?.trend ?? r?.trend,
    invalidation_reason: r?.setup?.invalidation_reason ?? r?.invalidation_reason,
    pending_step: r?.setup?.pending_step ?? r?.pending_step,
    from_cache: !!(r?.from_cache ?? r?.analysis?.from_cache),
    analyzed_at: r?.analyzed_at ?? r?.analysis?.analyzed_at,
    raw: r,
  };
}

const STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  VALID:   { label: 'Valide',      color: '#10b981', bg: 'rgba(16,185,129,0.1)'  },
  PENDING: { label: 'En cours',    color: '#38bdf8', bg: 'rgba(56,189,248,0.1)'  },
  WATCH:   { label: 'Surveiller',  color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
  INVALID: { label: 'Invalide',    color: '#f43f5e', bg: 'rgba(244,63,94,0.1)'   },
  EXPIRED: { label: 'Expiré',      color: '#71717a', bg: 'rgba(113,113,122,0.1)' },
};
const ZONE_META: Record<string, { label: string; color: string }> = {
  DEMAND:   { label: 'Demande',  color: '#10b981' }, SUPPLY:   { label: 'Offre',    color: '#f43f5e' },
  FLIPPY_D: { label: 'Flip D',  color: '#38bdf8' }, FLIPPY_S: { label: 'Flip O',   color: '#e85d1a' },
  HIDDEN_D: { label: 'Cachée D',color: '#2dd4bf' }, HIDDEN_S: { label: 'Cachée S', color: '#fb923c' },
};
const TFS: Timeframe[] = ['M15','M30','H1','H2','H4','H8','D1','W1','MN1'];
const STATUS_OPTS: SetupStatus[] = ['VALID','PENDING','WATCH','INVALID','EXPIRED'];
const PA_OPTS: PAPattern[] = ['ACCU','THREE_DRIVES','FTL','PATTERN_69','HIDDEN_SDE','NONE'];

export default function ScannerPage() {
  const [symbolsText, setSymbolsText] = useState('BTCUSDT ETHUSDT SOLUSDT');
  const [timeframes, setTimeframes] = useState<Timeframe[]>(['H4','D1']);
  const [minScore, setMinScore] = useState(60);
  const [candleLimit, setCandleLimit] = useState(300);
  const [statusFilter, setStatusFilter] = useState<SetupStatus[]>(['VALID','PENDING']);
  const [paFilter, setPaFilter] = useState<PAPattern[]>([]);
  const [view, setView] = useState<'cards'|'table'>('cards');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'score_desc'|'score_asc'|'symbol_asc'|'status_then_score'>('score_desc');
  const [loading, setLoading] = useState(false);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [error, setError] = useState<string|null>(null);
  const [scan, setScan] = useState<ScanResponse|null>(null);
  const [rows, setRows] = useState<NormalizedRow[]>([]);
  const [lastRunAt, setLastRunAt] = useState<string|null>(null);
  const [assetClass, setAssetClass] = useState<'CRYPTO'|'STOCK'|'FOREX'|'ALL'>('CRYPTO');

  const symbols = useMemo(() => splitSymbols(symbolsText), [symbolsText]);

  const filteredRows = useMemo(() => {
    let r = [...rows];
    if (query.trim()) { const q = query.trim().toUpperCase(); r = r.filter(x => x.symbol.includes(q) || x.timeframe.toUpperCase().includes(q)); }
    switch (sort) {
      case 'score_desc': r.sort((a,b) => b.score - a.score); break;
      case 'score_asc':  r.sort((a,b) => a.score - b.score); break;
      case 'symbol_asc': r.sort((a,b) => a.symbol.localeCompare(b.symbol)); break;
      case 'status_then_score': r.sort((a,b) => { const rank = (s: SetupStatus) => ['VALID','PENDING','WATCH','INVALID','EXPIRED'].indexOf(s); return rank(a.status) - rank(b.status) || b.score - a.score; }); break;
    }
    return r;
  }, [rows, query, sort]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { VALID: 0, PENDING: 0, WATCH: 0, INVALID: 0, EXPIRED: 0 };
    rows.forEach(r => { c[r.status] = (c[r.status] ?? 0) + 1; });
    return c;
  }, [rows]);

  const runScan = useCallback(async () => {
    if (!symbols.length) { setError('Ajoute au moins 1 symbole.'); return; }
    if (!timeframes.length) { setError('Sélectionne au moins 1 timeframe.'); return; }
    setError(null); setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/analysis/batch/scan`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbols, timeframes, min_score: minScore, status_filter: statusFilter, pa_filter: paFilter, candle_limit: candleLimit }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} — ${await res.text().catch(() => '')}`);
      const data = await res.json() as ScanResponse;
      setScan(data); setRows((data.results ?? []).map(normalizeRow)); setLastRunAt(new Date().toISOString());
    } catch (e: any) { setError(e?.message ?? 'Erreur inconnue'); }
    finally { setLoading(false); }
  }, [symbols, timeframes, minScore, statusFilter, paFilter, candleLimit]);

  const loadAssets = useCallback(async () => {
    setAssetsLoading(true); setError(null);
    try {
      const url = new URL(`${API_BASE}/assets`);
      if (assetClass !== 'ALL') url.searchParams.set('asset_class', assetClass);
      url.searchParams.set('active', 'true'); url.searchParams.set('limit', '200');
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const list = (data.assets ?? [] as AssetResponse[]).map((a: AssetResponse) => a.symbol.toUpperCase()).filter(Boolean);
      if (!list.length) { setError('Aucun asset actif trouvé.'); return; }
      setSymbolsText(Array.from(new Set([...symbols, ...list])).join(' '));
    } catch (e: any) { setError(e?.message); }
    finally { setAssetsLoading(false); }
  }, [assetClass, symbols]);

  const toggleTF = (tf: Timeframe) => setTimeframes(p => p.includes(tf) ? p.filter(x => x !== tf) : [...p, tf]);
  const toggleStatus = (s: SetupStatus) => setStatusFilter(p => p.includes(s) ? p.filter(x => x !== s) : [...p, s]);
  const togglePA = (p: PAPattern) => setPaFilter(prev => prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p]);

  return (
    <div className="relative min-h-screen p-5 md:p-6" style={{ fontFamily: MONO }}>

      {/* Header bar */}
      <div className="mb-5 flex items-center justify-between gap-4 rounded-xl px-4 py-2.5"
        style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
        <div className="flex items-center gap-3">
          <Link href="/" className="text-xs px-3 py-1.5 rounded-lg transition-all"
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.6)' }}>
            ← Dashboard
          </Link>
          <span className="text-xs font-bold" style={{ color: '#378add', letterSpacing: '0.15em' }}>SCANNER</span>
          <span className="text-xs" style={{ color: 'rgba(255,255,255,0.3)' }}>Multi-symboles · Multi-timeframes · S&D</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setView(v => v === 'cards' ? 'table' : 'cards')}
            className="text-[11px] px-3 py-1.5 rounded-lg transition-all"
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.5)' }}>
            {view === 'cards' ? '⊞ Cartes' : '≡ Tableau'}
          </button>
          <button onClick={runScan} disabled={loading}
            className="text-xs px-4 py-1.5 rounded-lg font-semibold transition-all disabled:opacity-50"
            style={{ background: loading ? 'rgba(56,122,221,0.2)' : 'rgba(56,122,221,0.25)', border: '1px solid rgba(56,122,221,0.4)', color: '#378add' }}>
            {loading ? '⟳ Scan en cours…' : '▶ Lancer le scan'}
          </button>
        </div>
      </div>

      {/* Error */}
      <AnimatePresence>
        {error && (
          <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="mb-4 rounded-xl px-4 py-3 text-sm"
            style={{ background: 'rgba(244,63,94,0.08)', border: '1px solid rgba(244,63,94,0.2)', color: '#f43f5e' }}>
            ✕ {error}
          </motion.div>
        )}
      </AnimatePresence>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">

        {/* LEFT: Config */}
        <div className="xl:col-span-4 space-y-4">

          {/* Symboles */}
          <Section title="Symboles" icon="◈" color="#e85d1a">
            <div className="flex items-center gap-2 mb-3">
              <select value={assetClass} onChange={e => setAssetClass(e.target.value as any)}
                className="flex-1 text-xs rounded-lg px-3 py-2 outline-none"
                style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.7)' }}>
                {['CRYPTO','STOCK','FOREX','ALL'].map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <button onClick={loadAssets} disabled={assetsLoading}
                className="text-xs px-3 py-2 rounded-lg transition-all disabled:opacity-50"
                style={{ background: 'rgba(232,93,26,0.12)', border: '1px solid rgba(232,93,26,0.25)', color: '#e85d1a' }}>
                {assetsLoading ? '…' : '+ Charger DB'}
              </button>
            </div>
            <textarea value={symbolsText} onChange={e => setSymbolsText(e.target.value)} rows={3}
              placeholder="BTCUSDT ETHUSDT SOLUSDT…"
              className="w-full rounded-xl px-3 py-3 text-xs outline-none resize-none"
              style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.8)', fontFamily: MONO }}
              onFocus={e => { (e.target as HTMLElement).style.borderColor = 'rgba(232,93,26,0.4)'; }}
              onBlur={e => { (e.target as HTMLElement).style.borderColor = 'rgba(255,255,255,0.08)'; }} />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {symbols.slice(0, 12).map(s => (
                <span key={s} className="text-[11px] px-2 py-0.5 rounded-lg"
                  style={{ background: 'rgba(232,93,26,0.08)', border: '1px solid rgba(232,93,26,0.2)', color: '#e85d1a' }}>
                  {s}
                </span>
              ))}
              {symbols.length > 12 && <span className="text-[11px] px-2 py-0.5 rounded-lg" style={{ color: 'rgba(255,255,255,0.3)' }}>+{symbols.length - 12}</span>}
            </div>
            <div className="mt-2 text-[11px]" style={{ color: 'rgba(255,255,255,0.3)' }}>{symbols.length} symbole{symbols.length > 1 ? 's' : ''} · séparés par espaces ou virgules</div>
          </Section>

          {/* Timeframes */}
          <Section title="Timeframes" icon="◎" color="#378add">
            <div className="flex gap-2 mb-3 text-[11px]" style={{ color: 'rgba(255,255,255,0.35)' }}>
              <button onClick={() => setTimeframes(['H4','D1'])} className="hover:text-white transition">H4/D1</button>
              <span style={{ color: 'rgba(255,255,255,0.15)' }}>·</span>
              <button onClick={() => setTimeframes([...TFS])} className="hover:text-white transition">Tous</button>
              <span style={{ color: 'rgba(255,255,255,0.15)' }}>·</span>
              <button onClick={() => setTimeframes([])} className="hover:text-white transition">Aucun</button>
            </div>
            <div className="flex flex-wrap gap-2">
              {TFS.map(tf => (
                <button key={tf} onClick={() => toggleTF(tf)}
                  className="text-xs px-3 py-1.5 rounded-lg font-medium transition-all"
                  style={{
                    background: timeframes.includes(tf) ? 'rgba(56,122,221,0.2)' : 'rgba(255,255,255,0.04)',
                    border: `1px solid ${timeframes.includes(tf) ? 'rgba(56,122,221,0.4)' : 'rgba(255,255,255,0.08)'}`,
                    color: timeframes.includes(tf) ? '#378add' : 'rgba(255,255,255,0.45)',
                  }}>
                  {tf}
                </button>
              ))}
            </div>
            <div className="mt-2 text-[11px]" style={{ color: 'rgba(255,255,255,0.3)' }}>{timeframes.length} timeframe{timeframes.length > 1 ? 's' : ''} sélectionné{timeframes.length > 1 ? 's' : ''}</div>
          </Section>

          {/* Paramètres */}
          <Section title="Paramètres" icon="◐" color="#8b5cf6">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-[11px] mb-1.5" style={{ color: 'rgba(255,255,255,0.4)' }}>Score minimum</div>
                <input type="number" min={0} max={100} value={minScore} onChange={e => setMinScore(Number(e.target.value))}
                  className="w-full rounded-xl px-3 py-2 text-sm outline-none"
                  style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.85)', fontFamily: MONO }} />
              </div>
              <div>
                <div className="text-[11px] mb-1.5" style={{ color: 'rgba(255,255,255,0.4)' }}>Limite bougies</div>
                <input type="number" min={100} max={5000} value={candleLimit} onChange={e => setCandleLimit(Number(e.target.value))}
                  className="w-full rounded-xl px-3 py-2 text-sm outline-none"
                  style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.85)', fontFamily: MONO }} />
              </div>
            </div>
            <div className="mt-2 text-[11px]" style={{ color: 'rgba(255,255,255,0.3)' }}>
              Total requêtes : {symbols.length} × {timeframes.length} = {symbols.length * timeframes.length} analyses
            </div>
          </Section>

          {/* Filtres statut */}
          <Section title="Filtre statut" icon="✦" color="#10b981">
            <div className="flex gap-2 mb-3 text-[11px]" style={{ color: 'rgba(255,255,255,0.35)' }}>
              <button onClick={() => setStatusFilter(['VALID','PENDING'])} className="hover:text-white transition">Défaut</button>
              <span style={{ color: 'rgba(255,255,255,0.15)' }}>·</span>
              <button onClick={() => setStatusFilter([...STATUS_OPTS])} className="hover:text-white transition">Tous</button>
              <span style={{ color: 'rgba(255,255,255,0.15)' }}>·</span>
              <button onClick={() => setStatusFilter([])} className="hover:text-white transition">Aucun</button>
            </div>
            <div className="flex flex-wrap gap-2">
              {STATUS_OPTS.map(s => {
                const m = STATUS_META[s]; const on = statusFilter.includes(s);
                return (
                  <button key={s} onClick={() => toggleStatus(s)}
                    className="text-xs px-3 py-1.5 rounded-lg font-medium transition-all"
                    style={{ background: on ? m.bg : 'rgba(255,255,255,0.04)', border: `1px solid ${on ? m.color + '40' : 'rgba(255,255,255,0.08)'}`, color: on ? m.color : 'rgba(255,255,255,0.4)' }}>
                    {m.label}
                  </button>
                );
              })}
            </div>
          </Section>

          {/* Filtre PA */}
          <Section title="Filtre pattern PA" icon="◇" color="#f59e0b">
            <div className="flex gap-2 mb-3 text-[11px]" style={{ color: 'rgba(255,255,255,0.35)' }}>
              <button onClick={() => setPaFilter([])} className="hover:text-white transition">Aucun</button>
              <span style={{ color: 'rgba(255,255,255,0.15)' }}>·</span>
              <button onClick={() => setPaFilter(['ACCU','FTL'])} className="hover:text-white transition">ACCU/FTL</button>
            </div>
            <div className="flex flex-wrap gap-2">
              {PA_OPTS.map(p => {
                const on = paFilter.includes(p);
                return (
                  <button key={p} onClick={() => togglePA(p)}
                    className="text-xs px-3 py-1.5 rounded-lg transition-all"
                    style={{ background: on ? 'rgba(56,189,248,0.12)' : 'rgba(255,255,255,0.04)', border: `1px solid ${on ? 'rgba(56,189,248,0.35)' : 'rgba(255,255,255,0.08)'}`, color: on ? '#38bdf8' : 'rgba(255,255,255,0.4)' }}>
                    {p}
                  </button>
                );
              })}
            </div>
          </Section>
        </div>

        {/* RIGHT: Résultats */}
        <div className="xl:col-span-8 space-y-4">

          {/* Stats bar */}
          <div className="grid grid-cols-3 gap-3 md:grid-cols-6">
            {[
              { label: 'Résultats', value: scan ? String(scan.total) : '—', color: '#ffffff' },
              { label: 'Valides',   value: String(counts.VALID),   color: '#10b981' },
              { label: 'En cours',  value: String(counts.PENDING),  color: '#38bdf8' },
              { label: 'Surveiller',value: String(counts.WATCH),    color: '#f59e0b' },
              { label: 'Invalides', value: String(counts.INVALID),  color: '#f43f5e' },
              { label: 'Durée',     value: scan ? `${fmt(scan.duration_ms, 0)}ms` : '—', color: '#71717a' },
            ].map((s, i) => (
              <motion.div key={s.label} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}
                className="rounded-2xl p-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
                <div className="text-[11px] mb-1" style={{ color: 'rgba(255,255,255,0.4)' }}>{s.label}</div>
                <div className="text-xl font-bold tabular-nums" style={{ color: s.color, fontFamily: MONO }}>{s.value}</div>
              </motion.div>
            ))}
          </div>

          {/* Toolbar résultats */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs" style={{ color: 'rgba(255,255,255,0.3)' }}>⌕</span>
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Filtrer — BTC, H4, VALID…"
                className="w-full rounded-xl pl-9 pr-4 py-2.5 text-xs outline-none"
                style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.8)', fontFamily: MONO }} />
            </div>
            <select value={sort} onChange={e => setSort(e.target.value as any)}
              className="text-xs rounded-xl px-3 py-2.5 outline-none"
              style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.7)' }}>
              <option value="score_desc">Score ↓</option>
              <option value="score_asc">Score ↑</option>
              <option value="symbol_asc">Symbole A→Z</option>
              <option value="status_then_score">Statut → Score</option>
            </select>
            <span className="text-xs" style={{ color: 'rgba(255,255,255,0.3)' }}>{filteredRows.length} / {rows.length}</span>
          </div>

          {/* Empty / loading */}
          {loading && (
            <div className="rounded-2xl p-8 text-center" style={{ background: 'rgba(255,255,255,0.02)', border: '1px dashed rgba(56,122,221,0.2)' }}>
              <div className="text-2xl mb-3" style={{ color: '#378add' }}>⟳</div>
              <div className="text-sm font-medium mb-1" style={{ color: 'rgba(255,255,255,0.6)' }}>Scan en cours…</div>
              <div className="text-xs" style={{ color: 'rgba(255,255,255,0.3)' }}>{symbols.length} symboles × {timeframes.length} timeframes = {symbols.length * timeframes.length} analyses</div>
            </div>
          )}

          {!loading && rows.length === 0 && (
            <div className="rounded-2xl py-14 px-6 text-center" style={{ background: 'rgba(255,255,255,0.02)', border: '1px dashed rgba(255,255,255,0.08)' }}>
              <div className="text-3xl mb-3" style={{ color: 'rgba(255,255,255,0.15)' }}>⊞</div>
              <div className="text-sm font-medium mb-2" style={{ color: 'rgba(255,255,255,0.5)' }}>Aucun résultat</div>
              <div className="text-xs max-w-sm mx-auto" style={{ color: 'rgba(255,255,255,0.3)' }}>
                Configure tes symboles et timeframes à gauche, puis clique <strong style={{ color: '#378add' }}>▶ Lancer le scan</strong>.
              </div>
              <button onClick={runScan} className="mt-4 text-sm px-6 py-2.5 rounded-xl font-semibold transition-all"
                style={{ background: 'rgba(56,122,221,0.2)', border: '1px solid rgba(56,122,221,0.35)', color: '#378add' }}>
                ▶ Lancer maintenant
              </button>
            </div>
          )}

          {/* Cards view */}
          {!loading && filteredRows.length > 0 && view === 'cards' && (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <AnimatePresence>
                {filteredRows.map((r, i) => {
                  const sm = STATUS_META[r.status]; const zm = r.zone_type ? ZONE_META[r.zone_type] : null;
                  const barColor = r.score >= 80 ? '#10b981' : r.score >= 60 ? '#f59e0b' : '#f43f5e';
                  return (
                    <motion.div key={`${r.symbol}-${r.timeframe}`} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i * 0.03, 0.3) }}
                      className="rounded-2xl p-4 relative overflow-hidden"
                      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'rgba(56,122,221,0.25)'; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,255,255,0.07)'; }}>
                      {/* Score bar */}
                      <div className="absolute top-0 left-0 h-0.5 rounded-t-2xl" style={{ width: `${r.score}%`, background: barColor, boxShadow: `0 0 8px ${barColor}80` }} />

                      <div className="flex items-start justify-between gap-3 mb-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-bold" style={{ color: 'rgba(255,255,255,0.95)', fontFamily: MONO }}>{r.symbol}</span>
                            <span className="text-xs px-2 py-0.5 rounded-lg font-medium" style={{ background: 'rgba(56,122,221,0.12)', border: '1px solid rgba(56,122,221,0.25)', color: '#378add' }}>{r.timeframe}</span>
                            {r.from_cache !== undefined && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.3)' }}>
                                {r.from_cache ? 'cache' : 'fresh'}
                              </span>
                            )}
                          </div>
                          {(r.phase || r.trend) && (
                            <div className="text-[11px] mt-1" style={{ color: 'rgba(255,255,255,0.4)' }}>
                              {r.phase && <span>Phase: <span style={{ color: 'rgba(255,255,255,0.65)' }}>{r.phase}</span></span>}
                              {r.phase && r.trend && <span style={{ color: 'rgba(255,255,255,0.2)' }}> · </span>}
                              {r.trend && <span>Trend: <span style={{ color: 'rgba(255,255,255,0.65)' }}>{r.trend}</span></span>}
                            </div>
                          )}
                        </div>
                        <div className="text-right">
                          <div className="text-[11px]" style={{ color: 'rgba(255,255,255,0.4)' }}>Score</div>
                          <div className="text-2xl font-bold tabular-nums" style={{ color: barColor, fontFamily: MONO, textShadow: `0 0 20px ${barColor}60` }}>{fmt(r.score, 0)}%</div>
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-1.5 mb-3">
                        <span className="text-[11px] px-2 py-0.5 rounded-lg font-medium flex items-center gap-1"
                          style={{ background: sm.bg, border: `1px solid ${sm.color}35`, color: sm.color }}>
                          <span className="h-1.5 w-1.5 rounded-full" style={{ background: sm.color }} />{sm.label}
                        </span>
                        {zm && <span className="text-[11px] px-2 py-0.5 rounded-lg" style={{ background: `${zm.color}10`, border: `1px solid ${zm.color}25`, color: zm.color }}>{zm.label}</span>}
                        {r.pa_pattern && <span className="text-[11px] px-2 py-0.5 rounded-lg" style={{ background: 'rgba(56,189,248,0.1)', border: '1px solid rgba(56,189,248,0.25)', color: '#38bdf8' }}>PA: {r.pa_pattern}</span>}
                        {r.rr != null && <span className="text-[11px] px-2 py-0.5 rounded-lg" style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.5)' }}>RR {fmt(r.rr, 2)}</span>}
                      </div>

                      {(r.invalidation_reason || r.pending_step) && (
                        <div className="mb-3 rounded-xl px-3 py-2 text-xs" style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.06)' }}>
                          <span style={{ color: 'rgba(255,255,255,0.35)' }}>{r.status === 'INVALID' ? 'Raison : ' : 'Étape : '}</span>
                          <span style={{ color: 'rgba(255,255,255,0.65)' }}>{r.invalidation_reason ?? r.pending_step}</span>
                        </div>
                      )}

                      <div className="flex items-center justify-between">
                        <span className="text-[11px]" style={{ color: 'rgba(255,255,255,0.25)' }}>
                          {r.analyzed_at ? new Date(r.analyzed_at).toLocaleString('fr-FR', { hour12: false }) : '—'}
                        </span>
                        <Link href={`/analysis/${encodeURIComponent(r.symbol)}`}
                          className="text-xs px-3 py-1.5 rounded-xl font-medium transition-all"
                          style={{ background: 'rgba(56,122,221,0.12)', border: '1px solid rgba(56,122,221,0.25)', color: '#378add' }}
                          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(56,122,221,0.2)'; }}
                          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(56,122,221,0.12)'; }}>
                          Analyser →
                        </Link>
                      </div>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          )}

          {/* Table view */}
          {!loading && filteredRows.length > 0 && view === 'table' && (
            <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.07)' }}>
              <table className="w-full text-left">
                <thead>
                  <tr style={{ background: 'rgba(0,0,0,0.4)', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                    {['Symbole','TF','Statut','Score','Zone','PA','RR','Phase/Trend',''].map(h => (
                      <th key={h} className="px-4 py-3 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'rgba(255,255,255,0.35)', letterSpacing: '0.08em' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((r, i) => {
                    const sm = STATUS_META[r.status]; const zm = r.zone_type ? ZONE_META[r.zone_type] : null;
                    const barColor = r.score >= 80 ? '#10b981' : r.score >= 60 ? '#f59e0b' : '#f43f5e';
                    return (
                      <tr key={`${r.symbol}-${r.timeframe}-${i}`}
                        style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)' }}
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(56,122,221,0.05)'; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)'; }}>
                        <td className="px-4 py-3">
                          <span className="text-sm font-bold" style={{ color: 'rgba(255,255,255,0.9)', fontFamily: MONO }}>{r.symbol}</span>
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-xs px-2 py-0.5 rounded-lg" style={{ background: 'rgba(56,122,221,0.1)', color: '#378add' }}>{r.timeframe}</span>
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-[11px] px-2 py-0.5 rounded-lg font-medium" style={{ background: sm.bg, color: sm.color }}>{sm.label}</span>
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-sm font-bold tabular-nums" style={{ color: barColor, fontFamily: MONO }}>{fmt(r.score, 0)}%</span>
                        </td>
                        <td className="px-4 py-3">
                          {zm ? <span className="text-xs flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: zm.color }} /><span style={{ color: zm.color }}>{zm.label}</span></span> : <span style={{ color: 'rgba(255,255,255,0.2)' }}>—</span>}
                        </td>
                        <td className="px-4 py-3 text-xs" style={{ color: r.pa_pattern ? '#38bdf8' : 'rgba(255,255,255,0.2)' }}>{r.pa_pattern ?? '—'}</td>
                        <td className="px-4 py-3 text-xs tabular-nums" style={{ color: 'rgba(255,255,255,0.6)', fontFamily: MONO }}>{r.rr != null ? fmt(r.rr, 2) : '—'}</td>
                        <td className="px-4 py-3 text-xs" style={{ color: 'rgba(255,255,255,0.45)' }}>{r.phase ?? '—'} · {r.trend ?? '—'}</td>
                        <td className="px-4 py-3 text-right">
                          <Link href={`/analysis/${encodeURIComponent(r.symbol)}`}
                            className="text-xs px-3 py-1.5 rounded-lg transition-all"
                            style={{ background: 'rgba(56,122,221,0.1)', border: '1px solid rgba(56,122,221,0.2)', color: '#378add' }}>
                            Analyser →
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Errors from scan */}
          {scan?.errors?.length ? (
            <div className="rounded-2xl p-4" style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.2)' }}>
              <div className="text-xs font-semibold mb-2" style={{ color: '#f59e0b' }}>⚠ Erreurs ({scan.errors.length})</div>
              <div className="space-y-1">
                {scan.errors.slice(0, 5).map((e, i) => (
                  <div key={i} className="text-xs" style={{ color: 'rgba(255,255,255,0.5)' }}>{typeof e === 'string' ? e : JSON.stringify(e)}</div>
                ))}
              </div>
            </div>
          ) : null}

          {/* Last run info */}
          {lastRunAt && (
            <div className="text-[11px]" style={{ color: 'rgba(255,255,255,0.25)' }}>
              Dernier scan : {new Date(lastRunAt).toLocaleString('fr-FR', { hour12: false })} · {API_BASE}/analysis/batch/scan
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, icon, color, children }: { title: string; icon: string; color: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl p-4" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
      <div className="flex items-center gap-2 mb-4">
        <span style={{ color }}>{icon}</span>
        <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'rgba(255,255,255,0.5)', letterSpacing: '0.1em' }}>{title}</span>
      </div>
      {children}
    </div>
  );
}