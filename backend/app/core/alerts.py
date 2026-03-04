"""
app/core/alerts.py — Typed multi-sound OneSignal push notifications.

Sound profile mapping:
  signal  → signal.wav     / 26b3d408-b543-4708-8860-8326a6db4584
  tp      → take_profit.wav/ 969e380e-5a81-41ea-8edc-09e35779a2b5
  sl      → stop_loss.wav  / 0930daae-8c84-493e-ba48-c23cf5381507
  ttl     → ttl_close.wav  / 7ce477fa-c859-46e1-9520-451d8d8812df
"""
from __future__ import annotations
import logging
import httpx
from app.core.config import ONESIGNAL_APP_ID, ONESIGNAL_REST_KEY
import app.core.state as state

logger = logging.getLogger("fx-signal")

# (ios_sound, android_channel_id, android_sound, notification_group)
_PUSH_PROFILES: dict[str, tuple[str, str, str, str]] = {
    "signal": ("signal.wav",      "26b3d408-b543-4708-8860-8326a6db4584", "signal",      "fx-signals"),
    "tp":     ("take_profit.wav", "969e380e-5a81-41ea-8edc-09e35779a2b5", "take_profit", "fx-exits"),
    "sl":     ("stop_loss.wav",   "0930daae-8c84-493e-ba48-c23cf5381507", "stop_loss",   "fx-exits"),
    "ttl":    ("ttl_close.wav",   "7ce477fa-c859-46e1-9520-451d8d8812df", "ttl_close",   "fx-exits"),
}
_PUSH_DEFAULT = ("signal.wav", "26b3d408-b543-4708-8860-8326a6db4584", "signal", "fx-signals")


async def push_notification(
    notification_type: str,  # 'signal' | 'tp' | 'sl' | 'ttl'
    title: str,
    body:  str,
    data:  dict,
) -> None:
    """
    Fire a typed OneSignal push to all registered subscribers.
    Each type carries its own sound file and Android channel ID.
    No-ops silently when credentials or subscribers are absent.
    """
    if not ONESIGNAL_APP_ID or not ONESIGNAL_REST_KEY:
        return
    if not state.push_subscriptions:
        return

    ios_snd, chan_id, and_snd, group = _PUSH_PROFILES.get(
        notification_type, _PUSH_DEFAULT
    )
    inst_key = data.get("instrument", data.get("symbol", "fx-signal"))

    payload = {
        "app_id":                   ONESIGNAL_APP_ID,
        "include_subscription_ids": list(state.push_subscriptions),
        "headings":                 {"en": title},
        "contents":                 {"en": body},
        "data":                     {**data, "notification_type": notification_type},
        "ios_sound":                ios_snd,
        "android_sound":            and_snd,
        "android_channel_id":       chan_id,
        "android_vibrate":          True,
        "android_group":            group,
        "android_group_message":    {"en": "$[notif_count] FX Signal alerts"},
        "thread_id":                group,
        "summary_arg":              "FX Signal",
        "collapse_id":              f"{notification_type}:{inst_key}",
        "content_available":        True,
        "priority":                 10,
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                "https://onesignal.com/api/v1/notifications",
                headers={
                    "Authorization": f"Basic {ONESIGNAL_REST_KEY}",
                    "Content-Type":  "application/json",
                },
                json=payload,
            )
        if resp.status_code not in (200, 201):
            logger.warning("[push:%s] failed %s — %s", notification_type, resp.status_code, resp.text[:200])
        else:
            logger.info("📲 [%s] → %d sub(s)  snd=%s  %s", notification_type, len(state.push_subscriptions), ios_snd, body[:60])
    except Exception as exc:
        logger.warning("[push:%s] error: %s", notification_type, exc)
