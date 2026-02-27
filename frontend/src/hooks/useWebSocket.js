/**
 * useWebSocket — auto-reconnecting WebSocket hook
 *
 * Fix: WS URL is now derived from VITE_API_URL so the Android emulator
 * (or any non-localhost device) only needs ONE env var change:
 *
 *   VITE_API_URL=http://192.168.1.x:8000   ← your Mac's LAN IP
 *
 * The hook converts it automatically:
 *   http://192.168.1.x:8000  →  ws://192.168.1.x:8000/ws
 *   https://api.example.com  →  wss://api.example.com/ws
 *
 * You can still override with VITE_WS_URL if you need a custom path.
 *
 * Token is appended as a query param:  ws://host:8000/ws?token=eyJ...
 * The backend reads it via:  async def websocket_endpoint(ws, token: str = "")
 */

import { useEffect, useRef, useState, useCallback } from "react";

/**
 * Derive the WebSocket base URL from VITE_API_URL.
 * Replaces the http(s) scheme with ws(s) and strips the /api path suffix.
 *
 * Examples:
 *   http://localhost:8000/api  →  ws://localhost:8000/ws
 *   http://192.168.1.5:8000    →  ws://192.168.1.5:8000/ws
 *   https://api.fxradiant.com  →  wss://api.fxradiant.com/ws
 */
function deriveWsUrl() {
  // Explicit override always wins
  if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL;

  const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

  // Strip trailing /api or /api/ — we only need the host:port
  const base = apiUrl.replace(/\/api\/?$/, "");

  // Replace scheme: http → ws, https → wss
  const wsBase = base.replace(/^http/, "ws");

  return `${wsBase}/ws`;
}

const WS_BASE = deriveWsUrl();

export function useWebSocket(token) {
  const [lastMessage, setLastMessage] = useState(null);
  const [status, setStatus]           = useState("disconnected");
  const wsRef     = useRef(null);
  const timerRef  = useRef(null);
  const retryRef  = useRef(null);

  const connect = useCallback(() => {
    // Don't connect without a token — the backend will reject with 4001
    if (!token) {
      setStatus("no-token");
      return;
    }

    // Don't open a second connection if one is already live
    const ws = wsRef.current;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    // Append token as query param — backend reads it as: token: str = ""
    const url = `${WS_BASE}?token=${encodeURIComponent(token)}`;
    console.debug("[WS] connecting to", url.replace(token, token.slice(0, 12) + "…"));

    const newWs = new WebSocket(url);
    wsRef.current = newWs;
    setStatus("connecting");

    newWs.onopen = () => {
      console.debug("[WS] connected");
      setStatus("connected");
      // Keep-alive ping every 20 s — prevents Oanda proxy / Nginx timeouts
      timerRef.current = setInterval(() => {
        if (newWs.readyState === WebSocket.OPEN) newWs.send("ping");
      }, 20_000);
    };

    newWs.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);

        // Log auth errors clearly so they show in the browser console
        if (data.type === "AUTH_ERROR") {
          console.error("[WS] AUTH_ERROR from server:", data.reason);
          setStatus("auth-error");
          return;
        }

        setLastMessage(data);
      } catch {
        // Ignore non-JSON frames (e.g. pong responses)
      }
    };

    newWs.onclose = (evt) => {
      console.debug("[WS] closed  code=%d  reason=%s", evt.code, evt.reason || "(none)");
      setStatus("disconnected");
      clearInterval(timerRef.current);
      clearTimeout(retryRef.current);

      // Don't retry on auth failure — would just loop forever
      if (evt.code === 4001) {
        setStatus("auth-error");
        console.error("[WS] Auth rejected by server (code 4001). Check your token.");
        return;
      }

      // Exponential back-off: 3 s, then 6 s, then 10 s
      const delay = evt.code === 1006 ? 6_000 : 3_000;
      retryRef.current = setTimeout(connect, delay);
    };

    newWs.onerror = (err) => {
      console.error("[WS] error — will close and retry", err);
      newWs.close();
    };
  }, [token]);

  useEffect(() => {
    connect();
    return () => {
      clearInterval(timerRef.current);
      clearTimeout(retryRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((data) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(typeof data === "string" ? data : JSON.stringify(data));
    }
  }, []);

  return { lastMessage, status, send };
}