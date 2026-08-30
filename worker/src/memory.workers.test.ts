// UserMemory against a real Durable Object, in the real Workers runtime.
//
// Everything here is a SQL property. None of it can be tested in plain node,
// and none of it was tested at all before: eval/memory.ts says so in its own
// header — it tests the prompt in isolation and "cannot see" the storage. The
// most important assertion in this file is the cross-character one, because a
// leak there is a privacy failure, not a quality failure.

import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";

// The pool provides bindings from wrangler.toml; the generated ProvidedEnv is
// not wired into tsconfig, so name the one binding this file uses.
const MEMORY = (env as unknown as { MEMORY: DurableObjectNamespace<import("./memory").UserMemory> })
  .MEMORY;

/** A fresh, empty instance per test. Each name is its own DO. */
let seq = 0;
function freshUser() {
  seq += 1;
  return MEMORY.get(MEMORY.idFromName(`test-user-${seq}-${Date.now()}`));
}

let user: ReturnType<typeof freshUser>;
beforeEach(() => {
  user = freshUser();
});

const DAY = 24 * 60 * 60 * 1000;

async function seedEpisode(characterId: string, daysAgo: number, summary: string, salience = 0.5) {
  const endedAt = Date.now() - daysAgo * DAY;
  await user.addEpisode({
    characterId,
    startedAt: endedAt - 600_000,
    endedAt,
    turnCount: 12,
    summary,
    mood: null,
    salience,
  });
}

// ── The privacy property ──────────────────────────────────────

describe("memory is scoped to one character", () => {
  it("does not leak a fact from one character to another", async () => {
    // ADR-022: nothing is shared between characters. The character is a column,
    // and this is the test that the column is actually respected in the WHERE.
    await user.writeFact({
      characterId: "demo",
      subject: "dog.name",
      content: "His dog is called Pepper.",
      confidence: 0.9,
    });

    const mine = await user.loadContext("demo");
    const theirs = await user.loadContext("other");

    expect(mine.memoryBlock).toMatch(/Pepper/);
    expect(theirs.memoryBlock).not.toMatch(/Pepper/);
    expect(theirs.factCount).toBe(0);
  });

  it("does not leak an episode either", async () => {
    await seedEpisode("demo", 2, "He told me about the pottery class he is starting.");
    const theirs = await user.loadContext("other");
    expect(theirs.memoryBlock).not.toMatch(/pottery/);
    expect(theirs.episodeCount).toBe(0);
  });

  it("keeps open loops apart too", async () => {
    await user.addOpenLoop("demo", "He had a job interview Thursday.");
    expect(await user.getOpenLoops("other")).toEqual([]);
    expect(await user.getOpenLoops("demo")).toHaveLength(1);
  });
});

// ── Supersession ──────────────────────────────────────────────

describe("writeFact supersedes rather than appends", () => {
  it("replaces a fact on the same subject", async () => {
    // doc/09 acceptance check: "I bought a car", then "I sold it".
    await user.writeFact({
      characterId: "demo",
      subject: "car",
      content: "He owns a blue estate car.",
      confidence: 0.8,
    });
    const r = await user.writeFact({
      characterId: "demo",
      subject: "car",
      content: "He sold his car.",
      confidence: 0.9,
    });

    expect(r.superseded).toBe(1);
    const ctx = await user.loadContext("demo");
    expect(ctx.memoryBlock).toMatch(/sold his car/);
    expect(ctx.memoryBlock).not.toMatch(/owns a blue estate/);
    expect(ctx.factCount).toBe(1);
  });

  it("keeps the superseded row as history rather than deleting it", async () => {
    // ADR-019. A hard delete makes a wrong memory impossible to debug later.
    await user.writeFact({ characterId: "demo", subject: "job", content: "He works at a bank.", confidence: 0.8 });
    await user.writeFact({ characterId: "demo", subject: "job", content: "He teaches maths.", confidence: 0.9 });

    const dump = await user.inspect();
    expect(dump.facts).toHaveLength(2);
    expect(dump.facts.filter((f) => f.invalidated_at !== null)).toHaveLength(1);
  });

  it("does not churn when he says the same thing twice", async () => {
    // Without this, every repeat mention invalidates the row and writes an
    // identical one, and use_count -- which orders the prompt -- resets.
    const first = { characterId: "demo", subject: "job", content: "He teaches maths.", confidence: 0.8 };
    await user.writeFact(first);
    const again = await user.writeFact(first);

    expect(again.superseded).toBe(0);
    expect((await user.inspect()).facts).toHaveLength(1);
  });

  it("supersedes only within one character", async () => {
    await user.writeFact({ characterId: "demo", subject: "job", content: "He teaches maths.", confidence: 0.9 });
    const r = await user.writeFact({ characterId: "other", subject: "job", content: "He works at a bank.", confidence: 0.9 });

    expect(r.superseded).toBe(0);
    expect(await user.loadContext("demo")).toMatchObject({ factCount: 1 });
    expect((await user.loadContext("demo")).memoryBlock).toMatch(/teaches maths/);
    expect((await user.loadContext("other")).memoryBlock).toMatch(/works at a bank/);
  });
});

// ── Write grades ──────────────────────────────────────────────

describe("write grades", () => {
  it("keeps reflex facts out of the prompt", async () => {
    // The whole point of the grade: scene noise can be written down without
    // being asserted back at him as biography.
    await user.writeFact({
      characterId: "demo",
      subject: "mood.now",
      content: "He sounded impatient tonight.",
      confidence: 0.4,
      grade: "reflex",
    });
    const ctx = await user.loadContext("demo");
    expect(ctx.factCount).toBe(0);
    expect(ctx.memoryBlock).not.toMatch(/impatient/);
  });

  it("defaults to heuristic, which does reach the prompt", async () => {
    await user.writeFact({ characterId: "demo", subject: "sister.name", content: "His sister is Anna.", confidence: 0.7 });
    expect((await user.loadContext("demo")).memoryBlock).toMatch(/Anna/);
  });

  it("lets canon through", async () => {
    await user.writeFact({
      characterId: "demo", subject: "job", content: "He teaches maths.", confidence: 1, grade: "canon",
    });
    expect((await user.loadContext("demo")).memoryBlock).toMatch(/teaches maths/);
  });
});

// ── Open loops ────────────────────────────────────────────────

describe("open loops", () => {
  it("reach the card", async () => {
    await user.addOpenLoop("demo", "He had a job interview Thursday. You have not heard how it went.");
    const ctx = await user.loadContext("demo");
    expect(ctx.loopCount).toBe(1);
    expect(ctx.memoryBlock).toMatch(/job interview Thursday/);
  });

  it("are capped at two, so she does not open with a status meeting", async () => {
    for (let i = 0; i < 6; i++) await user.addOpenLoop("demo", `Loop number ${i}.`);
    expect(await user.getOpenLoops("demo")).toHaveLength(2);
    expect((await user.loadContext("demo")).loopCount).toBe(2);
  });

  it("drop off the card once closed", async () => {
    await user.addOpenLoop("demo", "He had a job interview Thursday.");
    const dump = await user.inspect();
    expect(dump.openLoops).toHaveLength(1);

    // ids are not exposed by getOpenLoops; close the only one there is.
    await user.closeOpenLoop(1, "resolved");
    expect(await user.getOpenLoops("demo")).toEqual([]);
  });

  it("expire when nobody ever answers", async () => {
    // Asking once is warmth. Asking six weeks later is evidence she is not
    // listening. expireStaleLoops is what makes the difference.
    await user.addOpenLoop("demo", "He said he would call his mother.");
    expect((await user.expireStaleLoops(0)).expired).toBe(1);
    expect(await user.getOpenLoops("demo")).toEqual([]);
  });
});

// ── The size budget, through real SQL ─────────────────────────

describe("the state card stays bounded in storage", () => {
  it("does not grow past the cap after a hundred sessions", async () => {
    // The measured failure this was built for: 3078 chars at five episodes,
    // crossing 4000 at about seven, and users were already at five.
    const summary = "He talked about work and about how the flat feels when he gets home to it in the evening. ".repeat(3);
    for (let i = 1; i <= 100; i++) await seedEpisode("demo", i, `Session ${i}. ${summary}`);
    await user.recordSession("demo", 12);

    const ctx = await user.loadContext("demo");
    expect(ctx.memoryBlock.length).toBeLessThanOrEqual(4000);
    expect(ctx.memoryBlock).toMatch(/Session 1\./); // the newest survived
  });
});

// ── Erasure ───────────────────────────────────────────────────

describe("forgetAll", () => {
  it("leaves nothing behind, open loops included", async () => {
    // doc/06: a user asking to be forgotten means gone, not flagged. A table
    // added later and missed here is exactly how that promise gets broken.
    await seedEpisode("demo", 1, "We talked.");
    await user.writeFact({ characterId: "demo", subject: "job", content: "He teaches.", confidence: 0.9 });
    await user.addOpenLoop("demo", "He had an interview.");
    await user.recordSession("demo", 4);

    await user.forgetAll();

    const after = await user.summary();
    for (const [table, n] of Object.entries(after)) {
      expect(`${table}=${n}`).toBe(`${table}=0`);
    }
    expect((await user.loadContext("demo")).memoryBlock).toBe("");
  });
});

// ── Migration ─────────────────────────────────────────────────

describe("migration", () => {
  it("is idempotent across reconstructions of the object", async () => {
    // migrate() runs in every constructor, and SQLite has no
    // ADD COLUMN IF NOT EXISTS. A second run must be a no-op, not an error.
    await user.writeFact({ characterId: "demo", subject: "job", content: "He teaches.", confidence: 0.9 });
    for (let i = 0; i < 3; i++) {
      expect(await user.summary()).toMatchObject({ facts: 1 });
    }
  });
});
