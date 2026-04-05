/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/* ──────────────────────────────────────────────────────────────
   Types
────────────────────────────────────────────────────────────── */

export type Role = 'system' | 'user' | 'assistant';

export type ChatMessage = {
  role: Role;
  content: string;
};

export type AIStatusResponse = {
  ollama_online: boolean;
  model: string;
  host: string;
  version?: string;
  models_available?: any;
};

export type AIModelsResponse = {
  models: { name: string; size?: number; modified_at?: string }[];
};

export type AIChatRequest = {
  symbol: string;
  timeframe: string;
  messages: ChatMessage[];

  model?: string;
  temperature?: number;

  /** backend supports stream=false on /ai/chat */
  stream?: boolean;
};

export type AIChatResponse = {
  response: string;
  model: string;
  symbol: string;
  timeframe: string;
  tokens_used?: number;
};

export type AIReportRequest = {
  symbol: string;
  timeframe: string;
  higher_tf?: string;
  force_analysis?: boolean;
  report_type?: 'full' | 'short' | string;
  language?: 'fr' | 'en' | string;
};

export type AIReportResponse = {
  symbol: string;
  timeframe: string;
  report: string;
  summary?: string;
  setup_status?: string;
  score?: number;
  generated_at?: string;
  model?: string;
};

export type AISummarizeRequest = {
  symbol: string;
  timeframe: string;
  max_words?: number;
};

export type AISummarizeResponse = {
  symbol: string;
  timeframe: string;
  summary: string;
  generated_at?: string;
};

export type UseIgnisAIOptions = {
  apiBase?: string;

  /** auto-load status/models on mount */
  auto?: boolean;

  /** defaults used by helpers if not provided per call */
  defaultSymbol?: string;
  defaultTimeframe?: string;

  defaultModel?: string;
  defaultTemperature?: number;

  /** persistence (optional) */
  persistKey?: string; // only for preferences: model/temp

  /** network */
  statusRefreshMs?: number; // 0 disables polling
  requestTimeoutMs?: number; // for non-stream requests
};

export type UseIgnisAIReturn = {
  // state
  status: AIStatusResponse | null;
  models: AIModelsResponse | null;

  loadingStatus: boolean;
  loadingModels: boolean;

  chatLoading: boolean;
  streamLoading: boolean;
  reportLoading: boolean;
  summarizeLoading: boolean;

  error: string | null;

  // preferences
  model: string;
  setModel: (m: string) => void;
  temperature: number;
  setTemperature: (t: number) => void;

  ollamaOnline: boolean;

  // actions
  refreshStatus: () => Promise<AIStatusResponse | null>;
  refreshModels: () => Promise<AIModelsResponse | null>;
  refreshAll: () => Promise<void>;

  /** non-stream chat */
  chat: (req: Partial<AIChatRequest>) => Promise<AIChatResponse | null>;

  /**
   * SSE streaming chat:
   * - calls /ai/chat/stream
   * - onToken called for each token/chunk
   * - resolves with full text
   */
  chatStream: (params: {
    req: Partial<AIChatRequest>;
    onToken?: (token: string) => void;
    onEvent?: (evt: { raw: string; data: string }) => void;
  }) => Promise<{ fullText: string } | null>;

  /** stop the current in-flight request (streaming or non-stream) */
  abort: () => void;

  report: (req: Partial<AIReportRequest>) => Promise<AIReportResponse | null>;
  summarize: (req: Partial<AISummarizeRequest>) => Promise<AISummarizeResponse | null>;
};

/* ──────────────────────────────────────────────────────────────
   Defaults / helpers
────────────────────────────────────────────────────────────── */

const API_BASE_DEFAULT =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:8000/api/v1';

function normSymbol(s?: string) {
  return (s ?? '').trim().toUpperCase();
}

function withTimeout<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  if (!ms || ms <= 0) return p;

  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout ${ms}ms`)), ms);

    const cleanup = () => clearTimeout(t);

    if (signal) {
      if (signal.aborted) {
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      const onAbort = () => {
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      p.then((v) => {
        cleanup();
        resolve(v);
      }).catch((e) => {
        cleanup();
        reject(e);
      });
    } else {
      p.then((v) => {
        cleanup();
        resolve(v);
      }).catch((e) => {
        cleanup();
        reject(e);
      });
    }
  });
}

/**
 * Parse SSE streamed from a fetch Response.
 * Supports:
 * - data: raw text chunks
 * - data: JSON {token|delta|content|response|text}
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

    // SSE events split by blank line
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

        const tok = tryExtractToken(data);
        if (tok) onToken(tok);
      }
    }
  }
}

function tryExtractToken(data: string): string | null {
  const s = data ?? '';
  if (!s.trim()) return null;

  // most implementations stream raw text
  if (!s.trim().startsWith('{') && !s.trim().startsWith('[')) return s;

  try {
    const obj = JSON.parse(s);

    if (typeof obj === 'string') return obj;
    if (obj?.token && typeof obj.token === 'string') return obj.token;
    if (obj?.delta && typeof obj.delta === 'string') return obj.delta;
    if (obj?.content && typeof obj.content === 'string') return obj.content;
    if (obj?.response && typeof obj.response === 'string') return obj.response;
    if (obj?.text && typeof obj.text === 'string') return obj.text;

    const c = obj?.choices?.[0]?.delta?.content;
    if (typeof c === 'string') return c;

    return null;
  } catch {
    // fallback: treat as raw
    return s;
  }
}

/* ──────────────────────────────────────────────────────────────
   Hook
────────────────────────────────────────────────────────────── */

export function useignisai(options: UseIgnisAIOptions = {}): UseIgnisAIReturn {
  const {
    apiBase = API_BASE_DEFAULT,
    auto = true,

    defaultSymbol = 'BTCUSDT',
    defaultTimeframe = 'H4',

    defaultModel = '',
    defaultTemperature = 0.35,

    persistKey = 'ignis_ai_prefs_v1',

    statusRefreshMs = 20_000,
    requestTimeoutMs = 18_000,
  } = options;

  // persisted prefs
  const [model, setModelState] = useState(defaultModel);
  const [temperature, setTemperatureState] = useState(defaultTemperature);

  const [status, setStatus] = useState<AIStatusResponse | null>(null);
  const [models, setModels] = useState<AIModelsResponse | null>(null);

  const [loadingStatus, setLoadingStatus] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);

  const [chatLoading, setChatLoading] = useState(false);
  const [streamLoading, setStreamLoading] = useState(false);
  const [reportLoading, setReportLoading] = useState(false);
  const [summarizeLoading, setSummarizeLoading] = useState(false);

  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const reqIdRef = useRef(0);

  // Load prefs once
  useEffect(() => {
    try {
      const raw = localStorage.getItem(persistKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (typeof parsed?.model === 'string') setModelState(parsed.model);
      if (typeof parsed?.temperature === 'number') setTemperatureState(parsed.temperature);
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist prefs
  useEffect(() => {
    try {
      localStorage.setItem(persistKey, JSON.stringify({ model, temperature }));
    } catch {
      // ignore
    }
  }, [model, temperature, persistKey]);

  const setModel = useCallback((m: string) => setModelState((m ?? '').trim()), []);
  const setTemperature = useCallback((t: number) => setTemperatureState(Number.isFinite(t) ? t : defaultTemperature), [defaultTemperature]);

  const ollamaOnline = useMemo(() => !!status?.ollama_online, [status?.ollama_online]);

  const abort = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setChatLoading(false);
    setStreamLoading(false);
    setReportLoading(false);
    setSummarizeLoading(false);
  }, []);

  const refreshStatus = useCallback(async () => {
    setError(null);
    setLoadingStatus(true);

    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;

    try {
      const res = await withTimeout(fetch(`${apiBase}/ai/status`, { method: 'GET', signal: controller.signal }), requestTimeoutMs, controller.signal);
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${t || 'Erreur /ai/status'}`);
      }
      const data = (await res.json()) as AIStatusResponse;
      setStatus(data);

      // if user didn't choose model yet, take backend default
      setModelState((prev) => prev || data.model || '');

      return data;
    } catch (e: any) {
      if (e?.name === 'AbortError') return null;
      setError(e?.message ?? 'Erreur status');
      setStatus(null);
      return null;
    } finally {
      setLoadingStatus(false);
    }
  }, [apiBase, requestTimeoutMs]);

  const refreshModels = useCallback(async () => {
    setError(null);
    setLoadingModels(true);

    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;

    try {
      const res = await withTimeout(fetch(`${apiBase}/ai/models`, { method: 'GET', signal: controller.signal }), requestTimeoutMs, controller.signal);
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${t || 'Erreur /ai/models'}`);
      }
      const data = (await res.json()) as AIModelsResponse;
      setModels(data);

      // if model still empty, pick first available
      setModelState((prev) => prev || data.models?.[0]?.name || '');

      return data;
    } catch (e: any) {
      if (e?.name === 'AbortError') return null;
      setError(e?.message ?? 'Erreur models');
      setModels(null);
      return null;
    } finally {
      setLoadingModels(false);
    }
  }, [apiBase, requestTimeoutMs]);

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshStatus(), refreshModels()]);
  }, [refreshStatus, refreshModels]);

  // auto init + polling
  useEffect(() => {
    if (!auto) return;

    refreshAll();

    if (!statusRefreshMs || statusRefreshMs < 5000) return;
    const t = setInterval(() => {
      refreshStatus();
    }, statusRefreshMs);

    return () => clearInterval(t);
  }, [auto, refreshAll, refreshStatus, statusRefreshMs]);

  const chat = useCallback(async (reqPartial: Partial<AIChatRequest>) => {
    setError(null);
    setChatLoading(true);

    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;

    const reqId = ++reqIdRef.current;

    try {
      const req: AIChatRequest = {
        symbol: normSymbol(reqPartial.symbol ?? defaultSymbol),
        timeframe: String(reqPartial.timeframe ?? defaultTimeframe),
        messages: reqPartial.messages ?? [],
        model: reqPartial.model ?? (model || undefined),
        temperature: reqPartial.temperature ?? temperature,
        stream: false,
      };

      const res = await withTimeout(
        fetch(`${apiBase}/ai/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req),
          signal: controller.signal,
        }),
        requestTimeoutMs,
        controller.signal
      );

      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${t || 'Erreur /ai/chat'}`);
      }

      const data = (await res.json()) as AIChatResponse;

      // ignore stale
      if (reqId !== reqIdRef.current) return null;

      // sync model if backend returns one
      if (data?.model) setModelState((prev) => prev || data.model);

      return data;
    } catch (e: any) {
      if (e?.name === 'AbortError') return null;
      setError(e?.message ?? 'Erreur chat');
      return null;
    } finally {
      setChatLoading(false);
    }
  }, [apiBase, defaultSymbol, defaultTimeframe, model, temperature, requestTimeoutMs]);

  const chatStream = useCallback(async (params: {
    req: Partial<AIChatRequest>;
    onToken?: (token: string) => void;
    onEvent?: (evt: { raw: string; data: string }) => void;
  }) => {
    setError(null);
    setStreamLoading(true);

    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;

    const reqId = ++reqIdRef.current;

    try {
      const req: AIChatRequest = {
        symbol: normSymbol(params.req.symbol ?? defaultSymbol),
        timeframe: String(params.req.timeframe ?? defaultTimeframe),
        messages: params.req.messages ?? [],
        model: params.req.model ?? (model || undefined),
        temperature: params.req.temperature ?? temperature,
        stream: true,
      };

      const res = await fetch(`${apiBase}/ai/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
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
          // ignore stale stream
          if (reqId !== reqIdRef.current) return;
          acc += token;
          params.onToken?.(token);
        },
        params.onEvent
      );

      if (reqId !== reqIdRef.current) return null;

      return { fullText: acc };
    } catch (e: any) {
      if (e?.name === 'AbortError') return null;
      setError(e?.message ?? 'Erreur stream');
      return null;
    } finally {
      setStreamLoading(false);
    }
  }, [apiBase, defaultSymbol, defaultTimeframe, model, temperature]);

  const report = useCallback(async (reqPartial: Partial<AIReportRequest>) => {
    setError(null);
    setReportLoading(true);

    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;

    const reqId = ++reqIdRef.current;

    try {
      const req: AIReportRequest = {
        symbol: normSymbol(reqPartial.symbol ?? defaultSymbol),
        timeframe: String(reqPartial.timeframe ?? defaultTimeframe),
        higher_tf: reqPartial.higher_tf,
        force_analysis: reqPartial.force_analysis ?? false,
        report_type: reqPartial.report_type ?? 'full',
        language: reqPartial.language ?? 'fr',
      };

      const res = await withTimeout(
        fetch(`${apiBase}/ai/report`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req),
          signal: controller.signal,
        }),
        requestTimeoutMs,
        controller.signal
      );

      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${t || 'Erreur /ai/report'}`);
      }

      const data = (await res.json()) as AIReportResponse;

      if (reqId !== reqIdRef.current) return null;

      // model hint
      if (data?.model) setModelState((prev) => prev || data.model);

      return data;
    } catch (e: any) {
      if (e?.name === 'AbortError') return null;
      setError(e?.message ?? 'Erreur report');
      return null;
    } finally {
      setReportLoading(false);
    }
  }, [apiBase, defaultSymbol, defaultTimeframe, requestTimeoutMs]);

  const summarize = useCallback(async (reqPartial: Partial<AISummarizeRequest>) => {
    setError(null);
    setSummarizeLoading(true);

    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;

    const reqId = ++reqIdRef.current;

    try {
      const req: AISummarizeRequest = {
        symbol: normSymbol(reqPartial.symbol ?? defaultSymbol),
        timeframe: String(reqPartial.timeframe ?? defaultTimeframe),
        max_words: reqPartial.max_words ?? 150,
      };

      const res = await withTimeout(
        fetch(`${apiBase}/ai/summarize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req),
          signal: controller.signal,
        }),
        requestTimeoutMs,
        controller.signal
      );

      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} — ${t || 'Erreur /ai/summarize'}`);
      }

      const data = (await res.json()) as AISummarizeResponse;

      if (reqId !== reqIdRef.current) return null;

      return data;
    } catch (e: any) {
      if (e?.name === 'AbortError') return null;
      setError(e?.message ?? 'Erreur summarize');
      return null;
    } finally {
      setSummarizeLoading(false);
    }
  }, [apiBase, defaultSymbol, defaultTimeframe, requestTimeoutMs]);

  return {
    status,
    models,

    loadingStatus,
    loadingModels,

    chatLoading,
    streamLoading,
    reportLoading,
    summarizeLoading,

    error,

    model,
    setModel,
    temperature,
    setTemperature,

    ollamaOnline,

    refreshStatus,
    refreshModels,
    refreshAll,

    chat,
    chatStream,

    abort,

    report,
    summarize,
  };
}