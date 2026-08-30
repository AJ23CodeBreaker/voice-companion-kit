/**
 * Runtime config. Edited in place rather than built, so the page stays a
 * single static file you can host anywhere.
 *
 *   Local dev  : ws://localhost:8787/ws
 *   Deployed   : wss://your-worker.workers.dev/ws   (wss:// on an HTTPS site)
 *
 * Whatever origin you serve this page from must also be in ALLOWED_ORIGINS in
 * worker/src/index.ts, or /ws and /auth/login will refuse the connection. That
 * is the check working, not a bug.
 *
 * No speech-to-text key here: the Worker mints a short-lived one per
 * connection via GET {API_BASE_URL}/deepgram-token, so the long-lived key
 * never reaches a browser.
 */

window.APP_CONFIG = {
  WS_URL:       'ws://localhost:8787/ws',
  API_BASE_URL: 'http://localhost:8787',
};
