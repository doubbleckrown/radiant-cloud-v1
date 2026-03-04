"""
app/engines/bybit/engine.py — Bybit ticker refresh + candle polling + SMC analysis.
Completely isolated from Oanda state — only touches bybit_* dicts in state.py.
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
                "price":    float(item.get("lastPrice",       0) or 0),
                "high24h":  float(item.get("highPrice24h",    0) or 0),
                "low24h":   float(item.get("lowPrice24h",     0) or 0),
                "volume24h":float(item.get("turnover24h",     0) or 0),
                "change24h":round(float(item.get("price24hPcnt", 0) or 0) * 100, 2),
            }
        except (ValueError, TypeError):
            pass
    return result


async def fetch_candles(symbol: str, interval: str, limit: int = 200) -> list[Candle]:
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.get(f"{BYBIT_BASE}/v5/market/kline", params={
            "category": "linear", "symbol": symbol,
            "interval": interval, "limit": str(min(limit, 200)),
        })
        r.raise_for_status()
    data = r.json()
    if data.get("retCode", -1) != 0:
        raise RuntimeError(f"Bybit kline {symbol} {data.get('retCode')}: {data.get('retMsg')}")
    rows = data.get("result", {}).get("list", [])
    candles = [
        Candle(time=int(row[0])//1000, open=float(row[1]), high=float(row[2]),
               low=float(row[3]), close=float(row[4]), volume=float(row[5]))
        for row in rows if len(row) >= 6
    ]
    candles.reverse()              # Bybit newest-first → oldest-first
    return candles[:-1] if candles else candles   # drop still-forming candle


async def bybit_refresh_loop() -> None:
    """Refresh tickers + candles every 60 s, run SMC, auto-execute at 100%."""
    FETCH_TIMEOUT = 20.0
    MAX_BACKOFF   = 60.0
    fail_counts: dict[str, int] = {sym: 0 for sym in BYBIT_SYMBOLS}

    async def _safe_candles(sym: str, iv: str):
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
            # ── Tickers ──────────────────────────────────────────────────
            try:
                ticker_data = await asyncio.wait_for(fetch_tickers(BYBIT_SYMBOLS), timeout=15.0)
                for sym, meta in ticker_data.items():
                    state.bybit_prices[sym] = meta["price"]
                    state.bybit_meta[sym]   = meta
            except Exception as tick_exc:
                logger.warning("Bybit ticker refresh: %s", tick_exc)

            # ── Candles + SMC ─────────────────────────────────────────────
            for sym in BYBIT_SYMBOLS:
                fails   = fail_counts.get(sym, 0)
                backoff = min(5.0 * (2 ** max(0, fails - 1)), MAX_BACKOFF) if fails > 0 else 0.0
                if backoff:
                    await asyncio.sleep(backoff)

                for iv in BYBIT_INTERVALS:
                    result = await _safe_candles(sym, iv)
                    if result is not None:
                        state.bybit_candle_cache[sym][iv] = result
                        if result:
                            fail_counts[sym] = 0

                try:
                    h1    = state.bybit_candle_cache[sym]["60"]
                    price = state.bybit_prices.get(sym)
                    if price and len(h1) >= 60 and not trade_tracker.is_locked(sym):
                        signal: Optional[TradeSignal] = state.bybit_engines[sym].analyze(
                            h1, price, int(time.time()),
                        )
                        if signal:
                            sig_dict = {
                                "type": "BYBIT_SIGNAL", "symbol": sym, "instrument": sym,
                                "engine": "BYBIT",
                                "direction": signal.direction.value,
                                "entry":     round(signal.entry_price,     5),
                                "sl":        round(signal.stop_loss,       5),
                                "tp":        round(signal.take_profit,     5),
                                "breakeven": round(signal.breakeven_price, 5),
                                "rr":        signal.risk_reward,
                                "confidence":signal.confidence,
                                "layer1":    signal.layer1_bias,
                                "layer2":    signal.layer2_zone,
                                "layer3":    signal.layer3_mss,
                                "timestamp": signal.timestamp,
                                "exec_status": None,
                            }
                            state.bybit_signal_history[sym] = ([sig_dict] + state.bybit_signal_history[sym])[:50]
                            logger.info("⚡ BYBIT SIGNAL: %s %s conf=%d%%", sym, signal.direction.value, signal.confidence)

                            if signal.confidence >= 95:
                                lbl     = sym.replace("USDT", "/USDT")
                                is_full = signal.confidence >= 100
                                asyncio.create_task(push_notification(
                                    "signal",
                                    f"🚨 New 100% Signal: {lbl} {signal.direction.value.title()}!" if is_full
                                    else f"⚡ {signal.confidence}% Setup: {lbl} {signal.direction.value.title()}",
                                    f"Entry {signal.entry_price:.4f}  ·  SL {signal.stop_loss:.4f}  ·  TP {signal.take_profit:.4f}  ·  R:R 1:{signal.risk_reward}",
                                    {"symbol": sym, "direction": signal.direction.value, "entry": round(signal.entry_price, 5), "confidence": signal.confidence, "engine": "BYBIT"},
                                ))
                            if signal.confidence >= 100:
                                asyncio.create_task(auto_execute(sym, sig_dict, signal))
                except Exception as smc_exc:
                    logger.warning("Bybit SMC %s: %s", sym, smc_exc)

        except Exception as loop_exc:
            logger.error("bybit_refresh_loop error: %s — restart in 15s", loop_exc)
            await asyncio.sleep(15)
            continue
        await asyncio.sleep(60)
