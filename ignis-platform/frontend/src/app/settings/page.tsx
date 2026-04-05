/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';

/* ──────────────────────────────────────────────────────────────
   Config
────────────────────────────────────────────────────────────── */

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:8000/api/v1';

type SetupStatus = 'VALID' | 'PENDING' | 'INVALID' | 'WATCH' | 'EXPIRED';
type ZoneType = 'DEMAND' | 'SUPPLY' | 'FLIPPY_D' | 'FLIPPY_S' | 'HIDDEN_D' | 'HIDDEN_S';
type PAPattern = 'ACCU' | 'THREE_DRIVES' | 'FTL' | 'PATTERN_69' | 'HIDDEN_SDE' | 'NONE';

type AssetClass = 'CRYPTO' | 'STOCK' | 'FOREX' | 'COMMODITY' | 'INDEX' | 'ETF' | 'OTHER';

type AlertChannel = 'WEBSOCKET' | 'TELEGRAM';

type TabKey = 'assets' | 'alerts' | 'ai' | 'telegram' | 'system';

/* ──────────────────────────────────────────────────────────────
   Types (best-effort based on your schema)
────────────────────────────────────────────────────────────── */

interface AssetResponse {
  symbol: string;
  asset_class: string;
  name: string;
  exchange: string;
  active: boolean;
  last_price?: number;
  last_analysis_at?: string;
  setup?: {
    status: SetupStatus;
    score: number;
    zone_type?: ZoneType;
    pa_pattern?: PAPattern;
    rr?: number;
  };
  created_at: string;
  updated_at: string;
  meta?: any;
}

interface AssetsListResponse {
  total: number;
  assets: AssetResponse[];
  page?: number;
  page_size?: number;
}

interface AssetStatsResponse {
  total: number;
  active: number;
  by_class: Record<string, number>;
  with_analysis: number;
  valid_setups: int;
  pending_setups: int;
}

interface AlertStatsResponse {
  total: number;
  by_type?: Record<string, number>;
  by_priority?: Record<string, number>;
  sent?: number;
  failed?: number;
  queued?: number;
}

interface AlertResponse {
  id: string;
  alert_type: string;
  priority: string;
  symbol: string;
  timeframe: string;
  title: string;
  message: string;
  emoji: string;
  payload: object;
  channels: string[];
  status: string;
  created_at: string;
  sent_at?: string;
}

interface AIStatusResponse {
  ollama_online: boolean;
  model: string;
  host: string;
  version?: string;
  models_available?: any;
}

interface AIModelsResponse {
  models: { name: string; size?: number; modified_at?: string }[];
}

/* ──────────────────────────────────────────────────────────────
   Helpers
────────────────────────────────────────────────────────────── */

function cn(...classes: Array<string | undefined | null | false>) {
  return classes.filter(Boolean).join(' ');
}

function fmt(n: number | undefined, digits = 2) {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits }).format(n);
}

function fmtDate(iso?: string) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('fr-FR', { hour12: false });
}

function safeJsonParse(text: string): { ok: boolean; value?: any; error?: string } {
  try {
    if (!text.trim()) return { ok: true, value: undefined };
    return { ok: true, value: JSON.parse(text) };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Invalid JSON' };
  }
}

function pillForSetup(status: SetupStatus) {
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

function colorForZoneType(z?: ZoneType) {
  if (!z) return 'rgba(255,255,255,0.35)';
  const map: Record<ZoneType, string> = {
    DEMAND: '#1D9E75',
    SUPPLY: '#E24B4A',
    FLIPPY_D: '#378ADD',
    FLIPPY_S: '#E85D1A',
    HIDDEN_D: '#2AD4A5',
    HIDDEN_S: '#FF6B6A',
  };
  return map[z] ?? 'rgba(255,255,255,0.35)';
}

/* ──────────────────────────────────────────────────────────────
   Page
────────────────────────────────────────────────────────────── */

export default function SettingsPage() {
  const [tab, setTab] = useState<TabKey>('assets');

  // Global UX
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // ── Assets state
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [assetStatsLoading, setAssetStatsLoading] = useState(false);
  const [assetsTotal, setAssetsTotal] = useState(0);
  const [assets, setAssets] = useState<AssetResponse[]>([]);
  const [assetStats, setAssetStats] = useState<AssetStatsResponse | null>(null);

  const [assetClass, setAssetClass] = useState<AssetClass | 'ALL'>('CRYPTO');
  const [assetActive, setAssetActive] = useState<'ALL' | 'true' | 'false'>('true');
  const [assetQuery, setAssetQuery] = useState('');
  const [assetsLimit, setAssetsLimit] = useState(50);
  const [assetsOffset, setAssetsOffset] = useState(0);

  // Asset modal
  const [assetModalOpen, setAssetModalOpen] = useState(false);
  const [assetModalMode, setAssetModalMode] = useState<'create' | 'edit'>('create');
  const [assetForm, setAssetForm] = useState<{
    symbol: string;
    asset_class: AssetClass;
    name: string;
    exchange: string;
    active: boolean;
    metaJson: string;
  }>({
    symbol: '',
    asset_class: 'CRYPTO',
    name: '',
    exchange: '',
    active: true,
    metaJson: '',
  });

  // ── Alerts state
  const [alertsStatsLoading, setAlertsStatsLoading] = useState(false);
  const [alertsStats, setAlertsStats] = useState<AlertStatsResponse | null>(null);

  const [deadLoading, setDeadLoading] = useState(false);
  const [deadLetter, setDeadLetter] = useState<AlertResponse[]>([]);

  const [filtersLoading, setFiltersLoading] = useState(false);
  const [alertFilters, setAlertFilters] = useState<any>(null);

  // Alert test / emit
  const [emitOpen, setEmitOpen] = useState(false);
  const [emitForm, setEmitForm] = useState<{
    mode: 'emit' | 'test';
    channel: AlertChannel;
    alert_type: string;
    priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    symbol: string;
    timeframe: string;
    title: string;
    message: string;
    payloadJson: string;
    channels: AlertChannel[];
  }>({
    mode: 'emit',
    channel: 'WEBSOCKET',
    alert_type: 'SETUP',
    priority: 'MEDIUM',
    symbol: 'BTCUSDT',
    timeframe: 'H4',
    title: 'Test alert',
    message: 'Hello from Settings',
    payloadJson: '{"source":"settings"}',
    channels: ['WEBSOCKET'],
  });

  // ── AI state
  const [aiLoading, setAiLoading] = useState(false);
  const [aiStatus, setAiStatus] = useState<AIStatusResponse | null>(null);
  const [aiModels, setAiModels] = useState<AIModelsResponse | null>(null);
  const [aiChatLoading, setAiChatLoading] = useState(false);
  const [aiChatInput, setAiChatInput] = useState('Donne un résumé du contexte S&D pour BTCUSDT H4.');
  const [aiChatOutput, setAiChatOutput] = useState<string>('');
  const [aiChatModel, setAiChatModel] = useState<string>('');

  /* ──────────────────────────────────────────────────────────────
     Assets: fetch list + stats
  ─────────────────────────────────────────────────────────────── */

  const fetchAssetStats = useCallback(async () => {
    setAssetStatsLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/assets/stats`);
      if (!res.ok) throw new Error(`HTTP ${res.status} — assets/stats`);
      const data = await res.json();
      setAssetStats(data);
    } catch (e: any) {
      setError(e?.message ?? 'Erreur assets stats');
    } finally {
      setAssetStatsLoading(false);
    }
  }, []);

  const fetchAssets = useCallback(async () => {
    setAssetsLoading(true);
    setError(null);
    try {
      const url = new URL(`${API_BASE}/assets`);
      if (assetClass !== 'ALL') url.searchParams.set('asset_class', assetClass);
      if (assetActive !== 'ALL') url.searchParams.set('active', assetActive);
      url.searchParams.set('limit', String(assetsLimit));
      url.searchParams.set('offset', String(assetsOffset));

      const res = await fetch(url.toString());
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${txt || 'Erreur assets'}`);
      }

      const data = (await res.json()) as AssetsListResponse;
      setAssets(data.assets ?? []);
      setAssetsTotal(Number(data.total ?? (data.assets?.length ?? 0)));
    } catch (e: any) {
      setError(e?.message ?? 'Erreur assets');
    } finally {
      setAssetsLoading(false);
    }
  }, [assetClass, assetActive, assetsLimit, assetsOffset]);

  useEffect(() => {
    fetchAssets();
  }, [fetchAssets]);

  useEffect(() => {
    fetchAssetStats();
  }, [fetchAssetStats]);

  const filteredAssets = useMemo(() => {
    const q = assetQuery.trim().toUpperCase();
    if (!q) return assets;
    return assets.filter((a) => {
      const hay = `${a.symbol} ${a.name ?? ''} ${a.exchange ?? ''} ${a.asset_class ?? ''}`.toUpperCase();
      return hay.includes(q);
    });
  }, [assets, assetQuery]);

  const assetsPage = useMemo(() => Math.floor(assetsOffset / assetsLimit) + 1, [assetsOffset, assetsLimit]);
  const assetsPages = useMemo(() => Math.max(1, Math.ceil(assetsTotal / assetsLimit)), [assetsTotal, assetsLimit]);

  const openCreateAsset = useCallback(() => {
    setNotice(null);
    setError(null);
    setAssetModalMode('create');
    setAssetForm({
      symbol: '',
      asset_class: 'CRYPTO',
      name: '',
      exchange: '',
      active: true,
      metaJson: '',
    });
    setAssetModalOpen(true);
  }, []);

  const openEditAsset = useCallback((a: AssetResponse) => {
    setNotice(null);
    setError(null);
    setAssetModalMode('edit');
    setAssetForm({
      symbol: a.symbol,
      asset_class: (a.asset_class as AssetClass) ?? 'CRYPTO',
      name: a.name ?? '',
      exchange: a.exchange ?? '',
      active: !!a.active,
      metaJson: a.meta ? JSON.stringify(a.meta, null, 2) : '',
    });
    setAssetModalOpen(true);
  }, []);

  const submitAsset = useCallback(async () => {
    setError(null);
    setNotice(null);

    const symbol = assetForm.symbol.trim().toUpperCase();
    if (!symbol) {
      setError('Symbol requis.');
      return;
    }

    const metaParsed = safeJsonParse(assetForm.metaJson);
    if (!metaParsed.ok) {
      setError(`Meta JSON invalide: ${metaParsed.error}`);
      return;
    }

    try {
      if (assetModalMode === 'create') {
        const res = await fetch(`${API_BASE}/assets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symbol,
            asset_class: assetForm.asset_class,
            name: assetForm.name?.trim() || undefined,
            exchange: assetForm.exchange?.trim() || undefined,
            active: assetForm.active,
          }),
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status} — ${txt || 'Erreur create asset'}`);
        }
        setNotice(`Asset créé: ${symbol}`);
      } else {
        const res = await fetch(`${API_BASE}/assets/${encodeURIComponent(symbol)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: assetForm.name?.trim() || undefined,
            exchange: assetForm.exchange?.trim() || undefined,
            active: assetForm.active,
            meta: metaParsed.value,
          }),
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status} — ${txt || 'Erreur patch asset'}`);
        }
        setNotice(`Asset mis à jour: ${symbol}`);
      }

      setAssetModalOpen(false);
      await Promise.all([fetchAssets(), fetchAssetStats()]);
    } catch (e: any) {
      setError(e?.message ?? 'Erreur asset');
    }
  }, [assetForm, assetModalMode, fetchAssets, fetchAssetStats]);

  const deleteAsset = useCallback(async (symbol: string) => {
    setError(null);
    setNotice(null);

    const ok = confirm(`Supprimer l’asset ${symbol} ?`);
    if (!ok) return;

    try {
      const res = await fetch(`${API_BASE}/assets/${encodeURIComponent(symbol)}`, { method: 'DELETE' });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${txt || 'Erreur delete asset'}`);
      }
      setNotice(`Asset supprimé: ${symbol}`);
      await Promise.all([fetchAssets(), fetchAssetStats()]);
    } catch (e: any) {
      setError(e?.message ?? 'Erreur delete asset');
    }
  }, [fetchAssets, fetchAssetStats]);

  const refreshAssetAnalysis = useCallback(async (symbol: string) => {
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${API_BASE}/assets/${encodeURIComponent(symbol)}/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeframe: 'H4', force: false }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${txt || 'Erreur refresh asset'}`);
      }
      setNotice(`Refresh demandé: ${symbol}`);
      await fetchAssets();
    } catch (e: any) {
      setError(e?.message ?? 'Erreur refresh asset');
    }
  }, [fetchAssets]);

  /* ──────────────────────────────────────────────────────────────
     Alerts: stats + filters + dead-letter
  ─────────────────────────────────────────────────────────────── */

  const fetchAlertsStats = useCallback(async () => {
    setAlertsStatsLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/alerts/stats`);
      if (!res.ok) throw new Error(`HTTP ${res.status} — alerts/stats`);
      const data = await res.json();
      setAlertsStats(data);
    } catch (e: any) {
      setError(e?.message ?? 'Erreur alerts stats');
    } finally {
      setAlertsStatsLoading(false);
    }
  }, []);

  const fetchAlertFilters = useCallback(async () => {
    setFiltersLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/alerts/filters`);
      if (!res.ok) throw new Error(`HTTP ${res.status} — alerts/filters`);
      const data = await res.json();
      setAlertFilters(data);
    } catch (e: any) {
      setError(e?.message ?? 'Erreur alerts filters');
    } finally {
      setFiltersLoading(false);
    }
  }, []);

  const fetchDeadLetter = useCallback(async () => {
    setDeadLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/alerts/dead-letter`);
      if (!res.ok) throw new Error(`HTTP ${res.status} — dead-letter`);
      const data = await res.json();
      const items = (data?.items ?? data?.alerts ?? data ?? []) as AlertResponse[];
      setDeadLetter(Array.isArray(items) ? items : []);
    } catch (e: any) {
      setError(e?.message ?? 'Erreur dead-letter');
    } finally {
      setDeadLoading(false);
    }
  }, []);

  const clearDeadLetter = useCallback(async () => {
    setError(null);
    setNotice(null);
    const ok = confirm('Vider la dead-letter queue ?');
    if (!ok) return;

    try {
      const res = await fetch(`${API_BASE}/alerts/dead-letter`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status} — delete dead-letter`);
      setNotice('Dead-letter vidée.');
      await fetchDeadLetter();
    } catch (e: any) {
      setError(e?.message ?? 'Erreur clear dead-letter');
    }
  }, [fetchDeadLetter]);

  const submitEmit = useCallback(async () => {
    setError(null);
    setNotice(null);

    const symbol = emitForm.symbol.trim().toUpperCase();
    if (!symbol) {
      setError('Symbol requis (emit).');
      return;
    }

    if (emitForm.mode === 'test') {
      try {
        const res = await fetch(`${API_BASE}/alerts/test`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channel: emitForm.channel,
            symbol,
            message: emitForm.message?.trim() || undefined,
          }),
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status} — ${txt || 'Erreur alerts/test'}`);
        }
        setNotice(`Alert test envoyée via ${emitForm.channel}.`);
        setEmitOpen(false);
        await Promise.all([fetchAlertsStats(), fetchDeadLetter()]);
      } catch (e: any) {
        setError(e?.message ?? 'Erreur emit test');
      }
      return;
    }

    // emit mode
    const payloadParsed = safeJsonParse(emitForm.payloadJson);
    if (!payloadParsed.ok) {
      setError(`Payload JSON invalide: ${payloadParsed.error}`);
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/alerts/emit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alert_type: emitForm.alert_type,
          priority: emitForm.priority,
          symbol,
          timeframe: emitForm.timeframe,
          title: emitForm.title,
          message: emitForm.message,
          payload: payloadParsed.value ?? {},
          channels: emitForm.channels,
        }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${txt || 'Erreur alerts/emit'}`);
      }

      setNotice('Alert emit envoyée.');
      setEmitOpen(false);
      await Promise.all([fetchAlertsStats(), fetchDeadLetter()]);
    } catch (e: any) {
      setError(e?.message ?? 'Erreur emit alert');
    }
  }, [emitForm, fetchAlertsStats, fetchDeadLetter]);

  /* ──────────────────────────────────────────────────────────────
     AI: status + models + mini chat (non-stream)
  ─────────────────────────────────────────────────────────────── */

  const fetchAI = useCallback(async () => {
    setAiLoading(true);
    setError(null);
    try {
      const [s, m] = await Promise.all([
        fetch(`${API_BASE}/ai/status`),
        fetch(`${API_BASE}/ai/models`),
      ]);

      if (!s.ok) throw new Error(`HTTP ${s.status} — ai/status`);
      if (!m.ok) throw new Error(`HTTP ${m.status} — ai/models`);

      const status = (await s.json()) as AIStatusResponse;
      const models = (await m.json()) as AIModelsResponse;

      setAiStatus(status);
      setAiModels(models);

      // choose default model
      setAiChatModel((prev) => prev || status.model || models.models?.[0]?.name || '');
    } catch (e: any) {
      setError(e?.message ?? 'Erreur AI');
    } finally {
      setAiLoading(false);
    }
  }, []);

  const runAIChat = useCallback(async () => {
    setAiChatLoading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${API_BASE}/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: 'SETTINGS',
          timeframe: 'H4',
          model: aiChatModel || undefined,
          temperature: 0.4,
          stream: false,
          messages: [
            { role: 'system', content: 'Tu es IGNIS AI. Réponds en français, concis et actionnable.' },
            { role: 'user', content: aiChatInput },
          ],
        }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${txt || 'Erreur ai/chat'}`);
      }
      const data = await res.json();
      setAiChatOutput(data?.response ?? '');
      setNotice(`AI ok · model=${data?.model ?? aiChatModel ?? '—'}`);
    } catch (e: any) {
      setError(e?.message ?? 'Erreur AI chat');
    } finally {
      setAiChatLoading(false);
    }
  }, [aiChatInput, aiChatModel]);

  /* ──────────────────────────────────────────────────────────────
     Tab prefetch behavior
  ─────────────────────────────────────────────────────────────── */

  useEffect(() => {
    // load alerts/ai lazily
    if (tab === 'alerts') {
      fetchAlertsStats();
      fetchAlertFilters();
      fetchDeadLetter();
    }
    if (tab === 'ai') {
      fetchAI();
    }
  }, [tab, fetchAlertsStats, fetchAlertFilters, fetchDeadLetter, fetchAI]);

  /* ──────────────────────────────────────────────────────────────
     Render
  ─────────────────────────────────────────────────────────────── */

  return (
    <div className="min-h-screen bg-[#0A0A0F] text-white">
      {/* background glow */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-24 left-1/3 h-[420px] w-[420px] rounded-full bg-[#E85D1A]/15 blur-[80px]" />
        <div className="absolute top-1/3 right-1/4 h-[360px] w-[360px] rounded-full bg-[#378ADD]/12 blur-[90px]" />
        <div className="absolute bottom-0 left-1/4 h-[360px] w-[360px] rounded-full bg-[#1D9E75]/10 blur-[90px]" />
      </div>

      <div className="relative mx-auto max-w-[1600px] px-6 py-6">
        {/* Header */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-5">
          <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-[20px] px-5 py-4 shadow-[0_20px_70px_rgba(0,0,0,0.55)]">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="flex items-center gap-3">
                <Link
                  href="/"
                  className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/85 hover:bg-white/10 transition"
                >
                  ← Dashboard
                </Link>
                <div>
                  <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
                  <div className="text-xs text-white/60">
                    Assets CRUD, alerting tools, Ollama status/models, Telegram (via alert channels).
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70">
                  API: {API_BASE}
                </span>
                <a
                  href={API_BASE.replace(/\/api\/v1$/, '') + '/docs'}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10 transition"
                >
                  Swagger
                </a>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <TabButton active={tab === 'assets'} onClick={() => setTab('assets')}>Assets</TabButton>
              <TabButton active={tab === 'alerts'} onClick={() => setTab('alerts')}>Alerts</TabButton>
              <TabButton active={tab === 'ai'} onClick={() => setTab('ai')}>Ollama / AI</TabButton>
              <TabButton active={tab === 'telegram'} onClick={() => setTab('telegram')}>Telegram</TabButton>
              <TabButton active={tab === 'system'} onClick={() => setTab('system')}>System</TabButton>
            </div>

            {(error || notice) && (
              <div className="mt-4 grid grid-cols-1 gap-2">
                {notice && (
                  <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
                    {notice}
                  </div>
                )}
                {error && (
                  <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                    {error}
                  </div>
                )}
              </div>
            )}
          </div>
        </motion.div>

        <AnimatePresence mode="wait">
          {/* ───────────────────────── ASSETS TAB ───────────────────────── */}
          {tab === 'assets' && (
            <motion.div
              key="assets"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-5"
            >
              <Card>
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <div className="text-base font-semibold">Assets</div>
                    <div className="text-xs text-white/60 mt-1">
                      Gestion watchlist côté DB (CRUD). Tu peux refresh un asset (backend analyse) et ouvrir la page analysis.
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => { setError(null); setNotice(null); fetchAssets(); fetchAssetStats(); }}
                      className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10 transition"
                    >
                      Refresh
                    </button>
                    <button
                      onClick={openCreateAsset}
                      className="rounded-xl border border-white/10 bg-gradient-to-b from-[#E85D1A]/90 to-[#E85D1A]/40 px-4 py-2 text-sm font-medium text-white hover:from-[#E85D1A] hover:to-[#E85D1A]/50 transition"
                    >
                      New asset
                    </button>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-12">
                  <div className="md:col-span-3">
                    <Field label="Asset class">
                      <select
                        value={assetClass}
                        onChange={(e) => { setAssetsOffset(0); setAssetClass(e.target.value as any); }}
                        className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                      >
                        <option value="ALL">ALL</option>
                        <option value="CRYPTO">CRYPTO</option>
                        <option value="STOCK">STOCK</option>
                        <option value="FOREX">FOREX</option>
                        <option value="INDEX">INDEX</option>
                        <option value="ETF">ETF</option>
                        <option value="COMMODITY">COMMODITY</option>
                        <option value="OTHER">OTHER</option>
                      </select>
                    </Field>
                  </div>

                  <div className="md:col-span-2">
                    <Field label="Active">
                      <select
                        value={assetActive}
                        onChange={(e) => { setAssetsOffset(0); setAssetActive(e.target.value as any); }}
                        className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                      >
                        <option value="ALL">ALL</option>
                        <option value="true">true</option>
                        <option value="false">false</option>
                      </select>
                    </Field>
                  </div>

                  <div className="md:col-span-4">
                    <Field label="Search">
                      <input
                        value={assetQuery}
                        onChange={(e) => setAssetQuery(e.target.value)}
                        placeholder="BTC, Binance, Apple…"
                        className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
                      />
                    </Field>
                  </div>

                  <div className="md:col-span-1">
                    <Field label="Limit">
                      <select
                        value={assetsLimit}
                        onChange={(e) => { setAssetsOffset(0); setAssetsLimit(Number(e.target.value)); }}
                        className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                      >
                        {[20, 50, 100, 200].map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                    </Field>
                  </div>

                  <div className="md:col-span-2 flex items-end gap-2">
                    <button
                      onClick={() => setAssetsOffset((p) => Math.max(0, p - assetsLimit))}
                      disabled={assetsOffset === 0}
                      className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10 transition disabled:opacity-50"
                    >
                      Prev
                    </button>
                    <button
                      onClick={() => setAssetsOffset((p) => Math.min((assetsPages - 1) * assetsLimit, p + assetsLimit))}
                      disabled={assetsOffset + assetsLimit >= assetsTotal}
                      className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10 transition disabled:opacity-50"
                    >
                      Next
                    </button>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-6">
                  <Stat label="Total" value={assetStatsLoading ? '…' : String(assetStats?.total ?? '—')} />
                  <Stat label="Active" value={assetStatsLoading ? '…' : String(assetStats?.active ?? '—')} />
                  <Stat label="With analysis" value={assetStatsLoading ? '…' : String(assetStats?.with_analysis ?? '—')} />
                  <Stat label="Valid setups" value={assetStatsLoading ? '…' : String((assetStats as any)?.valid_setups ?? '—')} accent />
                  <Stat label="Pending setups" value={assetStatsLoading ? '…' : String((assetStats as any)?.pending_setups ?? '—')} />
                  <Stat label="Page" value={`${assetsPage}/${assetsPages}`} />
                </div>
              </Card>

              <Card noPadding>
                <div className="border-b border-white/10 bg-black/20 px-4 py-3 flex items-center justify-between">
                  <div className="text-sm font-semibold">Assets list</div>
                  <div className="text-xs text-white/55">
                    {assetsLoading ? 'Loading…' : `${filteredAssets.length} shown · ${assetsTotal} total`}
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="min-w-full text-left">
                    <thead className="bg-black/25">
                      <tr className="text-[11px] uppercase tracking-wider text-white/45">
                        <th className="px-4 py-3">Symbol</th>
                        <th className="px-4 py-3">Class</th>
                        <th className="px-4 py-3">Exchange</th>
                        <th className="px-4 py-3">Active</th>
                        <th className="px-4 py-3">Last price</th>
                        <th className="px-4 py-3">Last analysis</th>
                        <th className="px-4 py-3">Setup</th>
                        <th className="px-4 py-3 text-right">Actions</th>
                      </tr>
                    </thead>

                    <tbody className="divide-y divide-white/10">
                      {assetsLoading && (
                        <tr>
                          <td colSpan={8} className="px-4 py-6 text-sm text-white/55">Chargement…</td>
                        </tr>
                      )}

                      {!assetsLoading && filteredAssets.length === 0 && (
                        <tr>
                          <td colSpan={8} className="px-4 py-6 text-sm text-white/55">Aucun asset.</td>
                        </tr>
                      )}

                      {filteredAssets.map((a) => (
                        <tr key={a.symbol} className="hover:bg-white/5 transition">
                          <td className="px-4 py-3">
                            <div className="text-sm font-semibold text-white/90">{a.symbol}</div>
                            <div className="text-[11px] text-white/45 truncate max-w-[320px]">
                              {a.name || '—'}
                            </div>
                          </td>

                          <td className="px-4 py-3 text-xs text-white/75">{a.asset_class}</td>
                          <td className="px-4 py-3 text-xs text-white/75">{a.exchange || '—'}</td>

                          <td className="px-4 py-3">
                            <span className={cn(
                              'rounded-full border px-2.5 py-1 text-[11px] font-medium',
                              a.active ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200' : 'border-zinc-500/25 bg-zinc-500/10 text-zinc-200'
                            )}>
                              {a.active ? 'true' : 'false'}
                            </span>
                          </td>

                          <td className="px-4 py-3 text-sm text-white/80">{fmt(a.last_price, 4)}</td>
                          <td className="px-4 py-3 text-xs text-white/65">{fmtDate(a.last_analysis_at)}</td>

                          <td className="px-4 py-3">
                            {a.setup ? (
                              <div className="flex flex-wrap items-center gap-2">
                                <span className={cn('rounded-full border px-2.5 py-1 text-[11px] font-medium', pillForSetup(a.setup.status))}>
                                  {a.setup.status}
                                </span>
                                <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/70">
                                  {fmt(a.setup.score, 0)}%
                                </span>
                                {a.setup.zone_type && (
                                  <span
                                    className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/75"
                                    style={{ boxShadow: `0 0 0 1px ${colorForZoneType(a.setup.zone_type)} inset` }}
                                  >
                                    <span className="inline-block h-2 w-2 rounded-full mr-2 align-middle" style={{ backgroundColor: colorForZoneType(a.setup.zone_type) }} />
                                    {a.setup.zone_type}
                                  </span>
                                )}
                                {a.setup.pa_pattern && (
                                  <span className="rounded-full border border-[#378ADD]/25 bg-[#378ADD]/10 px-2.5 py-1 text-[11px] text-sky-200">
                                    PA {a.setup.pa_pattern}
                                  </span>
                                )}
                                {a.setup.rr !== undefined && (
                                  <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/70">
                                    RR {fmt(a.setup.rr, 2)}
                                  </span>
                                )}
                              </div>
                            ) : (
                              <div className="text-xs text-white/50">—</div>
                            )}
                          </td>

                          <td className="px-4 py-3 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <Link
                                href={`/analysis/${encodeURIComponent(a.symbol)}`}
                                className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white/80 hover:bg-white/10 transition"
                              >
                                Open
                              </Link>
                              <button
                                onClick={() => refreshAssetAnalysis(a.symbol)}
                                className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-200 hover:bg-emerald-500/15 transition"
                              >
                                Refresh
                              </button>
                              <button
                                onClick={() => openEditAsset(a)}
                                className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white/80 hover:bg-white/10 transition"
                              >
                                Edit
                              </button>
                              <button
                                onClick={() => deleteAsset(a.symbol)}
                                className="rounded-lg border border-rose-500/20 bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-200 hover:bg-rose-500/15 transition"
                              >
                                Delete
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              <Modal
                open={assetModalOpen}
                title={assetModalMode === 'create' ? 'New asset' : 'Edit asset'}
                subtitle={assetModalMode === 'create' ? 'Crée un nouvel asset dans la DB.' : 'Modifie name/exchange/active/meta.'}
                onClose={() => setAssetModalOpen(false)}
                footer={(
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setAssetModalOpen(false)}
                      className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10 transition"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={submitAsset}
                      className="rounded-xl border border-white/10 bg-gradient-to-b from-[#E85D1A]/90 to-[#E85D1A]/40 px-4 py-2 text-sm font-medium text-white hover:from-[#E85D1A] hover:to-[#E85D1A]/50 transition"
                    >
                      {assetModalMode === 'create' ? 'Create' : 'Save'}
                    </button>
                  </div>
                )}
              >
                <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
                  <div className="md:col-span-4">
                    <Field label="Symbol *">
                      <input
                        value={assetForm.symbol}
                        onChange={(e) => setAssetForm((p) => ({ ...p, symbol: e.target.value }))}
                        placeholder="BTCUSDT"
                        disabled={assetModalMode === 'edit'}
                        className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40 disabled:opacity-60"
                      />
                    </Field>
                  </div>

                  <div className="md:col-span-4">
                    <Field label="Asset class">
                      <select
                        value={assetForm.asset_class}
                        onChange={(e) => setAssetForm((p) => ({ ...p, asset_class: e.target.value as AssetClass }))}
                        disabled={assetModalMode === 'edit'}
                        className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none disabled:opacity-60"
                      >
                        <option value="CRYPTO">CRYPTO</option>
                        <option value="STOCK">STOCK</option>
                        <option value="FOREX">FOREX</option>
                        <option value="INDEX">INDEX</option>
                        <option value="ETF">ETF</option>
                        <option value="COMMODITY">COMMODITY</option>
                        <option value="OTHER">OTHER</option>
                      </select>
                    </Field>
                  </div>

                  <div className="md:col-span-4 flex items-end">
                    <button
                      onClick={() => setAssetForm((p) => ({ ...p, active: !p.active }))}
                      className={cn(
                        'w-full rounded-xl border px-3 py-2 text-sm font-medium transition',
                        assetForm.active
                          ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200'
                          : 'border-zinc-500/25 bg-zinc-500/10 text-zinc-200'
                      )}
                    >
                      active: {assetForm.active ? 'true' : 'false'}
                    </button>
                  </div>

                  <div className="md:col-span-6">
                    <Field label="Name">
                      <input
                        value={assetForm.name}
                        onChange={(e) => setAssetForm((p) => ({ ...p, name: e.target.value }))}
                        placeholder="Bitcoin"
                        className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
                      />
                    </Field>
                  </div>

                  <div className="md:col-span-6">
                    <Field label="Exchange">
                      <input
                        value={assetForm.exchange}
                        onChange={(e) => setAssetForm((p) => ({ ...p, exchange: e.target.value }))}
                        placeholder="Binance"
                        className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
                      />
                    </Field>
                  </div>

                  <div className="md:col-span-12">
                    <Field label="Meta (JSON)">
                      <textarea
                        value={assetForm.metaJson}
                        onChange={(e) => setAssetForm((p) => ({ ...p, metaJson: e.target.value }))}
                        rows={8}
                        placeholder={`{\n  "watch": true,\n  "notes": "my bias"\n}`}
                        className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
                      />
                    </Field>
                    <div className="mt-1 text-[11px] text-white/50">
                      Astuce: tu peux stocker des tags, une whitelist de TF, un commentaire, etc.
                    </div>
                  </div>
                </div>
              </Modal>
            </motion.div>
          )}

          {/* ───────────────────────── ALERTS TAB ───────────────────────── */}
          {tab === 'alerts' && (
            <motion.div
              key="alerts"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-5"
            >
              <Card>
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <div className="text-base font-semibold">Alerts</div>
                    <div className="text-xs text-white/60 mt-1">
                      Stats, filtres backend, dead-letter, et outils de test (emit/test).
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => { fetchAlertsStats(); fetchAlertFilters(); fetchDeadLetter(); }}
                      className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10 transition"
                    >
                      Refresh
                    </button>
                    <button
                      onClick={() => setEmitOpen(true)}
                      className="rounded-xl border border-white/10 bg-gradient-to-b from-[#E85D1A]/90 to-[#E85D1A]/40 px-4 py-2 text-sm font-medium text-white hover:from-[#E85D1A] hover:to-[#E85D1A]/50 transition"
                    >
                      Send test/emit
                    </button>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-6">
                  <Stat label="Total" value={alertsStatsLoading ? '…' : String((alertsStats as any)?.total ?? '—')} />
                  <Stat label="Sent" value={alertsStatsLoading ? '…' : String((alertsStats as any)?.sent ?? '—')} />
                  <Stat label="Failed" value={alertsStatsLoading ? '…' : String((alertsStats as any)?.failed ?? '—')} />
                  <Stat label="Queued" value={alertsStatsLoading ? '…' : String((alertsStats as any)?.queued ?? '—')} />
                  <Stat label="Dead-letter" value={deadLoading ? '…' : String(deadLetter?.length ?? 0)} accent />
                  <Stat label="Filters" value={filtersLoading ? '…' : (alertFilters ? 'loaded' : '—')} />
                </div>
              </Card>

              <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
                <Card className="xl:col-span-7" noPadding>
                  <div className="border-b border-white/10 bg-black/20 px-4 py-3 flex items-center justify-between">
                    <div className="text-sm font-semibold">Dead-letter queue</div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={fetchDeadLetter}
                        className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white/80 hover:bg-white/10 transition"
                      >
                        Refresh
                      </button>
                      <button
                        onClick={clearDeadLetter}
                        className="rounded-lg border border-rose-500/20 bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-200 hover:bg-rose-500/15 transition"
                      >
                        Clear
                      </button>
                    </div>
                  </div>

                  <div className="p-4">
                    {!deadLetter.length && !deadLoading && (
                      <div className="rounded-xl border border-white/10 bg-black/20 p-4 text-sm text-white/60">
                        Aucun message en dead-letter.
                      </div>
                    )}

                    <div className="space-y-3">
                      {deadLetter.slice(0, 25).map((a) => (
                        <div key={a.id} className="rounded-2xl border border-white/10 bg-black/20 p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-sm font-semibold text-white/90 truncate">
                                {a.title || a.alert_type}{' '}
                                <span className="text-white/45 font-normal">· {a.symbol} {a.timeframe}</span>
                              </div>
                              <div className="text-xs text-white/60 mt-1 whitespace-pre-wrap">
                                {a.message}
                              </div>
                            </div>

                            <div className="text-right">
                              <div className="text-[11px] text-white/50">{a.priority}</div>
                              <div className="text-[11px] text-white/50">{fmtDate(a.created_at)}</div>
                            </div>
                          </div>

                          <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
                            <MiniStat label="Type" value={a.alert_type} />
                            <MiniStat label="Status" value={a.status} />
                            <MiniStat label="Channels" value={(a.channels ?? []).join(', ') || '—'} />
                            <MiniStat label="Emoji" value={a.emoji || '—'} />
                          </div>

                          <details className="mt-3">
                            <summary className="cursor-pointer text-xs text-white/60 hover:text-white/80 transition">
                              Payload JSON
                            </summary>
                            <pre className="mt-2 rounded-xl border border-white/10 bg-black/30 p-3 text-xs text-white/75 overflow-auto">
                              {JSON.stringify(a.payload ?? {}, null, 2)}
                            </pre>
                          </details>
                        </div>
                      ))}
                    </div>
                  </div>
                </Card>

                <Card className="xl:col-span-5">
                  <div className="text-sm font-semibold">Backend alert filters</div>
                  <div className="text-xs text-white/60 mt-1">
                    Données renvoyées par <code>/alerts/filters</code> (utile pour voir types/priorités/channels dispo).
                  </div>

                  <div className="mt-4">
                    <pre className="rounded-2xl border border-white/10 bg-black/30 p-4 text-xs text-white/75 overflow-auto max-h-[520px]">
                      {alertFilters ? JSON.stringify(alertFilters, null, 2) : '—'}
                    </pre>
                  </div>
                </Card>
              </div>

              <Modal
                open={emitOpen}
                title="Send alert (emit/test)"
                subtitle="emit = enregistre + route vers channels. test = ping simple par channel."
                onClose={() => setEmitOpen(false)}
                footer={(
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setEmitOpen(false)}
                      className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10 transition"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={submitEmit}
                      className="rounded-xl border border-white/10 bg-gradient-to-b from-[#E85D1A]/90 to-[#E85D1A]/40 px-4 py-2 text-sm font-medium text-white hover:from-[#E85D1A] hover:to-[#E85D1A]/50 transition"
                    >
                      Send
                    </button>
                  </div>
                )}
              >
                <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
                  <div className="md:col-span-4">
                    <Field label="Mode">
                      <select
                        value={emitForm.mode}
                        onChange={(e) => setEmitForm((p) => ({ ...p, mode: e.target.value as any }))}
                        className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                      >
                        <option value="emit">emit</option>
                        <option value="test">test</option>
                      </select>
                    </Field>
                  </div>

                  {emitForm.mode === 'test' ? (
                    <div className="md:col-span-8">
                      <Field label="Channel">
                        <select
                          value={emitForm.channel}
                          onChange={(e) => setEmitForm((p) => ({ ...p, channel: e.target.value as AlertChannel }))}
                          className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                        >
                          <option value="WEBSOCKET">WEBSOCKET</option>
                          <option value="TELEGRAM">TELEGRAM</option>
                        </select>
                      </Field>
                      <div className="mt-1 text-[11px] text-white/50">
                        Si TELEGRAM échoue, vérifie <code>TELEGRAM_BOT_TOKEN</code> et <code>TELEGRAM_CHAT_IDS</code> côté backend.
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="md:col-span-4">
                        <Field label="Priority">
                          <select
                            value={emitForm.priority}
                            onChange={(e) => setEmitForm((p) => ({ ...p, priority: e.target.value as any }))}
                            className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                          >
                            <option value="LOW">LOW</option>
                            <option value="MEDIUM">MEDIUM</option>
                            <option value="HIGH">HIGH</option>
                            <option value="CRITICAL">CRITICAL</option>
                          </select>
                        </Field>
                      </div>
                      <div className="md:col-span-4">
                        <Field label="Alert type">
                          <input
                            value={emitForm.alert_type}
                            onChange={(e) => setEmitForm((p) => ({ ...p, alert_type: e.target.value }))}
                            placeholder="SETUP / PRICE / SYSTEM…"
                            className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                          />
                        </Field>
                      </div>
                      <div className="md:col-span-4">
                        <Field label="Timeframe">
                          <input
                            value={emitForm.timeframe}
                            onChange={(e) => setEmitForm((p) => ({ ...p, timeframe: e.target.value }))}
                            placeholder="H4"
                            className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                          />
                        </Field>
                      </div>
                    </>
                  )}

                  <div className="md:col-span-6">
                    <Field label="Symbol *">
                      <input
                        value={emitForm.symbol}
                        onChange={(e) => setEmitForm((p) => ({ ...p, symbol: e.target.value }))}
                        placeholder="BTCUSDT"
                        className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
                      />
                    </Field>
                  </div>

                  {emitForm.mode === 'emit' && (
                    <div className="md:col-span-6">
                      <Field label="Channels">
                        <div className="flex flex-wrap gap-2">
                          {(['WEBSOCKET', 'TELEGRAM'] as AlertChannel[]).map((ch) => {
                            const on = emitForm.channels.includes(ch);
                            return (
                              <button
                                key={ch}
                                onClick={() =>
                                  setEmitForm((p) => ({
                                    ...p,
                                    channels: on ? p.channels.filter((x) => x !== ch) : [...p.channels, ch],
                                  }))
                                }
                                className={cn(
                                  'rounded-full border px-3 py-1.5 text-xs font-medium transition',
                                  on
                                    ? 'border-[#E85D1A]/30 bg-[#E85D1A]/10 text-white'
                                    : 'border-white/10 bg-white/5 text-white/65 hover:bg-white/10'
                                )}
                              >
                                {ch}
                              </button>
                            );
                          })}
                        </div>
                      </Field>
                    </div>
                  )}

                  {emitForm.mode === 'emit' && (
                    <div className="md:col-span-12">
                      <Field label="Title">
                        <input
                          value={emitForm.title}
                          onChange={(e) => setEmitForm((p) => ({ ...p, title: e.target.value }))}
                          className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                        />
                      </Field>
                    </div>
                  )}

                  <div className="md:col-span-12">
                    <Field label="Message">
                      <textarea
                        value={emitForm.message}
                        onChange={(e) => setEmitForm((p) => ({ ...p, message: e.target.value }))}
                        rows={4}
                        className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                      />
                    </Field>
                  </div>

                  {emitForm.mode === 'emit' && (
                    <div className="md:col-span-12">
                      <Field label="Payload JSON">
                        <textarea
                          value={emitForm.payloadJson}
                          onChange={(e) => setEmitForm((p) => ({ ...p, payloadJson: e.target.value }))}
                          rows={6}
                          className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs outline-none"
                        />
                      </Field>
                    </div>
                  )}
                </div>
              </Modal>
            </motion.div>
          )}

          {/* ───────────────────────── AI TAB ───────────────────────── */}
          {tab === 'ai' && (
            <motion.div
              key="ai"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-5"
            >
              <Card>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-base font-semibold">Ollama / AI</div>
                    <div className="text-xs text-white/60 mt-1">
                      Status + models + test rapide via <code>/ai/chat</code>.
                    </div>
                  </div>
                  <button
                    onClick={fetchAI}
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10 transition"
                  >
                    {aiLoading ? 'Loading…' : 'Refresh'}
                  </button>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-6">
                  <Stat label="Online" value={aiStatus ? String(aiStatus.ollama_online) : '—'} accent />
                  <Stat label="Host" value={aiStatus?.host ?? '—'} />
                  <Stat label="Default model" value={aiStatus?.model ?? '—'} />
                  <Stat label="Version" value={aiStatus?.version ?? '—'} />
                  <Stat label="Models" value={aiModels ? String(aiModels.models?.length ?? 0) : '—'} />
                  <Stat label="API" value="/ai/status + /ai/models" />
                </div>
              </Card>

              <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
                <Card className="xl:col-span-5">
                  <div className="text-sm font-semibold">Models</div>
                  <div className="text-xs text-white/60 mt-1">
                    Liste issue de <code>/ai/models</code>.
                  </div>

                  <div className="mt-4 space-y-2 max-h-[520px] overflow-auto pr-1">
                    {(aiModels?.models ?? []).map((m) => {
                      const selected = aiChatModel === m.name;
                      return (
                        <button
                          key={m.name}
                          onClick={() => setAiChatModel(m.name)}
                          className={cn(
                            'w-full text-left rounded-2xl border p-3 transition',
                            selected ? 'border-white/20 bg-white/10' : 'border-white/10 bg-black/20 hover:bg-white/10'
                          )}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="text-sm font-semibold text-white/90">{m.name}</div>
                            <div className="text-[11px] text-white/55">{m.size ? `${fmt(m.size / 1e9, 2)} GB` : '—'}</div>
                          </div>
                          <div className="text-[11px] text-white/55 mt-1">
                            modified: {m.modified_at ?? '—'}
                          </div>
                        </button>
                      );
                    })}
                    {!aiModels?.models?.length && (
                      <div className="rounded-xl border border-white/10 bg-black/20 p-4 text-sm text-white/60">
                        Aucun modèle trouvé. Vérifie que Ollama tourne et que des modèles existent.
                      </div>
                    )}
                  </div>
                </Card>

                <Card className="xl:col-span-7">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold">AI quick test</div>
                      <div className="text-xs text-white/60 mt-1">
                        Ce test utilise <code>/ai/chat</code> (non-stream) pour valider que le pipeline IA répond.
                      </div>
                    </div>

                    <button
                      onClick={runAIChat}
                      disabled={aiChatLoading}
                      className="rounded-xl border border-white/10 bg-gradient-to-b from-[#378ADD]/80 to-[#378ADD]/30 px-4 py-2 text-sm font-medium text-white hover:from-[#378ADD]/90 hover:to-[#378ADD]/35 transition disabled:opacity-60"
                    >
                      {aiChatLoading ? 'Running…' : 'Run'}
                    </button>
                  </div>

                  <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-12">
                    <div className="md:col-span-6">
                      <Field label="Model">
                        <input
                          value={aiChatModel}
                          onChange={(e) => setAiChatModel(e.target.value)}
                          placeholder="llama3.1"
                          className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                        />
                      </Field>
                      <div className="mt-1 text-[11px] text-white/50">
                        Tu peux laisser vide pour utiliser le modèle par défaut backend.
                      </div>
                    </div>

                    <div className="md:col-span-12">
                      <Field label="Prompt">
                        <textarea
                          value={aiChatInput}
                          onChange={(e) => setAiChatInput(e.target.value)}
                          rows={5}
                          className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                        />
                      </Field>
                    </div>

                    <div className="md:col-span-12">
                      <Field label="Response">
                        <pre className="w-full rounded-2xl border border-white/10 bg-black/30 p-4 text-sm text-white/80 overflow-auto max-h-[360px] whitespace-pre-wrap">
                          {aiChatOutput || '—'}
                        </pre>
                      </Field>
                    </div>
                  </div>
                </Card>
              </div>
            </motion.div>
          )}

          {/* ───────────────────────── TELEGRAM TAB ───────────────────────── */}
          {tab === 'telegram' && (
            <motion.div
              key="telegram"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-5"
            >
              <Card>
                <div className="text-base font-semibold">Telegram</div>
                <div className="text-xs text-white/60 mt-1">
                  Le backend utilise un bot Telegram pour envoyer les alertes (si configuré).
                  La gestion fine des chats (TelegramChat ORM) n’est pas exposée dans la liste d’endpoints fournie,
                  donc ici on met surtout: vérifications + test d’envoi via <code>/alerts/test</code> ou <code>/alerts/emit</code>.
                </div>

                <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-12">
                  <div className="md:col-span-7">
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                      <div className="text-sm font-semibold">Checklist config backend</div>
                      <ul className="mt-2 space-y-1 text-xs text-white/70 list-disc pl-4">
                        <li><code>TELEGRAM_BOT_TOKEN</code> défini</li>
                        <li><code>TELEGRAM_CHAT_IDS</code> défini (comma-separated)</li>
                        <li>Le backend tourne et peut accéder à l’API Telegram</li>
                        <li>Le bot a déjà été “/start” dans les chats ciblés</li>
                      </ul>

                      <div className="mt-3 text-[11px] text-white/50">
                        Si tu veux un vrai CRUD de <code>TelegramChat</code> (activer/silencer/whitelist),
                        il faudra ajouter des routes dédiées côté backend (ou me donner celles qui existent si elles sont déjà codées).
                      </div>
                    </div>
                  </div>

                  <div className="md:col-span-5">
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                      <div className="text-sm font-semibold">Send Telegram test</div>
                      <div className="text-xs text-white/60 mt-1">
                        Envoie un ping via <code>/alerts/test</code> (channel=TELEGRAM).
                      </div>

                      <div className="mt-3 space-y-3">
                        <Field label="Symbol">
                          <input
                            value={emitForm.symbol}
                            onChange={(e) => setEmitForm((p) => ({ ...p, symbol: e.target.value }))}
                            className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                          />
                        </Field>

                        <Field label="Message">
                          <textarea
                            value={emitForm.message}
                            onChange={(e) => setEmitForm((p) => ({ ...p, message: e.target.value }))}
                            rows={4}
                            className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                          />
                        </Field>

                        <button
                          onClick={async () => {
                            setEmitForm((p) => ({ ...p, mode: 'test', channel: 'TELEGRAM' }));
                            await submitEmit();
                          }}
                          className="w-full rounded-xl border border-white/10 bg-gradient-to-b from-[#E85D1A]/90 to-[#E85D1A]/40 px-4 py-2 text-sm font-medium text-white hover:from-[#E85D1A] hover:to-[#E85D1A]/50 transition"
                        >
                          Send TELEGRAM test
                        </button>

                        <button
                          onClick={() => setEmitOpen(true)}
                          className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/80 hover:bg-white/10 transition"
                        >
                          Open advanced emit/test modal
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </Card>
            </motion.div>
          )}

          {/* ───────────────────────── SYSTEM TAB ───────────────────────── */}
          {tab === 'system' && (
            <motion.div
              key="system"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-5"
            >
              <Card>
                <div className="text-base font-semibold">System</div>
                <div className="text-xs text-white/60 mt-1">
                  Infos utiles et raccourcis. (Ce tab n’écrit rien; il aide au diagnostic.)
                </div>

                <div className="mt-4 grid grid-cols-1 gap-5 xl:grid-cols-12">
                  <div className="xl:col-span-7 space-y-3">
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                      <div className="text-sm font-semibold">Endpoints</div>
                      <div className="mt-2 text-xs text-white/70 space-y-1">
                        <div><span className="text-white/50">Assets:</span> <code>/assets</code>, <code>/assets/stats</code></div>
                        <div><span className="text-white/50">Alerts:</span> <code>/alerts/stats</code>, <code>/alerts/emit</code>, <code>/alerts/test</code>, <code>/alerts/dead-letter</code></div>
                        <div><span className="text-white/50">AI:</span> <code>/ai/status</code>, <code>/ai/models</code>, <code>/ai/chat</code></div>
                      </div>

                      <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
                        <a
                          href={API_BASE.replace(/\/api\/v1$/, '') + '/docs'}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10 transition text-center"
                        >
                          Open Swagger
                        </a>
                        <a
                          href={API_BASE.replace(/\/api\/v1$/, '')}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10 transition text-center"
                        >
                          Open Backend root
                        </a>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                      <div className="text-sm font-semibold">Common issues</div>
                      <ul className="mt-2 space-y-1 text-xs text-white/70 list-disc pl-4">
                        <li>Si le frontend ne reach pas le backend: vérifie <code>NEXT_PUBLIC_API_URL</code> (sinon fallback localhost:8000).</li>
                        <li>Si Ollama offline: lance <code>ollama serve</code> et vérifie <code>OLLAMA_HOST</code> côté backend.</li>
                        <li>Si Telegram ne marche pas: bot token, chat ids, et autorisation du bot dans les chats.</li>
                      </ul>
                    </div>
                  </div>

                  <div className="xl:col-span-5">
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                      <div className="text-sm font-semibold">Runtime</div>
                      <div className="mt-2 grid grid-cols-1 gap-2">
                        <MiniStat label="API_BASE" value={API_BASE} />
                        <MiniStat label="Tab" value={tab} />
                        <MiniStat label="Assets loaded" value={String(assets.length)} />
                        <MiniStat label="Dead-letter size" value={String(deadLetter.length)} />
                      </div>

                      <div className="mt-3 text-[11px] text-white/50">
                        Cette page est volontairement “opérationnelle” (debug + actions).
                        Si tu veux une vraie page Settings produit (avec persistance), on ajoutera des endpoints config côté backend.
                      </div>
                    </div>
                  </div>
                </div>
              </Card>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="mt-6 text-xs text-white/40">
          IGNIS Platform · Settings UI (glass) · <span className="text-white/55">dark-only</span>
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   UI components
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

function Card({
  children,
  className,
  noPadding,
}: {
  children: React.ReactNode;
  className?: string;
  noPadding?: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-white/10 bg-white/5 backdrop-blur-[20px] shadow-[0_25px_80px_rgba(0,0,0,0.55)]',
        noPadding ? 'overflow-hidden' : 'p-5',
        className
      )}
    >
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-xs text-white/60 mb-1">{label}</div>
      {children}
    </label>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={cn('rounded-xl border border-white/10 bg-black/20 px-3 py-2', accent && 'bg-gradient-to-b from-white/10 to-black/20')}>
      <div className="text-[11px] text-white/55">{label}</div>
      <div className="text-sm font-semibold text-white/90 truncate">{value}</div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2">
      <div className="text-[11px] text-white/55">{label}</div>
      <div className="text-xs font-medium text-white/85 break-all">{value}</div>
    </div>
  );
}

function Modal({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div className="absolute inset-0 bg-black/60" onClick={onClose} />
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            className="relative w-full max-w-3xl rounded-2xl border border-white/10 bg-[#0A0A0F]/70 backdrop-blur-[22px] shadow-[0_30px_100px_rgba(0,0,0,0.7)]"
          >
            <div className="border-b border-white/10 px-5 py-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-base font-semibold">{title}</div>
                  {subtitle && <div className="text-xs text-white/60 mt-1">{subtitle}</div>}
                </div>
                <button
                  onClick={onClose}
                  className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white/75 hover:bg-white/10 transition"
                >
                  Close
                </button>
              </div>
            </div>

            <div className="px-5 py-4">{children}</div>

            {footer && (
              <div className="border-t border-white/10 px-5 py-4 flex items-center justify-end">
                {footer}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}