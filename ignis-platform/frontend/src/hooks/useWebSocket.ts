/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * usewebsocket.ts (singleton WS manager)
 * - Une seule connexion WebSocket partagée (évite 3 connexions Dashboard/Alerts/Analysis)
 * - Ref-count + fermeture différée (idle)
 * - Subscribe/Unsubscribe par "room" avec compteur (alerts, prices)
 * - Auto-reconnect backoff + re-subscribe automatique
 * - Ping/pong + latence estimée
 * - Event listeners par type de message (ex: "alert", "price_update", "analysis_ready")
 *
 * Backend protocol (rappel):
 *  ws://localhost:8000/ws
 *  client -> server:
 *    {type:"subscribe", room:"alerts"|"prices"}
 *    {type:"unsubscribe", room:"alerts"|"prices"}
 *    {type:"ping"}
 *    {type:"request_analysis", symbol:"BTCUSDT", timeframe:"H4"}
 *  server -> client:
 *    {type:"alert", data: ...}
 *    {type:"price_update", data: ...}
 *    {type:"analysis_ready", data: ...}
 *    {type:"pong"}
 */

/* ──────────────────────────────────────────────────────────────
   Types
────────────────────────────────────────────────────────────── */

export type WsRoom = 'alerts' | 'prices' | string;

export type WsStatus = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED';

export type WsInMessage =
  | { type: 'subscribe'; room: WsRoom }
  | { type: 'unsubscribe'; room: WsRoom }
  | { type: 'ping' }
  | { type: 'request_analysis'; symbol: string; timeframe: string }
  | { type: string; [k: string]: any };

export type WsOutMessage =
  | { type: 'alert'; data: any }
  | { type: 'price_update'; data: any }
  | { type: 'analysis_ready'; data: any }
  | { type: 'pong' }
  | { type: string; data?: any; [k: string]: any };

export type WsEventMap = {
  status: { status: WsStatus };
  error: { error: string };
  message: { message: WsOutMessage; raw: string };
};

export type UseWebSocketOptions = {
  wsUrl?: string;

  /** if true, connect on mount */
  autoConnect?: boolean;

  /** if true, reconnect on close while there are subscribers */
  autoReconnect?: boolean;

  /** rooms to auto-subscribe on mount */
  rooms?: WsRoom[];

  /** ping interval; 0 disables */
  pingIntervalMs?: number;

  /** reconnect backoff config */
  reconnectMinDelayMs?: number;
  reconnectMaxDelayMs?: number;

  /** if no hook instances remain, close after this idle delay (ms) */
  idleCloseDelayMs?: number;
};

export type UseWebSocketReturn = {
  status: WsStatus;
  connected: boolean;

  error: string | null;

  wsUrl: string;

  lastMessage: WsOutMessage | null;
  lastMessageRaw: string | null;

  lastPongAt: number | null;
  latencyMs: number | null;

  rooms: WsRoom[];

  connect: () => void;
  disconnect: () => void;

  subscribe: (room: WsRoom) => void;
  unsubscribe: (room: WsRoom) => void;

  send: (msg: WsInMessage) => void;

  /** convenience wrapper */
  requestAnalysis: (symbol: string, timeframe: string) => void;

  /**
   * Add a listener on msg.type (or "*" for all)
   * Returns an unsubscribe function.
   */
  on: (type: string | '*', cb: (msg: WsOutMessage) => void) => () => void;
};

/* ──────────────────────────────────────────────────────────────
   Singleton manager
────────────────────────────────────────────────────────────── */

const WS_URL_DEFAULT =
  process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:8000/ws';

type Listener = (payload: any) => void;

class WebSocketManager {
  private url: string;

  private ws: WebSocket | null = null;
  private status: WsStatus = 'DISCONNECTED';
  private error: string | null = null;

  private refCount = 0;
  private idleCloseTimer: any = null;

  private autoReconnect = true;
  private reconnectAttempt = 0;
  private reconnectTimer: any = null;
  private reconnectMinDelayMs = 2500;
  private reconnectMaxDelayMs = 12000;

  private pingIntervalMs = 15000;
  private pingTimer: any = null;
  private lastPingAt: number | null = null;
  private lastPongAt: number | null = null;
  private latencyMs: number | null = null;

  private roomCounts = new Map<WsRoom, number>();
  private sendQueue: string[] = [];

  // app-level events (status/error/message)
  private listeners = new Map<keyof WsEventMap, Set<Listener>>();

  // message listeners by msg.type (including "*")
  private msgListeners = new Map<string, Set<(msg: WsOutMessage) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  setUrl(url: string) {
    if (!url || url === this.url) return;
    this.url = url;
    // if connected, reconnect to new url
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.closeSocket(true);
      this.connect();
    }
  }

  configure(opts: Partial<UseWebSocketOptions>) {
    if (typeof opts.autoReconnect === 'boolean') this.autoReconnect = opts.autoReconnect;
    if (typeof opts.pingIntervalMs === 'number') this.pingIntervalMs = opts.pingIntervalMs;

    if (typeof opts.reconnectMinDelayMs === 'number') this.reconnectMinDelayMs = opts.reconnectMinDelayMs;
    if (typeof opts.reconnectMaxDelayMs === 'number') this.reconnectMaxDelayMs = opts.reconnectMaxDelayMs;
  }

  acquire(idleCloseDelayMs = 4500) {
    this.refCount += 1;

    // cancel scheduled idle close
    if (this.idleCloseTimer) {
      clearTimeout(this.idleCloseTimer);
      this.idleCloseTimer = null;
    }

    // store default idle close delay in timer call closure
    return () => this.release(idleCloseDelayMs);
  }

  private release(idleCloseDelayMs: number) {
    this.refCount = Math.max(0, this.refCount - 1);

    if (this.refCount > 0) return;

    // schedule close to avoid flapping in React strict mode or quick nav
    if (this.idleCloseTimer) clearTimeout(this.idleCloseTimer);
    this.idleCloseTimer = setTimeout(() => {
      if (this.refCount === 0) {
        this.disconnect(); // will stop reconnect etc.
      }
    }, idleCloseDelayMs);
  }

  getState() {
    return {
      status: this.status,
      error: this.error,
      url: this.url,
      lastPongAt: this.lastPongAt,
      latencyMs: this.latencyMs,
      rooms: Array.from(this.roomCounts.keys()).filter((r) => (this.roomCounts.get(r) ?? 0) > 0),
    };
  }

  onEvent<K extends keyof WsEventMap>(event: K, cb: (payload: WsEventMap[K]) => void) {
    const set = this.listeners.get(event) ?? new Set();
    set.add(cb as any);
    this.listeners.set(event, set);

    return () => {
      const s = this.listeners.get(event);
      s?.delete(cb as any);
    };
  }

  onMessageType(type: string | '*', cb: (msg: WsOutMessage) => void) {
    const key = type || '*';
    const set = this.msgListeners.get(key) ?? new Set();
    set.add(cb);
    this.msgListeners.set(key, set);

    return () => {
      const s = this.msgListeners.get(key);
      s?.delete(cb);
    };
  }

  private emit<K extends keyof WsEventMap>(event: K, payload: WsEventMap[K]) {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    for (const cb of set) {
      try {
        cb(payload);
      } catch {
        // ignore listener errors
      }
    }
  }

  private emitMsg(msg: WsOutMessage, raw: string) {
    // "*" listeners
    const anySet = this.msgListeners.get('*');
    if (anySet) {
      for (const cb of anySet) {
        try { cb(msg); } catch {}
      }
    }

    // type listeners
    const set = this.msgListeners.get(msg.type);
    if (set) {
      for (const cb of set) {
        try { cb(msg); } catch {}
      }
    }

    // global message event
    this.emit('message', { message: msg, raw });
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.clearReconnectTimer();
    this.setStatus('CONNECTING');

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.reconnectAttempt = 0;
        this.setStatus('CONNECTED');

        // subscribe to all active rooms
        for (const [room, count] of this.roomCounts.entries()) {
          if ((count ?? 0) > 0) this.send({ type: 'subscribe', room });
        }

        // flush queued sends
        this.flushQueue();

        // start ping
        this.startPing();
      };

      this.ws.onmessage = (evt) => {
        const raw = String(evt.data ?? '');
        let msg: WsOutMessage | null = null;

        try {
          msg = JSON.parse(raw);
        } catch {
          // ignore non-json; still emit as "message" with type="raw"
          msg = { type: 'raw', data: raw };
        }

        if (msg?.type === 'pong') {
          this.lastPongAt = Date.now();
          if (this.lastPingAt) {
            this.latencyMs = Math.max(0, this.lastPongAt - this.lastPingAt);
          }
        }

        this.emitMsg(msg!, raw);
      };

      this.ws.onerror = () => {
        // most browsers don't provide details; rely on onclose + reconnect
        this.error = 'WebSocket error';
        this.emit('error', { error: this.error });
      };

      this.ws.onclose = () => {
        this.stopPing();

        // only mark disconnected if it's still the current ws
        this.setStatus('DISCONNECTED');

        // auto reconnect if needed
        if (this.autoReconnect && this.refCount > 0 && this.hasAnyRoom()) {
          this.scheduleReconnect();
        }
      };
    } catch (e: any) {
      this.error = e?.message ?? 'WS connect failed';
      this.emit('error', { error: this.error });
      this.setStatus('DISCONNECTED');
      this.scheduleReconnect();
    }
  }

  disconnect() {
    this.clearReconnectTimer();
    this.stopPing();
    this.closeSocket(false);
    this.setStatus('DISCONNECTED');
  }

  private closeSocket(keepRooms: boolean) {
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = null;

    // if we want a hard reset, clear rooms
    if (!keepRooms) {
      this.roomCounts.clear();
      this.sendQueue = [];
    }
  }

  private setStatus(s: WsStatus) {
    this.status = s;
    this.emit('status', { status: s });
  }

  private hasAnyRoom() {
    for (const [, count] of this.roomCounts.entries()) {
      if ((count ?? 0) > 0) return true;
    }
    return false;
  }

  private scheduleReconnect() {
    this.clearReconnectTimer();

    const attempt = (this.reconnectAttempt += 1);
    const delay = Math.min(
      this.reconnectMinDelayMs + attempt * 1200,
      this.reconnectMaxDelayMs
    );

    this.reconnectTimer = setTimeout(() => {
      // only reconnect if still needed
      if (this.refCount > 0 && this.hasAnyRoom()) this.connect();
    }, delay);
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private startPing() {
    this.stopPing();
    if (!this.pingIntervalMs || this.pingIntervalMs < 5000) return;

    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.lastPingAt = Date.now();
      this.send({ type: 'ping' });
    }, this.pingIntervalMs);
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  subscribe(room: WsRoom) {
    const prev = this.roomCounts.get(room) ?? 0;
    this.roomCounts.set(room, prev + 1);

    // if we were at 0 and are connected, send subscribe now
    if (prev === 0 && this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: 'subscribe', room });
    }

    // ensure connected if auto
    if (this.refCount > 0) this.connect();
  }

  unsubscribe(room: WsRoom) {
    const prev = this.roomCounts.get(room) ?? 0;
    const next = Math.max(0, prev - 1);

    if (next === 0) this.roomCounts.delete(room);
    else this.roomCounts.set(room, next);

    // if we transitioned to 0 and are connected, send unsubscribe
    if (prev > 0 && next === 0 && this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: 'unsubscribe', room });
    }

    // if no rooms left, we may disconnect later via refCount/idle close
  }

  send(msg: WsInMessage) {
    const payload = JSON.stringify(msg);

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // queue during connecting/disconnected
      this.sendQueue.push(payload);
      // if there are active users, try connect
      if (this.refCount > 0) this.connect();
      return;
    }

    try {
      this.ws.send(payload);
    } catch (e: any) {
      this.error = e?.message ?? 'WS send failed';
      this.emit('error', { error: this.error });
      // requeue
      this.sendQueue.push(payload);
    }
  }

  private flushQueue() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.sendQueue.length) return;

    const queue = [...this.sendQueue];
    this.sendQueue = [];

    for (const payload of queue) {
      try {
        this.ws.send(payload);
      } catch {
        // if sending fails, keep remaining
        this.sendQueue.unshift(payload);
        break;
      }
    }
  }

  requestAnalysis(symbol: string, timeframe: string) {
    this.send({
      type: 'request_analysis',
      symbol: (symbol ?? '').trim().toUpperCase(),
      timeframe: String(timeframe ?? '').trim(),
    });
  }
}

let _manager: WebSocketManager | null = null;

function getManager(wsUrl: string) {
  if (!_manager) _manager = new WebSocketManager(wsUrl);
  _manager.setUrl(wsUrl);
  return _manager;
}

/* ──────────────────────────────────────────────────────────────
   Hook
────────────────────────────────────────────────────────────── */

export function usewebsocket(options: UseWebSocketOptions = {}): UseWebSocketReturn {
  const {
    wsUrl = WS_URL_DEFAULT,
    autoConnect = true,
    autoReconnect = true,
    rooms = [],
    pingIntervalMs = 15000,
    reconnectMinDelayMs = 2500,
    reconnectMaxDelayMs = 12000,
    idleCloseDelayMs = 4500,
  } = options;

  const mgr = useMemo(() => {
    const m = getManager(wsUrl);
    m.configure({ autoReconnect, pingIntervalMs, reconnectMinDelayMs, reconnectMaxDelayMs });
    return m;
  }, [wsUrl, autoReconnect, pingIntervalMs, reconnectMinDelayMs, reconnectMaxDelayMs]);

  const [status, setStatus] = useState<WsStatus>(mgr.getState().status);
  const [error, setError] = useState<string | null>(mgr.getState().error);

  const [lastMessage, setLastMessage] = useState<WsOutMessage | null>(null);
  const [lastMessageRaw, setLastMessageRaw] = useState<string | null>(null);

  const [lastPongAt, setLastPongAt] = useState<number | null>(mgr.getState().lastPongAt);
  const [latencyMs, setLatencyMs] = useState<number | null>(mgr.getState().latencyMs);

  const [roomsState, setRoomsState] = useState<WsRoom[]>(mgr.getState().rooms);

  // stable room list
  const roomsRef = useRef<WsRoom[]>(rooms);
  roomsRef.current = rooms;

  // Acquire/release lifecycle
  useEffect(() => {
    const release = mgr.acquire(idleCloseDelayMs);

    // subscribe to rooms for this hook instance
    for (const r of roomsRef.current) mgr.subscribe(r);

    if (autoConnect) mgr.connect();

    const offStatus = mgr.onEvent('status', (p) => {
      setStatus(p.status);
      setRoomsState(mgr.getState().rooms);
    });

    const offError = mgr.onEvent('error', (p) => setError(p.error));
    const offMsg = mgr.onEvent('message', (p) => {
      setLastMessage(p.message);
      setLastMessageRaw(p.raw);
      const st = mgr.getState();
      setLastPongAt(st.lastPongAt);
      setLatencyMs(st.latencyMs);
    });

    return () => {
      // unsubscribe rooms
      for (const r of roomsRef.current) mgr.unsubscribe(r);

      offStatus();
      offError();
      offMsg();

      release();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mgr, autoConnect, idleCloseDelayMs]);

  const connect = useCallback(() => mgr.connect(), [mgr]);
  const disconnect = useCallback(() => mgr.disconnect(), [mgr]);

  const subscribe = useCallback((room: WsRoom) => {
    mgr.subscribe(room);
    setRoomsState(mgr.getState().rooms);
  }, [mgr]);

  const unsubscribe = useCallback((room: WsRoom) => {
    mgr.unsubscribe(room);
    setRoomsState(mgr.getState().rooms);
  }, [mgr]);

  const send = useCallback((msg: WsInMessage) => mgr.send(msg), [mgr]);

  const requestAnalysis = useCallback((symbol: string, timeframe: string) => {
    mgr.requestAnalysis(symbol, timeframe);
  }, [mgr]);

  const on = useCallback((type: string | '*', cb: (msg: WsOutMessage) => void) => {
    return mgr.onMessageType(type, cb);
  }, [mgr]);

  return {
    status,
    connected: status === 'CONNECTED',
    error,

    wsUrl,

    lastMessage,
    lastMessageRaw,

    lastPongAt,
    latencyMs,

    rooms: roomsState,

    connect,
    disconnect,

    subscribe,
    unsubscribe,

    send,
    requestAnalysis,

    on,
  };
}

// Optional alias (si tu préfères camelCase)
export const useWebSocket = usewebsocket;