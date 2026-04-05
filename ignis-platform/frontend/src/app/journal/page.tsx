/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';

/* ──────────────────────────────────────────────────────────────
   Types (reprend ton schéma)
────────────────────────────────────────────────────────────── */

type TradeSide = 'LONG' | 'SHORT';
type TradeStatus = 'OPEN' | 'CLOSED' | 'CANCELLED';
type Timeframe = 'M1'|'M5'|'M15'|'M30'|'H1'|'H2'|'H4'|'H8'|'D1'|'W1'|'MN1';

interface JournalEntryResponse {
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
  opened_at?: string;
  closed_at?: string;
  exit_price?: number;
  pnl?: number;
  pnl_pct?: number;
  notes: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

interface JournalStatsResponse {
  total: number;
  open: number;
  closed: number;
  win_rate: number;     // backend likely 0..100 (ou 0..1) => on gère
  total_pnl: number;
  avg_rr: number;
  best_trade?: any;
  worst_trade?: any;
  by_symbol: Record<string, { total?: number; win_rate?: number; pnl?: number; avg_rr?: number }>;
}

/* ──────────────────────────────────────────────────────────────
   Config
────────────────────────────────────────────────────────────── */

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:8000/api/v1';

const TIMEFRAMES: Timeframe[] = ['M15','M30','H1','H2','H4','H8','D1','W1','MN1'];

/* ──────────────────────────────────────────────────────────────
   Helpers UI / formatting
────────────────────────────────────────────────────────────── */

function cn(...classes: Array<string | undefined | null | false>) {
  return classes.filter(Boolean).join(' ');
}

function fmt(n: number | undefined, digits = 2) {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits }).format(n);
}

function fmtPct(n: number | undefined, digits = 1) {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  const val = n <= 1 ? n * 100 : n; // accepte 0..1 ou 0..100
  return `${fmt(val, digits)}%`;
}

function fmtDate(iso: string | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('fr-FR', { hour12: false });
}

function sidePill(side: TradeSide) {
  return side === 'LONG'
    ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200'
    : 'border-rose-500/25 bg-rose-500/10 text-rose-200';
}

function statusPill(status: TradeStatus) {
  switch (status) {
    case 'OPEN':
      return 'border-sky-500/25 bg-sky-500/10 text-sky-200';
    case 'CLOSED':
      return 'border-zinc-200/10 bg-white/5 text-white/75';
    case 'CANCELLED':
      return 'border-amber-500/25 bg-amber-500/10 text-amber-200';
    default:
      return 'border-zinc-200/10 bg-white/5 text-white/75';
  }
}

function pnlColor(pnl?: number) {
  if (pnl === undefined || pnl === null) return 'text-white/70';
  if (pnl > 0) return 'text-emerald-300';
  if (pnl < 0) return 'text-rose-300';
  return 'text-white/70';
}

/* ──────────────────────────────────────────────────────────────
   Page
────────────────────────────────────────────────────────────── */

export default function JournalPage() {
  // filters / pagination
  const [statusFilter, setStatusFilter] = useState<'ALL' | TradeStatus>('OPEN');
  const [symbolFilter, setSymbolFilter] = useState<string>('');
  const [limit, setLimit] = useState<number>(50);
  const [offset, setOffset] = useState<number>(0);

  // data
  const [entries, setEntries] = useState<JournalEntryResponse[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [stats, setStats] = useState<JournalStatsResponse | null>(null);

  // ux
  const [loading, setLoading] = useState<boolean>(false);
  const [statsLoading, setStatsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  // modals
  const [createOpen, setCreateOpen] = useState<boolean>(false);
  const [editOpen, setEditOpen] = useState<boolean>(false);
  const [closeOpen, setCloseOpen] = useState<boolean>(false);

  // forms
  const [form, setForm] = useState<CreateOrEditFormState>(() => defaultCreateForm());
  const [closeForm, setCloseForm] = useState<CloseFormState>({ exit_price: '', closed_at: '', notes: '' });

  const selected = useMemo(
    () => entries.find((e) => e.id === selectedId) ?? null,
    [entries, selectedId]
  );

  const page = useMemo(() => Math.floor(offset / limit) + 1, [offset, limit]);
  const pageCount = useMemo(() => Math.max(1, Math.ceil(total / limit)), [total, limit]);

  const fetchEntries = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const url = new URL(`${API_BASE}/journal`);
      if (statusFilter !== 'ALL') url.searchParams.set('status', statusFilter);
      if (symbolFilter.trim()) url.searchParams.set('symbol', symbolFilter.trim().toUpperCase());
      url.searchParams.set('limit', String(limit));
      url.searchParams.set('offset', String(offset));

      const res = await fetch(url.toString(), { method: 'GET' });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${txt || 'Erreur journal'}`);
      }

      const data = await res.json();

      // backend probable: { total, entries, page, page_size }
      const list = (data.entries ?? data.results ?? data.items ?? []) as JournalEntryResponse[];
      setEntries(list);
      setTotal(Number(data.total ?? list.length ?? 0));

      // auto-select first
      setSelectedId((prev) => prev ?? (list[0]?.id ?? null));
    } catch (e: any) {
      setError(e?.message ?? 'Erreur inconnue');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, symbolFilter, limit, offset]);

  const fetchStats = useCallback(async () => {
    setError(null);
    setStatsLoading(true);
    try {
      const url = new URL(`${API_BASE}/journal/stats`);
      if (symbolFilter.trim()) url.searchParams.set('symbol', symbolFilter.trim().toUpperCase());

      const res = await fetch(url.toString(), { method: 'GET' });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${txt || 'Erreur stats'}`);
      }
      const data = (await res.json()) as JournalStatsResponse;
      setStats(data);
    } catch (e: any) {
      setError(e?.message ?? 'Erreur inconnue');
    } finally {
      setStatsLoading(false);
    }
  }, [symbolFilter]);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  const refreshAll = useCallback(async () => {
    await Promise.all([fetchEntries(), fetchStats()]);
  }, [fetchEntries, fetchStats]);

  const openCreate = useCallback(() => {
    setForm(defaultCreateForm());
    setCreateOpen(true);
  }, []);

  const openEdit = useCallback((entry: JournalEntryResponse) => {
    setForm(fromEntryToForm(entry));
    setEditOpen(true);
  }, []);

  const openClose = useCallback((entry: JournalEntryResponse) => {
    setCloseForm({
      exit_price: entry.exit_price ? String(entry.exit_price) : '',
      closed_at: new Date().toISOString().slice(0, 16), // for datetime-local
      notes: '',
    });
    setCloseOpen(true);
  }, []);

  const submitCreate = useCallback(async () => {
    setError(null);
    const payload = buildCreatePayload(form);
    if (!payload) return;

    try {
      const res = await fetch(`${API_BASE}/journal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${txt || 'Erreur création'}`);
      }

      const created = (await res.json()) as JournalEntryResponse;
      setCreateOpen(false);

      // refresh list (ensure server canonical)
      setOffset(0);
      await refreshAll();
      setSelectedId(created.id);
    } catch (e: any) {
      setError(e?.message ?? 'Erreur inconnue');
    }
  }, [form, refreshAll]);

  const submitEdit = useCallback(async () => {
    setError(null);
    const entryId = form.id;
    if (!entryId) {
      setError('Impossible: id manquant pour édition.');
      return;
    }

    const payload = buildPatchPayload(form);
    if (!payload) return;

    try {
      const res = await fetch(`${API_BASE}/journal/${encodeURIComponent(entryId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${txt || 'Erreur update'}`);
      }

      setEditOpen(false);
      await refreshAll();
    } catch (e: any) {
      setError(e?.message ?? 'Erreur inconnue');
    }
  }, [form, refreshAll]);

  const submitClose = useCallback(async () => {
    setError(null);
    if (!selected) {
      setError('Aucune entrée sélectionnée.');
      return;
    }
    const exit = Number(closeForm.exit_price);
    if (!Number.isFinite(exit) || exit <= 0) {
      setError('Exit price invalide.');
      return;
    }

    const payload: any = {
      exit_price: exit,
      notes: closeForm.notes?.trim() || undefined,
    };

    if (closeForm.closed_at) {
      const iso = toISOFromDatetimeLocal(closeForm.closed_at);
      if (iso) payload.closed_at = iso;
    }

    try {
      const res = await fetch(`${API_BASE}/journal/${encodeURIComponent(selected.id)}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${txt || 'Erreur clôture'}`);
      }

      setCloseOpen(false);
      await refreshAll();
    } catch (e: any) {
      setError(e?.message ?? 'Erreur inconnue');
    }
  }, [selected, closeForm, refreshAll]);

  const deleteEntry = useCallback(async (entry: JournalEntryResponse) => {
    setError(null);
    const ok = confirm(`Supprimer l'entrée ${entry.symbol} (${entry.id}) ?`);
    if (!ok) return;

    try {
      const res = await fetch(`${API_BASE}/journal/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${txt || 'Erreur suppression'}`);
      }
      await refreshAll();
      setSelectedId((prev) => (prev === entry.id ? null : prev));
    } catch (e: any) {
      setError(e?.message ?? 'Erreur inconnue');
    }
  }, [refreshAll]);

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
                  <h1 className="text-xl font-semibold tracking-tight">Journal</h1>
                  <div className="text-xs text-white/60">
                    Log de trades + stats P&L + création/édition/clôture.
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => refreshAll()}
                  className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10 transition"
                >
                  Refresh
                </button>

                <button
                  onClick={openCreate}
                  className="rounded-xl border border-white/10 bg-gradient-to-b from-[#E85D1A]/90 to-[#E85D1A]/40 px-4 py-2 text-sm font-medium text-white shadow-[0_12px_40px_rgba(232,93,26,0.25)] hover:from-[#E85D1A] hover:to-[#E85D1A]/50 transition"
                >
                  New trade
                </button>
              </div>
            </div>

            {/* Filters */}
            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-12">
              <div className="md:col-span-3">
                <label className="block text-xs text-white/60 mb-1">Status</label>
                <select
                  value={statusFilter}
                  onChange={(e) => { setOffset(0); setStatusFilter(e.target.value as any); }}
                  className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
                >
                  <option value="ALL">ALL</option>
                  <option value="OPEN">OPEN</option>
                  <option value="CLOSED">CLOSED</option>
                  <option value="CANCELLED">CANCELLED</option>
                </select>
              </div>

              <div className="md:col-span-5">
                <label className="block text-xs text-white/60 mb-1">Symbol (option)</label>
                <input
                  value={symbolFilter}
                  onChange={(e) => { setOffset(0); setSymbolFilter(e.target.value); }}
                  placeholder="BTCUSDT, AAPL…"
                  className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
                />
              </div>

              <div className="md:col-span-2">
                <label className="block text-xs text-white/60 mb-1">Page size</label>
                <select
                  value={limit}
                  onChange={(e) => { setOffset(0); setLimit(Number(e.target.value)); }}
                  className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
                >
                  {[20, 50, 100].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>

              <div className="md:col-span-2 flex items-end gap-2">
                <button
                  onClick={() => { setOffset((p) => Math.max(0, p - limit)); }}
                  disabled={offset === 0}
                  className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10 transition disabled:opacity-50"
                >
                  Prev
                </button>
                <button
                  onClick={() => { setOffset((p) => Math.min((pageCount - 1) * limit, p + limit)); }}
                  disabled={offset + limit >= total}
                  className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10 transition disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            </div>

            <div className="mt-3 flex items-center justify-between text-xs text-white/50">
              <div>
                {loading ? 'Loading…' : `Page ${page}/${pageCount} · ${total} entrées`}
              </div>
              <div>
                Stats: {statsLoading ? 'loading…' : 'ok'} · API: <span className="text-white/65">{API_BASE}</span>
              </div>
            </div>

            {error && (
              <div className="mt-4 rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                {error}
              </div>
            )}
          </div>
        </motion.div>

        {/* Stats */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="mb-5">
          <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-[20px] p-5 shadow-[0_25px_80px_rgba(0,0,0,0.55)]">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-semibold">Stats</h2>
              <div className="text-xs text-white/55">
                Filtre symbol appliqué: <span className="text-white/80">{symbolFilter.trim() ? symbolFilter.trim().toUpperCase() : '—'}</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
              <Stat label="Total" value={stats ? String(stats.total) : '—'} />
              <Stat label="Open" value={stats ? String(stats.open) : '—'} />
              <Stat label="Closed" value={stats ? String(stats.closed) : '—'} />
              <Stat label="Win rate" value={stats ? fmtPct(stats.win_rate) : '—'} accent />
              <Stat label="Total PnL" value={stats ? fmt(stats.total_pnl, 2) : '—'} className={pnlColor(stats?.total_pnl)} />
              <Stat label="Avg RR" value={stats ? fmt(stats.avg_rr, 2) : '—'} />
            </div>

            {/* by_symbol */}
            <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-3">
              <div className="text-xs font-medium text-white/70 mb-2">By symbol</div>
              {stats && Object.keys(stats.by_symbol ?? {}).length ? (
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  {Object.entries(stats.by_symbol).slice(0, 10).map(([sym, v]) => (
                    <div key={sym} className="rounded-lg border border-white/10 bg-white/5 px-3 py-2">
                      <div className="flex items-center justify-between">
                        <div className="text-xs font-semibold text-white/85">{sym}</div>
                        <div className="text-[11px] text-white/55">trades: {v.total ?? '—'}</div>
                      </div>
                      <div className="mt-1 text-[11px] text-white/60">
                        WR: <span className="text-white/80">{fmtPct(v.win_rate)}</span>
                        <span className="mx-2 text-white/20">·</span>
                        PnL: <span className={cn('font-medium', pnlColor(v.pnl))}>{fmt(v.pnl as any, 2)}</span>
                        <span className="mx-2 text-white/20">·</span>
                        Avg RR: <span className="text-white/80">{fmt(v.avg_rr as any, 2)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-white/55">Aucune donnée.</div>
              )}
            </div>
          </div>
        </motion.div>

        {/* Main */}
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
          {/* List */}
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="xl:col-span-8">
            <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-[20px] shadow-[0_25px_80px_rgba(0,0,0,0.55)] overflow-hidden">
              <div className="border-b border-white/10 bg-black/20 px-4 py-3 flex items-center justify-between">
                <div className="text-sm font-semibold">Entries</div>
                <div className="text-xs text-white/55">
                  Clique une ligne pour voir le détail.
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="min-w-full text-left">
                  <thead className="bg-black/25">
                    <tr className="text-[11px] uppercase tracking-wider text-white/45">
                      <th className="px-4 py-3">Symbol</th>
                      <th className="px-4 py-3">TF</th>
                      <th className="px-4 py-3">Side</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Entry</th>
                      <th className="px-4 py-3">SL / TP</th>
                      <th className="px-4 py-3">RR</th>
                      <th className="px-4 py-3">PnL</th>
                      <th className="px-4 py-3">Opened</th>
                      <th className="px-4 py-3 text-right">Actions</th>
                    </tr>
                  </thead>

                  <tbody className="divide-y divide-white/10">
                    {entries.length === 0 && !loading && (
                      <tr>
                        <td className="px-4 py-6 text-sm text-white/55" colSpan={10}>
                          Aucune entrée. Crée un trade avec “New trade”.
                        </td>
                      </tr>
                    )}

                    {entries.map((e) => {
                      const isSel = e.id === selectedId;
                      return (
                        <tr
                          key={e.id}
                          onClick={() => setSelectedId(e.id)}
                          className={cn(
                            'cursor-pointer transition',
                            isSel ? 'bg-white/10' : 'hover:bg-white/5'
                          )}
                        >
                          <td className="px-4 py-3">
                            <div className="text-sm font-semibold text-white/90">{e.symbol}</div>
                            <div className="text-[11px] text-white/45 truncate max-w-[220px]">
                              {e.setup_id ? `setup: ${e.setup_id}` : '—'}
                              {typeof e.setup_score === 'number' ? ` · score ${fmt(e.setup_score, 0)}%` : ''}
                            </div>
                          </td>

                          <td className="px-4 py-3 text-sm text-white/80">{e.timeframe}</td>

                          <td className="px-4 py-3">
                            <span className={cn('rounded-full border px-2.5 py-1 text-[11px] font-medium', sidePill(e.side))}>
                              {e.side}
                            </span>
                          </td>

                          <td className="px-4 py-3">
                            <span className={cn('rounded-full border px-2.5 py-1 text-[11px] font-medium', statusPill(e.status))}>
                              {e.status}
                            </span>
                          </td>

                          <td className="px-4 py-3 text-sm text-white/80">{fmt(e.entry, 4)}</td>

                          <td className="px-4 py-3 text-[12px] text-white/70">
                            <div>SL: <span className="text-white/80">{fmt(e.sl, 4)}</span></div>
                            <div>TP: <span className="text-white/80">{fmt(e.tp, 4)}</span></div>
                          </td>

                          <td className="px-4 py-3 text-sm text-white/80">{fmt(e.rr, 2)}</td>

                          <td className="px-4 py-3 text-sm">
                            <div className={cn('font-semibold', pnlColor(e.pnl))}>
                              {fmt(e.pnl, 2)}
                            </div>
                            <div className="text-[11px] text-white/45">
                              {e.pnl_pct !== undefined ? fmtPct(e.pnl_pct, 2) : '—'}
                            </div>
                          </td>

                          <td className="px-4 py-3 text-[12px] text-white/65">
                            {fmtDate(e.opened_at ?? e.created_at)}
                          </td>

                          <td className="px-4 py-3 text-right" onClick={(ev) => ev.stopPropagation()}>
                            <div className="flex items-center justify-end gap-2">
                              <button
                                onClick={() => openEdit(e)}
                                className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white/75 hover:bg-white/10 transition"
                              >
                                Edit
                              </button>

                              {e.status === 'OPEN' && (
                                <button
                                  onClick={() => { setSelectedId(e.id); openClose(e); }}
                                  className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-200 hover:bg-emerald-500/15 transition"
                                >
                                  Close
                                </button>
                              )}

                              <button
                                onClick={() => deleteEntry(e)}
                                className="rounded-lg border border-rose-500/20 bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-200 hover:bg-rose-500/15 transition"
                              >
                                Delete
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}

                    {loading && (
                      <tr>
                        <td className="px-4 py-6 text-sm text-white/55" colSpan={10}>
                          Chargement…
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </motion.div>

          {/* Detail */}
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="xl:col-span-4 space-y-5">
            <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-[20px] p-5 shadow-[0_25px_80px_rgba(0,0,0,0.55)]">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-base font-semibold">Détail</h3>
                <div className="text-xs text-white/55">{selected?.id ?? '—'}</div>
              </div>

              {selected ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-lg font-semibold">{selected.symbol}</div>
                    <div className="flex items-center gap-2">
                      <span className={cn('rounded-full border px-2.5 py-1 text-[11px] font-medium', sidePill(selected.side))}>
                        {selected.side}
                      </span>
                      <span className={cn('rounded-full border px-2.5 py-1 text-[11px] font-medium', statusPill(selected.status))}>
                        {selected.status}
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <MiniStat label="Timeframe" value={selected.timeframe} />
                    <MiniStat label="Size" value={fmt(selected.size, 4)} />
                    <MiniStat label="Entry" value={fmt(selected.entry, 6)} />
                    <MiniStat label="Exit" value={fmt(selected.exit_price, 6)} />
                    <MiniStat label="SL" value={fmt(selected.sl, 6)} />
                    <MiniStat label="TP" value={fmt(selected.tp, 6)} />
                    <MiniStat label="RR" value={fmt(selected.rr, 2)} />
                    <MiniStat label="Setup score" value={selected.setup_score !== undefined ? `${fmt(selected.setup_score, 0)}%` : '—'} />
                  </div>

                  <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                    <div className="text-xs font-medium text-white/70 mb-2">PnL</div>
                    <div className="flex items-baseline justify-between">
                      <div className={cn('text-2xl font-semibold', pnlColor(selected.pnl))}>
                        {fmt(selected.pnl, 2)}
                      </div>
                      <div className="text-sm text-white/65">
                        {selected.pnl_pct !== undefined ? fmtPct(selected.pnl_pct, 2) : '—'}
                      </div>
                    </div>
                  </div>

                  <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                    <div className="text-xs font-medium text-white/70 mb-2">Dates</div>
                    <div className="text-[12px] text-white/65 space-y-1">
                      <div>Opened: <span className="text-white/80">{fmtDate(selected.opened_at ?? selected.created_at)}</span></div>
                      <div>Closed: <span className="text-white/80">{fmtDate(selected.closed_at)}</span></div>
                      <div>Updated: <span className="text-white/80">{fmtDate(selected.updated_at)}</span></div>
                    </div>
                  </div>

                  <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                    <div className="text-xs font-medium text-white/70 mb-2">Tags</div>
                    <div className="flex flex-wrap gap-2">
                      {selected.tags?.length ? selected.tags.map((t) => (
                        <span key={t} className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/70">
                          {t}
                        </span>
                      )) : (
                        <div className="text-xs text-white/55">—</div>
                      )}
                    </div>
                  </div>

                  <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                    <div className="text-xs font-medium text-white/70 mb-2">Notes</div>
                    <div className="text-sm text-white/75 whitespace-pre-wrap leading-relaxed">
                      {selected.notes?.trim() ? selected.notes : '—'}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => openEdit(selected)}
                      className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10 transition"
                    >
                      Edit
                    </button>

                    {selected.status === 'OPEN' ? (
                      <button
                        onClick={() => openClose(selected)}
                        className="w-full rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200 hover:bg-emerald-500/15 transition"
                      >
                        Close
                      </button>
                    ) : (
                      <button
                        onClick={() => {
                          setError(null);
                          alert('La clôture n’est possible que pour les trades OPEN.');
                        }}
                        className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/40"
                        disabled
                      >
                        Close
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="text-sm text-white/60">Sélectionne une entrée dans la table.</div>
              )}
            </div>
          </motion.div>
        </div>

        {/* Modals */}
        <Modal
          open={createOpen}
          title="New trade"
          subtitle="Crée une entrée journal (OPEN)."
          onClose={() => setCreateOpen(false)}
          footer={(
            <div className="flex items-center gap-2">
              <button
                onClick={() => setCreateOpen(false)}
                className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10 transition"
              >
                Cancel
              </button>
              <button
                onClick={submitCreate}
                className="rounded-xl border border-white/10 bg-gradient-to-b from-[#E85D1A]/90 to-[#E85D1A]/40 px-4 py-2 text-sm font-medium text-white hover:from-[#E85D1A] hover:to-[#E85D1A]/50 transition"
              >
                Create
              </button>
            </div>
          )}
        >
          <EntryForm form={form} onChange={setForm} mode="create" />
        </Modal>

        <Modal
          open={editOpen}
          title="Edit trade"
          subtitle="Modifie SL/TP/notes/tags (et statut si besoin)."
          onClose={() => setEditOpen(false)}
          footer={(
            <div className="flex items-center gap-2">
              <button
                onClick={() => setEditOpen(false)}
                className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10 transition"
              >
                Cancel
              </button>
              <button
                onClick={submitEdit}
                className="rounded-xl border border-white/10 bg-gradient-to-b from-[#378ADD]/80 to-[#378ADD]/30 px-4 py-2 text-sm font-medium text-white hover:from-[#378ADD]/90 hover:to-[#378ADD]/35 transition"
              >
                Save
              </button>
            </div>
          )}
        >
          <EntryForm form={form} onChange={setForm} mode="edit" />
        </Modal>

        <Modal
          open={closeOpen}
          title="Close trade"
          subtitle={selected ? `${selected.symbol} · ${selected.timeframe} · ${selected.side}` : '—'}
          onClose={() => setCloseOpen(false)}
          footer={(
            <div className="flex items-center gap-2">
              <button
                onClick={() => setCloseOpen(false)}
                className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10 transition"
              >
                Cancel
              </button>
              <button
                onClick={submitClose}
                className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-200 hover:bg-emerald-500/15 transition"
              >
                Close trade
              </button>
            </div>
          )}
        >
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Exit price *">
              <input
                value={closeForm.exit_price}
                onChange={(e) => setCloseForm((p) => ({ ...p, exit_price: e.target.value }))}
                placeholder="ex: 65432.5"
                className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
              />
            </Field>

            <Field label="Closed at (option)">
              <input
                type="datetime-local"
                value={closeForm.closed_at}
                onChange={(e) => setCloseForm((p) => ({ ...p, closed_at: e.target.value }))}
                className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
              />
            </Field>

            <div className="md:col-span-2">
              <Field label="Notes (option)">
                <textarea
                  value={closeForm.notes}
                  onChange={(e) => setCloseForm((p) => ({ ...p, notes: e.target.value }))}
                  rows={4}
                  className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
                />
              </Field>
            </div>
          </div>
        </Modal>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Forms / payload builders
────────────────────────────────────────────────────────────── */

type CreateOrEditFormState = {
  id?: string;

  symbol: string;
  timeframe: Timeframe;
  side: TradeSide;

  entry: string;
  sl: string;
  tp: string;
  rr: string;
  size: string;

  setup_id: string;
  setup_score: string;

  opened_at: string; // datetime-local
  status: TradeStatus;

  notes: string;
  tags: string; // comma separated
};

type CloseFormState = {
  exit_price: string;
  closed_at: string; // datetime-local
  notes: string;
};

function defaultCreateForm(): CreateOrEditFormState {
  return {
    symbol: '',
    timeframe: 'H4',
    side: 'LONG',
    entry: '',
    sl: '',
    tp: '',
    rr: '',
    size: '',
    setup_id: '',
    setup_score: '',
    opened_at: '',
    status: 'OPEN',
    notes: '',
    tags: '',
  };
}

function fromEntryToForm(e: JournalEntryResponse): CreateOrEditFormState {
  return {
    id: e.id,
    symbol: e.symbol ?? '',
    timeframe: (e.timeframe as Timeframe) ?? 'H4',
    side: e.side ?? 'LONG',
    entry: e.entry !== undefined ? String(e.entry) : '',
    sl: e.sl !== undefined ? String(e.sl) : '',
    tp: e.tp !== undefined ? String(e.tp) : '',
    rr: e.rr !== undefined ? String(e.rr) : '',
    size: e.size !== undefined ? String(e.size) : '',
    setup_id: e.setup_id ?? '',
    setup_score: e.setup_score !== undefined ? String(e.setup_score) : '',
    opened_at: e.opened_at ? toDatetimeLocal(e.opened_at) : '',
    status: e.status ?? 'OPEN',
    notes: e.notes ?? '',
    tags: (e.tags ?? []).join(', '),
  };
}

function buildCreatePayload(form: CreateOrEditFormState) {
  const symbol = form.symbol.trim().toUpperCase();
  if (!symbol) {
    alert('Symbol requis.');
    return null;
  }

  const entry = Number(form.entry);
  if (!Number.isFinite(entry) || entry <= 0) {
    alert('Entry invalide.');
    return null;
  }

  const payload: any = {
    symbol,
    timeframe: form.timeframe,
    side: form.side,
    entry,
    notes: form.notes?.trim() || '',
    tags: parseTags(form.tags),
  };

  const sl = parseOptNumber(form.sl);
  const tp = parseOptNumber(form.tp);
  const rr = parseOptNumber(form.rr);
  const size = parseOptNumber(form.size);
  const setupScore = parseOptNumber(form.setup_score);

  if (sl !== undefined) payload.sl = sl;
  if (tp !== undefined) payload.tp = tp;
  if (rr !== undefined) payload.rr = rr;
  if (size !== undefined) payload.size = size;
  if (form.setup_id.trim()) payload.setup_id = form.setup_id.trim();
  if (setupScore !== undefined) payload.setup_score = setupScore;

  if (form.opened_at) {
    const iso = toISOFromDatetimeLocal(form.opened_at);
    if (iso) payload.opened_at = iso;
  }

  return payload;
}

function buildPatchPayload(form: CreateOrEditFormState) {
  // PATCH backend: { sl?, tp?, notes?, tags?, status? }
  const payload: any = {
    notes: form.notes?.trim() ?? '',
    tags: parseTags(form.tags),
    status: form.status,
  };

  const sl = parseOptNumber(form.sl);
  const tp = parseOptNumber(form.tp);

  // allow nulling? backend expects omitted to keep value. We'll omit if empty.
  if (sl !== undefined) payload.sl = sl;
  if (tp !== undefined) payload.tp = tp;

  return payload;
}

function parseOptNumber(v: string) {
  const s = (v ?? '').trim();
  if (!s) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

function parseTags(s: string) {
  return (s ?? '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean)
    .slice(0, 30);
}

function toDatetimeLocal(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const min = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

function toISOFromDatetimeLocal(dtLocal: string) {
  // dtLocal like "2026-04-05T14:30"
  const d = new Date(dtLocal);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/* ──────────────────────────────────────────────────────────────
   UI components
────────────────────────────────────────────────────────────── */

function Stat({ label, value, accent, className }: { label: string; value: string; accent?: boolean; className?: string }) {
  return (
    <div className={cn(
      'rounded-xl border border-white/10 bg-black/20 px-3 py-2',
      accent && 'bg-gradient-to-b from-white/10 to-black/20'
    )}>
      <div className="text-[11px] text-white/55">{label}</div>
      <div className={cn('text-sm font-semibold text-white/90', className)}>{value}</div>
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-xs text-white/60 mb-1">{label}</div>
      {children}
    </label>
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
            className="relative w-full max-w-2xl rounded-2xl border border-white/10 bg-[#0A0A0F]/70 backdrop-blur-[22px] shadow-[0_30px_100px_rgba(0,0,0,0.7)]"
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

function EntryForm({
  form,
  onChange,
  mode,
}: {
  form: CreateOrEditFormState;
  onChange: React.Dispatch<React.SetStateAction<CreateOrEditFormState>>;
  mode: 'create' | 'edit';
}) {
  const set = (patch: Partial<CreateOrEditFormState>) => onChange((p) => ({ ...p, ...patch }));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
        <div className="md:col-span-4">
          <Field label="Symbol *">
            <input
              value={form.symbol}
              onChange={(e) => set({ symbol: e.target.value })}
              placeholder="BTCUSDT"
              disabled={mode === 'edit'} // souvent on ne change pas le symbol en edit
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40 disabled:opacity-60"
            />
          </Field>
        </div>

        <div className="md:col-span-4">
          <Field label="Timeframe">
            <select
              value={form.timeframe}
              onChange={(e) => set({ timeframe: e.target.value as Timeframe })}
              disabled={mode === 'edit'}
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40 disabled:opacity-60"
            >
              {TIMEFRAMES.map(tf => <option key={tf} value={tf}>{tf}</option>)}
            </select>
          </Field>
        </div>

        <div className="md:col-span-4">
          <Field label="Side">
            <select
              value={form.side}
              onChange={(e) => set({ side: e.target.value as TradeSide })}
              disabled={mode === 'edit'}
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40 disabled:opacity-60"
            >
              <option value="LONG">LONG</option>
              <option value="SHORT">SHORT</option>
            </select>
          </Field>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
        <div className="md:col-span-3">
          <Field label="Entry *">
            <input
              value={form.entry}
              onChange={(e) => set({ entry: e.target.value })}
              placeholder="ex: 65000"
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
            />
          </Field>
        </div>

        <div className="md:col-span-3">
          <Field label="SL (option)">
            <input
              value={form.sl}
              onChange={(e) => set({ sl: e.target.value })}
              placeholder="ex: 64000"
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
            />
          </Field>
        </div>

        <div className="md:col-span-3">
          <Field label="TP (option)">
            <input
              value={form.tp}
              onChange={(e) => set({ tp: e.target.value })}
              placeholder="ex: 69000"
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
            />
          </Field>
        </div>

        <div className="md:col-span-3">
          <Field label="RR (option)">
            <input
              value={form.rr}
              onChange={(e) => set({ rr: e.target.value })}
              placeholder="ex: 2.5"
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
            />
          </Field>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
        <div className="md:col-span-4">
          <Field label="Size (option)">
            <input
              value={form.size}
              onChange={(e) => set({ size: e.target.value })}
              placeholder="ex: 0.1"
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
            />
          </Field>
        </div>

        <div className="md:col-span-4">
          <Field label="Opened at (option)">
            <input
              type="datetime-local"
              value={form.opened_at}
              onChange={(e) => set({ opened_at: e.target.value })}
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
            />
          </Field>
        </div>

        <div className="md:col-span-4">
          <Field label="Status (edit)">
            <select
              value={form.status}
              onChange={(e) => set({ status: e.target.value as TradeStatus })}
              disabled={mode === 'create'}
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40 disabled:opacity-60"
            >
              <option value="OPEN">OPEN</option>
              <option value="CLOSED">CLOSED</option>
              <option value="CANCELLED">CANCELLED</option>
            </select>
          </Field>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
        <div className="md:col-span-6">
          <Field label="Setup id (option)">
            <input
              value={form.setup_id}
              onChange={(e) => set({ setup_id: e.target.value })}
              placeholder="uuid / setup ref"
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
            />
          </Field>
        </div>

        <div className="md:col-span-6">
          <Field label="Setup score (option)">
            <input
              value={form.setup_score}
              onChange={(e) => set({ setup_score: e.target.value })}
              placeholder="ex: 78"
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
            />
          </Field>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
        <div className="md:col-span-6">
          <Field label="Tags (comma separated)">
            <input
              value={form.tags}
              onChange={(e) => set({ tags: e.target.value })}
              placeholder="supply, break, retest…"
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
            />
          </Field>
          <div className="text-[11px] text-white/50 mt-1">
            Exemple: <span className="text-white/70">ftb, flippy, news, revenge</span>
          </div>
        </div>

        <div className="md:col-span-6">
          <Field label="Notes">
            <textarea
              value={form.notes}
              onChange={(e) => set({ notes: e.target.value })}
              rows={5}
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
            />
          </Field>
        </div>
      </div>
    </div>
  );
}