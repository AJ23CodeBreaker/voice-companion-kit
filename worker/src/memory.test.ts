import { describe, it, expect } from "vitest";
import {
  describeGap,
  renderMemoryBlock,
  selectEpisodesWithinBudget,
  describeCloseness,
  MEMORY_PREAMBLE,
  BLOCK_BUDGET_CHARS,
  type MemoryEpisode,
} from "./memory-text";
import { parseSummary } from "./episode";
import { buildTurnMessages } from "./turn";
import { CHARACTERS, BEHAVIOR } from "./personas.generated";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("describeGap", () => {
  it("speaks like a person, not a database", () => {
    expect(describeGap(5 * 60_000)).toMatch(/earlier today/);
    expect(describeGap(3 * HOUR)).toMatch(/earlier today/);
    expect(describeGap(1.2 * DAY)).toMatch(/yesterday/);
    expect(describeGap(3 * DAY)).toMatch(/3 days ago/);
    expect(describeGap(9 * DAY)).toMatch(/about a week/);
    expect(describeGap(20 * DAY)).toMatch(/weeks ago/);
    expect(describeGap(60 * DAY)).toMatch(/months ago/);
    expect(describeGap(800 * DAY)).toMatch(/a very long time/);
  });

  it("never emits an exact day count past a month", () => {
    // "You last spoke 47 days ago" from a companion reads as a lookup, not a
    // memory. Precision is the tell.
    for (const days of [40, 90, 200, 400]) {
      expect(describeGap(days * DAY)).not.toMatch(new RegExp(`\\b${days}\\b`));
    }
  });
});

describe("parseSummary", () => {
  const good = '{"summary":"He had a hard week and did not want to talk about it at first.","mood":"heavy","salience":0.7}';

  it("parses a clean object", () => {
    const r = parseSummary(good)!;
    expect(r.summary).toMatch(/hard week/);
    expect(r.mood).toBe("heavy");
    expect(r.salience).toBeCloseTo(0.7);
  });

  it("survives a markdown fence", () => {
    expect(parseSummary("```json\n" + good + "\n```")!.mood).toBe("heavy");
  });

  it("survives prose either side", () => {
    expect(parseSummary("Sure! Here you go:\n" + good + "\nHope that helps.")!.mood).toBe("heavy");
  });

  it("clamps salience into range", () => {
    expect(parseSummary('{"summary":"x","salience":5}')!.salience).toBe(1);
    expect(parseSummary('{"summary":"x","salience":-3}')!.salience).toBe(0);
    expect(parseSummary('{"summary":"x","salience":"nonsense"}')!.salience).toBeGreaterThanOrEqual(0);
  });

  it("returns null rather than inventing a memory", () => {
    // A fabricated memory is worse than an absent one — she would recall
    // something that never happened, with total confidence.
    expect(parseSummary("I'm sorry, I can't help with that.")).toBeNull();
    expect(parseSummary("{ not json ")).toBeNull();
    expect(parseSummary('{"mood":"warm"}')).toBeNull();      // no summary
    expect(parseSummary('{"summary":"   "}')).toBeNull();    // blank summary
    expect(parseSummary("")).toBeNull();
  });

  it("defaults facts and loops to empty when the model omits them", () => {
    // The old summariser returned neither field. A missing key must read as
    // "nothing to record", never as a crash on the session-close path.
    const r = parseSummary(good)!;
    expect(r.facts).toEqual([]);
    expect(r.openLoops).toEqual([]);
  });
});

describe("extracted facts", () => {
  const wrap = (facts: string) =>
    parseSummary(`{"summary":"We talked.","salience":0.4,"facts":${facts}}`)!;

  it("keeps a well-formed fact", () => {
    const r = wrap('[{"subject":"job","content":"He teaches secondary maths.","confidence":0.8}]');
    expect(r.facts).toHaveLength(1);
    expect(r.facts[0]).toMatchObject({ subject: "job", confidence: 0.8 });
  });

  it("lowercases the subject, because supersession matches on it exactly", () => {
    expect(wrap('[{"subject":"Dog.Name","content":"His dog is Pepper.","confidence":1}]').facts[0].subject)
      .toBe("dog.name");
  });

  it("drops a fact whose subject could never be matched again", () => {
    // A subject is a key, not prose. "his job, i think" can never collide with
    // the same fact next month, so the contradiction would never be found and
    // she would hold both truths at once.
    for (const bad of ['"his job, i think"', '"  "', '"9lives"', '""', "null", "42"]) {
      expect(wrap(`[{"subject":${bad},"content":"He teaches.","confidence":1}]`).facts).toEqual([]);
    }
  });

  it("drops a fact with no content to assert", () => {
    expect(wrap('[{"subject":"job","content":"","confidence":1}]').facts).toEqual([]);
    expect(wrap('[{"subject":"job","confidence":1}]').facts).toEqual([]);
  });

  it("keeps only the first claim per subject", () => {
    // Two contents on one subject in ONE conversation is the model hedging.
    // Writing both would supersede the first with the second immediately.
    const r = wrap(
      '[{"subject":"job","content":"He teaches.","confidence":0.9},' +
        '{"subject":"job","content":"He might still be at the bank.","confidence":0.3}]',
    );
    expect(r.facts).toHaveLength(1);
    expect(r.facts[0].content).toMatch(/teaches/);
  });

  it("caps how much one conversation may assert", () => {
    const many = Array.from({ length: 12 }, (_, i) => `{"subject":"k${i}","content":"He said thing ${i}.","confidence":0.5}`);
    expect(wrap(`[${many.join(",")}]`).facts).toHaveLength(5);
  });

  it("survives the field being the wrong shape entirely", () => {
    for (const junk of ['"not an array"', "null", "{}", "[null,3,\"x\"]"]) {
      expect(wrap(junk).facts).toEqual([]);
    }
  });
});

describe("extracted open loops", () => {
  const wrap = (loops: string) =>
    parseSummary(`{"summary":"We talked.","salience":0.4,"open_loops":${loops}}`)!;

  it("keeps a usable loop", () => {
    expect(wrap('["He had a job interview on Thursday."]').openLoops)
      .toEqual(["He had a job interview on Thursday."]);
  });

  it("caps at two, so she does not open with a status meeting", () => {
    expect(wrap('["one thing","two thing","three thing","four thing"]').openLoops).toHaveLength(2);
  });

  it("drops anything too short to follow up on", () => {
    expect(wrap('["ok","","  ",null,7]').openLoops).toEqual([]);
  });

  it("survives the wrong shape", () => {
    expect(wrap('"a string"').openLoops).toEqual([]);
    expect(wrap("null").openLoops).toEqual([]);
  });
});

describe("memory placement in the prompt", () => {
  const base = {
    systemPrompt: CHARACTERS.demo.systemPrompt,
    behavior: BEHAVIOR,
    // Deliberately unlike anything in fewshot.ts — an earlier version of this
    // test used "hey" and matched a few-shot demonstration instead of history.
    history: [
      { role: "user" as const, content: "HISTORY_USER_MARKER" },
      { role: "assistant" as const, content: "HISTORY_ASSISTANT_MARKER" },
    ],
    turnId: 1,
    message: "how are you",
  };

  it("does not touch the prompt when there is nothing remembered", () => {
    const withNone = buildTurnMessages({ ...base });
    const withEmpty = buildTurnMessages({ ...base, memoryBlock: "   " });
    const control = buildTurnMessages({ ...base });
    expect(withNone.memoryInjected).toBe(false);
    expect(withEmpty.memoryInjected).toBe(false);
    expect(withEmpty.messages).toEqual(control.messages);
  });

  it("keeps position 0 byte-identical — this is the cache invariant", () => {
    // doc/09 §5: position 0 is the shared prefix across EVERY user and EVERY
    // session. Personalising it there changes the first bytes of every request
    // and destroys prefix reuse globally. If this test fails, someone has moved
    // memory into the system prompt and the reason it is not there has been
    // forgotten.
    const plain = buildTurnMessages({ ...base });
    const remembered = buildTurnMessages({ ...base, memoryBlock: "He has a sister called Anna." });
    expect(remembered.messages[0]).toEqual(plain.messages[0]);
  });

  it("sits after the few-shot block and before the history", () => {
    const remembered = buildTurnMessages({ ...base, memoryBlock: "He has a sister called Anna." });
    const idx = remembered.messages.findIndex((m) => m.content.includes("sister called Anna"));
    expect(idx).toBeGreaterThan(0);
    expect(remembered.messages[idx].role).toBe("system");

    const firstHistory = remembered.messages.findIndex((m) => m.content === "HISTORY_USER_MARKER");
    expect(firstHistory).toBeGreaterThan(idx);

    // Every few-shot demonstration must precede it, or the shared prefix is
    // no longer a prefix.
    const lastExample = remembered.messages.reduce(
      (acc, m, i) => (m.name?.startsWith("example_") ? i : acc),
      -1,
    );
    if (lastExample >= 0) expect(idx).toBeGreaterThan(lastExample);
  });

  it("adds exactly one message, and the rest are unchanged", () => {
    const plain = buildTurnMessages({ ...base });
    const remembered = buildTurnMessages({ ...base, memoryBlock: "He has a sister called Anna." });
    expect(remembered.messages.length).toBe(plain.messages.length + 1);
    const withoutMemory = remembered.messages.filter((m) => !m.content.includes("sister called Anna"));
    expect(withoutMemory).toEqual(plain.messages);
  });

  it("still puts his message last", () => {
    const remembered = buildTurnMessages({ ...base, memoryBlock: "He has a sister called Anna." });
    const last = remembered.messages[remembered.messages.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toBe("how are you");
  });

  it("keeps the behaviour reminder working alongside memory", () => {
    const r = buildTurnMessages({ ...base, turnId: 10, memoryBlock: "He has a sister called Anna." });
    expect(r.reminderInjected).toBe(true);
    expect(r.memoryInjected).toBe(true);
  });
});

// ── State card ────────────────────────────────────────────────

const NOW = Date.UTC(2026, 7, 29, 12, 0, 0);

function ep(daysAgo: number, summary: string, salience = 0.5, id = daysAgo): MemoryEpisode {
  return { id, ended_at: NOW - daysAgo * DAY, summary, mood: null, salience };
}

/** A summary at the length production actually writes them. */
const LONG = "x".repeat(320);

describe("the absence rule", () => {
  it("is in the preamble, so every block carries it", () => {
    // The fix for a measured 45% confabulation rate. If this assertion ever
    // fails, she is inventing his family again and no other test will notice.
    expect(MEMORY_PREAMBLE).toMatch(/if it is not written here, you do not know it/i);
    expect(MEMORY_PREAMBLE).toMatch(/never invent a detail/i);
  });
});

describe("selectEpisodesWithinBudget", () => {
  it("keeps the whole set when it fits", () => {
    const eps = [ep(1, "a"), ep(2, "b"), ep(3, "c")];
    expect(selectEpisodesWithinBudget(eps, 1800)).toHaveLength(3);
  });

  it("drops oldest first once the budget is spent", () => {
    const eps = [ep(1, LONG), ep(2, LONG), ep(3, LONG), ep(4, LONG), ep(5, LONG)];
    const kept = selectEpisodesWithinBudget(eps, 800);
    expect(kept.length).toBeLessThan(5);
    // Whatever survives, the most recent conversation must be among it.
    expect(kept.some((e) => e.id === 1)).toBe(true);
  });

  it("keeps the newest even when it alone busts the budget", () => {
    // A block with no recent episode is worse than one slightly over.
    const kept = selectEpisodesWithinBudget([ep(1, LONG), ep(2, LONG)], 10);
    expect(kept).toHaveLength(1);
    expect(kept[0].id).toBe(1);
  });

  it("never drops the night that mattered", () => {
    // Five chatty recent sessions and one that counted, on a budget that fits
    // barely two. The salient one is old, so recency alone would lose it.
    const eps = [
      ep(1, LONG, 0.1), ep(2, LONG, 0.1), ep(3, LONG, 0.1),
      ep(4, LONG, 0.1), ep(30, LONG, 0.97, 30),
    ];
    const kept = selectEpisodesWithinBudget(eps, 800);
    expect(kept.some((e) => e.id === 30)).toBe(true);
  });

  it("returns them oldest first, so the block reads as history", () => {
    const kept = selectEpisodesWithinBudget([ep(1, "new"), ep(9, "old"), ep(4, "mid")], 1800);
    expect(kept.map((e) => e.summary)).toEqual(["old", "mid", "new"]);
  });

  it("never truncates a summary mid-sentence", () => {
    // A memory cut off at "He finally quit the ba" is not a shorter memory,
    // it is a false one. Episodes are dropped whole or not at all.
    const eps = [ep(1, LONG), ep(2, LONG), ep(3, LONG)];
    for (const e of selectEpisodesWithinBudget(eps, 500)) {
      expect(e.summary).toBe(LONG);
    }
  });
});

describe("the state card stays bounded", () => {
  it("does not grow past the cap however long she has known him", () => {
    // The measured failure: 3078 chars at five episodes, ~616 each, crossing
    // 4000 at about seven. Users were at five. This is the regression gate.
    const bond = { sessions: 100, last_seen_at: NOW - DAY };
    for (const n of [1, 5, 8, 20, 100]) {
      const episodes = Array.from({ length: n }, (_, i) => ep(i + 1, LONG, 0.5, i + 1));
      const block = renderMemoryBlock({ bond, episodes }, NOW);
      expect(block.length).toBeLessThanOrEqual(BLOCK_BUDGET_CHARS);
    }
  });

  it("is still empty when there is nothing to remember", () => {
    // The caller must not inject an empty system message.
    expect(renderMemoryBlock({}, NOW)).toBe("");
  });
});

describe("describeCloseness", () => {
  const recent = (sessions: number) => describeCloseness({ sessions, last_seen_at: NOW - DAY }, NOW);

  it("says nothing at all on the first couple of conversations", () => {
    // Silence is the right default. A first conversation needs no instruction
    // about register, and one there would only make her self-conscious.
    expect(recent(1)).toBe("");
    expect(recent(2)).toBe("");
  });

  it("warms up as they rack up sessions", () => {
    expect(recent(4)).toMatch(/starting to know/i);
    expect(recent(10)).toMatch(/past being polite|tease/i);
    expect(recent(40)).toMatch(/know him well|shorthand/i);
  });

  it("notices a long silence on top of the closeness", () => {
    const line = describeCloseness({ sessions: 12, last_seen_at: NOW - 90 * DAY }, NOW);
    expect(line).toMatch(/past being polite/i);   // still close
    expect(line).toMatch(/long time/i);           // and still a gap
  });

  it("does not mention a gap to someone who has only met him once", () => {
    expect(describeCloseness({ sessions: 1, last_seen_at: NOW - 90 * DAY }, NOW)).toBe("");
  });

  it("only ever talks about register, never about facts", () => {
    // The line changes HOW she says things. If it ever starts implying what
    // she knows, it becomes a licence to invent — the exact bug the absence
    // rule exists to kill.
    for (const n of [1, 3, 8, 20, 60]) {
      const line = describeCloseness({ sessions: n, last_seen_at: NOW - 40 * DAY }, NOW);
      expect(line).not.toMatch(/\b(remember|know that|told you|he said|his )\b/i);
    }
  });
});

describe("open loops", () => {
  const bond = { sessions: 4, last_seen_at: NOW - 2 * DAY };

  it("appear on the card, and she is told she may ask once", () => {
    const block = renderMemoryBlock(
      { bond, openLoops: ["He had a job interview on Thursday. You have not heard how it went."] },
      NOW,
    );
    expect(block).toMatch(/job interview on Thursday/);
    expect(block).toMatch(/once/);
    expect(block).toMatch(/let it go/);
  });

  it("are absent entirely when there are none", () => {
    const block = renderMemoryBlock({ bond, openLoops: [] }, NOW);
    expect(block).not.toMatch(/Left hanging/);
  });
});
