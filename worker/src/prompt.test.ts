import { describe, it, expect } from "vitest";
import {
  extractSentence,
  stripForDisplay,
  stripForTts,
  stripAllTags,
  isBannedPhrase,
} from "./prompt";

describe("extractSentence", () => {
  it("splits on sentence-ending punctuation", () => {
    const { sentence, remainder } = extractSentence("Hello there. How are you?", 0);
    expect(sentence).toBe("Hello there.");
    expect(remainder).toBe("How are you?");
  });

  it("does not split too early (before 8 chars)", () => {
    const { sentence, remainder } = extractSentence("Hi. More text here", 0);
    expect(sentence).toBe("");
    expect(remainder).toBe("Hi. More text here");
  });

  it("does not split inside an emotion bracket tag", () => {
    const { sentence } = extractSentence("She said [happy] hello. Next", 0);
    // Every "[" returned in the sentence must have its matching "]" — i.e.
    // the split never lands between an opening and closing bracket.
    const opens = (sentence.match(/\[/g) || []).length;
    const closes = (sentence.match(/\]/g) || []).length;
    expect(opens).toBe(closes);
  });

  it("early-splits on a comma once far enough in", () => {
    const buf = "This is a long enough clause, and here is more text after it";
    const { sentence, remainder } = extractSentence(buf, 0);
    expect(sentence.endsWith(",")).toBe(true);
    expect(remainder.length).toBeGreaterThan(0);
  });

  it("word-fragment splits after 8 words once the pause threshold is hit", () => {
    const buf = "one two three four five six seven eight nine ten";
    const { sentence, remainder } = extractSentence(buf, 500);
    expect(sentence.split(/\s+/).length).toBeGreaterThanOrEqual(8);
    expect(remainder.length).toBeGreaterThan(0);
  });

  it("does not word-fragment split before the pause threshold", () => {
    const buf = "one two three four five six seven eight nine ten";
    const { sentence } = extractSentence(buf, 100);
    expect(sentence).toBe("");
  });

  it("force-splits very long buffers with no punctuation", () => {
    const buf = "word ".repeat(60).trim();
    const { sentence, remainder } = extractSentence(buf, 0);
    expect(sentence.length).toBeGreaterThan(0);
    expect(sentence.length).toBeLessThanOrEqual(200);
    expect(remainder.length).toBeGreaterThan(0);
  });

  it("returns empty sentence for a short, unpunctuated buffer", () => {
    const { sentence, remainder } = extractSentence("hi", 0);
    expect(sentence).toBe("");
    expect(remainder).toBe("hi");
  });
});

describe("stripForDisplay", () => {
  it("removes emotion tags", () => {
    expect(stripForDisplay("[happy] Hello there [warm]")).toBe("Hello there");
  });
  it("collapses extra whitespace", () => {
    expect(stripForDisplay("Hello    there")).toBe("Hello there");
  });
});

describe("stripForTts", () => {
  it("removes action tags but keeps emotion brackets", () => {
    expect(stripForTts("[happy] Hello *waves*")).toBe("[happy] Hello");
  });
});

describe("stripAllTags", () => {
  it("removes every tag type", () => {
    expect(stripAllTags("[happy] Hello *waves* (soft)")).toBe("Hello");
  });
});

describe("isBannedPhrase", () => {
  it("flags AI self-disclosure phrases", () => {
    expect(isBannedPhrase("I'm an AI and I can't feel anything")).toBe(true);
    expect(isBannedPhrase("As an AI, I don't have a body")).toBe(true);
  });
  it("does not flag ordinary conversation", () => {
    expect(isBannedPhrase("I missed you so much today")).toBe(false);
  });
});
