/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * src/lib/utils.ts
 * Utils frontend IGNIS (format, time, math, css, clipboard, debounce, etc.)
 * - Pure helpers (no React)
 * - Dark glass friendly
 */

export function cn(...classes: Array<string | undefined | null | false>) {
  return classes.filter(Boolean).join(' ');
}

/* ──────────────────────────────────────────────────────────────
   Numbers / formatting
────────────────────────────────────────────────────────────── */

export function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export function isFiniteNumber(n: any): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

export function toNumber(v: any, fallback?: number) {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function fmt(n: number | undefined | null, digits = 2) {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits }).format(n);
}

export function fmtInt(n: number | undefined | null) {
  return fmt(n, 0);
}

export function fmtPct(n: number | undefined | null, digits = 1) {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  const v = n <= 1 ? n * 100 : n; // support 0..1 or 0..100
  return `${fmt(v, digits)}%`;
}

export function fmtCompact(n: number | undefined | null, digits = 2) {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('fr-FR', {
    notation: 'compact',
    maximumFractionDigits: digits,
  }).format(n);
}

/* ──────────────────────────────────────────────────────────────
   Time helpers (backend uses seconds or ms)
────────────────────────────────────────────────────────────── */

export function isSeconds(ts: number) {
  return ts < 10_000_000_000;
}

export function toMs(ts: number) {
  return isSeconds(ts) ? ts * 1000 : ts;
}

export function toSeconds(ts: number) {
  return isSeconds(ts) ? Math.floor(ts) : Math.floor(ts / 1000);
}

export function fmtDate(iso?: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('fr-FR', { hour12: false });
}

export function fmtTs(ts?: number | string | null) {
  if (ts === undefined || ts === null) return '—';
  if (typeof ts === 'string') {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? ts : d.toLocaleString('fr-FR', { hour12: false });
  }
  return new Date(toMs(ts)).toLocaleString('fr-FR', { hour12: false });
}

export function timeAgoFromIso(iso?: string | null) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return timeAgo(Date.now() - t);
}

export function timeAgo(diffMs: number) {
  const ms = Math.max(0, diffMs);
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

/* ──────────────────────────────────────────────────────────────
   Colors
────────────────────────────────────────────────────────────── */

export function hexToRgba(hex: string, a: number) {
  const h = (hex ?? '').replace('#', '').trim();
  if (h.length !== 6) return `rgba(255,255,255,${a})`;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

export function scoreToGradient(score: number) {
  const s = clamp(score ?? 0, 0, 100);
  if (s >= 85) return 'from-emerald-400/60 to-emerald-700/10';
  if (s >= 70) return 'from-orange-400/60 to-orange-700/10';
  if (s >= 55) return 'from-amber-400/60 to-amber-700/10';
  return 'from-rose-400/60 to-rose-700/10';
}

/* ──────────────────────────────────────────────────────────────
   Arrays / objects
────────────────────────────────────────────────────────────── */

export function uniq<T>(arr: T[]) {
  return Array.from(new Set(arr));
}

export function groupBy<T, K extends string | number | symbol>(
  arr: T[],
  keyFn: (x: T) => K
): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const x of arr) {
    const k = String(keyFn(x));
    if (!out[k]) out[k] = [];
    out[k].push(x);
  }
  return out;
}

export function safeJsonParse<T = any>(s: string): { ok: true; value: T } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(s) as T };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Invalid JSON' };
  }
}

/* ──────────────────────────────────────────────────────────────
   Clipboard / download
────────────────────────────────────────────────────────────── */

export async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // fallback
    const el = document.createElement('textarea');
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
  }
}

export function downloadText(filename: string, content: string, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ──────────────────────────────────────────────────────────────
   Debounce / throttle
────────────────────────────────────────────────────────────── */

export function debounce<T extends (...args: any[]) => void>(fn: T, waitMs: number) {
  let t: any = null;
  return (...args: Parameters<T>) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), waitMs);
  };
}

export function throttle<T extends (...args: any[]) => void>(fn: T, waitMs: number) {
  let last = 0;
  let t: any = null;

  return (...args: Parameters<T>) => {
    const now = Date.now();
    const remaining = waitMs - (now - last);

    if (remaining <= 0) {
      last = now;
      fn(...args);
      return;
    }

    if (t) return;
    t = setTimeout(() => {
      t = null;
      last = Date.now();
      fn(...args);
    }, remaining);
  };
}

/* ──────────────────────────────────────────────────────────────
   URL helpers
────────────────────────────────────────────────────────────── */

export function qs(params: Record<string, any> = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      if (!v.length) continue;
      sp.set(k, v.join(','));
      continue;
    }
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/* ──────────────────────────────────────────────────────────────
   Trading helpers
────────────────────────────────────────────────────────────── */

export function zoneDistanceToPrice(zoneTop: number, zoneBot: number, price: number) {
  const hi = Math.max(zoneTop, zoneBot);
  const lo = Math.min(zoneTop, zoneBot);
  if (price >= lo && price <= hi) return 0;
  return Math.min(Math.abs(price - lo), Math.abs(price - hi));
}

export function rrFromPrices(entry: number, sl: number, tp: number) {
  // RR = reward / risk (absolute)
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  if (!risk || !Number.isFinite(risk)) return null;
  return reward / risk;
}