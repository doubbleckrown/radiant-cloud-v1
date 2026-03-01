/**
 * OneSignal Service Worker — required at the site root.
 * This single line re-exports the OneSignal background worker.
 * Vite serves everything in /public at the root URL, so this file
 * will be available at https://your-domain.com/OneSignalSDKWorker.js
 */
importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');