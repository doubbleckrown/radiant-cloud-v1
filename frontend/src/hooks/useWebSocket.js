import { useEffect, useRef, useState, useCallback } from "react";

const WS_BASE = import.meta.env.VITE_WS_URL ?? "ws://localhost:8000/ws";

export function useWebSocket() {
  const [lastMessage, setLastMessage] = useState(null);
  const [wsStatus,    setWsStatus]    = useState("disconnected");
  const wsRef    = useRef(null);
  const timerRef = useRef(null);

  const connect = useCallback(async () => {
    // Guard: don't open a second connection if already open/connecting
    if (wsRef.current?.readyState === WebSocket.OPEN)  return;
    if (wsRef.current?.readyState === WebSocket.CONNECTING) return;

    // Get the current Clerk session token (cached — no network round-trip)
    let token = "";
    try {
      token = (await window.Clerk?.session?.getToken()) ?? "";
    } catch {
      // Clerk not ready yet — retry in 3 s
      setTimeout(connect, 3_000);
      return;
    }

    if (!token) {
      // Not signed in yet — retry in 3 s
      setTimeout(connect, 3_000);
      return;
    }

    const url = `${WS_BASE}?token=${token}`;
    const ws  = new WebSocket(url);
    wsRef.current = ws;
    setWsStatus("connecting");

    ws.onopen = () => {
      setWsStatus("connected");
      // Keep-alive ping every 20 s
      timerRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("ping");
      }, 20_000);
    };

    ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);
        setLastMessage(data);
      } catch { /* ignore */ }
    };

    ws.onclose = () => {
      setWsStatus("disconnected");
      clearInterval(timerRef.current);
      // Reconnect after 3 s (with a fresh Clerk token)
      setTimeout(connect, 3_000);
    };

    ws.onerror = () => ws.close();
  }, []);

  useEffect(() => {
    connect();
    return () => {
      clearInterval(timerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((data) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  return { lastMessage, wsStatus, send };
}