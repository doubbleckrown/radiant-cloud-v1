/**
 * usePushNotifications.js  ·  FX Radiant
 * ══════════════════════════════════════════════════════════════════════════════
 * Manages the full OneSignal push lifecycle — now fully automatic.
 *
 * Previous version required the user to tap "Enable Alerts".
 * New behaviour:
 *   • On mount, init the SDK silently.
 *   • If permission is already 'granted'  → fetch/register the player ID
 *     immediately (returning user, no prompt needed).
 *   • If permission is 'default'          → call requestPermission() to show
 *     the OS dialog automatically.  No user gesture required on mobile PWA;
 *     desktop Chrome will queue it until the next user interaction.
 *   • If permission is 'denied'           → do nothing; app still works for
 *     local foreground notifications once the user re-enables in OS settings.
 *
 * The hook still returns { supported, permission, subscribed, loading, error }
 * so callers can render status (e.g. a small "notifications blocked" hint)
 * without needing to expose a subscribe button.
 */

import { useState, useEffect } from 'react';
import api from '../utils/api';
import {
  initOneSignal,
  requestPermission,
  waitForSubscriptionId,
  isSubscribed,
} from '../services/pushNotifications';

const APP_ID = import.meta.env.VITE_ONESIGNAL_APP_ID;

export function usePushNotifications() {
  const supported =
    typeof window !== 'undefined' &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    Boolean(APP_ID);

  const [permission,  setPermission]  = useState(() =>
    typeof Notification !== 'undefined' ? Notification.permission : 'default'
  );
  const [subscribed,  setSubscribed]  = useState(false);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState(null);

  useEffect(() => {
    if (!supported) return;

    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);

      try {
        // ── Step 1: init SDK (registers SW, loads script, calls OneSignal.init)
        await initOneSignal();
        if (cancelled) return;

        const currentPerm = typeof Notification !== 'undefined'
          ? Notification.permission
          : 'default';
        setPermission(currentPerm);

        // ── Step 2: already subscribed? Just re-register the ID silently
        if (isSubscribed()) {
          const id = await waitForSubscriptionId(5_000);
          if (!cancelled && id) {
            // Fire-and-forget — backend just upserts the player ID
            api.post('/push/register', { player_id: id }).catch(() => {});
            setSubscribed(true);
          }
          return;
        }

        // ── Step 3: permission already granted but not yet subscribed
        //   (e.g. page refreshed after user approved earlier in the session)
        if (currentPerm === 'granted') {
          const id = await waitForSubscriptionId(10_000);
          if (cancelled) return;
          if (id) {
            await api.post('/push/register', { player_id: id });
            setSubscribed(true);
          }
          return;
        }

        // ── Step 4: permission is 'default' — ask the OS automatically
        //   On mobile PWA and most browsers this shows the native prompt.
        //   Desktop Chrome requires a user gesture; if blocked it simply
        //   leaves permission as 'default' and we do nothing.
        if (currentPerm === 'default') {
          const perm = await requestPermission();
          if (cancelled) return;
          setPermission(perm);

          if (perm === 'granted') {
            // Wait for OneSignal to complete the server-side subscription
            const id = await waitForSubscriptionId(20_000);
            if (cancelled) return;
            if (id) {
              await api.post('/push/register', { player_id: id });
              setSubscribed(true);
            } else {
              // Token never arrived — could be a dashboard/HTTPS config issue
              // Log to console but don't surface an error to the UI
              console.warn('[FX Radiant] Push token timeout — check OneSignal dashboard & site origin');
            }
          }
          // If 'denied': do nothing, silently let it go
        }
      } catch (err) {
        if (!cancelled) {
          // Non-fatal: log but don't break the UI
          console.warn('[FX Radiant] Push auto-subscribe error:', err);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [supported]); // run once after mount

  return { supported, permission, subscribed, loading, error };
}