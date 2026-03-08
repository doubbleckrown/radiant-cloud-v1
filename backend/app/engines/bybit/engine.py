"""
app/engines/bybit/engine.py — Bybit ticker refresh + candle polling + SMC analysis.

MTF data flow (fixed in v3.0):
  • Fetches 4H ("240"), H1 ("60"), and M5 ("5") candles.
  • 4H candles refreshed every HTF_REFRESH_CYCLES cycles (~10 min).
  • analyze() called with all three timeframes: candles_4h, candles_h1, candles_m5.
  • get_partial_state() for the MarketsPage UI poll also receives candles_4h.
  • Completely isolated from Oanda state — only touches bybit_* dicts in state.py.
"""
from __future__ import annotations
import asyncio
import logging
import time
from typing import Optional

import httpx

import app.core.state as state
from app.core.config import BYBIT_BASE, BYBIT_SYMBOLS, BYBIT_INTERVALS, get_bybit_creds
from app.core.trade_tracker import trade_tracker
from app.core.alerts import push_notification
from app.engines.bybit.executor import auto_execute
from app.services.strategy import Candle, TradeSignal

logger = logging.getLogger("fx-signal")

# 4H candles refreshed every N cycles (60 s each) → every 10 minutes.
HTF_REFRESH_CYCLES = 10


async def fetch_tickers(symbols: list[str]) -> dict[str, dict]:
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(f"{BYBIT_BASE}/v5/market/tickers", params={"category": "linear"})
        r.raise_for_status()
    data = r.json()
    if data.get("retCode", -1) != 0:
        raise RuntimeError(f"Bybit tickers {data.get('retCode')}: {data.get('retMsg')}")
    sym_set = set(symbols)
    result: dict[str, dict] = {}
    for item in data.get("result", {}).get("list", []):
        sym = item.get("symbol", "")
        if sym not in sym_set:
            continue
        try:
            result[sym] = {
                "price":      float(item.get("lastPrice",       0) or 0),
                "mark_price": float(item.get("markPrice",       0) or 0),
                "high24h":    float(item.get("highPrice24h",    0) or 0),
                "low24h":     float(item.get("lowPrice24h",     0) or 0),
                "volume24h":  float(item.get("turnover24h",     0) or 0),
                "change24h":  round(float(item.get("price24hPcnt", 0) or 0) * 100, 2),
            }
        except (ValueError, TypeError):
            pass
    return result


async def fetch_candles(symbol: str, interval: str, limit: int = 250) -> list[Candle]:
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.get(
            f"{BYBIT_BASE}/v5/market/kline",
            params={
                "category": "linear", "symbol": symbol,
                "interval": interval, "limit": str(min(limit, 1000)),
            },
        )
        r.raise_for_status()
    data = r.json()
    if data.get("retCode", -1) != 0:
        raise RuntimeError(
            f"Bybit kline {symbol} {data.get('retCode')}: {data.get('retMsg')}"
        )
    rows = data.get("result", {}).get("list", [])
    candles = [
        Candle(
            time=int(row[0]) // 1000,
            open=float(row[1]), high=float(row[2]),
            low=float(row[3]), close=float(row[4]),
            volume=float(row[5]),
        )
        for row in rows if len(row) >= 6
    ]
    candles.reverse()              # Bybit returns newest-first → convert to oldest-first
    return candles[:-1] if candles else candles   # drop still-forming candle


async def bybit_refresh_loop() -> None:
    """
    Refresh Bybit tickers + candles every 60 s, run SMC, auto-execute at 100%.

    Timeframe fetch schedule (updated for CryptoSMCEngine):
      • 240 — every HTF_REFRESH_CYCLES cycles (~10 min).  4H bias.
      • 15  — every cycle (60 s).  PRIMARY structural timeframe for crypto sweep + momentum.
      • 5   — every cycle (60 s).  5m entry zone detection.
      • 60  — every cycle (60 s).  H1 retained for chart display and SL calculation.
      • 1   — every 10 cycles.     Fine-grain chart display.

    Rate limiting: CANDLE_DELAY_S = 0.12 s between each kline request → ≤ 8 req/s.
    Normal cycle (240 + 15 + 5 + 60): 19 × 4 = 76 req → 76 × 0.12 ≈ 9.1 s per cycle.
    """
    FETCH_TIMEOUT  = 20.0
    MAX_BACKOFF    = 60.0
    CANDLE_DELAY_S = 0.12
    cycle          = 0
    fail_counts: dict[str, int] = {sym: 0 for sym in BYBIT_SYMBOLS}

    async def _safe_candles(sym: str, iv: str):
        await asyncio.sleep(CANDLE_DELAY_S)
        try:
            return await asyncio.wait_for(fetch_candles(sym, iv), timeout=FETCH_TIMEOUT)
        except asyncio.TimeoutError:
            logger.warning("Bybit timeout %ss: %s %s", FETCH_TIMEOUT, sym, iv)
        except Exception as exc:
            logger.warning("Bybit candle %s %s: %s", sym, iv, exc)
        fail_counts[sym] = fail_counts.get(sym, 0) + 1
        return None

    while True:
        try:
            # ── Tickers ───────────────────────────────────────────────────────
            try:
                ticker_data = await asyncio.wait_for(
                    fetch_tickers(BYBIT_SYMBOLS), timeout=15.0
                )
                for sym, meta in ticker_data.items():
                    state.bybit_prices[sym] = meta["price"]
                    state.bybit_meta[sym]   = meta
            except Exception as tick_exc:
                logger.warning("Bybit ticker refresh: %s", tick_exc)

            # ── Candles + SMC ─────────────────────────────────────────────────
            for sym in BYBIT_SYMBOLS:
                fails   = fail_counts.get(sym, 0)
                backoff = min(5.0 * (2 ** max(0, fails - 1)), MAX_BACKOFF) if fails > 0 else 0.0
                if backoff:
                    await asyncio.sleep(backoff)

                # Build the fetch list for this cycle.
                # CryptoSMCEngine uses 15m as the structural timeframe, so
                # "15" is now fetched every cycle (same cadence as "5").
                # "60" (H1) is still fetched every cycle for chart display
                # and for SL calculation in candle_anchor_levels().
                intervals_this_cycle: list[str] = ["15", "5", "60"]
                if cycle % HTF_REFRESH_CYCLES == 0:
                    intervals_this_cycle.insert(0, "240")
                if cycle % 10 == 0:
                    intervals_this_cycle.append("1")

                for iv in intervals_this_cycle:
                    result = await _safe_candles(sym, iv)
                    if result is not None:
                        state.bybit_candle_cache[sym][iv] = result
                        if result:
                            fail_counts[sym] = 0

                # ── SMC analysis (full 4-stage MTF) ──────────────────────────
                try:
                    candles_4h  = state.bybit_candle_cache[sym].get("240", [])
                    candles_15m = state.bybit_candle_cache[sym].get("15",  [])
                    candles_m5  = state.bybit_candle_cache[sym].get("5",   [])
                    price       = state.bybit_prices.get(sym)

                    # Minimum data gates:
                    #   4H  — 200 bars for EMA-200 bias
                    #   15m — 100 bars (≈25h) for sweep + momentum detection
                    #   5m  —  20 bars for entry zone detection
                    if (not price
                            or len(candles_4h)  < 200
                            or len(candles_15m) < 100
                            or len(candles_m5)  < 20):
                        continue

                    if trade_tracker.is_locked(sym):
                        continue

                    # Pass candles_15m as the second (structural) argument.
                    # CryptoSMCEngine expects: (4H, 15m, 5m, price, ts)
                    signal: Optional[TradeSignal] = state.bybit_engines[sym].analyze(
                        candles_4h, candles_15m, candles_m5,
                        price, int(time.time()),
                    )

                    if signal:
                        sig_dict = {
                            "type":       "BYBIT_SIGNAL",
                            "symbol":     sym,
                            "instrument": sym,
                            "engine":     "BYBIT",
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
                        state.bybit_signal_history[sym] = (
                            [sig_dict] + state.bybit_signal_history[sym]
                        )[:50]
                        logger.info(
                            "⚡ BYBIT SIGNAL: %s %s conf=%d%%",
                            sym, signal.direction.value, signal.confidence,
                        )

                        if signal.confidence >= 95:
                            lbl     = sym.replace("USDT", "/USDT")
                            is_full = signal.confidence >= 100
                            asyncio.create_task(push_notification(
                                "signal",
                                (
                                    f"🚨 New 100% Signal: {lbl} {signal.direction.value.title()}!"
                                    if is_full
                                    else f"⚡ {signal.confidence}% Setup: {lbl} {signal.direction.value.title()}"
                                ),
                                (
                                    f"Entry {signal.entry_price:.4f}  ·  "
                                    f"SL {signal.stop_loss:.4f}  ·  "
                                    f"TP {signal.take_profit:.4f}  ·  "
                                    f"R:R 1:{signal.risk_reward}"
                                ),
                                {
                                    "symbol":     sym,
                                    "direction":  signal.direction.value,
                                    "entry":      round(signal.entry_price, 5),
                                    "confidence": signal.confidence,
                                    "engine":     "BYBIT",
                                },
                            ))

                        if signal.confidence >= 100:
                            asyncio.create_task(auto_execute(sym, sig_dict, signal))

                except Exception as smc_exc:
                    logger.warning("Bybit SMC %s: %s", sym, smc_exc)

        except Exception as loop_exc:
            logger.error("bybit_refresh_loop error: %s — restart in 15s", loop_exc)
            await asyncio.sleep(15)
            continue

        cycle += 1
        await asyncio.sleep(60)