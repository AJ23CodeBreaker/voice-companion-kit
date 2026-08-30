// Startup greeting selection.
//
// A greeting is a canned line spoken while the loading bar runs, before the
// user has said anything. It never goes near the LLM — the text is fixed and
// goes straight to TTS. See pipelines/08_orchestrator/greetings_*.txt for the
// lines themselves and the rules for editing them.
//
// Pure function, no I/O — so the "don't repeat yourself" rule is testable
// rather than something we hope is working in production.

/** How many recently-played greetings the client is allowed to rule out. */
export const MAX_EXCLUDE = 8;

/**
 * Pick a greeting index, avoiding the ones the client says it played
 * recently. Ten lines picked uniformly repeat inside about four sessions —
 * often enough to notice, and a companion that opens with the same sentence
 * twice in a week reads as a machine. The client remembers its recent picks
 * across sessions in localStorage and passes them here.
 *
 * Falls back to the full pool if the exclusions would leave nothing, so a
 * confused or hostile client can never produce "no greeting".
 */
export function pickGreetingIndex(
  poolSize: number,
  exclude: readonly number[] = [],
  random: () => number = Math.random,
): number {
  if (poolSize <= 0) return -1;
  if (poolSize === 1) return 0;

  const blocked = new Set(
    exclude
      .slice(0, MAX_EXCLUDE)
      .filter((n) => Number.isInteger(n) && n >= 0 && n < poolSize),
  );
  const allowed: number[] = [];
  for (let i = 0; i < poolSize; i++) if (!blocked.has(i)) allowed.push(i);

  // Everything ruled out — a long-running user who has heard them all, or a
  // client sending nonsense. Either way, saying nothing is the worst option.
  const pool = allowed.length > 0 ? allowed : Array.from({ length: poolSize }, (_, i) => i);
  return pool[Math.floor(random() * pool.length) % pool.length];
}

/**
 * Validate the `exclude` array off the wire. Same posture as the rest of the
 * client-supplied payloads in session.ts: take only what is well-formed,
 * bound it, and never let its size drive any work.
 */
export function sanitizeExclude(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const v of raw.slice(0, MAX_EXCLUDE)) {
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 1000) out.push(v);
  }
  return out;
}
