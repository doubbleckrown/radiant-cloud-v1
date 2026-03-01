/**
 * pushNotifications.js  ·  FX Radiant
 * ══════════════════════════════════════════════════════════════════════════════
 * OneSignal Web SDK v16 wrapper.
 *
 * Key changes from previous version:
 *   • Pre-registers the service worker explicitly (scope '/') BEFORE
 *     OneSignal.init() runs.  This prevents the "wrong scope" error that
 *     causes push token registration to silently fail.
 *   • Replaces the unreliable polling loop with OneSignal's own
 *     PushSubscription 'change' event listener.  The event fires exactly
 *     once when the server-side subscription ID arrives — no more racing.
 *   • Exports waitForSubscriptionId() so the hook can await it directly.
 *   • All other behaviour (graceful no-op, deferred init, showLocalNotification)
 *     is unchanged.
 */

const APP_ID = import.meta.env.VITE_ONESIGNAL_APP_ID;

let _ready       = false;
let _initPromise = null;


// ═════════════════════════════════════════════════════════════════════════════
//  Public API
// ═════════════════════════════════════════════════════════════════════════════

export async function initOneSignal() {
  if (!APP_ID)      return;
  if (_ready)       return;
  if (_initPromise) return _initPromise;
  _initPromise = _loadAndInit();
  await _initPromise;
}

export async function requestPermission() {
  if (!APP_ID || !_ready || !window.OneSignal)
    return typeof Notification !== 'undefined' ? Notification.permission : 'default';
  try {
    await window.OneSignal.Notifications.requestPermission();
    return Notification.permission;
  } catch {
    return typeof Notification !== 'undefined' ? Notification.permission : 'default';
  }
}

/** Synchronous read of the current subscription ID — null if not yet available. */
export function getPlayerId() {
  if (!APP_ID || !_ready || !window.OneSignal) return null;
  try { return window.OneSignal.User.PushSubscription.id ?? null; } catch { return null; }
}

/**
 * Event-driven wait for the subscription ID.
 *
 * Problem with the old polling approach:
 *   OneSignal's PushSubscription.id is populated after an async server
 *   key-exchange.  Polling getPlayerId() every 500 ms races that handshake
 *   and loses on slower connections, producing "Could not get push token".
 *
 * Solution:
 *   OneSignal v16 emits a 'change' event on User.PushSubscription when
 *   id transitions from null to a real value.  We listen for exactly that
 *   event and resolve the promise the moment it fires.
 */
export function waitForSubscriptionId(timeoutMs = 20_000) {
  return new Promise((resolve) => {
    if (!APP_ID || !_ready || !window.OneSignal) { resolve(null); return; }

    // Already available synchronously?
    const immediate = getPlayerId();
    if (immediate) { resolve(immediate); return; }

    let settled = false;
    const done = (id) => {
      if (settled) return;
      settled = true;
      try {
        window.OneSignal.User.PushSubscription.removeEventListener('change', onChange);
      } catch { /* ignore */ }
      resolve(id ?? null);
    };

    const onChange = (event) => {
      const id = event?.current?.id ?? getPlayerId();
      if (id) done(id);
    };

    try {
      window.OneSignal.User.PushSubscription.addEventListener('change', onChange);
    } catch {
      // If addEventListener is unavailable the timeout below will resolve null
    }

    setTimeout(() => done(null), timeoutMs);
  });
}

export function isSubscribed() {
  if (!APP_ID || !_ready || !window.OneSignal) return false;
  try { return window.OneSignal.User.PushSubscription.optedIn ?? false; } catch { return false; }
}

export function showLocalNotification(title, body, data = {}) {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  try {
    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.ready.then((reg) => {
        reg.showNotification(title, {
          body, icon: '/favicon.ico', badge: '/favicon.ico',
          vibrate: [200, 100, 200], tag: 'fx-radiant-signal', renotify: true, data,
        });
      });
    } else {
      new Notification(title, { body, icon: '/favicon.ico', tag: 'fx-radiant-signal', renotify: true });
    }
  } catch { /* best-effort */ }
}


// ═════════════════════════════════════════════════════════════════════════════
//  Private: load SDK + init
// ═════════════════════════════════════════════════════════════════════════════

async function _loadAndInit() {
  // ── 1. Pre-register service worker BEFORE the SDK loads ──────────────────
  //
  // This is the key fix for the token error.  If the browser has no active
  // SW — or has one on a wrong scope — OneSignal's push subscription will
  // fail silently.  Registering manually with { scope: '/' } and waiting
  // for .ready guarantees OneSignal finds an active worker immediately.
  //
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('/OneSignalSDKWorker.js', {
        scope:          '/',
        updateViaCache: 'none',
      });
      await navigator.serviceWorker.ready;   // wait until controller is active
    } catch (e) {
      console.warn('[FX Radiant] SW registration failed (non-fatal):', e);
    }
  }

  // ── 2. Inject SDK script once ──────────────────────────────────────────
  if (!document.getElementById('onesignal-page-sdk')) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.id      = 'onesignal-page-sdk';
      s.src     = 'https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js';
      s.defer   = true;
      s.onload  = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // ── 3. Initialize via deferred queue ──────────────────────────────────
  await new Promise((resolve) => {
    window.OneSignalDeferred = window.OneSignalDeferred || [];
    window.OneSignalDeferred.push(async (OneSignal) => {
      try {
        await OneSignal.init({
          appId:   APP_ID,
          // Must match the scope used in register() above
          serviceWorkerPath:            '/OneSignalSDKWorker.js',
          serviceWorkerParam:           { scope: '/' },
          notifyButton:                 { enable: false },
          promptOptions:                { autoPrompt: false },
          allowLocalhostAsSecureOrigin: true,
        });
        _ready = true;
      } catch (e) {
        console.warn('[FX Radiant] OneSignal init error:', e);
      }
      resolve();
    });
  });
}