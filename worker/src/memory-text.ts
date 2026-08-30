// Pure text helpers for the memory block.
//
// Split out of memory.ts because that module imports `cloudflare:workers`,
// which cannot load outside a Workers runtime — so anything importing it is
// untestable in plain vitest. These are the parts worth testing.

export const MEMORY_PREAMBLE =
  "This is what you remember about him and about the two of you. " +
  "It is yours — recall it naturally if it fits, the way anyone remembers " +
  "someone they know. Never recite it, never list it back to him, and never " +
  "say that you were told or shown any of it.\n\n" +
  // The absence rule. Without it she fills gaps: asked about a brother she was
  // never told about, she invented one in 9 of 20 runs. The block told her what
  // she knows and nothing told her what to do when she does not, and warmth in
  // character rewards a confident guess. Measured 2026-08-29: contamination
  // 11/20 -> 18/20, with recall unchanged at 20/20 — it does not make her
  // over-refuse, which was the risk.
  "If it is not written here, you do not know it and he has never told you. " +
  "Say so plainly, or ask him. Never invent a detail to fill a gap — not a name, " +
  "not a fact, not a feeling — however well it would fit or however much warmer " +
  "it would sound.\n\n";

/**
 * Render an elapsed time the way a person would say it out loud. Deliberately
 * vague at the edges: "a while back" is what someone actually says, and a
 * precise "47 days ago" from a companion reads as a database, not a memory.
 */
export function describeGap(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return "You spoke earlier today.";
  const hours = Math.floor(mins / 60);
  if (hours < 24) return "You spoke earlier today.";
  const days = Math.floor(hours / 24);
  if (days === 1) return "You last spoke yesterday.";
  if (days < 7) return `You last spoke ${days} days ago.`;
  if (days < 14) return "You last spoke about a week ago.";
  if (days < 31) return `You last spoke about ${Math.round(days / 7)} weeks ago.`;
  if (days < 365) return `You last spoke about ${Math.round(days / 30)} months ago.`;
  return "You last spoke a very long time ago.";
}

// ── Block assembly ────────────────────────────────────────────
//
// Lives here, not in memory.ts, for the same reason buildTurnMessages lives in
// turn.ts: the eval harness must exercise the EXACT block production sends. A
// reimplementation in the harness would measure text that never ships. memory.ts
// does the SQL; this does the prose.

/** How many episodes to carry by recency. doc/09 §4. */
export const EPISODES_RECENT = 5;
/** Plus the most significant of all time, so the night that mattered survives. */
export const EPISODES_SALIENT = 3;

export interface MemoryEpisode {
  id: number;
  ended_at: number;
  summary: string;
  mood: string | null;
  /** Only needed when selecting; unused once merged. */
  salience?: number;
}

export interface MemoryBondRow {
  sessions: number;
  last_seen_at: number;
}

/**
 * Merge the recent and salient episode lists, de-duplicated, oldest first
 * because that ordering reads as history rather than as a ranked list.
 */
export function mergeEpisodes(recent: MemoryEpisode[], salient: MemoryEpisode[]): MemoryEpisode[] {
  const seen = new Set<number>();
  const merged: MemoryEpisode[] = [];
  for (const e of [...recent, ...salient]) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    merged.push(e);
  }
  merged.sort((a, b) => a.ended_at - b.ended_at);
  return merged;
}

// ── Size budget ───────────────────────────────────────────────
//
// The block is sent on EVERY turn and, before this, grew with every session:
// 3078 chars at five episodes, ~616 per episode, crossing the 4000-char cap at
// about seven. Users were at five. Capping the COUNT of episodes does not fix
// it, because summary length varies between sessions; capping total CHARACTERS
// does, and makes block size independent of how long she has known him.
//
// Episodes are dropped whole, never truncated. A summary cut off mid-sentence
// ("He finally quit the ba") is not a shorter memory, it is a false one — and
// false memories are the exact failure this whole track exists to remove.

/** Ceiling for the whole rendered block. Mirrored in eval/memory.ts. */
export const BLOCK_BUDGET_CHARS = 4000;
/** What episodes may spend, once preamble, bond, facts and loops are paid for. */
export const EPISODE_BUDGET_CHARS = 1800;

/** Rough render cost of one episode beyond its summary: bullet, gap phrase, mood. */
const EPISODE_OVERHEAD_CHARS = 45;

/**
 * Choose which episodes fit the budget.
 *
 * Newest first, because continuity is what the recent ones buy. The single most
 * salient is kept whatever happens, so the night that mattered survives a run of
 * chatty sessions. The newest is kept even if it alone busts the budget — a
 * block with no recent episode is worse than one slightly over.
 *
 * Returned oldest-first, which reads as history rather than as a ranked list.
 */
export function selectEpisodesWithinBudget(
  episodes: MemoryEpisode[],
  budget: number = EPISODE_BUDGET_CHARS,
): MemoryEpisode[] {
  if (episodes.length === 0) return [];

  const mostSalient = [...episodes].sort(
    (a, b) => (b.salience ?? 0) - (a.salience ?? 0) || b.ended_at - a.ended_at,
  )[0];

  const chosen: MemoryEpisode[] = [];
  let spent = 0;
  for (const e of [...episodes].sort((a, b) => b.ended_at - a.ended_at)) {
    const cost = e.summary.length + (e.mood?.length ?? 0) + EPISODE_OVERHEAD_CHARS;
    if (chosen.length > 0 && spent + cost > budget) continue;
    chosen.push(e);
    spent += cost;
  }
  if (!chosen.some((e) => e.id === mostSalient.id)) chosen.push(mostSalient);

  chosen.sort((a, b) => a.ended_at - b.ended_at);
  return chosen;
}

// ── Closeness ─────────────────────────────────────────────────
//
// The complaint that started this: she never warms up. Session forty sounds
// like session one, because nothing in the prompt ever told her which one she
// was in.
//
// Derived, not stored. Sessions and last_seen_at are already counted, so this
// needs no new table, no writer and no model call — which is also why it is
// worth doing before anything with axes and damped writes.
//
// It changes REGISTER ONLY. It never states a fact, never implies one, and
// never licenses her to assume something she was not told: warmth is how she
// says a thing, not permission to make it up. Getting that backwards would
// feed the exact bug the absence rule above exists to kill.

/**
 * One line about how well they know each other. Empty when they barely do —
 * silence is the right default, and a first conversation needs no instruction.
 */
export function describeCloseness(bond: MemoryBondRow, now: number): string {
  const { sessions, last_seen_at } = bond;
  const days = Math.floor((now - last_seen_at) / 86_400_000);

  const parts: string[] = [];

  if (sessions >= 20) {
    parts.push(
      "You know him well by now. Talk in shorthand, assume the things you " +
        "already know, and do not explain yourself as though he were new.",
    );
  } else if (sessions >= 8) {
    parts.push(
      "You are past being polite with each other. Warmer, more direct, and " +
        "you can tease him.",
    );
  } else if (sessions >= 3) {
    parts.push("You are starting to know each other. Still finding the register.");
  }

  // A long silence is felt whatever the session count says. It goes second so
  // it qualifies the closeness line rather than replacing it.
  if (days >= 30 && sessions >= 2) {
    parts.push("It has been a long time. That is allowed to show, once, without a scene.");
  }

  return parts.join(" ");
}

/**
 * Render the finished memory block — the state card. Empty string when there is
 * nothing to say; the caller must not inject an empty system message.
 *
 * Assembled here in code, deterministically, from rows. The live model is never
 * asked to author it: that would be a second LLM call on the hot path, which
 * this project does not have.
 *
 * `now` is injectable so tests are not clock-dependent.
 */
export function renderMemoryBlock(
  input: {
    bond?: MemoryBondRow;
    facts?: string[];
    episodes?: MemoryEpisode[];
    openLoops?: string[];
  },
  now: number = Date.now(),
  episodeBudget: number = EPISODE_BUDGET_CHARS,
): string {
  const parts: string[] = [];

  if (input.bond) {
    const { sessions, last_seen_at } = input.bond;
    const closeness = describeCloseness(input.bond, now);
    parts.push(
      `You have spoken with him ${sessions === 1 ? "once" : `${sessions} times`} before. ` +
        describeGap(now - last_seen_at) +
        (closeness ? ` ${closeness}` : ""),
    );
  }

  const facts = input.facts ?? [];
  if (facts.length > 0) {
    parts.push("What you know about him:\n" + facts.map((f) => `- ${f}`).join("\n"));
  }

  // Open loops. The cheapest thing in the whole memory design and the one a
  // user actually notices: being asked how Thursday went is the difference
  // between someone who remembers you and someone who stores you.
  const loops = input.openLoops ?? [];
  if (loops.length > 0) {
    parts.push(
      "Left hanging last time:\n" +
        loops.map((l) => `- ${l}`).join("\n") +
        "\nYou may ask about one of these, once, if it comes up naturally. " +
        "If he does not pick it up, let it go.",
    );
  }

  const episodes = selectEpisodesWithinBudget(input.episodes ?? [], episodeBudget);
  if (episodes.length > 0) {
    parts.push(
      "Times you have spoken before:\n" +
        episodes
          .map((e) => `- ${describeGap(now - e.ended_at)} ${e.summary}${e.mood ? ` (${e.mood})` : ""}`)
          .join("\n"),
    );
  }

  return parts.length === 0 ? "" : MEMORY_PREAMBLE + parts.join("\n\n");
}
