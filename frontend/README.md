# fx-signal v4.0 — Dual-Engine Architecture

## Backend: `app/`

```
app/
├── main.py                   ← FastAPI entry point, lifespan, WS, health
├── core/
│   ├── config.py             ← All env vars, instrument lists, constants
│   ├── state.py              ← Shared in-memory dicts (Oanda + Bybit, isolated)
│   ├── auth.py               ← Clerk RS256 JWT verification
│   ├── alerts.py             ← Typed OneSignal push (signal/tp/sl/ttl)
│   └── trade_tracker.py      ← Single TradeTracker instance (both engines)
├── database/
│   └── user_vault.py         ← Clerk-linked JSON profiles (oanda_risk, bybit_risk, bot_enabled, ttl)
├── engines/
│   ├── oanda/
│   │   ├── engine.py         ← SSE price stream + candle refresh + SMC loop
│   │   └── executor.py       ← fetch_account/trades, place_market_order (XAU int fix), auto_execute
│   ├── bybit/
│   │   ├── engine.py         ← Ticker poll + candle refresh + SMC loop
│   │   └── executor.py       ← sign_post (compact JSON fix for 10004), fetch_positions, auto_execute
│   └── watcher.py            ← Unified TP/SL/TTL exit monitor (30s sweep, both engines)
├── routes/
│   ├── routes_markets.py     ← /api/markets, /api/bybit/market, candles, analysis
│   ├── routes_signals.py     ← /api/signals, /api/bybit/signals, trade-locks
│   ├── routes_account.py     ← /api/account, /api/bybit/account, manual close
│   └── routes_profile.py     ← /api/profile, /api/profile/update (Clerk-linked)
└── services/
    └── strategy.py           ← SMCConfluenceEngine (unchanged)
```

## Frontend: `src/`

```
src/
├── App.jsx                   ← Root shell, Binance-style transitions (preserved)
├── pages/
│   ├── MarketsPage.jsx       ← Market cards, price glow, 24h % (preserved)
│   ├── SignalsPage.jsx       ← Active/History tabs; FAILED→History immediately
│   ├── AccountPage.jsx       ← Summary/Open Trades/History (preserved)
│   └── ProfilePage.jsx       ← 5 sections: User·Bot·Risk·Security·About
├── hooks/
│   ├── useTheme.js
│   ├── useWebSocket.js
│   └── usePushNotifications.js
└── store/
    └── authStore.js
```

## Critical Fixes

### Bybit Error 10004 (Invalid Signature)
`app/engines/bybit/executor.py` → `sign_post()`:
```python
body_str = json.dumps(body, separators=(",", ":"), ensure_ascii=True)
sig      = _sign(secret, ts + api_key + BYBIT_RECV_WINDOW + body_str)
```
Compact JSON (no spaces) is mandatory. Standard `json.dumps` adds spaces → signature mismatch.

### Oanda XAU_USD Integer Units
`app/engines/oanda/executor.py` → `place_market_order()`:
```python
units_str = str(int(units))   # "1" not "1.0" — Oanda v20 rejects floats for metals
```

### Oanda Open Position Deduplication
`fetch_open_trades()` groups by instrument, keeps highest (most recent) trade ID.

### Clerk-Linked User Vault
`app/database/user_vault.py` stores per-user profiles in `user_vault/{clerk_id}.json`.
Routes read `payload["sub"]` from the Clerk JWT — no shared global state.
Fixes "Sync Failed" by writing to the correct user file instead of `settings.json`.

### SignalsPage Failed→History
Signals with `exec_status === "failed"` are always routed to History tab immediately,
never shown in Active — preventing stale failed cards from blocking the active view.

### Multi-Tone Notifications
`app/core/alerts.py` maps each event type to its own iOS sound + Android channel:
- `signal`  → signal.wav      / 26b3d408-...
- `tp`      → take_profit.wav / 969e380e-...
- `sl`      → stop_loss.wav   / 0930daae-...
- `ttl`     → ttl_close.wav   / 7ce477fa-...
