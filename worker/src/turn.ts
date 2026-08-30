// Prompt assembly for a single turn.
//
// Extracted out of session.ts deliberately: the eval harness (eval/) must
// exercise the EXACT message array production sends, not a reimplementation.
// Any divergence between the two would make eval results meaningless — the
// harness would be measuring code that never ships.
//
// Pure function, no I/O, no Worker globals — so it runs unchanged in Node.

import type { ChatMessage } from "./llm";
import { fewShotMessages } from "./fewshot";

/**
 * Re-inject the full behavior contract every N turns to counter persona
 * drift in long conversations — same mechanism and cadence as the Modal
 * version (see CHANGELOG.md 2026-08-09, "persona-drift fixes").
 */
export const REMINDER_EVERY = 10;

export interface BuildTurnOptions {
  /** Character persona + behavior, already concatenated at build time. */
  systemPrompt: string;
  /** Shared behavior contract, re-injected periodically. */
  behavior: string;
  /** Prior turns, already validated and trimmed by the caller. */
  history: ChatMessage[];
  /** 1-based turn number within this session. */
  turnId: number;
  /** The user's message for this turn. */
  message: string;
  reminderEvery?: number;
  /** Off only for A/B measurement against the pre-few-shot baseline. */
  includeFewShot?: boolean;
  /**
   * What she remembers, assembled once at connect by UserMemory.loadContext().
   * Empty or absent for a user with no history, which is every user before
   * phase 1 ships and every FIRST conversation after it.
   *
   * The eval harness does not pass this, so the golden-set baseline keeps
   * measuring the same prompt it always did.
   */
  memoryBlock?: string;
}

export interface BuiltTurn {
  messages: ChatMessage[];
  /** True when the periodic behavior reminder was added this turn. */
  reminderInjected: boolean;
  /** True when a memory block was inserted — logged, so it is verifiable. */
  memoryInjected: boolean;
}

export function buildTurnMessages(opts: BuildTurnOptions): BuiltTurn {
  const reminderEvery = opts.reminderEvery ?? REMINDER_EVERY;
  const messages: ChatMessage[] = [{ role: "system", content: opts.systemPrompt }];

  // Demonstrations sit between the persona and the real conversation —
  // the standard placement. Whether they survive being buried by a long
  // history is an empirical question, measured by eval/, not assumed.
  if (opts.includeFewShot !== false) {
    messages.push(...fewShotMessages());
  }

  // ── Memory ────────────────────────────────────────────────
  // AFTER the few-shot block, never inside the system prompt. Position 0 is the
  // shared prefix across every user and every session; personalising it there
  // changes the first bytes of every request and destroys prefix reuse
  // globally. Here, the shared prefix stays byte-identical, and because the
  // block is fixed for the whole session the prefix through it is stable turn
  // to turn as well. doc/09 §5.
  const memoryBlock = opts.memoryBlock?.trim() ?? "";
  const memoryInjected = memoryBlock.length > 0;
  if (memoryInjected) {
    messages.push({ role: "system", content: memoryBlock });
  }

  messages.push(...opts.history);

  const reminderInjected = opts.turnId > 0 && opts.turnId % reminderEvery === 0;
  if (reminderInjected) {
    messages.push({ role: "system", content: opts.behavior });
  }

  messages.push({ role: "user", content: opts.message });
  return { messages, reminderInjected, memoryInjected };
}
