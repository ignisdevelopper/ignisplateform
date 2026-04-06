/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:8000/api/v1';
const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:8000/ws';

type SetupStatus = 'VALID' | 'PENDING' | 'INVALID' | 'WATCH' | 'EXPIRED';
type ZoneType = 'DEMAND' | 'SUPPLY' | 'FLIPPY_D' | 'FLIPPY_S' | 'HIDDEN_D' | 'HIDDEN_S';
type PAPattern = 'ACCU' | 'THREE_DRIVES' | 'FTL' | 'PATTERN_69' | 'HIDDEN_SDE' | 'NONE';
type AssetClass = 'CRYPTO' | 'STOCK' | 'FOREX' | 'COMMODITY' | 'INDEX' | 'ETF' | 'OTHER';

interface AssetResponse {
  symbol: string; asset_class: string; name: string; exchange: string;
  active: boolean; last_price?: number; last_analysis_at?: string;
  setup?: { status: SetupStatus; score: number; zone_type?: ZoneType; pa_pattern?: PAPattern; rr?: number };
  created_at: string; updated_at: string; meta?: any;
}
interface AssetsListResponse { total: number; assets: AssetResponse[] }
interface AssetStatsResponse {
  total: number; active: number; by_class: Record<string, number>;
  with_analysis: number; valid_setups: number; pending_setups: number;
}
interface AlertEvent {
  id: string; alert_type: string; priority: string; symbol: string;
  timeframe: string; title: string; message: string; emoji?: string;
  payload: any; channels: string[]; status: string; created_at: string;
}

function cn(...c: Array<string | undefined | null | false>) { return c.filter(Boolean).join(' '); }
function fmt(n?: number | null, d = 2) {
  if (n == null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: d }).format(n);
}
function fmtDate(iso?: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('fr-FR', { hour12: false });
}
function timeAgo(iso?: string | null) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  if (ms < 86400000) return `${Math.round(ms / 3600000)}h`;
  return `${Math.round(ms / 86400000)}j`;
}

const STATUS_META: Record<string, { label: string; color: string; bg: string; dot: string }> = {
  VALID:   { label: 'Valide',      color: '#10b981', bg: 'rgba(16,185,129,0.08)',  dot: '#10b981' },
  PENDING: { label: 'En cours',    color: '#38bdf8', bg: 'rgba(56,189,248,0.08)',  dot: '#38bdf8' },
  WATCH:   { label: 'Surveiller',  color: '#f59e0b', bg: 'rgba(245,158,11,0.08)', dot: '#f59e0b' },
  INVALID: { label: 'Invalide',    color: '#f43f5e', bg: 'rgba(244,63,94,0.08)',   dot: '#f43f5e' },
  EXPIRED: { label: 'Expiré',      color: '#71717a', bg: 'rgba(113,113,122,0.08)', dot: '#71717a' },
};
const ZONE_META: Record<string, { label: string; color: string }> = {
  DEMAND:   { label: 'Demande',        color: '#10b981' },
  SUPPLY:   { label: 'Offre',          color: '#f43f5e' },
  FLIPPY_D: { label: 'Flippy Demande', color: '#38bdf8' },
  FLIPPY_S: { label: 'Flippy Offre',   color: '#e85d1a' },
  HIDDEN_D: { label: 'Cachée D',       color: '#2dd4bf' },
  HIDDEN_S: { label: 'Cachée S',       color: '#fb923c' },
};
const PRIORITY_META: Record<string, { color: string; bg: string }> = {
  CRITICAL: { color: '#f43f5e', bg: 'rgba(244,63,94,0.10)'   },
  HIGH:     { color: '#f97316', bg: 'rgba(249,115,22,0.10)'  },
  MEDIUM:   { color: '#38bdf8', bg: 'rgba(56,189,248,0.10)'  },
  LOW:      { color: '#71717a', bg: 'rgba(113,113,122,0.10)' },
};

export default function DashboardPage() {
  const [assetClass, setAssetClass] = useState<AssetClass | 'ALL'>('CRYPTO');
  const [activeOnly, setActiveOnly] = useState(true);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(60);
  const [offset, setOffset] = useState(0);
  const [assets, setAssets] = useState<AssetResponse[]>([]);
  const [assetsTotal, setAssetsTotal] = useState(0);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [stats, setStats] = useState<AssetStatsResponse | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [alerts, setAlerts] = useState<AlertEvent[]>([]);
  const [alertsLoading, setAlertsLoading] = useState(false);
  const [alertLimit] = useState(30);
  const [wsStatus, setWsStatus] = useState<'DISCONNECTED' | 'CONNECTING' | 'CONNECTED'>('DISCONNECTED');
  const wsRef = useRef<WebSocket | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'watchlist' | 'alertes'>('watchlist');
  const [selectedAsset, setSelectedAsset] = useState<AssetResponse | null>(null);

  const page = useMemo(() => Math.floor(offset / limit) + 1, [offset, limit]);
  const pageCount = useMemo(() => Math.max(1, Math.ceil(assetsTotal / limit)), [assetsTotal, limit]);
  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return assets;
    return assets.filter(a => `${a.symbol} ${a.name ?? ''} ${a.exchange ?? ''}`.toUpperCase().includes(q));
  }, [assets, query]);
  const kpis = useMemo(() => {
    const active = stats?.active ?? 0;
    const withAn = stats?.with_analysis ?? 0;
    return { active, withAnalysis: withAn, coverage: active > 0 ? Math.round((withAn / active) * 100) : 0, valid: stats?.valid_setups ?? 0, pending: stats?.pending_setups ?? 0, total: stats?.total ?? 0 };
  }, [stats]);

  const fetchAssets = useCallback(async () => {
    setAssetsLoading(true); setError(null);
    try {
      const url = new URL(`${API_BASE}/assets`);
      if (assetClass !== 'ALL') url.searchParams.set('asset_class', assetClass);
      url.searchParams.set('active', activeOnly ? 'true' : 'false');
      url.searchParams.set('limit', String(limit));
      url.searchParams.set('offset', String(offset));
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as AssetsListResponse;
      setAssets(data.assets ?? []); setAssetsTotal(Number(data.total ?? data.assets?.length ?? 0));
    } catch (e: any) { setError(e?.message ?? 'Erreur assets'); }
    finally { setAssetsLoading(false); }
  }, [assetClass, activeOnly, limit, offset]);

  const fetchStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/assets/stats`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStats(await res.json() as AssetStatsResponse);
    } catch {} finally { setStatsLoading(false); }
  }, []);

  const fetchAlerts = useCallback(async () => {
    setAlertsLoading(true);
    try {
      const url = new URL(`${API_BASE}/alerts`);
      url.searchParams.set('limit', String(alertLimit));
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const list = data.alerts ?? data.items ?? data.results ?? data ?? [];
      setAlerts(Array.isArray(list) ? list : []);
    } catch {} finally { setAlertsLoading(false); }
  }, [alertLimit]);

  const refreshAll = useCallback(async () => {
    await Promise.all([fetchAssets(), fetchStats(), fetchAlerts()]);
    setNotice('Données mises à jour'); setTimeout(() => setNotice(null), 2000);
  }, [fetchAssets, fetchStats, fetchAlerts]);

  const refreshAsset = useCallback(async (symbol: string) => {
    try {
      await fetch(`${API_BASE}/assets/${encodeURIComponent(symbol)}/refresh`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeframe: 'H4', force: false }),
      });
      setNotice(`Analyse lancée : ${symbol}`); setTimeout(() => setNotice(null), 2000);
      setTimeout(fetchAssets, 1000);
    } catch (e: any) { setError(e?.message); }
  }, [fetchAssets]);

  useEffect(() => { fetchAssets(); }, [fetchAssets]);
  useEffect(() => { fetchStats(); }, [fetchStats]);
  useEffect(() => { fetchAlerts(); }, [fetchAlerts]);
  useEffect(() => {
    const t = setInterval(() => { fetchStats(); fetchAlerts(); }, 30000);
    return () => clearInterval(t);
  }, [fetchStats, fetchAlerts]);

  useEffect(() => {
    let alive = true; let ws: WebSocket | null = null; let retry = 0; let timer: any;
    const connect = () => {
      if (!alive) return;
      setWsStatus('CONNECTING');
      ws = new WebSocket(WS_URL); wsRef.current = ws;
      ws.onopen = () => {
        if (!alive) return; retry = 0; setWsStatus('CONNECTED');
        ws?.send(JSON.stringify({ type: 'subscribe', room: 'alerts' }));
        ws?.send(JSON.stringify({ type: 'subscribe', room: 'prices' }));
      };
      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg?.type === 'alert' && msg.data) {
            setAlerts(prev => {
              const next = [msg.data, ...prev]; const seen = new Set<string>(); const out: AlertEvent[] = [];
              for (const a of next) { const k = a.id ?? `${a.symbol}-${a.created_at}`; if (!seen.has(k)) { seen.add(k); out.push(a); } if (out.length >= alertLimit) break; }
              return out;
            });
          }
          if (msg?.type === 'price_update' && msg.data) {
            const { symbol, price } = msg.data;
            if (symbol && typeof price === 'number') { const sym = String(symbol).toUpperCase(); setAssets(prev => prev.map(a => a.symbol.toUpperCase() === sym ? { ...a, last_price: price } : a)); }
          }
        } catch {}
      };
      ws.onclose = () => { if (!alive) return; setWsStatus('DISCONNECTED'); timer = setTimeout(connect, Math.min(3000 + retry * 1500, 12000)); retry++; };
    };
    connect();
    return () => { alive = false; clearTimeout(timer); try { ws?.close(); } catch {} wsRef.current = null; };
  }, [alertLimit]);

  const MONO = "'IBM Plex Mono', 'JetBrains Mono', 'Fira Code', monospace";

  return (
    <div className="relative min-h-screen p-5 md:p-6" style={{ fontFamily: MONO }}>

      {/* Ticker bar */}
      <div className="mb-5 flex items-center justify-between gap-4 rounded-xl px-4 py-2.5"
        style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
        <div className="flex items-center gap-3">
          <span className="text-xs font-bold" style={{ color: '#e85d1a', letterSpacing: '0.15em' }}>IGNIS</span>
          <span className="text-xs" style={{ color: 'rgba(255,255,255,0.2)' }}>|</span>
          <span className="text-xs" style={{ color: 'rgba(255,255,255,0.4)' }}>Supply & Demand Intelligence</span>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <span className={cn('h-1.5 w-1.5 rounded-full', wsStatus === 'CONNECTED' ? 'animate-pulse' : '')}
              style={{ background: wsStatus === 'CONNECTED' ? '#10b981' : wsStatus === 'CONNECTING' ? '#38bdf8' : '#f43f5e', boxShadow: wsStatus === 'CONNECTED' ? '0 0 6px #10b981' : 'none' }} />
            <span className="text-[11px]" style={{ color: 'rgba(255,255,255,0.35)' }}>
              {wsStatus === 'CONNECTED' ? 'Live' : wsStatus === 'CONNECTING' ? 'Connexion…' : 'Hors ligne'}
            </span>
          </div>
          <button onClick={refreshAll} className="text-[11px] px-3 py-1 rounded-lg transition-all"
            style={{ background: 'rgba(232,93,26,0.12)', border: '1px solid rgba(232,93,26,0.25)', color: '#e85d1a' }}>
            ↻ Actualiser
          </button>
        </div>
      </div>

      {/* Notices */}
      <AnimatePresence>
        {notice && <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mb-4 rounded-xl px-4 py-3 text-sm" style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)', color: '#10b981' }}>✓ {notice}</motion.div>}
        {error && <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mb-4 rounded-xl px-4 py-3 text-sm" style={{ background: 'rgba(244,63,94,0.08)', border: '1px solid rgba(244,63,94,0.2)', color: '#f43f5e' }}>✕ {error}</motion.div>}
      </AnimatePresence>

      {/* KPI Grid */}
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}
        className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KPICard label="Assets actifs" value={statsLoading ? '…' : String(kpis.active)} sub="dans la watchlist" color="#e85d1a" delay={0} icon="◈" />
        <KPICard label="Analysés" value={statsLoading ? '…' : String(kpis.withAnalysis)} sub="avec une analyse" color="#378add" delay={0.05} icon="◎" />
        <KPICard label="Couverture" value={statsLoading ? '…' : `${kpis.coverage}%`} sub="des actifs analysés" color="#8b5cf6" delay={0.1} icon="◐" progress={kpis.coverage} />
        <KPICard label="Setups valides" value={statsLoading ? '…' : String(kpis.valid)} sub="opportunités actives" color="#10b981" delay={0.15} icon="✦" accent />
        <KPICard label="En attente" value={statsLoading ? '…' : String(kpis.pending)} sub="à surveiller" color="#f59e0b" delay={0.2} icon="◇" />
        <KPICard label="Alertes" value={alertsLoading ? '…' : String(alerts.length)} sub="dans le feed" color="#f43f5e" delay={0.25} icon="⚡" pulse={alerts.length > 0 && wsStatus === 'CONNECTED'} />
      </motion.div>

      {/* Main grid */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
        <div className="xl:col-span-8 space-y-4">

          {/* Tabs */}
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex gap-1 rounded-xl p-1" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
              {(['watchlist', 'alertes'] as const).map(tab => (
                <button key={tab} onClick={() => setActiveTab(tab)} className="px-4 py-2 rounded-lg text-xs font-medium tracking-wide uppercase transition-all"
                  style={{ background: activeTab === tab ? 'rgba(232,93,26,0.15)' : 'transparent', color: activeTab === tab ? '#e85d1a' : 'rgba(255,255,255,0.4)', border: activeTab === tab ? '1px solid rgba(232,93,26,0.25)' : '1px solid transparent' }}>
                  {tab === 'watchlist' ? `Watchlist (${filtered.length})` : `Alertes (${alerts.length})`}
                </button>
              ))}
            </div>
            {activeTab === 'watchlist' && (
              <div className="flex items-center gap-2">
                <select value={assetClass} onChange={e => { setOffset(0); setAssetClass(e.target.value as any); }}
                  className="text-xs rounded-lg px-3 py-2 outline-none"
                  style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.7)' }}>
                  {['ALL','CRYPTO','STOCK','FOREX','INDEX','ETF','COMMODITY','OTHER'].map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <button onClick={() => { setOffset(0); setActiveOnly(p => !p); }} className="text-xs rounded-lg px-3 py-2 transition-all"
                  style={{ background: activeOnly ? 'rgba(16,185,129,0.1)' : 'rgba(255,255,255,0.04)', border: `1px solid ${activeOnly ? 'rgba(16,185,129,0.25)' : 'rgba(255,255,255,0.08)'}`, color: activeOnly ? '#10b981' : 'rgba(255,255,255,0.4)' }}>
                  {activeOnly ? '● Actifs' : '○ Tous'}
                </button>
              </div>
            )}
          </div>

          {/* Search */}
          {activeTab === 'watchlist' && (
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-xs" style={{ color: 'rgba(255,255,255,0.3)' }}>⌕</span>
              <input value={query} onChange={e => setQuery(e.target.value)}
                placeholder="Rechercher un actif — symbole, nom, exchange…"
                className="w-full rounded-xl pl-10 pr-10 py-3 text-sm outline-none"
                style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.85)', fontFamily: MONO }}
                onFocus={e => { (e.target as HTMLElement).style.borderColor = 'rgba(232,93,26,0.4)'; }}
                onBlur={e => { (e.target as HTMLElement).style.borderColor = 'rgba(255,255,255,0.08)'; }} />
              {query && <button onClick={() => setQuery('')} className="absolute right-4 top-1/2 -translate-y-1/2 text-xs" style={{ color: 'rgba(255,255,255,0.3)' }}>✕</button>}
            </div>
          )}

          {/* Content */}
          <AnimatePresence mode="wait">
            {activeTab === 'watchlist' && (
              <motion.div key="wl" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                {assetsLoading ? (
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {Array.from({ length: 6 }).map((_, i) => <div key={i} className="rounded-2xl animate-pulse h-44" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }} />)}
                  </div>
                ) : filtered.length === 0 ? (
                  <EmptyState icon="◈" title="Aucun actif trouvé"
                    desc={query ? `Aucun résultat pour "${query}".` : "Va dans Paramètres → Assets pour ajouter des actifs à ta watchlist."}
                    action={query ? <button onClick={() => setQuery('')} className="mt-3 text-xs px-4 py-2 rounded-xl" style={{ background: 'rgba(232,93,26,0.15)', border: '1px solid rgba(232,93,26,0.25)', color: '#e85d1a' }}>Effacer</button> : undefined} />
                ) : (
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {filtered.map((a, i) => <AssetCard key={a.symbol} asset={a} index={i} onRefresh={refreshAsset} onSelect={setSelectedAsset} />)}
                  </div>
                )}
                {assetsTotal > limit && (
                  <div className="mt-4 flex items-center justify-between">
                    <span className="text-xs" style={{ color: 'rgba(255,255,255,0.3)' }}>Page {page}/{pageCount} · {assetsTotal} actifs</span>
                    <div className="flex gap-2">
                      <button onClick={() => setOffset(p => Math.max(0, p - limit))} disabled={offset === 0} className="text-xs px-4 py-2 rounded-xl transition-all disabled:opacity-30" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.7)' }}>← Précédent</button>
                      <button onClick={() => setOffset(p => Math.min((pageCount - 1) * limit, p + limit))} disabled={offset + limit >= assetsTotal} className="text-xs px-4 py-2 rounded-xl transition-all disabled:opacity-30" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.7)' }}>Suivant →</button>
                    </div>
                  </div>
                )}
              </motion.div>
            )}
            {activeTab === 'alertes' && (
              <motion.div key="al" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-3">
                {alertsLoading ? Array.from({ length: 4 }).map((_, i) => <div key={i} className="rounded-2xl animate-pulse h-24" style={{ background: 'rgba(255,255,255,0.04)' }} />)
                  : alerts.length === 0 ? <EmptyState icon="⚡" title="Aucune alerte" desc="Le feed WebSocket est actif. Les alertes apparaîtront ici en temps réel dès qu'elles seront déclenchées." />
                  : <AnimatePresence initial={false}>{alerts.map(a => <AlertRow key={a.id ?? `${a.symbol}-${a.created_at}`} alert={a} />)}</AnimatePresence>}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Right panel */}
        <div className="xl:col-span-4 space-y-4">
          <Panel title="Guide rapide" icon="◉">
            <div className="space-y-3">
              {[
                { step: '01', title: 'Ajouter des actifs', desc: "Paramètres → Assets pour créer ta watchlist (BTC, ETH, EURUSD…)", href: '/settings', color: '#e85d1a' },
                { step: '02', title: 'Lancer le Scanner', desc: "Analyse multi-symboles avec scoring Supply & Demand automatique.", href: '/scanner', color: '#378add' },
                { step: '03', title: 'Ouvrir une analyse', desc: "Clique 'Analyser →' sur un actif pour voir le chart, zones et structure.", href: '#', color: '#10b981' },
                { step: '04', title: 'Configurer les alertes', desc: "Paramètres → Alertes pour recevoir des notifications en temps réel.", href: '/settings', color: '#8b5cf6' },
              ].map(s => (
                <Link key={s.step} href={s.href} className="flex items-start gap-3 rounded-xl p-3 transition-all group"
                  style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.05)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.02)'; }}>
                  <span className="text-xs font-bold min-w-[20px]" style={{ color: s.color }}>{s.step}</span>
                  <div className="min-w-0">
                    <div className="text-xs font-semibold mb-0.5" style={{ color: 'rgba(255,255,255,0.85)' }}>{s.title}</div>
                    <div className="text-xs leading-relaxed" style={{ color: 'rgba(255,255,255,0.4)' }}>{s.desc}</div>
                  </div>
                  <span className="ml-auto text-xs opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: s.color }}>→</span>
                </Link>
              ))}
            </div>
          </Panel>

          {stats?.by_class && Object.keys(stats.by_class).length > 0 && (
            <Panel title="Répartition" icon="◐">
              <div className="space-y-2">
                {Object.entries(stats.by_class).sort(([,a],[,b]) => b - a).map(([cls, count]) => {
                  const pct = stats.total > 0 ? Math.round((count / stats.total) * 100) : 0;
                  const colors: Record<string, string> = { CRYPTO: '#e85d1a', STOCK: '#378add', FOREX: '#10b981', INDEX: '#8b5cf6', ETF: '#f59e0b', COMMODITY: '#f43f5e', OTHER: '#71717a' };
                  const col = colors[cls] ?? '#71717a';
                  return (
                    <div key={cls}>
                      <div className="flex justify-between mb-1">
                        <span className="text-xs" style={{ color: 'rgba(255,255,255,0.55)' }}>{cls}</span>
                        <span className="text-xs tabular-nums" style={{ color: 'rgba(255,255,255,0.35)' }}>{count} · {pct}%</span>
                      </div>
                      <div className="h-1 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
                        <motion.div initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.8 }} className="h-full rounded-full" style={{ background: col }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </Panel>
          )}

          <Panel title="Accès rapides" icon="◈">
            <div className="grid grid-cols-2 gap-2">
              {[
                { href: '/scanner', label: 'Scanner', icon: '⊞', color: '#378add' },
                { href: '/journal', label: 'Journal', icon: '▤', color: '#10b981' },
                { href: '/ai', label: 'IGNIS AI', icon: '◈', color: '#8b5cf6' },
                { href: '/settings', label: 'Paramètres', icon: '⚙', color: '#f59e0b' },
              ].map(item => (
                <Link key={item.href} href={item.href} className="flex flex-col items-center gap-2 rounded-xl py-4 text-center transition-all"
                  style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = `${item.color}15`; (e.currentTarget as HTMLElement).style.borderColor = `${item.color}30`; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.03)'; (e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,255,255,0.07)'; }}>
                  <span className="text-lg" style={{ color: item.color }}>{item.icon}</span>
                  <span className="text-xs" style={{ color: 'rgba(255,255,255,0.65)' }}>{item.label}</span>
                </Link>
              ))}
            </div>
          </Panel>

          <Panel title="Connexion" icon="◎">
            <div className="space-y-2 text-xs">
              <StatusRow label="API Backend" value={API_BASE.replace(/https?:\/\//, '')} ok={!error} />
              <StatusRow label="WebSocket Live" value={wsStatus === 'CONNECTED' ? 'Connecté' : wsStatus === 'CONNECTING' ? 'Connexion…' : 'Déconnecté'} ok={wsStatus === 'CONNECTED'} />
            </div>
            <div className="mt-3 pt-3 text-xs leading-relaxed" style={{ borderTop: '1px solid rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.3)' }}>
              💡 Backend non connecté ? Lance <code className="px-1 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.6)' }}>uvicorn main:app --port 8000</code> dans un terminal séparé.
            </div>
          </Panel>
        </div>
      </div>

      <AnimatePresence>
        {selectedAsset && <AssetModal asset={selectedAsset} onClose={() => setSelectedAsset(null)} onRefresh={refreshAsset} />}
      </AnimatePresence>
    </div>
  );
}

/* ── Sub components ── */

function KPICard({ label, value, sub, color, delay, icon, accent, progress, pulse }: {
  label: string; value: string; sub: string; color: string; delay: number; icon: string; accent?: boolean; progress?: number; pulse?: boolean;
}) {
  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay }}
      className="rounded-2xl p-4 relative overflow-hidden"
      style={{ background: accent ? `${color}10` : 'rgba(255,255,255,0.03)', border: `1px solid ${accent ? color + '25' : 'rgba(255,255,255,0.07)'}` }}>
      {accent && <div className="absolute inset-0 opacity-20" style={{ background: `radial-gradient(ellipse at top left, ${color}40, transparent 70%)` }} />}
      <div className="relative">
        <div className="flex items-start justify-between mb-2">
          <span style={{ color: `${color}cc` }}>{icon}</span>
          {pulse && <span className="h-2 w-2 rounded-full animate-pulse" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />}
        </div>
        <div className="text-2xl font-bold tabular-nums tracking-tight" style={{ color: accent ? color : 'rgba(255,255,255,0.92)', fontFamily: "'IBM Plex Mono', monospace", textShadow: accent ? `0 0 20px ${color}60` : 'none' }}>
          {value}
        </div>
        <div className="text-xs font-medium mt-1" style={{ color: 'rgba(255,255,255,0.7)' }}>{label}</div>
        <div className="text-[11px] mt-0.5" style={{ color: 'rgba(255,255,255,0.3)' }}>{sub}</div>
        {progress !== undefined && (
          <div className="mt-3 h-0.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
            <motion.div initial={{ width: 0 }} animate={{ width: `${progress}%` }} transition={{ duration: 1, delay: delay + 0.3 }} className="h-full rounded-full" style={{ background: color }} />
          </div>
        )}
      </div>
    </motion.div>
  );
}

function AssetCard({ asset: a, index, onRefresh, onSelect }: { asset: AssetResponse; index: number; onRefresh: (s: string) => void; onSelect: (a: AssetResponse) => void }) {
  const st = a.setup?.status;
  const meta = st ? STATUS_META[st] : null;
  const zone = a.setup?.zone_type ? ZONE_META[a.setup.zone_type] : null;
  const score = a.setup?.score ?? 0;
  const barColor = score >= 80 ? '#10b981' : score >= 60 ? '#f59e0b' : '#f43f5e';

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: Math.min(index * 0.04, 0.4) }}
      className="rounded-2xl p-4 relative overflow-hidden cursor-pointer"
      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'rgba(232,93,26,0.25)'; (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.05)'; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,255,255,0.07)'; (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.03)'; }}
      onClick={() => onSelect(a)}>
      <div className="absolute top-0 left-0 h-0.5 rounded-t-2xl" style={{ width: `${score}%`, background: barColor, boxShadow: `0 0 8px ${barColor}80` }} />
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold tracking-tight" style={{ color: 'rgba(255,255,255,0.95)', fontFamily: "'IBM Plex Mono', monospace" }}>{a.symbol}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.4)' }}>{a.asset_class}</span>
          </div>
          <div className="text-[11px] mt-0.5 truncate" style={{ color: 'rgba(255,255,255,0.4)' }}>{a.name || a.exchange || '—'}</div>
        </div>
        <div className="text-right">
          <div className="text-sm font-bold tabular-nums" style={{ color: 'rgba(255,255,255,0.9)', fontFamily: "'IBM Plex Mono', monospace" }}>
            {a.last_price != null ? fmt(a.last_price, a.last_price > 100 ? 2 : 6) : '—'}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 mb-3">
        {meta ? (
          <span className="text-[11px] px-2 py-0.5 rounded-lg font-medium flex items-center gap-1" style={{ background: meta.bg, color: meta.color, border: `1px solid ${meta.color}30` }}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.dot }} />{meta.label}
          </span>
        ) : (
          <span className="text-[11px] px-2 py-0.5 rounded-lg" style={{ background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.3)' }}>Pas d'analyse</span>
        )}
        {zone && <span className="text-[11px] px-2 py-0.5 rounded-lg" style={{ background: `${zone.color}10`, color: zone.color, border: `1px solid ${zone.color}25` }}>{zone.label}</span>}
        {a.setup?.score != null && <span className="text-[11px] px-2 py-0.5 rounded-lg tabular-nums" style={{ background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.45)' }}>Score {fmt(a.setup.score, 0)}%</span>}
      </div>
      <div className="text-[11px] mb-3 flex items-center gap-1" style={{ color: 'rgba(255,255,255,0.3)' }}>
        <span>↻</span>
        <span>{a.last_analysis_at ? `Il y a ${timeAgo(a.last_analysis_at)}` : 'Jamais analysé'}</span>
      </div>
      <div className="flex gap-2" onClick={e => e.stopPropagation()}>
        <Link href={`/analysis/${encodeURIComponent(a.symbol)}`}
          className="flex-1 text-center text-xs py-2 rounded-xl transition-all font-medium"
          style={{ background: 'rgba(232,93,26,0.12)', border: '1px solid rgba(232,93,26,0.25)', color: '#e85d1a' }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(232,93,26,0.2)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(232,93,26,0.12)'; }}>
          Analyser →
        </Link>
        <button onClick={() => onRefresh(a.symbol)} className="text-xs px-3 py-2 rounded-xl transition-all"
          style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.45)' }}
          title="Relancer l'analyse backend"
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.1)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.05)'; }}>
          ↻
        </button>
      </div>
    </motion.div>
  );
}

function AlertRow({ alert: a }: { alert: AlertEvent }) {
  const [open, setOpen] = useState(false);
  const pm = PRIORITY_META[(a.priority ?? '').toUpperCase()] ?? PRIORITY_META.LOW;
  return (
    <motion.div initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} className="rounded-2xl overflow-hidden" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
      <div className="p-4">
        <div className="flex items-start gap-3">
          <div className="mt-1 h-2 w-2 rounded-full flex-shrink-0" style={{ background: pm.color, boxShadow: `0 0 6px ${pm.color}` }} />
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <span className="text-sm font-bold" style={{ color: 'rgba(255,255,255,0.9)', fontFamily: "'IBM Plex Mono', monospace" }}>{a.symbol} <span className="text-xs font-normal" style={{ color: 'rgba(255,255,255,0.4)' }}>{a.timeframe}</span></span>
              <span className="text-[10px] px-2 py-0.5 rounded font-medium" style={{ background: pm.bg, color: pm.color }}>{(a.priority ?? '').toUpperCase()}</span>
            </div>
            <div className="text-xs mt-1" style={{ color: 'rgba(255,255,255,0.65)' }}>{a.title || a.alert_type}</div>
            <div className="text-xs mt-1" style={{ color: 'rgba(255,255,255,0.4)' }}>{a.message}</div>
            <div className="flex items-center justify-between mt-2">
              <span className="text-[11px]" style={{ color: 'rgba(255,255,255,0.25)' }}>{fmtDate(a.created_at)}</span>
              <div className="flex gap-2">
                <button onClick={() => setOpen(o => !o)} className="text-[11px] px-2 py-1 rounded-lg" style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.4)' }}>{open ? '▲' : '▼'} Détails</button>
                <Link href={`/analysis/${encodeURIComponent(a.symbol)}`} className="text-[11px] px-2 py-1 rounded-lg" style={{ background: 'rgba(232,93,26,0.1)', color: '#e85d1a' }}>Ouvrir →</Link>
              </div>
            </div>
          </div>
        </div>
      </div>
      <AnimatePresence>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <pre className="px-4 pb-4 text-[11px] overflow-auto" style={{ color: 'rgba(255,255,255,0.45)', borderTop: '1px solid rgba(255,255,255,0.06)' }}>{JSON.stringify(a.payload ?? {}, null, 2)}</pre>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function Panel({ title, icon, children }: { title: string; icon: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl p-4" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
      <div className="flex items-center gap-2 mb-4">
        <span style={{ color: '#e85d1a' }}>{icon}</span>
        <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'rgba(255,255,255,0.55)', letterSpacing: '0.1em' }}>{title}</span>
      </div>
      {children}
    </div>
  );
}

function StatusRow({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between py-1.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
      <span style={{ color: 'rgba(255,255,255,0.4)' }}>{label}</span>
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: ok ? '#10b981' : '#f43f5e' }} />
        <span className="tabular-nums truncate max-w-[140px]" style={{ color: ok ? 'rgba(255,255,255,0.65)' : '#f43f5e' }}>{value}</span>
      </div>
    </div>
  );
}

function EmptyState({ icon, title, desc, action }: { icon: string; title: string; desc: string; action?: React.ReactNode }) {
  return (
    <div className="rounded-2xl py-12 px-6 text-center" style={{ background: 'rgba(255,255,255,0.02)', border: '1px dashed rgba(255,255,255,0.08)' }}>
      <div className="text-3xl mb-3" style={{ color: 'rgba(255,255,255,0.2)' }}>{icon}</div>
      <div className="text-sm font-medium mb-2" style={{ color: 'rgba(255,255,255,0.55)' }}>{title}</div>
      <div className="text-xs leading-relaxed max-w-sm mx-auto" style={{ color: 'rgba(255,255,255,0.3)' }}>{desc}</div>
      {action}
    </div>
  );
}

function AssetModal({ asset: a, onClose, onRefresh }: { asset: AssetResponse; onClose: () => void; onRefresh: (s: string) => void }) {
  const st = a.setup?.status; const meta = st ? STATUS_META[st] : null; const zone = a.setup?.zone_type ? ZONE_META[a.setup.zone_type] : null;
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(8px)' }} onClick={onClose}>
      <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
        className="w-full max-w-md rounded-3xl p-6" style={{ background: '#0d0d14', border: '1px solid rgba(255,255,255,0.12)' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-5">
          <div>
            <h2 className="text-xl font-bold" style={{ color: 'rgba(255,255,255,0.95)', fontFamily: "'IBM Plex Mono', monospace" }}>{a.symbol}</h2>
            <p className="text-sm mt-0.5" style={{ color: 'rgba(255,255,255,0.4)' }}>{a.name || '—'} · {a.asset_class}</p>
          </div>
          <button onClick={onClose} className="text-xl" style={{ color: 'rgba(255,255,255,0.3)' }}>✕</button>
        </div>
        <div className="grid grid-cols-2 gap-3 mb-5">
          {[
            { l: 'Prix actuel', v: a.last_price != null ? fmt(a.last_price, 6) : '—' },
            { l: 'Score', v: a.setup?.score != null ? `${fmt(a.setup.score, 0)}%` : '—' },
            { l: 'Statut', v: meta?.label ?? 'Aucun' },
            { l: 'Zone', v: zone?.label ?? '—' },
            { l: 'Pattern PA', v: a.setup?.pa_pattern ?? '—' },
            { l: 'Risk/Reward', v: a.setup?.rr != null ? fmt(a.setup.rr, 2) : '—' },
          ].map(row => (
            <div key={row.l} className="rounded-xl p-3" style={{ background: 'rgba(255,255,255,0.04)' }}>
              <div className="text-[11px] mb-1" style={{ color: 'rgba(255,255,255,0.35)' }}>{row.l}</div>
              <div className="text-sm font-semibold" style={{ color: 'rgba(255,255,255,0.85)', fontFamily: "'IBM Plex Mono', monospace" }}>{row.v}</div>
            </div>
          ))}
        </div>
        <div className="text-xs mb-5" style={{ color: 'rgba(255,255,255,0.3)' }}>Dernière analyse : {a.last_analysis_at ? fmtDate(a.last_analysis_at) : 'Jamais'}</div>
        <div className="flex gap-3">
          <Link href={`/analysis/${encodeURIComponent(a.symbol)}`} className="flex-1 text-center text-sm py-3 rounded-2xl font-semibold" style={{ background: 'rgba(232,93,26,0.2)', border: '1px solid rgba(232,93,26,0.4)', color: '#e85d1a' }}>Ouvrir l'analyse →</Link>
          <button onClick={() => { onRefresh(a.symbol); onClose(); }} className="text-sm px-4 py-3 rounded-2xl" style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.7)' }}>↻ Refresh</button>
        </div>
      </motion.div>
    </motion.div>
  );
}