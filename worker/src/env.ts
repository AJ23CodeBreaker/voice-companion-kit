// Type-only imports — these make the Durable Object stubs RPC-typed, so
// `env.AUTH.get(id).login(...)` is checked at compile time. Circular at the
// type level only; erased at runtime.
import type { VoiceSession } from "./session";
import type { AuthStore } from "./auth";

export interface Env {
  /** One instance per user — working + episodic memory. See src/memory.ts. */
  MEMORY: DurableObjectNamespace<import("./memory").UserMemory>;
  SESSION: DurableObjectNamespace<VoiceSession>;
  /** Accounts + session tokens — see auth.ts. Single named instance ("global"). */
  AUTH: DurableObjectNamespace<AuthStore>;
  OPENROUTER_API_KEY: string;
  FISH_API_KEY: string;
  FISH_VOICE_ID: string;    // Fallback voice id, used when a character has no literal one
  DEEPGRAM_API_KEY: string;
  /**
   * Admin key. Server-side only — never sent to the browser. Gates account
   * creation (`POST /auth/register`) so accounts can only be made from a
   * trusted terminal. User-facing access uses login tokens instead, because
   * a shared key embedded in a public page is not a secret.
   */
  APP_SHARED_KEY: string;
}
