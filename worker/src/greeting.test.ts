import { describe, it, expect } from "vitest";
import { pickGreetingIndex, sanitizeExclude, MAX_EXCLUDE } from "./greeting";
import { CHARACTERS } from "./personas.generated";

describe("pickGreetingIndex", () => {
  it("returns an index inside the pool", () => {
    for (let i = 0; i < 200; i++) {
      const idx = pickGreetingIndex(10);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(10);
    }
  });

  it("never picks an excluded index while alternatives remain", () => {
    const exclude = [0, 1, 2];
    for (let i = 0; i < 200; i++) {
      expect(exclude).not.toContain(pickGreetingIndex(10, exclude));
    }
  });

  it("falls back to the full pool rather than returning nothing", () => {
    const all = [0, 1, 2, 3];
    const idx = pickGreetingIndex(4, all);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(4);
  });

  it("ignores out-of-range and non-integer exclusions", () => {
    const idx = pickGreetingIndex(3, [99, -1, 1.5] as number[]);
    expect([0, 1, 2]).toContain(idx);
  });

  it("stays in range at the top of the random interval", () => {
    // Math.random() can return values arbitrarily close to 1; a naive
    // floor(r * n) must not be able to index past the end.
    expect(pickGreetingIndex(10, [], () => 0.9999999999999999)).toBeLessThan(10);
  });

  it("handles an empty pool", () => {
    expect(pickGreetingIndex(0)).toBe(-1);
  });
});

describe("sanitizeExclude", () => {
  it("drops non-arrays and junk entries", () => {
    expect(sanitizeExclude("nope")).toEqual([]);
    expect(sanitizeExclude([1, "2", null, 3.5, 4])).toEqual([1, 4]);
  });

  it("bounds the array so its length cannot drive work", () => {
    const huge = Array.from({ length: 500 }, (_, i) => i);
    expect(sanitizeExclude(huge).length).toBe(MAX_EXCLUDE);
  });
});

describe("every character has usable greetings", () => {
  for (const [id, c] of Object.entries(CHARACTERS)) {
    it(`${id} has at least 5 non-empty greetings`, () => {
      expect(c.greetings.length).toBeGreaterThanOrEqual(5);
      for (const g of c.greetings) expect(g.trim().length).toBeGreaterThan(0);
    });

    it(`${id} greetings carry no comment or placeholder lines`, () => {
      for (const g of c.greetings) expect(g.startsWith("#")).toBe(false);
    });
  }
});

describe("character table", () => {
  it("gives every character either a literal voice id or the env fallback", () => {
    // The shipped demo character has an empty literal on purpose and resolves
    // from FISH_VOICE_ID at runtime. Anything non-empty must still look like a
    // real id, because a typo here is silence in production, not an error.
    for (const [, c] of Object.entries(CHARACTERS)) {
      if (c.voiceId === "") continue;
      expect(c.voiceId).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it("has a name and a one-line description for the picker", () => {
    for (const [id, c] of Object.entries(CHARACTERS)) {
      expect(c.name.length, id).toBeGreaterThan(0);
      expect(c.desc.length, id).toBeGreaterThan(0);
    }
  });

  it("gives every character a crisis-response instruction", () => {
    // Every persona must say what she does if he tells her he is in real
    // despair. It is the one thing in these files that is not a style choice,
    // and a new character is exactly where it would get forgotten.
    for (const [id, c] of Object.entries(CHARACTERS)) {
      expect(c.systemPrompt.toLowerCase(), `${id} has no crisis paragraph`).toMatch(
        /despair|hurting himself/,
      );
    }
  });

  it("names no real brand, bank or university in any persona", () => {
    const banned =
      /(morgan stanley|goldman|jpmorgan|barclays|hsbc|ubs|citibank|deutsche bank|harvard|stanford|oxford|cambridge|wechat|weibo|instagram|tiktok|facebook|starbucks|chanel|gucci|prada)/i;
    for (const [id, c] of Object.entries(CHARACTERS)) {
      const hit = c.systemPrompt.match(banned);
      expect(hit?.[0], `${id} names ${hit?.[0]}`).toBeUndefined();
    }
  });
});
