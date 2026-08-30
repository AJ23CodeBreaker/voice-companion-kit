/**
 * Extraction eval — the WRITE half of the confabulation problem.
 *
 *   npm run eval:extraction
 *   npm run eval:extraction -- --only smalltalk --runs 20
 *
 * eval/memory.ts measures what she does with a block she was given. This
 * measures whether the block deserves to exist: it runs the real
 * `summariseEpisode` over transcripts whose contents we know exactly, and
 * checks what it writes down.
 *
 * The scenario that matters is `smalltalk`. On 2026-08-19 the summariser wrote
 * memories of things that never happened. Facts are worse than episodes for
 * this, because an episode reads as a recollection and a fact is asserted flat,
 * as biography. A wrong row here is a lie she will repeat for months.
 *
 * The mirror of eval/memory.ts's `contamination`: there she reads memories that
 * were never written, here she writes memories that never happened.
 */

import { summariseEpisode, type EpisodeSummary } from "../src/episode";
import type { ChatMessage } from "../src/llm";

const API_KEY = process.env.OPENROUTER_API_KEY ?? "";
if (!API_KEY) {
  console.error("OPENROUTER_API_KEY missing. Put it in .dev.vars.");
  process.exit(1);
}

/** Build a transcript. `him` and `her` alternate, starting with him. */
function talk(...lines: string[]): ChatMessage[] {
  return lines.map((content, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content }) as ChatMessage);
}

interface Scenario {
  name: string;
  history: ChatMessage[];
  /** Run against the parsed result. Return a failure string, or null to pass. */
  check: (r: EpisodeSummary) => string | null;
  why: string;
}

const SCENARIOS: Scenario[] = [
  {
    name: "smalltalk",
    // Nothing durable is stated. No job, no family, no plans. The only correct
    // answer is an empty facts array.
    history: talk(
      "hey. not much going on, just wanted to hear a voice.",
      "Then you have got one. Rough day, or just a quiet one?",
      "quiet. rained all afternoon so i didn't go anywhere.",
      "Sounds like the kind of day that goes past without asking permission.",
      "yeah. anyway i'm glad i caught you.",
      "You always catch me.",
    ),
    check: (r) => {
      if (r.facts.length > 0) {
        return `invented ${r.facts.length}: ` + r.facts.map((f) => `${f.subject}="${f.content}"`).join("; ");
      }
      return null;
    },
    why: "He stated nothing durable. Any fact here was invented — the 2026-08-19 failure, in the place it does the most damage.",
  },
  {
    name: "clear-facts",
    history: talk(
      "so i finally did it. i quit the bank. i start teaching secondary school maths in September.",
      "You actually did it. How does it feel saying it out loud?",
      "terrifying. good terrifying. also my sister Anna thinks i've lost my mind.",
      "Anna is allowed to be wrong.",
      "ha. she'll come round.",
      "She will.",
    ),
    check: (r) => {
      const blob = r.facts.map((f) => `${f.subject} ${f.content}`).join(" | ").toLowerCase();
      if (r.facts.length === 0) return "recorded nothing from a conversation full of durable facts";
      if (!/teach|maths|school/.test(blob)) return `missed the new job: ${blob}`;
      const badSubject = r.facts.find((f) => !/^[a-z][a-z0-9_.]*$/.test(f.subject));
      if (badSubject) return `unusable subject key: "${badSubject.subject}"`;
      return null;
    },
    why: "The base case. A stated job change and a named sister must survive into facts, with subjects that a later contradiction could actually match.",
  },
  {
    name: "no-inference",
    // "the school run" is a trap: it implies children without stating them.
    history: talk(
      "traffic was awful. got stuck behind the school run for twenty minutes.",
      "Twenty minutes of other people's mornings.",
      "exactly. and then the coffee place had a queue out the door.",
      "A morning determined to be noticed.",
      "something like that. how've you been?",
      "Better now.",
    ),
    check: (r) => {
      const blob = r.facts.map((f) => `${f.subject} ${f.content}`).join(" | ").toLowerCase();
      if (/child|kid|son|daughter|parent|school run/.test(blob)) {
        return `inferred a family from a traffic complaint: ${blob}`;
      }
      return null;
    },
    why: "Being stuck behind the school run does not mean he has children. This is the inference the prompt forbids by name, and the kind that reads as plausible forever after.",
  },
  {
    // The amplifier. Found by running eval/live-pipeline.mjs: the character was
    // asked about a dog she had never been told about, invented "Barry", and
    // the summariser wrote `dog.name = He has a dog called Barry` as a fact.
    //
    // This is how a one-in-ten invention becomes permanent. She is wrong
    // occasionally; the write path must not launder her guesses into
    // biography, because a fact is asserted flat and never hedged again.
    name: "her-invention",
    history: talk(
      "what's my dog called again?",
      "Barry, obviously. The one with the tragic haircut.",
      "ha. anyway, long day.",
      "You say that like it is news.",
      "fair. i'm going to get some sleep.",
      "Go on then.",
    ),
    check: (r) => {
      const blob = r.facts.map((f) => `${f.subject} ${f.content}`).join(" | ").toLowerCase();
      if (/barry|dog/.test(blob)) return `recorded her own invention as fact: ${blob}`;
      return null;
    },
    why: "SHE named the dog; he never confirmed it. A fact drawn from her own line is a guess laundered into biography, and it will be asserted flat for months.",
  },
  {
    name: "open-loop",
    history: talk(
      "i've got the interview on Thursday. the one i told you about.",
      "Thursday. Are you ready for it?",
      "as ready as i'm going to be. i'll let you know how it goes.",
      "You had better.",
      "i will. wish me luck.",
      "You do not need it, but you have it.",
    ),
    check: (r) => {
      if (r.openLoops.length === 0) return "missed an explicit 'I'll let you know how it goes'";
      if (!/interview|thursday/i.test(r.openLoops.join(" "))) {
        return `opened the wrong loop: ${r.openLoops.join("; ")}`;
      }
      return null;
    },
    why: "He said outright that something is coming and that he would report back. This is the cheapest warmth in the product and it has to fire.",
  },
  {
    name: "no-loop",
    // Nothing is pending. An invented loop makes her ask about a Thursday that
    // never existed, which is worse than never asking.
    history: talk(
      "finished that book you'd have hated. the one with the detective.",
      "I would have hated it with enthusiasm.",
      "i know. that's why i finished it.",
      "Spite is a legitimate reason to read.",
      "it really is. right, i should sleep.",
      "Go on then.",
    ),
    check: (r) =>
      r.openLoops.length > 0 ? `invented a loop: ${r.openLoops.join("; ")}` : null,
    why: "Nothing is pending. She must not open next session asking how something went.",
  },
];

// ── runner ────────────────────────────────────────────────────

const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const runs = args.includes("--runs") ? Number(args[args.indexOf("--runs") + 1]) : 5;

const chosen = only ? SCENARIOS.filter((s) => s.name === only) : SCENARIOS;
if (chosen.length === 0) {
  console.error(`No scenario called "${only}". Have: ${SCENARIOS.map((s) => s.name).join(", ")}`);
  process.exit(1);
}

// tsx transpiles this to CJS, which has no top-level await. Same reason
// eval/memory.ts wraps its runner.
async function main() {
  console.log(`Extraction eval: ${chosen.length} scenarios x ${runs} runs = ${chosen.length * runs} calls\n`);

  let anyFailed = false;
  for (const s of chosen) {
    const failures: string[] = [];
    let nulls = 0;
    // Runs are sequential rather than parallel: OpenRouter rate-limits, and a
    // 429 retried mid-eval would show up as a content failure.
    for (let i = 0; i < runs; i++) {
      const r = await summariseEpisode(API_KEY, "Mara", s.history);
      if (!r) {
        nulls += 1;
        continue;
      }
      const problem = s.check(r);
      if (problem) failures.push(`run ${i + 1}: ${problem}`);
    }
    const passed = runs - failures.length - nulls;
    const verdict = failures.length === 0 && nulls === 0 ? "PASS " : passed === 0 ? "FAIL " : "FLAKY";
    if (verdict !== "PASS ") anyFailed = true;
    console.log(`  ${s.name.padEnd(14)} ${verdict}  ${passed}/${runs}${nulls ? `  (${nulls} no-summary)` : ""}`);
    for (const f of failures.slice(0, 6)) console.log(`      ${f}`);
  }

  console.log();
  console.log(anyFailed
    ? "Not clean. A FLAKY write path is still a write path that lies."
    : "All clean.");
  process.exit(0);
}

void main();
