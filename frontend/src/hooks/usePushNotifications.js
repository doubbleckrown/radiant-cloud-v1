/**
 * usePushNotifications.js
 * ══════════════════════════════════════════════════════════════
 * React hook that manages the full OneSignal push lifecycle:
 *   1. Initialise the SDK on mount
 *   2. Reflect current permission + subscription state
 *   3. Provide a subscribe() function that:
 *        a) Requests OS permission
 *        b) Waits for the OneSignal player ID
 *        c) POSTs it to the backend (/api/push/register)
 *
 * Returns:
 *   {
 *     supported:   boolean   — Web Push is available in this browser
 *     permission:  string    — 'default' | 'granted' | 'denied'
 *     subscribed:  boolean   — actively subscribed to push
 *     loading:     boolean   — subscribe() is in progress
 *     error:       string|null
 *     subscribe:   function
 *   }
 *
 * This hook never throws — errors are captured in the `error` field.
 */

import { useState, useEffect, useCallback } from 'react';
import api from '../utils/api';
import {
  initOneSignal,
  requestPermission,
  getPlayerId,
  isSubscribed,
} from '../services/pushNotifications';

const APP_ID = import.meta.env.VITE_ONESIGNAL_APP_ID;

export function usePushNotifications() {
  // Is Web Push even supported / configured?
  const supported =
    typeof window !== 'undefined' &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    Boolean(APP_ID);

  const [permission,  setPermission]  = useState(() =>
    typeof Notification !== 'undefined' ? Notification.permission : 'default'
  );
  const [subscribed, setSubscribed]  = useState(false);
  const [loading,    setLoading]     = useState(false);
  const [error,      setError]       = useState(null);

  // ── Initialise OneSignal and hydrate state on mount ──────────────────────
  useEffect(() => {
    if (!supported) return;

    let cancelled = false;
    const init = async () => {
      await initOneSignal();
      if (cancelled) return;
      setPermission(Notification.permission);
      setSubscribed(await isSubscribed());
    };
    init();
    return () => { cancelled = true; };
  }, [supported]);

  // ── subscribe() — called when the user taps "Enable Alerts" ─────────────
  const subscribe = useCallback(async () => {
    if (!supported || loading) return;
    setLoading(true);
    setError(null);

    try {
      // Step 1: ensure SDK is ready
      await initOneSignal();

      // Step 2: ask OS for notification permission
      const perm = await requestPermission();
      setPermission(perm);

      if (perm !== 'granted') {
        setError('Permission denied — enable notifications in your browser settings.');
        return;
      }

      // Step 3: wait up to 8 s for OneSignal to produce a player ID
      //         (it needs to complete its own internal subscription handshake)
      let playerId = null;
      for (let attempt = 0; attempt < 16; attempt++) {
        playerId = await getPlayerId();
        if (playerId) break;
        await _sleep(500);
      }

      if (!playerId) {
        setError('Could not get push token — check OneSignal dashboard & HTTPS.');
        return;
      }

      // Step 4: register with the backend
      await api.post('/push/register', { player_id: playerId });

      setSubscribed(true);
    } catch (err) {
      setError(err?.response?.data?.detail ?? 'Push registration failed.');
    } finally {
      setLoading(false);
    }
  }, [supported, loading]);

  return { supported, permission, subscribed, loading, error, subscribe };
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}