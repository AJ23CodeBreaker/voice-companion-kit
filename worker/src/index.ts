// Cloudflare Worker entry point — replaces orchestrator_modal.py's FastAPI
// app for the Voice page only (dist/index.html). See CHANGELOG.md for the
// migration rationale: this path is pure CPU relay work (LLM/TTS/STT APIs),
// no GPU, so it doesn't need Modal at all.

import type { Env } from "./env";
import { CHARACTERS } from "./personas.generated";
import { mintDeepgramToken } from "./deepgram";

export { VoiceSession } from "./session";
export { UserMemory } from "./memory";
export { AuthStore } from "./auth";

// Only these origins may call the API or open a /ws session. The Origin
// header is a weak control on its own (any script can claim any origin) —
// real access control is the login token checked in requireUser() below.
// This list is the cheap first filter, not the security boundary.
// Set this to wherever your frontend is served from. It is a real security
// boundary, not a formality: /ws and /auth/login both refuse a request whose
// Origin is not on it, which is what stops another site opening an
// authenticated socket against your Worker in a signed-in user's browser.
//
// A terminal sends no Origin header at all, which is why the eval harnesses
// pass `Origin: http://localhost` explicitly.
const ALLOWED_ORIGINS = [
  "http://localhost:8791",              // the bundled web/ shell
  // "https://your-frontend.example.com",
];

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // If your host gives every deploy its own preview URL, allow the pattern
  // here rather than listing them. Keep it anchored - a loose regex here is a
  // hole, not a convenience.
  // if (/^https:\/\/[a-z0-9-]+--yourapp\.example\.com$/.test(origin)) return true;
  // Local development
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return false;
}

function corsHeadersFor(origin: string | null): HeadersInit {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Key",
    Vary: "Origin",
  };
  if (isAllowedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin as string;
  }
  return headers;
}

function withCors(resp: Response, origin: string | null): Response {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(corsHeadersFor(origin))) headers.set(k, v);
  return new Response(resp.body, { status: resp.status, headers });
}

function authStub(env: Env) {
  return env.AUTH.get(env.AUTH.idFromName("global"));
}

/**
 * Extract the login token. Browsers can't set custom headers on a WebSocket
 * handshake, so /ws passes it as a query param instead; everything else uses
 * a normal Authorization header.
 */
function extractToken(request: Request, url: URL): string {
  const header = request.headers.get("Authorization") || "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  return url.searchParams.get("token") || "";
}

async function requireUser(
  request: Request,
  url: URL,
  env: Env,
): Promise<{ userId: string; username: string } | null> {
  const token = extractToken(request, url);
  if (!token) return null;
  const result = await authStub(env).verify(token);
  if (!result.ok || !result.userId || !result.username) return null;
  return { userId: result.userId, username: result.username };
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    if (typeof body !== "object" || body === null) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeadersFor(origin) });
    }

    // ── Public: health & character list (no paid calls behind them) ──
    if (url.pathname === "/health" && request.method === "GET") {
      return withCors(
        Response.json({
          status: "ok",
          mode: "voice-only streaming (Cloudflare Workers)",
          deepgram_configured: Boolean(env.DEEPGRAM_API_KEY),
          auth_required: true,
          characters: Object.fromEntries(
            Object.entries(CHARACTERS).map(([id, c]) => [id, c.name]),
          ),
        }),
        origin,
      );
    }

    if (url.pathname === "/characters" && request.method === "GET") {
      return withCors(
        Response.json(
          Object.fromEntries(
            Object.entries(CHARACTERS).map(([id, c]) => [id, { name: c.name, desc: c.desc }]),
          ),
        ),
        origin,
      );
    }

    // ── Auth ────────────────────────────────────────────────────────
    if (url.pathname === "/auth/login" && request.method === "POST") {
      if (!isAllowedOrigin(origin)) {
        return new Response("Forbidden origin", { status: 403 });
      }
      const body = await readJson(request);
      const username = typeof body?.username === "string" ? body.username : "";
      const password = typeof body?.password === "string" ? body.password : "";
      if (!username || !password) {
        return withCors(Response.json({ error: "username and password required" }, { status: 400 }), origin);
      }
      const result = await authStub(env).login(username, password);
      if (!result.ok) {
        return withCors(Response.json({ error: result.error }, { status: 401 }), origin);
      }
      return withCors(
        Response.json({ token: result.token, expires_at: result.expiresAt, username }),
        origin,
      );
    }

    if (url.pathname === "/auth/logout" && request.method === "POST") {
      const token = extractToken(request, url);
      await authStub(env).logout(token);
      return withCors(Response.json({ ok: true }), origin);
    }

    if (url.pathname === "/auth/me" && request.method === "GET") {
      const user = await requireUser(request, url, env);
      if (!user) return withCors(Response.json({ error: "unauthorized" }, { status: 401 }), origin);
      return withCors(Response.json({ username: user.username }), origin);
    }

    // Account creation is admin-only and deliberately has no UI — run it
    // from a terminal with the admin key. Not origin-restricted, because
    // it's called with curl, not from a browser.
    if (url.pathname === "/auth/register" && request.method === "POST") {
      if (!env.APP_SHARED_KEY || request.headers.get("X-Admin-Key") !== env.APP_SHARED_KEY) {
        return new Response("Forbidden", { status: 403 });
      }
      const body = await readJson(request);
      const username = typeof body?.username === "string" ? body.username : "";
      const password = typeof body?.password === "string" ? body.password : "";
      const result = await authStub(env).register(username, password);
      if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
      return Response.json({ ok: true, username: username.trim().toLowerCase() });
    }

    if (url.pathname === "/auth/users" && request.method === "GET") {
      if (!env.APP_SHARED_KEY || request.headers.get("X-Admin-Key") !== env.APP_SHARED_KEY) {
        return new Response("Forbidden", { status: 403 });
      }
      return Response.json({ users: await authStub(env).listUsers() });
    }

    if (url.pathname === "/auth/user" && request.method === "DELETE") {
      if (!env.APP_SHARED_KEY || request.headers.get("X-Admin-Key") !== env.APP_SHARED_KEY) {
        return new Response("Forbidden", { status: 403 });
      }
      const body = await readJson(request);
      const username = typeof body?.username === "string" ? body.username : "";
      const result = await authStub(env).deleteUser(username);
      if (!result.ok) return Response.json({ error: result.error }, { status: 404 });
      return Response.json({ ok: true });
    }

    // ── Authenticated: anything that costs money or holds a session ──
    if (url.pathname === "/deepgram-token" && request.method === "GET") {
      if (!isAllowedOrigin(origin)) {
        return new Response("Forbidden origin", { status: 403 });
      }
      const user = await requireUser(request, url, env);
      if (!user) {
        return withCors(Response.json({ error: "unauthorized" }, { status: 401 }), origin);
      }
      return withCors(await mintDeepgramToken(env.DEEPGRAM_API_KEY), origin);
    }

    // ── Memory: inspection and erasure ──────────────────────────────
    // doc/09 §8 makes this part of shipping memory rather than a later
    // nicety: these tables hold intimate detail about a real person, so the
    // person has to be able to see that they exist and delete them.
    //
    // Authenticated as the USER, not as an admin — this is his data, and the
    // id comes from the verified token, so one user can never reach another's.
    if (url.pathname === "/memory" && (request.method === "GET" || request.method === "DELETE")) {
      if (!isAllowedOrigin(origin)) {
        return new Response("Forbidden origin", { status: 403 });
      }
      const user = await requireUser(request, url, env);
      if (!user) {
        return withCors(Response.json({ error: "unauthorized" }, { status: 401 }), origin);
      }
      const memory = env.MEMORY.get(env.MEMORY.idFromName(user.userId));
      if (request.method === "GET") {
        // ?full=1 returns the stored summaries themselves. Same authentication
        // either way — this is his own data and the id comes from his token.
        if (url.searchParams.get("full") === "1") {
          return withCors(Response.json(await memory.inspect()), origin);
        }
        return withCors(Response.json(await memory.summary()), origin);
      }
      const result = await memory.forgetAll();
      console.log(
        JSON.stringify({ event: "memory_erased", user_id: user.userId, rows: result.deleted, ts: Date.now() }),
      );
      return withCors(Response.json({ ok: true, ...result }), origin);
    }

    // Admin memory inspection. Added 2026-08-19 to debug a wrong memory: the
    // summaries are the only evidence of WHY she recalled something
    // incorrectly, and there was no way to read them.
    //
    // This is a real privacy surface — it lets the operator read summaries of
    // another person's intimate conversations. It is admin-only, it is never
    // reachable from a user token, and every use is logged with the target.
    // On a private pilot where the operator owns the data that is an
    // acceptable trade; it would not be on a public product.
    // Admin erasure. Separate from the user-authenticated DELETE /memory,
    // which needs a password nobody should be handling on the user's behalf.
    // Total and irreversible — facts are invalidated rather than deleted in
    // normal operation, but "forget this person" means gone, not flagged.
    if (url.pathname === "/admin/memory" && request.method === "DELETE") {
      if (!env.APP_SHARED_KEY || request.headers.get("X-Admin-Key") !== env.APP_SHARED_KEY) {
        return new Response("Forbidden", { status: 403 });
      }
      const username = (url.searchParams.get("username") || "").trim();
      if (!username) return Response.json({ error: "username required" }, { status: 400 });
      const userId = await authStub(env).getUserId(username);
      if (!userId) return Response.json({ error: "no such user" }, { status: 404 });
      const result = await env.MEMORY.get(env.MEMORY.idFromName(userId)).forgetAll();
      console.log(
        JSON.stringify({ event: "admin_memory_erased", username, rows: result.deleted, ts: Date.now() }),
      );
      return Response.json({ ok: true, username, ...result });
    }

    if (url.pathname === "/admin/memory" && request.method === "GET") {
      if (!env.APP_SHARED_KEY || request.headers.get("X-Admin-Key") !== env.APP_SHARED_KEY) {
        return new Response("Forbidden", { status: 403 });
      }
      const username = (url.searchParams.get("username") || "").trim();
      if (!username) return Response.json({ error: "username required" }, { status: 400 });
      const userId = await authStub(env).getUserId(username);
      if (!userId) return Response.json({ error: "no such user" }, { status: 404 });
      console.log(
        JSON.stringify({ event: "admin_memory_inspected", username, ts: Date.now() }),
      );
      const memory = env.MEMORY.get(env.MEMORY.idFromName(userId));
      return Response.json(await memory.inspect());
    }

    if (url.pathname === "/ws") {
      if (!isAllowedOrigin(origin)) {
        return new Response("Forbidden origin", { status: 403 });
      }
      const user = await requireUser(request, url, env);
      if (!user) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }
      // One Durable Object instance per connection — matches the Modal
      // version's per-connection in-memory state (turn count, current
      // abort/interrupt), just via a different mechanism.
      //
      // The verified user_id is forwarded to the session so the memory
      // layer has an identity to key on.
      const id = env.SESSION.newUniqueId();
      const stub = env.SESSION.get(id);
      const forwarded = new URL(request.url);
      forwarded.searchParams.delete("token");
      forwarded.searchParams.set("user_id", user.userId);
      forwarded.searchParams.set("username", user.username);
      return stub.fetch(new Request(forwarded.toString(), request));
    }

    return withCors(new Response("Not Found", { status: 404 }), origin);
  },
};
