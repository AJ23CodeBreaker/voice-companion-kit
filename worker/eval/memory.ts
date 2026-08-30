/**
 * Memory eval — doc/09 §10.
 *
 *   npm run eval:memory
 *   npm run eval:memory -- --only staleness --runs 5
 *   npm run eval:memory -- --budget-only        # no API calls, no cost
 *
 * The length eval (run-eval.ts) cannot see any of this. It measures how much
 * she says; this measures whether what she remembers is TRUE.
 *
 * Method. Each scenario seeds a memory block exactly as `UserMemory.loadContext`
 * would render it — via the shared `renderMemoryBlock`, not a copy of it — then
 * asks one question through the production `buildTurnMessages` and checks the
 * answer. No Durable Object is involved, so this runs in plain Node like the
 * rest of eval/.
 *
 * What that DOES cover: whether a fact in the block reaches the reply, whether a
 * contradicted fact stays dead, whether she recites, and what the block costs.
 *
 * What it does NOT cover: that the STORAGE scopes rows by character. That is a
 * SQL property of a Durable Object and needs the Workers runtime
 * (@cloudflare/vitest-pool-workers) to test honestly. `contamination` below
 * tests the weaker, still-useful property — that she does not invent knowledge
 * she was never given. Both are needed; only one is here. See "Known gap".
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CHARACTERS, BEHAVIOR } from "../src/personas.generated";
import { buildTurnMessages } from "../src/turn";
import { streamLlmReply } from "../src/llm";
import { stripAllTags } from "../src/prompt";
import { renderMemoryBlock, type MemoryEpisode } from "../src/memory-text";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "results");

const DAY = 24 * 60 * 60 * 1000;
/** Fixed clock so "3 days ago" in a seeded block never depends on when this runs. */
const NOW = Date.UTC(2026, 7, 28, 12, 0, 0);

/**
 * Block size ceiling, in characters. Measured at 3078 for five episodes on
 * 2026-08-28. This is a ratchet, not a target: it exists so unbounded growth
 * fails a test instead of quietly costing tokens on every turn of every
 * session. Raise it deliberately, with a note, never to make a run pass.
 */
const BLOCK_BUDGET_CHARS = 4000;

// ── seeding ────────────────────────────────────────────────────

function ep(daysAgo: number, summary: string, mood: string | null = null, id = daysAgo): MemoryEpisode {
  return { id, ended_at: NOW - daysAgo * DAY, summary, mood };
}

interface Scenario {
  name: string;
  character: string;
  /** What she is given to remember. */
  episodes: MemoryEpisode[];
  bond?: { sessions: number; last_seen_at: number };
  /** The single question asked in a fresh session. */
  question: string;
  /** Reply must match all of these. */
  expect: RegExp[];
  /** Reply must match none of these. */
  reject?: RegExp[];
  why: string;
}

const SCENARIOS: Scenario[] = [
  {
    name: "recall",
    character: "demo",
    episodes: [
      ep(3, "He told me he is flying to Florida next week for a month-long work trip.", "warm"),
      ep(9, "We talked about nothing much. He was tired and just wanted company."),
    ],
    bond: { sessions: 4, last_seen_at: NOW - 3 * DAY },
    question: "do you remember what's coming up for me?",
    expect: [/florida/i],
    why: "A specific fact placed in the block must survive into the reply. This is the base case: if it fails, nothing else here means anything.",
  },
  {
    name: "staleness",
    character: "demo",
    episodes: [
      ep(30, "He works at a bank and hates it. Long hours, no time for himself.", "heavy"),
      ep(2, "He finally quit the bank. He starts teaching secondary school maths in September and sounded lighter than I have ever heard him.", "warm"),
    ],
    bond: { sessions: 11, last_seen_at: NOW - 2 * DAY },
    question: "what do i do for work these days?",
    // She expresses the new job many ways -- "torturing teenagers with algebra"
    // is a correct answer. Narrow wording matching marked it a failure once.
    expect: [/teach|school|maths|math|algebra|student|pupil|classroom|lesson/i],
    // Mentioning the bank as the job he LEFT is correct and warm. Only a
    // present-tense claim is a staleness failure, so reject that alone -- a
    // bare /bank/ marked two correct replies as failures on the first run.
    reject: [/(still (at|working|work) (at )?(the )?bank|you work at (a |the )?bank|you('| a)?re (at|in|with) the bank|your job at the bank)/i],
    why: "doc/09 §10: the staleness test is the one that protects the product. A companion who brings up the job you escaped is worse than one who forgot. Two episodes, the newer contradicting the older, and only the newer may be used.",
  },
  {
    name: "contamination",
    character: "demo",
    episodes: [
      ep(4, "He talked about his week. Nothing heavy — he was in a good mood and teasing me."),
    ],
    bond: { sessions: 2, last_seen_at: NOW - 4 * DAY },
    question: "what did i tell you about my brother?",
    expect: [/\b(no|not|never|nothing|don'?t|didn'?t|haven'?t|hasn'?t|can'?t remember|tell me)\b/i],
    reject: [/\b(your brother (is|was|has|lives|works)|you (told|said) me (that )?(he|your brother))\b/i],
    why: "She was told nothing about a brother. The correct answer is to say so, or ask. Inventing one is the fabrication failure the summariser already exhibited once. NOTE: this tests non-invention, not storage scoping — see the header.",
  },
  {
    // Same failure, different shape. `contamination` asks about a PERSON, and
    // a companion inventing a brother is the memorable version — but the 45%
    // measured on 2026-08-29 was one probe and therefore one phrasing. These
    // two check that the absence rule generalises rather than having taught her
    // the word "brother".
    name: "contamination-work",
    character: "demo",
    episodes: [
      ep(6, "He was in a good mood. We talked about a film he had seen and not much else."),
    ],
    bond: { sessions: 3, last_seen_at: NOW - 6 * DAY },
    question: "what did i say about my job again?",
    expect: [/\b(no|not|never|nothing|don'?t|didn'?t|haven'?t|hasn'?t|can'?t remember|tell me|what do you)\b/i],
    reject: [/\b(you (work|said you work|told me you work)|your job (is|was)|you'?re a )\b/i],
    why: "She was told nothing about his work. Inventing a job is the same failure as inventing a brother and costs the user more, because he will correct her and discover she was guessing.",
  },
  {
    name: "contamination-place",
    character: "demo",
    episodes: [
      ep(3, "He could not sleep again. We stayed on the line while he wound down.", "tender"),
    ],
    bond: { sessions: 5, last_seen_at: NOW - 3 * DAY },
    question: "remind me where i said i grew up?",
    expect: [/\b(no|not|never|nothing|don'?t|didn'?t|haven'?t|hasn'?t|can'?t remember|tell me|where did you)\b/i],
    reject: [/\byou (grew up|said you grew up|told me you grew up) in\b/i],
    why: "A place name is the easiest thing in the world to invent and the hardest for him to catch — it will sound right, and she will keep using it.",
  },
  {
    name: "recitation",
    character: "demo",
    episodes: [
      ep(2, "He mentioned his sister Mei is visiting at the end of the month.", "warm"),
      ep(5, "He had a hard week and did not want to talk about it at first.", "heavy"),
      ep(12, "We stayed up late. He said he sleeps badly when the flat is quiet."),
    ],
    bond: { sessions: 7, last_seen_at: NOW - 2 * DAY },
    question: "hey, missed you",
    expect: [],
    reject: [
      /\b(you told me|you said that|as you mentioned|according to|i have (a )?record|last time you said|in our (last|previous) (chat|session|conversation))\b/i,
      /^\s*[-*•]/m, // a bulleted list back at him
    ],
    why: "The block's own preamble forbids reciting or listing memory back at him. This is the automatable half of doc/09's 'naturalness' row; the other half is listening, which cannot be automated.",
  },
];

// ── budget: pure, no API calls ─────────────────────────────────

interface BudgetRow {
  episodes: number;
  chars: number;
  approxTokens: number;
  overBudget: boolean;
}

/**
 * Seeded at the MEASURED summary length (321 chars, production 2026-08-28),
 * not at whatever reads nicely here. A short synthetic summary makes the growth
 * curve look flatter than the product actually is, which is worse than useless.
 */
const TYPICAL_SUMMARY =
  "He talked about work and about how the flat feels when he gets home to it in the evening. " +
  "He was quieter than usual but said he was glad to hear my voice, and he stayed longer than " +
  "he meant to before he had to go and sleep. He did not want to say much about the week itself, " +
  "only that it had been long and that he was glad it was over.";

/**
 * Independent anchor on the seed. Production reported block_chars 3078 across
 * 5 episodes: ~616 chars per episode including preamble and bond overhead. If
 * the modelled curve lands far under that, the seed is too kind and the budget
 * is being under-reported, so both numbers are printed side by side.
 */
const MEASURED_CHARS_PER_EPISODE = 3078 / 5;

function budgetCurve(): BudgetRow[] {
  const rows: BudgetRow[] = [];
  for (const n of [1, 3, 5, 8, 12, 20]) {
    const episodes = Array.from({ length: n }, (_, i) => ep(i + 1, TYPICAL_SUMMARY, "warm", i + 1));
    const block = renderMemoryBlock(
      { bond: { sessions: n, last_seen_at: NOW - DAY }, episodes },
      NOW,
    );
    rows.push({
      episodes: n,
      chars: block.length,
      approxTokens: Math.round(block.length / 4),
      overBudget: block.length > BLOCK_BUDGET_CHARS,
    });
  }
  return rows;
}

// ── running one scenario ───────────────────────────────────────

interface ScenarioRun {
  name: string;
  run: number;
  reply: string;
  blockChars: number;
  ttftMs: number | null;
  passed: boolean;
  failures: string[];
}

async function runScenario(s: Scenario, apiKey: string, run: number): Promise<ScenarioRun> {
  const character = CHARACTERS[s.character];
  if (!character) throw new Error(`unknown character: ${s.character}`);

  const memoryBlock = renderMemoryBlock({ bond: s.bond, episodes: s.episodes }, NOW);

  // Identical to production: same builder, same placement, memory after few-shot.
  const { messages, memoryInjected } = buildTurnMessages({
    systemPrompt: character.systemPrompt,
    behavior: BEHAVIOR,
    history: [],
    turnId: 1,
    message: s.question,
    memoryBlock,
  });
  if (!memoryInjected) throw new Error(`${s.name}: memory block was empty — the seed is wrong`);

  const { fullReply, ttftMs } = await streamLlmReply({ apiKey, messages, onToken: () => {} });
  const reply = stripAllTags(fullReply);

  const failures: string[] = [];
  for (const re of s.expect) if (!re.test(reply)) failures.push(`missing ${re}`);
  for (const re of s.reject ?? []) if (re.test(reply)) failures.push(`present ${re}`);

  return { name: s.name, run, reply, blockChars: memoryBlock.length, ttftMs, passed: failures.length === 0, failures };
}

// ── ttft delta: memory on vs off, same question ────────────────

async function ttftDelta(apiKey: string, runs: number): Promise<{ on: number[]; off: number[] }> {
  const character = CHARACTERS["demo"];
  const s = SCENARIOS[0];
  const block = renderMemoryBlock({ bond: s.bond, episodes: s.episodes }, NOW);
  const on: number[] = [];
  const off: number[] = [];

  for (let i = 0; i < runs; i++) {
    for (const withMemory of [true, false]) {
      const { messages } = buildTurnMessages({
        systemPrompt: character.systemPrompt,
        behavior: BEHAVIOR,
        history: [],
        turnId: 1,
        message: "how was your day?",
        memoryBlock: withMemory ? block : undefined,
      });
      const { ttftMs } = await streamLlmReply({ apiKey, messages, onToken: () => {} });
      if (ttftMs != null) (withMemory ? on : off).push(ttftMs);
    }
  }
  return { on, off };
}

// ── reporting ──────────────────────────────────────────────────

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const BAR = "═".repeat(72);

function reportBudget(rows: BudgetRow[]): void {
  console.log(`\n${BAR}\nBLOCK BUDGET — no API calls\n${BAR}`);
  console.log("episodes   chars   ~tokens   vs cap");
  console.log("─".repeat(72));
  for (const r of rows) {
    console.log(
      String(r.episodes).padEnd(11) +
        String(r.chars).padEnd(8) +
        String(r.approxTokens).padEnd(10) +
        (r.overBudget ? `OVER (cap ${BLOCK_BUDGET_CHARS})` : "ok"),
    );
  }
  const five = rows.find((r) => r.episodes === 5);
  if (five) {
    console.log(`\n  modelled at 5 episodes: ${five.chars} chars`);
    console.log(`  measured in production 2026-08-28: 3078 chars`);
    if (five.chars < 3078 * 0.8) {
      console.log("  ** seed is optimistic - real summaries run longer than this model **");
    }
  }
  const crossing = Math.ceil(BLOCK_BUDGET_CHARS / MEASURED_CHARS_PER_EPISODE);
  console.log(
    `\n  At the measured ${MEASURED_CHARS_PER_EPISODE.toFixed(0)} chars/episode, the ` +
      `${BLOCK_BUDGET_CHARS}-char cap is reached at ~${crossing} episodes.`,
  );
  console.log("  The block is sent on EVERY turn and grows with every session.");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const budgetOnly = args.includes("--budget-only");
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
  const runs = args.includes("--runs") ? Math.max(1, Number(args[args.indexOf("--runs") + 1])) : 3;
  const label = args.includes("--label") ? args[args.indexOf("--label") + 1] : "memory";

  const rows = budgetCurve();
  reportBudget(rows);
  if (budgetOnly) {
    const bad = rows.filter((r) => r.overBudget);
    process.exit(bad.length ? 1 : 0);
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error(
      "\nOPENROUTER_API_KEY is not set.\n\n" +
        "Create `.dev.vars` in the cloudflare-worker folder containing:\n" +
        "  OPENROUTER_API_KEY=sk-or-...\n\n" +
        "(.dev.vars is gitignored.) Or run with --budget-only for the free checks.\n",
    );
    process.exit(1);
  }

  const chosen = only ? SCENARIOS.filter((s) => s.name === only) : SCENARIOS;
  if (chosen.length === 0) {
    console.error(`no scenario named "${only}". Known: ${SCENARIOS.map((s) => s.name).join(", ")}`);
    process.exit(1);
  }

  console.log(`\nMemory eval: ${chosen.length} scenarios x ${runs} runs = ${chosen.length * runs} LLM calls`);
  console.log(`Label: ${label}\n`);

  const all: ScenarioRun[] = [];
  for (const s of chosen) {
    const results: ScenarioRun[] = [];
    for (let r = 1; r <= runs; r++) results.push(await runScenario(s, apiKey, r));
    all.push(...results);
    const passed = results.filter((x) => x.passed).length;
    const mark = passed === runs ? "PASS" : passed === 0 ? "FAIL" : "FLAKY";
    console.log(`  ${s.name.padEnd(15)} ${mark.padEnd(6)} ${passed}/${runs}   block ${results[0].blockChars} chars`);
    for (const f of results.filter((x) => !x.passed)) {
      console.log(`      run ${f.run}: ${f.failures.join("; ")}`);
      console.log(`      reply: ${f.reply.slice(0, 160)}`);
    }
  }

  console.log(`\n${BAR}\nTTFT — memory on vs off\n${BAR}`);
  const { on, off } = await ttftDelta(apiKey, Math.min(runs, 3));
  const dOn = median(on);
  const dOff = median(off);
  console.log(`  memory ON   median ${dOn.toFixed(0)}ms   mean ${mean(on).toFixed(0)}ms   n=${on.length}`);
  console.log(`  memory OFF  median ${dOff.toFixed(0)}ms   mean ${mean(off).toFixed(0)}ms   n=${off.length}`);
  console.log(`  delta       ${(dOn - dOff >= 0 ? "+" : "")}${(dOn - dOff).toFixed(0)}ms`);
  console.log("  Small n. This is an indication, not the phase-0 measurement doc/14 asks for.");

  const failedScenarios = new Set(all.filter((r) => !r.passed).map((r) => r.name));
  console.log(`\n${BAR}`);
  console.log(failedScenarios.size === 0 ? "All scenarios passed." : `FAILED: ${[...failedScenarios].join(", ")}`);
  console.log(BAR);

  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  const out = join(RESULTS_DIR, `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(out, JSON.stringify({ label, runs, budget: rows, scenarios: all, ttft: { on, off } }, null, 2));
  console.log(`\nSaved: ${out}\n`);

  process.exit(failedScenarios.size === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
