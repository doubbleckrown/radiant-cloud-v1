"""fx-signal — WebSocket route"""
from __future__ import annotations
import json
import logging
from fastapi import WebSocket, WebSocketDisconnect
from app.core.auth import _verify_clerk_token
from app.core.state import ws_clients, latest_prices, signal_history
from app.core.config import INSTRUMENTS
from fastapi import HTTPException

logger = logging.getLogger("fx-signal.ws")


async def broadcast(message: dict) -> None:
    dead = set()
    payload = json.dumps(message)
    for ws in ws_clients:
        try:
            await ws.send_text(payload)
        except Exception:
            dead.add(ws)
    ws_clients.difference_update(dead)


async def websocket_endpoint(ws: WebSocket, token: str = ""):
    try:
        await _verify_clerk_token(token)
    except HTTPException:
        await ws.close(code=4001)
        return

    await ws.accept()
    ws_clients.add(ws)
    logger.info("WS connected. Total: %d", len(ws_clients))

    await ws.send_text(json.dumps({
        "type":    "SNAPSHOT",
        "prices":  latest_prices,
        "signals": {ins: signal_history[ins][:5] for ins in INSTRUMENTS},
    }))

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                continue
            if msg.get("type") == "SUBSCRIBE":
                ins = msg.get("instrument", "")
                if ins in INSTRUMENTS:
                    p = latest_prices.get(ins)
                    if p:
                        import time
                        await ws.send_text(json.dumps({
                            "type": "TICK", "instrument": ins,
                            "bid": p, "ask": p, "mid": p, "time": str(int(time.time())),
                        }))
    except WebSocketDisconnect:
        ws_clients.discard(ws)
        logger.info("WS disconnected. Total: %d", len(ws_clients))
