// Drives a REAL text-mode session against the live Worker.
//
// This is the only harness that exercises the actual storage path: the
// Durable Object, the summariser, and cross-character scoping. eval/memory.ts
// tests the prompt in isolation and cannot see any of that.
//
//   node eval/live-memory.mjs ../../../eval-token.key
//
// Needs eval-token.key at the repo root - a login token for a THROWAWAY test
// account, never the pilot user, because every run writes real episode rows.
// Create one with the commands in doc/08-operations.md, then:
//   $r = Invoke-RestMethod -Method Post -Uri "$api/auth/login" -ContentType 'application/json' `
//        -Headers @{ Origin = 'http://localhost' } -Body $body
//   $r.token | Set-Content .\eval-token.key -NoNewline
//
// Two things that will waste your time otherwise:
//   - /auth/login and /ws both reject a request with NO Origin header. A
//     terminal sends none. Pass Origin: http://localhost - it is on the
//     allowlist. /auth/register is NOT origin-checked, which is why creating
//     an account works but logging in appears to fail.
//   - The token expires after 7 days. Re-run the login step only.
//
// `ws` is used via an absolute require from the worker's node_modules - it is
// already there as a wrangler dependency, so package.json stays untouched.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
// `ws` comes from the worker's own node_modules - it is already there as a
// wrangler dependency, so package.json stays untouched. Resolved relative to
// this file rather than to the cwd, so the harness runs from anywhere.
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

// Defaults to a local `wrangler dev`, which is where you want it: the Durable
// Object, the summariser and the fact writer all run for real against a local
// SQLite nobody else is using, so you can exercise code that is not deployed.
// Point it at a deployed Worker with:
//   COMPANION_WS=wss://your-worker.workers.dev/ws node eval/live-pipeline.mjs <token-file>
const API_WS = process.env.COMPANION_WS || 'ws://localhost:8787/ws';
const ORIGIN = 'http://localhost';

export function openSession(tokenPath, character, { build = 'eval-probe' } = {}) {
  const token = readFileSync(tokenPath, 'utf8').trim();
  const url = `${API_WS}?character=${encodeURIComponent(character)}&token=${encodeURIComponent(token)}&build=${build}`;
  const ws = new WebSocket(url, { origin: ORIGIN });
  const events = [];
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    // The server sends base64 in `data`, not `audio`. Reading the wrong field
    // made every audio chunk look like zero bytes, so "TTS produced nothing"
    // was unfalsifiable here - it always looked true.
    if (m.type === 'audio_chunk' || m.type === 'greeting_audio') {
      events.push({ type: m.type, bytes: (m.data || '').length, error: m.error });
      return;
    }
    events.push(m);
  });
  const ready = new Promise((res, rej) => {
    ws.on('open', () => res());
    ws.on('error', (e) => rej(e));
  });
  return { ws, events, ready };
}

/** Send one turn and wait for response_end. Returns the full reply text. */
export function ask(sess, text, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('turn timeout')), timeoutMs);
    const onMsg = (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'response_end') {
        clearTimeout(t); sess.ws.off('message', onMsg);
        resolve({ reply: m.reply ?? '', latencyMs: m.latency_ms, ttftMs: m.ttft_ms });
      }
      if (m.type === 'error') { clearTimeout(t); sess.ws.off('message', onMsg); reject(new Error(m.detail || 'server error')); }
    };
    sess.ws.on('message', onMsg);
    sess.ws.send(JSON.stringify({ message: text }));
  });
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── HTTP side: inspect and wipe ───────────────────────────────
//
// What makes an unattended run possible. Without a wipe between runs the test
// account's memory fills up with everything previous runs told it, and by the
// twentieth run every result is contaminated by the nineteen before it.

const API_HTTP = API_WS.replace(/^ws/, 'http').replace(/\/ws$/, '');

async function authed(tokenPath, path, method) {
  const token = readFileSync(tokenPath, 'utf8').trim();
  const res = await fetch(`${API_HTTP}${path}`, {
    method,
    headers: { Origin: ORIGIN, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

/** Row counts per table. */
export const memorySummary = (tokenPath) => authed(tokenPath, '/memory', 'GET');

/** The stored rows themselves - episodes, facts with grades, open loops. */
export const inspectMemory = (tokenPath) => authed(tokenPath, '/memory?full=1', 'GET');

/** Start from nothing. Safe only on a throwaway account - it is irreversible. */
export const wipeMemory = (tokenPath) => authed(tokenPath, '/memory', 'DELETE');
