"""
app/engines/oanda/engine.py — Oanda price streaming + candle refresh + SMC analysis.

MTF data flow (fixed in v3.0):
  • Fetches Daily ("D"), H1, M5 candles every cycle.
  • Daily candles are only re-fetched every DAILY_REFRESH_CYCLES cycles (~10 min)
    to reduce Oanda API load — they don't change on a per-minute basis.
  • analyze() is called with all three timeframes: candles_d, candles_h1, candles_m5.
  • get_partial_state() for the MarketsPage UI poll also receives candles_d.
"""
from __future__ import annotations
import asyncio
import json
import logging
import time
from typing import Optional

import httpx
from fastapi import WebSocket

import app.core.state as state
from app.core.config import (
    OANDA_BASE, OANDA_STREAM, GRANULARITIES, INSTRUMENTS,
    get_oanda_creds,
)
from app.core.trade_tracker import trade_tracker
from app.core.alerts import push_notification
from app.engines.oanda.executor import fetch_candles, auto_execute
from app.services.strategy import TradeSignal

logger = logging.getLogger("fx-signal")

# Daily candles are refreshed every N cycles (60 s each) → every 10 minutes.
# This avoids hammering Oanda with daily requests every 60 seconds while keeping
# the daily bias data current for the HTF Stage 1 analysis.
DAILY_REFRESH_CYCLES = 10


async def broadcast(message: dict) -> None:
    dead: set[WebSocket] = set()
    payload = json.dumps(message)
    for ws in state.ws_clients:
        try:
            await ws.send_text(payload)
        except Exception:
            dead.add(ws)
    state.ws_clients.difference_update(dead)


async def price_stream_loop() -> None:
    """Oanda real-time price streaming via SSE."""
    MAX_RECONNECT    = 30.0
    delay            = 2.0
    instruments_param = ",".join(INSTRUMENTS)

    while True:
        creds = get_oanda_creds()
        if not creds:
            await asyncio.sleep(30)
            continue
        api_key, account_id = creds
        try:
            url     = f"{OANDA_STREAM}/v3/accounts/{account_id}/pricing/stream"
            headers = {"Authorization": f"Bearer {api_key}"}
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream(
                    "GET", url, headers=headers,
                    params={"instruments": instruments_param},
                ) as resp:
                    resp.raise_for_status()
                    delay = 2.0
                    async for line in resp.aiter_lines():
                        if not line:
                            continue
                        try:
                            tick = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if tick.get("type") != "PRICE":
                            continue
                        ins  = tick.get("instrument")
                        if not ins:
                            continue
                        bids = tick.get("bids", [])
                        asks = tick.get("asks", [])
                        if not bids or not asks:
                            continue
                        bid = float(bids[0].get("price", 0))
                        ask = float(asks[0].get("price", 0))
                        mid = round((bid + ask) / 2, 6)
                        state.latest_prices[ins] = mid
                        await broadcast({
                            "type": "TICK", "instrument": ins,
                            "bid": bid, "ask": ask, "mid": mid,
                            "time": tick.get("time", ""),
                        })
        except Exception as exc:
            logger.warning("price_stream_loop: %s — reconnect in %.0fs", exc, delay)
            await asyncio.sleep(delay)
            delay = min(delay * 1.5, MAX_RECONNECT)


async def candle_refresh_loop() -> None:
    """
    Refresh candles every 60 s, then run the full 4-stage SMC analysis.

    Timeframe fetch schedule:
      • D   — every DAILY_REFRESH_CYCLES cycles (~10 min). Bias is stable.
      • H1  — every cycle (60 s).  Primary structural timeframe.
      • M5  — every cycle (60 s).  Entry zone detection.
      • M15 — every cycle (60 s).  Context / chart display.
      • M1  — every cycle (60 s).  Fine-grain chart display.

    The D candle cache is pre-populated during the very first cycle so Stage 1
    analysis is available immediately on startup.
    """
    FETCH_TIMEOUT = 20.0
    MAX_BACKOFF   = 60.0
    fail_counts: dict[str, int] = {ins: 0 for ins in INSTRUMENTS}
    cycle = 0

    async def _safe(ins: str, gran: str):
        try:
            return await asyncio.wait_for(fetch_candles(ins, gran), timeout=FETCH_TIMEOUT)
        except Exception as exc:
            logger.warning("Oanda candle %s %s: %s", ins, gran, exc)
            fail_counts[ins] = fail_counts.get(ins, 0) + 1
        return None

    while True:
        try:
            for ins in INSTRUMENTS:
                fails   = fail_counts.get(ins, 0)
                backoff = min(5.0 * (2 ** max(0, fails - 1)), MAX_BACKOFF) if fails > 0 else 0.0
                if backoff:
                    await asyncio.sleep(backoff)

                # ── Determine which granularities to fetch this cycle ─────────
                grans_this_cycle = [g for g in GRANULARITIES if g != "D"]  # always fetch intraday
                if cycle % DAILY_REFRESH_CYCLES == 0:
                    grans_this_cycle.append("D")   # refresh daily every 10 cycles

                for gran in grans_this_cycle:
                    result = await _safe(ins, gran)
                    if result is not None:
                        state.candle_cache[ins][gran] = result
                        if result:
                            fail_counts[ins] = 0

                # Track daily open from first H1 candle of the last 24 h
                h1_snap = state.candle_cache[ins].get("H1", [])
                if h1_snap:
                    cutoff = time.time() - 86400
                    today  = [c for c in h1_snap if c.time >= cutoff]
                    if today:
                        state.oanda_daily_open[ins] = today[0].open

                # ── SMC analysis (full 4-stage MTF) ──────────────────────────
                try:
                    candles_d  = state.candle_cache[ins].get("D",  [])
                    candles_h1 = state.candle_cache[ins].get("H1", [])
                    candles_m5 = state.candle_cache[ins].get("M5", [])
                    price      = state.latest_prices.get(ins)

                    # Minimum data gates: need meaningful daily + H1 history
                    if (not price
                            or len(candles_d)  < 60
                            or len(candles_h1) < 100
                            or len(candles_m5) < 20):
                        continue

                    if trade_tracker.is_locked(ins):
                        continue

                    signal: Optional[TradeSignal] = state.oanda_engines[ins].analyze(
                        candles_d, candles_h1, candles_m5,
                        price, int(time.time()),
                    )

                    if signal:
                        sig_dict = {
                            "type":       "SIGNAL",
                            "instrument": ins,
                            "engine":     "OANDA",
                            "direction":  signal.direction.value,
                            "entry":      round(signal.entry_price,     5),
                            "sl":         round(signal.stop_loss,       5),
                            "tp":         round(signal.take_profit,     5),
                            "breakeven":  round(signal.breakeven_price, 5),
                            "rr":         signal.risk_reward,
                            "confidence": signal.confidence,
                            "layer1":     signal.layer1_bias,
                            "layer2":     signal.layer2_zone,
                            "layer3":     signal.layer3_mss,
                            "timestamp":  signal.timestamp,
                            "pd_zone":    signal.pd_zone,
                            "exec_status": None,
                        }
                        state.signal_history[ins] = (
                            [sig_dict] + state.signal_history[ins]
                        )[:50]
                        await broadcast(sig_dict)
                        logger.info(
                            "🟢 OANDA SIGNAL: %s %s conf=%d%%",
                            ins, signal.direction.value, signal.confidence,
                        )

                        if signal.confidence >= 95:
                            ins_lbl  = ins.replace("_", "/")
                            is_full  = signal.confidence >= 100
                            asyncio.create_task(push_notification(
                                "signal",
                                (
                                    f"🚨 New 100% Signal: {ins_lbl} {signal.direction.value.title()}!"
                                    if is_full
                                    else f"⚡ {signal.confidence}% Setup: {ins_lbl} {signal.direction.value.title()}"
                                ),
                                (
                                    f"Entry {signal.entry_price:.5f}  ·  "
                                    f"SL {signal.stop_loss:.5f}  ·  "
                                    f"TP {signal.take_profit:.5f}  ·  "
                                    f"R:R 1:{signal.risk_reward}"
                                ),
                                {
                                    "instrument": ins,
                                    "direction":  signal.direction.value,
                                    "entry":      round(signal.entry_price, 5),
                                    "confidence": signal.confidence,
                                    "engine":     "OANDA",
                                },
                            ))

                        if signal.confidence >= 100:
                            asyncio.create_task(auto_execute(ins, sig_dict, signal))

                except Exception as smc_exc:
                    logger.warning("Oanda SMC %s: %s", ins, smc_exc)

        except Exception as loop_exc:
            logger.error("candle_refresh_loop error: %s — restart in 10s", loop_exc)
            await asyncio.sleep(10)
            continue

        cycle += 1
        await asyncio.sleep(60)