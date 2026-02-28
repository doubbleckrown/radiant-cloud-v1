/**
 * pushNotifications.js
 * ══════════════════════════════════════════════════════════════
 * OneSignal Web SDK v16 wrapper.
 *
 * Design principles:
 *   • Gracefully no-ops everywhere if VITE_ONESIGNAL_APP_ID is absent —
 *     the app never crashes in envs without push configured.
 *   • Loads the SDK script lazily (injected into <head> on first call).
 *   • Exposes a tiny surface: init / requestPermission / getPlayerId / isSubscribed.
 *   • Also exposes showLocalNotification() for foreground alerts (when tab is open).
 *
 * OneSignal v16 API reference used here:
 *   OneSignal.init(config)
 *   OneSignal.Notifications.requestPermission()
 *   OneSignal.User.PushSubscription.id       → player/subscription ID
 *   OneSignal.User.PushSubscription.optedIn  → boolean
 */

const APP_ID = import.meta.env.VITE_ONESIGNAL_APP_ID;

// ── Module-level state ────────────────────────────────────────────────────────
let _ready       = false;   // true once init() has resolved
let _initPromise = null;    // deduplicate concurrent init() calls


// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load the OneSignal CDN script and call OneSignal.init().
 * Safe to call multiple times — resolves immediately on subsequent calls.
 */
export async function initOneSignal() {
  if (!APP_ID)         return;   // not configured — exit silently
  if (_ready)          return;
  if (_initPromise)    return _initPromise;

  _initPromise = _loadAndInit();
  await _initPromise;
}

/**
 * Ask the user for notification permission via the OS dialog.
 * Returns the Notification API permission string: 'granted' | 'denied' | 'default'
 */
export async function requestPermission() {
  if (!APP_ID || !_ready || !window.OneSignal) return Notification.permission ?? 'default';
  try {
    await window.OneSignal.Notifications.requestPermission();
    return Notification.permission;
  } catch {
    return Notification.permission ?? 'default';
  }
}

/**
 * Returns the OneSignal player / subscription ID, or null if not subscribed.
 * Send this to the backend to target this specific device for push.
 */
export async function getPlayerId() {
  if (!APP_ID || !_ready || !window.OneSignal) return null;
  try {
    // v16: synchronous property once initialised
    return window.OneSignal.User.PushSubscription.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Returns true if this device has an active OneSignal push subscription.
 */
export async function isSubscribed() {
  if (!APP_ID || !_ready || !window.OneSignal) return false;
  try {
    return window.OneSignal.User.PushSubscription.optedIn ?? false;
  } catch {
    return false;
  }
}

/**
 * Show a LOCAL (foreground) notification using the Web Notifications API.
 * This fires instantly when the tab is open — no round-trip to a push server.
 * Used as the immediate in-app alert; OneSignal handles background push.
 *
 * @param {string} title  — e.g. "🚨 High Probability Setup"
 * @param {string} body   — e.g. "EUR/USD Long at 1.0850  ·  95% confluence"
 * @param {object} data   — arbitrary payload attached to the notification
 */
export function showLocalNotification(title, body, data = {}) {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;

  try {
    // Use service worker notification if available (shows even if tab loses focus)
    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.ready.then(reg => {
        reg.showNotification(title, {
          body,
          icon:    '/favicon.ico',
          badge:   '/favicon.ico',
          vibrate: [200, 100, 200],   // pattern: buzz · pause · buzz
          tag:     'fx-radiant-signal',
          renotify: true,
          data,
        });
      });
    } else {
      // Fallback: plain Notification constructor
      new Notification(title, {
        body,
        icon: '/favicon.ico',
        tag:  'fx-radiant-signal',
        renotify: true,
      });
    }
  } catch {
    // Silently ignore — notifications are best-effort
  }
}


// ── Private helpers ───────────────────────────────────────────────────────────

async function _loadAndInit() {
  // 1. Inject the SDK <script> once
  if (!document.getElementById('onesignal-page-sdk')) {
    await new Promise((resolve, reject) => {
      const s  = document.createElement('script');
      s.id     = 'onesignal-page-sdk';
      s.src    = 'https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js';
      s.defer  = true;
      s.onload  = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // 2. Initialize via the deferred queue (OneSignal's recommended pattern)
  await new Promise((resolve) => {
    window.OneSignalDeferred = window.OneSignalDeferred || [];
    window.OneSignalDeferred.push(async (OneSignal) => {
      try {
        await OneSignal.init({
          appId:                        APP_ID,
          serviceWorkerPath:            '/OneSignalSDKWorker.js',
          // Disable OneSignal's own permission prompt UI — we show our own
          notifyButton:                 { enable: false },
          promptOptions:                { autoPrompt: false },
          // Allow http://localhost during development
          allowLocalhostAsSecureOrigin: true,
        });
        _ready = true;
      } catch (e) {
        console.warn('[FX Radiant] OneSignal init failed:', e);
      }
      resolve();
    });
  });
}