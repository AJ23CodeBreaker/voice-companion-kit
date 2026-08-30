// Accounts + sessions, backed by a single Durable Object with SQLite.
//
// Why a DO rather than KV: sessions and login-failure counters need strong
// consistency (KV is eventually consistent, so a lockout counter written on
// one edge wouldn't be visible on another for a while — which is exactly the
// window an attacker would use). One named DO instance gives us a single
// authoritative copy with zero extra infrastructure to provision.
//
// This also establishes the user_id that the memory layer will later key
// everything off — see the architecture notes in README.md.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

const PBKDF2_ITERATIONS = 100_000;
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_FAILED_ATTEMPTS = 6;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

export interface LoginResult {
  ok: boolean;
  token?: string;
  expiresAt?: number;
  userId?: string;
  error?: string;
}

export interface VerifyResult {
  ok: boolean;
  userId?: string;
  username?: string;
}

// ── crypto helpers ─────────────────────────────────────────────

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pbkdf2(password: string, saltHex: string, iterations: number): Promise<string> {
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256,
  );
  return toHex(new Uint8Array(bits));
}

/** Tokens are stored hashed, so a database read alone never yields a live token. */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return toHex(new Uint8Array(digest));
}

/** Length-independent comparison — avoids leaking equality via timing. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── the Durable Object ─────────────────────────────────────────

export class AuthStore extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS users (
          user_id    TEXT PRIMARY KEY,
          username   TEXT UNIQUE NOT NULL,
          salt       TEXT NOT NULL,
          hash       TEXT NOT NULL,
          iterations INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,
          user_id    TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS login_failures (
          username     TEXT PRIMARY KEY,
          count        INTEGER NOT NULL,
          first_at     INTEGER NOT NULL,
          locked_until INTEGER NOT NULL
        );
      `);
    });
  }

  /** Create an account. Called only from the admin-key-gated route. */
  async register(username: string, password: string): Promise<{ ok: boolean; error?: string }> {
    const name = username.trim().toLowerCase();
    if (name.length < 3 || name.length > 32) {
      return { ok: false, error: "username must be 3-32 characters" };
    }
    if (password.length < 8) {
      return { ok: false, error: "password must be at least 8 characters" };
    }

    const existing = this.ctx.storage.sql
      .exec("SELECT user_id FROM users WHERE username = ?", name)
      .toArray();
    if (existing.length > 0) return { ok: false, error: "username already exists" };

    const saltHex = toHex(randomBytes(16));
    const hash = await pbkdf2(password, saltHex, PBKDF2_ITERATIONS);
    const userId = crypto.randomUUID();

    this.ctx.storage.sql.exec(
      "INSERT INTO users (user_id, username, salt, hash, iterations, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      userId,
      name,
      saltHex,
      hash,
      PBKDF2_ITERATIONS,
      Date.now(),
    );
    return { ok: true };
  }

  async login(username: string, password: string): Promise<LoginResult> {
    const name = username.trim().toLowerCase();
    const now = Date.now();

    // Lockout check first — before doing any expensive hashing.
    const failRows = this.ctx.storage.sql
      .exec("SELECT count, first_at, locked_until FROM login_failures WHERE username = ?", name)
      .toArray() as Array<{ count: number; first_at: number; locked_until: number }>;
    const fail = failRows[0];
    if (fail && fail.locked_until > now) {
      return { ok: false, error: "too many attempts — try again later" };
    }

    const userRows = this.ctx.storage.sql
      .exec("SELECT user_id, salt, hash, iterations FROM users WHERE username = ?", name)
      .toArray() as Array<{ user_id: string; salt: string; hash: string; iterations: number }>;
    const user = userRows[0];

    // Always run a hash, even for an unknown username, so response timing
    // doesn't reveal whether the account exists.
    const candidate = await pbkdf2(
      password,
      user?.salt ?? toHex(new Uint8Array(16)),
      user?.iterations ?? PBKDF2_ITERATIONS,
    );

    if (!user || !timingSafeEqualHex(candidate, user.hash)) {
      this.recordFailure(name, now, fail);
      return { ok: false, error: "invalid username or password" };
    }

    this.ctx.storage.sql.exec("DELETE FROM login_failures WHERE username = ?", name);

    const token = base64url(randomBytes(32));
    const tokenHash = await sha256Hex(token);
    const expiresAt = now + TOKEN_TTL_MS;
    this.ctx.storage.sql.exec(
      "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
      tokenHash,
      user.user_id,
      now,
      expiresAt,
    );

    // Opportunistic cleanup of expired rows — cheap, avoids unbounded growth.
    this.ctx.storage.sql.exec("DELETE FROM sessions WHERE expires_at < ?", now);

    return { ok: true, token, expiresAt, userId: user.user_id };
  }

  private recordFailure(
    name: string,
    now: number,
    prev?: { count: number; first_at: number; locked_until: number },
  ) {
    // Reset the counter if the previous failures are older than the window,
    // so occasional typos over days never accumulate into a lockout.
    const withinWindow = prev && now - prev.first_at < FAILURE_WINDOW_MS;
    const count = withinWindow ? prev!.count + 1 : 1;
    const firstAt = withinWindow ? prev!.first_at : now;
    const lockedUntil = count >= MAX_FAILED_ATTEMPTS ? now + LOCKOUT_MS : 0;

    this.ctx.storage.sql.exec(
      `INSERT INTO login_failures (username, count, first_at, locked_until) VALUES (?, ?, ?, ?)
       ON CONFLICT(username) DO UPDATE SET count = ?, first_at = ?, locked_until = ?`,
      name,
      count,
      firstAt,
      lockedUntil,
      count,
      firstAt,
      lockedUntil,
    );
  }

  async verify(token: string): Promise<VerifyResult> {
    if (!token) return { ok: false };
    const tokenHash = await sha256Hex(token);
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT s.user_id AS user_id, s.expires_at AS expires_at, u.username AS username
         FROM sessions s JOIN users u ON u.user_id = s.user_id
         WHERE s.token_hash = ?`,
        tokenHash,
      )
      .toArray() as Array<{ user_id: string; expires_at: number; username: string }>;

    const row = rows[0];
    if (!row) return { ok: false };
    if (row.expires_at < Date.now()) {
      this.ctx.storage.sql.exec("DELETE FROM sessions WHERE token_hash = ?", tokenHash);
      return { ok: false };
    }
    return { ok: true, userId: row.user_id, username: row.username };
  }

  async logout(token: string): Promise<void> {
    if (!token) return;
    const tokenHash = await sha256Hex(token);
    this.ctx.storage.sql.exec("DELETE FROM sessions WHERE token_hash = ?", tokenHash);
  }

  /** Admin visibility — usernames only, never hashes. */
  async listUsers(): Promise<Array<{ username: string; created_at: number }>> {
    return this.ctx.storage.sql
      .exec("SELECT username, created_at FROM users ORDER BY created_at")
      .toArray() as Array<{ username: string; created_at: number }>;
  }

  /**
   * Resolve a username to the id memory is keyed by. Admin-only callers —
   * there is no path from a user token to another user's id.
   */
  async getUserId(username: string): Promise<string | null> {
    const rows = this.ctx.storage.sql
      .exec("SELECT user_id FROM users WHERE username = ?", username.trim().toLowerCase())
      .toArray() as Array<{ user_id: string }>;
    return rows[0]?.user_id ?? null;
  }

  /** Admin removal. Revokes the account's live sessions in the same step. */
  async deleteUser(username: string): Promise<{ ok: boolean; error?: string }> {
    const name = username.trim().toLowerCase();
    const rows = this.ctx.storage.sql
      .exec("SELECT user_id FROM users WHERE username = ?", name)
      .toArray() as Array<{ user_id: string }>;
    if (rows.length === 0) return { ok: false, error: "no such user" };

    this.ctx.storage.sql.exec("DELETE FROM sessions WHERE user_id = ?", rows[0].user_id);
    this.ctx.storage.sql.exec("DELETE FROM users WHERE username = ?", name);
    this.ctx.storage.sql.exec("DELETE FROM login_failures WHERE username = ?", name);
    return { ok: true };
  }
}
