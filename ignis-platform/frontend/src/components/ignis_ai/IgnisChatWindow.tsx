/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

type Role = 'system' | 'user' | 'assistant';

export type ChatMessage = {
  role: Role;
  content: string;
  createdAt?: string; // ISO
};

type AIStatusResponse = {
  ollama_online: boolean;
  model: string;
  host: string;
  version?: string;
  models_available?: any;
};

type AIModelsResponse = {
  models: { name: string; size?: number; modified_at?: string }[];
};

type AIChatResponse = {
  response: string;
  model: string;
  symbol: string;
  timeframe: string;
  tokens_used?: number;
};

type ReportResponse = {
  symbol: string;
  timeframe: string;
  report: string;
  summary?: string;
  setup_status?: string;
  score?: number;
  generated_at?: string;
  model?: string;
};

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:8000/api/v1';

function cn(...classes: Array<string | undefined | null | false>) {
  return classes.filter(Boolean).join(' ');
}

function fmtDate(iso?: string) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('fr-FR', { hour12: false });
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

function pillOnline(ok: boolean) {
  return ok
    ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200'
    : 'border-rose-500/20 bg-rose-500/10 text-rose-200';
}

function rolePill(role: Role) {
  if (role === 'assistant') return 'border-sky-500/20 bg-sky-500/10 text-sky-200';
  if (role === 'system') return 'border-zinc-500/20 bg-zinc-500/10 text-zinc-200';
  return 'border-[#E85D1A]/25 bg-[#E85D1A]/10 text-orange-200';
}

function roleBubble(role: Role) {
  if (role === 'assistant') return 'border-white/10 bg-white/5';
  if (role === 'system') return 'border-white/10 bg-black/25';
  return 'border-white/10 bg-black/35';
}

function defaultSystemPrompt(lang: 'fr' | 'en') {
  return lang === 'fr'
    ? `Tu es IGNIS AI, assistant de trading spécialisé Supply & Demand (S&D).
Réponds en français, clair, structuré (bullet points), et actionnable.
Si une info manque, pose une question courte au lieu d’inventer.`
    : `You are IGNIS AI, a Supply & Demand (S&D) trading assistant.
Answer in English, clear and actionable. If something is missing, ask a short question instead of guessing.`;
}

/**
 * Parse SSE streamed from a POST fetch.
 * Supports:
 * - data: some text token
 * - data: {"token":"..."} / {"content":"..."} / {"delta":"..."} / {"response":"..."}
 * - data: [DONE]
 */
async function readSSEStream(
  res: Response,
  onToken: (token: string) => void,
  onEvent?: (evt: { raw: string; data: string }) => void
) {
  if (!res.body) throw new Error('Streaming non supporté (Response.body null).');

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');

  let buffer = '';
  let done = false;

  while (!done) {
    const chunk = await reader.read();
    done = chunk.done;
    const text = decoder.decode(chunk.value ?? new Uint8Array(), { stream: !done });
    buffer += text;

    // SSE events are separated by double newlines
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';

    for (const part of parts) {
      const lines = part.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;

        const data = trimmed.replace(/^data:\s?/, '');
        onEvent?.({ raw: part, data });

        if (data === '[DONE]') return;

        // try json
        const t = tryExtractToken(data);
        if (t) onToken(t);
      }
    }
  }
}

function tryExtractToken(data: string): string | null {
  const s = data ?? '';
  if (!s.trim()) return null;

  // most backends stream raw text tokens
  if (!s.trim().startsWith('{') && !s.trim().startsWith('[')) return s;

  try {
    const obj = JSON.parse(s);

    // common shapes
    if (typeof obj === 'string') return obj;

    if (obj?.token && typeof obj.token === 'string') return obj.token;
    if (obj?.delta && typeof obj.delta === 'string') return obj.delta;
    if (obj?.content && typeof obj.content === 'string') return obj.content;
    if (obj?.response && typeof obj.response === 'string') return obj.response;

    // sometimes: { choices:[{delta:{content:""}}] }
    const c = obj?.choices?.[0]?.delta?.content;
    if (typeof c === 'string') return c;

    // fallback: try a "text" field
    if (obj?.text && typeof obj.text === 'string') return obj.text;

    return null;
  } catch {
    // if json parse fails, treat as raw token
    return s;
  }
}

export default function IgnisChatWindow({
  symbol = 'BTCUSDT',
  timeframe = 'H4',
  higherTf,

  title = 'IGNIS AI',
  subtitle = 'Chat Ollama (streaming SSE) + tools',

  persistKey = 'ignis_chat_v1',
  language = 'fr',

  defaultModel,
  defaultTemperature = 0.35,
  defaultStream = true,

  showReportTools = true,
  className,
}: {
  symbol?: string;
  timeframe?: string;
  higherTf?: string;

  title?: string;
  subtitle?: string;

  /** LocalStorage persistence key */
  persistKey?: string;

  language?: 'fr' | 'en';

  defaultModel?: string;
  defaultTemperature?: number;
  defaultStream?: boolean;

  showReportTools?: boolean;
  className?: string;
}) {
  const [status, setStatus] = useState<AIStatusResponse | null>(null);
  const [models, setModels] = useState<AIModelsResponse | null>(null);

  const [selectedModel, setSelectedModel] = useState<string>(defaultModel ?? '');
  const [temperature, setTemperature] = useState<number>(defaultTemperature);
  const [stream, setStream] = useState<boolean>(defaultStream);

  const [systemPrompt, setSystemPrompt] = useState<string>(defaultSystemPrompt(language));
  const [includeSystem, setIncludeSystem] = useState<boolean>(true);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState<string>('');

  const [sending, setSending] = useState<boolean>(false);
  const [streaming, setStreaming] = useState<boolean>(false);

  const [error, setError] = useState<string | null>(null);
  const [tokensUsed, setTokensUsed] = useState<number | null>(null);

  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [showRawSSE, setShowRawSSE] = useState<boolean>(false);
  const [sseLog, setSseLog] = useState<Array<{ at: string; data: string }>>([]);

  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const effectiveSymbol = (symbol ?? '').trim().toUpperCase() || 'BTCUSDT';
  const effectiveTf = (timeframe ?? '').trim() || 'H4';

  const ollamaOnline = !!status?.ollama_online;

  const requestPayloadMessages = useMemo(() => {
    const base = messages.map((m) => ({ role: m.role, content: m.content }));
    if (!includeSystem) return base;

    // Ensure a system prompt at the top (but do not duplicate if already there)
    const hasSystem = base.length > 0 && base[0].role === 'system';
    if (hasSystem) {
      // replace first system prompt by the current systemPrompt (keeps chat consistent)
      const cloned = [...base];
      cloned[0] = { role: 'system', content: systemPrompt };
      return cloned;
    }
    return [{ role: 'system', content: systemPrompt }, ...base];
  }, [messages, includeSystem, systemPrompt]);

  const canSend = useMemo(() => {
    if (sending || streaming) return false;
    if (!ollamaOnline && status) return false; // if we know it's offline
    return !!input.trim();
  }, [sending, streaming, input, ollamaOnline, status]);

  const scrollToBottom = useCallback((mode: ScrollBehavior = 'smooth') => {
    if (!listRef.current) return;
    listRef.current.scrollTo({ top: listRef.current.scrollHeight, behavior: mode });
  }, []);

  useEffect(() => {
    if (!autoScroll) return;
    scrollToBottom('smooth');
  }, [messages, autoScroll, scrollToBottom]);

  /* ──────────────────────────────────────────────────────────────
     Persistence
  ─────────────────────────────────────────────────────────────── */

  useEffect(() => {
    try {
      const raw = localStorage.getItem(persistKey);
      if (!raw) return;

      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.messages)) setMessages(parsed.messages);
      if (typeof parsed?.selectedModel === 'string') setSelectedModel(parsed.selectedModel);
      if (typeof parsed?.temperature === 'number') setTemperature(parsed.temperature);
      if (typeof parsed?.stream === 'boolean') setStream(parsed.stream);
      if (typeof parsed?.systemPrompt === 'string') setSystemPrompt(parsed.systemPrompt);
      if (typeof parsed?.includeSystem === 'boolean') setIncludeSystem(parsed.includeSystem);
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const id = setTimeout(() => {
      try {
        localStorage.setItem(
          persistKey,
          JSON.stringify({
            messages,
            selectedModel,
            temperature,
            stream,
            systemPrompt,
            includeSystem,
          })
        );
      } catch {
        // ignore
      }
    }, 250);

    return () => clearTimeout(id);
  }, [messages, selectedModel, temperature, stream, systemPrompt, includeSystem, persistKey]);

  /* ──────────────────────────────────────────────────────────────
     Load AI status & models
  ─────────────────────────────────────────────────────────────── */

  const refreshAI = useCallback(async () => {
    setError(null);
    try {
      const [sRes, mRes] = await Promise.all([
        fetch(`${API_BASE}/ai/status`, { method: 'GET' }),
        fetch(`${API_BASE}/ai/models`, { method: 'GET' }),
      ]);

      if (sRes.ok) {
        const st = (await sRes.json()) as AIStatusResponse;
        setStatus(st);

        // set default model (if empty)
        setSelectedModel((prev) => prev || defaultModel || st.model || '');
      } else {
        setStatus(null);
      }

      if (mRes.ok) {
        const mo = (await mRes.json()) as AIModelsResponse;
        setModels(mo);

        setSelectedModel((prev) => {
          if (prev) return prev;
          const fromStatus = defaultModel || status?.model;
          return fromStatus || mo.models?.[0]?.name || '';
        });
      } else {
        setModels(null);
      }
    } catch (e: any) {
      setError(e?.message ?? 'Erreur IA status/models');
    }
  }, [defaultModel, status?.model]);

  useEffect(() => {
    refreshAI();
  }, [refreshAI]);

  /* ──────────────────────────────────────────────────────────────
     Send message (HTTP or streaming SSE)
  ─────────────────────────────────────────────────────────────── */

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    setSending(false);
  }, []);

  const send = useCallback(async () => {
    setError(null);
    setTokensUsed(null);
    setSseLog([]);

    const text = input.trim();
    if (!text) return;

    const userMsg: ChatMessage = { role: 'user', content: text, createdAt: new Date().toISOString() };
    setInput('');

    // push user message
    setMessages((prev) => [...prev, userMsg]);

    // placeholder assistant message
    const assistantId = crypto.randomUUID?.() ?? String(Date.now());
    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, assistantMsg]);

    const controller = new AbortController();
    abortRef.current = controller;

    const body = {
      symbol: effectiveSymbol,
      timeframe: effectiveTf,
      messages: [...requestPayloadMessages, { role: 'user', content: text }],
      model: selectedModel || undefined,
      temperature,
      stream,
    };

    try {
      if (!stream) {
        setSending(true);

        const res = await fetch(`${API_BASE}/ai/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!res.ok) {
          const t = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status} — ${t || 'Erreur /ai/chat'}`);
        }

        const data = (await res.json()) as AIChatResponse;

        setMessages((prev) => {
          const next = [...prev];
          const idx = findLastAssistantIndex(next);
          if (idx !== -1) next[idx] = { ...next[idx], content: data.response ?? '' };
          return next;
        });

        setTokensUsed(typeof data.tokens_used === 'number' ? data.tokens_used : null);
        setSelectedModel((prev) => prev || data.model || '');
      } else {
        setStreaming(true);

        const res = await fetch(`${API_BASE}/ai/chat/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, stream: true }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const t = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status} — ${t || 'Erreur /ai/chat/stream'}`);
        }

        let acc = '';
        await readSSEStream(
          res,
          (token) => {
            acc += token;

            setMessages((prev) => {
              const next = [...prev];
              const idx = findLastAssistantIndex(next);
              if (idx !== -1) next[idx] = { ...next[idx], content: acc };
              return next;
            });
          },
          showRawSSE
            ? (evt) => {
                setSseLog((prev) => {
                  const next = [{ at: new Date().toISOString(), data: evt.data }, ...prev];
                  return next.slice(0, 80);
                });
              }
            : undefined
        );
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        setError('Streaming interrompu.');
      } else {
        setError(e?.message ?? 'Erreur inconnue');
      }

      // If assistant placeholder is empty, remove it (avoid blank bubble)
      setMessages((prev) => {
        const next = [...prev];
        const idx = findLastAssistantIndex(next);
        if (idx !== -1 && !next[idx].content.trim()) next.splice(idx, 1);
        return next;
      });
    } finally {
      abortRef.current = null;
      setSending(false);
      setStreaming(false);
    }
  }, [
    input,
    effectiveSymbol,
    effectiveTf,
    requestPayloadMessages,
    selectedModel,
    temperature,
    stream,
    showRawSSE,
  ]);

  const quickPrompt = useCallback((p: string) => {
    setInput((prev) => (prev ? `${prev}\n\n${p}` : p));
  }, []);

  const clearChat = useCallback(() => {
    const ok = confirm('Vider la conversation ?');
    if (!ok) return;
    stop();
    setMessages([]);
    setTokensUsed(null);
    setError(null);
    setSseLog([]);
  }, [stop]);

  const exportChat = useCallback(() => {
    const payload = {
      symbol: effectiveSymbol,
      timeframe: effectiveTf,
      model: selectedModel || status?.model,
      temperature,
      stream,
      messages,
      exported_at: new Date().toISOString(),
    };
    copyToClipboard(JSON.stringify(payload, null, 2));
  }, [effectiveSymbol, effectiveTf, selectedModel, status?.model, temperature, stream, messages]);

  const generateReport = useCallback(async () => {
    setError(null);
    try {
      setSending(true);

      const res = await fetch(`${API_BASE}/ai/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: effectiveSymbol,
          timeframe: effectiveTf,
          higher_tf: higherTf || undefined,
          force_analysis: false,
          report_type: 'full',
          language,
        }),
      });

      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${t || 'Erreur /ai/report'}`);
      }

      const data = (await res.json()) as ReportResponse;

      const content =
        `# Rapport IGNIS AI\n` +
        `Symbol: ${data.symbol} · TF: ${data.timeframe}\n` +
        (data.model ? `Model: ${data.model}\n` : '') +
        (data.generated_at ? `Generated: ${fmtDate(data.generated_at)}\n` : '') +
        (data.score !== undefined ? `Score: ${data.score}\n` : '') +
        (data.setup_status ? `Setup: ${data.setup_status}\n` : '') +
        `\n---\n\n` +
        (data.report ?? '');

      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content, createdAt: new Date().toISOString() },
      ]);
    } catch (e: any) {
      setError(e?.message ?? 'Erreur report');
    } finally {
      setSending(false);
    }
  }, [effectiveSymbol, effectiveTf, higherTf, language]);

  /* ──────────────────────────────────────────────────────────────
     Keyboard: Enter send / Shift+Enter newline
  ─────────────────────────────────────────────────────────────── */

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (canSend) send();
      }
    },
    [canSend, send]
  );

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
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="text-base font-semibold text-white/90">{title}</div>

              <span className={cn('rounded-full border px-2.5 py-1 text-[11px] font-medium', pillOnline(!!status?.ollama_online))}>
                {status ? (status.ollama_online ? 'Ollama online' : 'Ollama offline') : 'Status —'}
              </span>

              <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/70">
                {effectiveSymbol} · {effectiveTf}
              </span>

              {tokensUsed !== null && (
                <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/70">
                  tokens {tokensUsed}
                </span>
              )}

              {(sending || streaming) && (
                <span className="rounded-full border border-sky-500/20 bg-sky-500/10 px-2.5 py-1 text-[11px] text-sky-200">
                  {streaming ? 'streaming…' : 'sending…'}
                </span>
              )}
            </div>

            <div className="text-xs text-white/60 mt-1 truncate">{subtitle}</div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={refreshAI}
              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition"
            >
              Refresh
            </button>

            <button
              onClick={clearChat}
              className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200 hover:bg-rose-500/15 transition"
            >
              Clear
            </button>

            <button
              onClick={exportChat}
              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition"
              title="Copy full chat JSON"
            >
              Copy JSON
            </button>

            <button
              onClick={stop}
              disabled={!streaming && !sending}
              className={cn(
                'rounded-xl border px-3 py-2 text-xs font-medium transition',
                streaming || sending
                  ? 'border-amber-500/25 bg-amber-500/10 text-amber-200 hover:bg-amber-500/15'
                  : 'border-white/10 bg-white/5 text-white/40'
              )}
            >
              Stop
            </button>
          </div>
        </div>

        {/* Controls */}
        <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <label className="block text-xs text-white/60 mb-1">Model</label>
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
            >
              <option value="">(default backend)</option>
              {(models?.models ?? []).map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                </option>
              ))}
            </select>
            <div className="text-[11px] text-white/45 mt-1">
              backend default: <span className="text-white/70">{status?.model ?? '—'}</span>
              <span className="mx-2 text-white/20">·</span>
              host: <span className="text-white/70">{status?.host ?? '—'}</span>
            </div>
          </div>

          <div className="lg:col-span-4">
            <label className="block text-xs text-white/60 mb-1">
              Temperature <span className="text-white/40">({temperature.toFixed(2)})</span>
            </label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={temperature}
              onChange={(e) => setTemperature(Number(e.target.value))}
              className="w-full"
            />
            <div className="text-[11px] text-white/45 mt-1">
              Bas = plus strict. Haut = plus créatif.
            </div>
          </div>

          <div className="lg:col-span-4 flex flex-wrap items-end justify-end gap-2">
            <Toggle label="Streaming" value={stream} onChange={setStream} />
            <Toggle label="Auto-scroll" value={autoScroll} onChange={setAutoScroll} />
            <Toggle label="System prompt" value={includeSystem} onChange={setIncludeSystem} />
            <Toggle label="Raw SSE" value={showRawSSE} onChange={setShowRawSSE} />
          </div>
        </div>

        {/* System prompt editor */}
        {includeSystem && (
          <div className="mt-3">
            <details className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <summary className="cursor-pointer text-xs text-white/70 hover:text-white/85 transition">
                System prompt (editable)
              </summary>
              <div className="mt-3">
                <textarea
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  rows={5}
                  className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white/85 outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
                />
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    onClick={() => setSystemPrompt(defaultSystemPrompt(language))}
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition"
                  >
                    Reset default
                  </button>
                  <button
                    onClick={() => copyToClipboard(systemPrompt)}
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition"
                  >
                    Copy prompt
                  </button>
                </div>
              </div>
            </details>
          </div>
        )}

        {/* Tools */}
        {showReportTools && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <QuickChip onClick={() => quickPrompt(`Fais un résumé S&D pour ${effectiveSymbol} ${effectiveTf}.`)}>Résumé</QuickChip>
            <QuickChip onClick={() => quickPrompt(`Donne un plan de trade (conditions d'entrée, invalidation, TP/SL) pour ${effectiveSymbol} ${effectiveTf}.`)}>Plan trade</QuickChip>
            <QuickChip onClick={() => quickPrompt(`Liste les confluences: zone, base, structure, PA, DP/KL et les risques.`)}>Confluences</QuickChip>
            <QuickChip onClick={() => quickPrompt(`Quelles confirmations attendre si setup PENDING ?`)}>Pending → Confirm</QuickChip>
            <QuickChip onClick={() => quickPrompt(`Donne 3 scénarios: bullish / bearish / neutral avec triggers.`)}>Scénarios</QuickChip>

            <span className="mx-1 text-white/20">·</span>

            <button
              onClick={generateReport}
              disabled={sending || streaming}
              className={cn(
                'rounded-xl border px-3 py-2 text-xs font-medium transition',
                sending || streaming
                  ? 'border-white/10 bg-white/5 text-white/40'
                  : 'border-[#378ADD]/25 bg-[#378ADD]/10 text-sky-200 hover:bg-[#378ADD]/15'
              )}
              title="Appelle /ai/report et insère le rapport dans le chat"
            >
              Generate report
            </button>
          </div>
        )}

        {error && (
          <div className="mt-3 rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            {error}
          </div>
        )}
      </div>

      {/* Messages */}
      <div
        ref={listRef}
        className="max-h-[620px] overflow-auto px-5 py-4 space-y-3"
      >
        {messages.length === 0 && (
          <div className="rounded-2xl border border-white/10 bg-black/20 p-5">
            <div className="text-sm text-white/80">
              Démarre une conversation. (Enter = envoyer, Shift+Enter = nouvelle ligne)
            </div>
            <div className="text-xs text-white/55 mt-1">
              Astuce: utilise les “quick chips” pour générer des prompts propres.
            </div>
          </div>
        )}

        <AnimatePresence initial={false}>
          {messages.map((m, idx) => (
            <motion.div
              key={`${m.role}-${m.createdAt ?? idx}-${idx}`}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className={cn('rounded-2xl border p-4', roleBubble(m.role))}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={cn('rounded-full border px-2.5 py-1 text-[11px] font-medium', rolePill(m.role))}>
                      {m.role.toUpperCase()}
                    </span>
                    <span className="text-[11px] text-white/50">
                      {m.createdAt ? fmtDate(m.createdAt) : '—'}
                    </span>
                  </div>

                  <div className="mt-3 text-sm text-white/85 whitespace-pre-wrap leading-relaxed">
                    {m.content || (m.role === 'assistant' && (sending || streaming) ? '…' : '')}
                  </div>
                </div>

                <div className="flex flex-col items-end gap-2">
                  <button
                    onClick={() => copyToClipboard(m.content)}
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition"
                  >
                    Copy
                  </button>

                  {idx > 0 && (
                    <button
                      onClick={() => {
                        // quote message into input
                        const quote = m.content.trim();
                        setInput((prev) => (prev ? `${prev}\n\n> ${quote}` : `> ${quote}`));
                      }}
                      className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition"
                      title="Insérer en citation"
                    >
                      Quote
                    </button>
                  )}
                </div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {showRawSSE && sseLog.length > 0 && (
          <details className="rounded-2xl border border-white/10 bg-black/20 p-4">
            <summary className="cursor-pointer text-xs text-white/70 hover:text-white/85 transition">
              SSE debug log ({sseLog.length})
            </summary>
            <div className="mt-3 space-y-2 max-h-[320px] overflow-auto pr-1">
              {sseLog.map((x, i) => (
                <div key={i} className="rounded-xl border border-white/10 bg-black/30 p-3">
                  <div className="text-[11px] text-white/50">{fmtDate(x.at)}</div>
                  <div className="mt-1 text-xs text-white/75 whitespace-pre-wrap">{x.data}</div>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-white/10 bg-black/15 px-5 py-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
          <div className="md:col-span-10">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={3}
              placeholder={`Message à IGNIS AI… (context: ${effectiveSymbol} ${effectiveTf})`}
              className="w-full rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-white/90 outline-none focus:ring-2 focus:ring-[#E85D1A]/40"
            />
            <div className="mt-2 flex items-center justify-between text-[11px] text-white/50">
              <div>
                Enter = send · Shift+Enter = newline
                <span className="mx-2 text-white/20">·</span>
                stream: <span className="text-white/70">{stream ? 'on' : 'off'}</span>
              </div>
              <div>
                {input.length} chars
              </div>
            </div>
          </div>

          <div className="md:col-span-2 flex flex-col gap-2">
            <button
              onClick={send}
              disabled={!canSend}
              className={cn(
                'rounded-2xl border px-4 py-3 text-sm font-semibold transition',
                canSend
                  ? 'border-white/10 bg-gradient-to-b from-[#E85D1A]/90 to-[#E85D1A]/40 text-white hover:from-[#E85D1A] hover:to-[#E85D1A]/50'
                  : 'border-white/10 bg-white/5 text-white/40'
              )}
            >
              Send
            </button>

            <button
              onClick={() => scrollToBottom('smooth')}
              className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/80 hover:bg-white/10 transition"
            >
              Bottom
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Small UI
────────────────────────────────────────────────────────────── */

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
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
    >
      <div className="text-xs font-medium text-white/85">{label}</div>
      <div className={cn('h-6 w-11 rounded-full border p-1 transition', value ? 'border-[#E85D1A]/40 bg-[#E85D1A]/25' : 'border-white/10 bg-white/5')}>
        <div className={cn('h-4 w-4 rounded-full bg-white transition', value ? 'translate-x-5' : 'translate-x-0')} />
      </div>
    </button>
  );
}

function QuickChip({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/75 hover:bg-white/10 transition"
      type="button"
    >
      {children}
    </button>
  );
}

function findLastAssistantIndex(arr: ChatMessage[]) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].role === 'assistant') return i;
  }
  return -1;
}