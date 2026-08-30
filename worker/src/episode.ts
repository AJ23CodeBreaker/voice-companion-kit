// Phase 2 write path — the episode summary.
//
// doc/09 §7a: one cheap call at session end. Input is the transcript, output is
// 2-4 sentences in her voice, a mood word, and a salience score.
//
// Three things about this are deliberate:
//
//   1. It runs AFTER he hangs up. Nothing is waiting on it, so it can be slow
//      and it can fail without anyone noticing.
//   2. It runs on a separate, cheaper model from the one that serves turns.
//      Nobody is listening to this output; it only has to be ACCURATE — which
//      turned out to be a higher bar than "cheap" could clear, see below.
//   3. It is written in HER voice and from her side. "He told me his sister is
//      getting married" is a memory. "The user disclosed a family event" is a
//      log line, and it reads like one when she recalls it later.

import type { ChatMessage } from "./llm";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Nothing is waiting on this, but it IS the store of record — a detail lost
// here is lost permanently, and a detail invented here is one she will state
// with total confidence. An 8B model was used first and was not good enough:
// it copied the prompt's own example into every summary (see CHANGELOG
// 2026-08-19). Still cheap; still nobody waiting.
const SUMMARY_MODEL = "meta-llama/llama-3.3-70b-instruct";

const SUMMARY_TIMEOUT_MS = 20_000;
/** Below this, a conversation is a misfire rather than a memory. */
export const MIN_TURNS_FOR_EPISODE = 2;

export interface ExtractedFact {
  /** Normalised key. Supersession is matched on this, so it must be stable. */
  subject: string;
  content: string;
  confidence: number;
}

export interface EpisodeSummary {
  summary: string;
  mood: string | null;
  salience: number;
  /** Durable facts about him. Written as `heuristic` — inferred, supersedable. */
  facts: ExtractedFact[];
  /** Things he said would happen that she has not heard the end of. */
  openLoops: string[];
}

const SYSTEM = `You summarise a conversation from the point of view of ONE PARTICIPANT, so she can remember it later.

Return ONLY a JSON object, no markdown fence, no commentary:
{"summary": "...", "mood": "...", "salience": 0.0, "facts": [], "open_loops": []}

RULES FOR "summary" — 2 to 4 sentences, her memory of it, first person about him:

1. RECORD ONLY WHAT HAPPENED. Never add detail that is not in the transcript.
   If he did not say he had a bad day, do not write that he did. An invented
   memory is worse than no memory: she will recall it with total confidence
   and he will know it never happened.

2. COPY SPECIFICS EXACTLY. Names, places, dates, numbers, brands and product
   names must appear EXACTLY as he said them, character for character. If he
   said a specific model or a specific day, write that model and that day —
   never a looser word for it, never a shortened form. These are the details
   he will test her on.

3. START WHEREVER THE CONVERSATION STARTS. Do not use a standard opening
   sentence. Two summaries of two different conversations must not begin the
   same way.

4. Write what he said about his life, what he seemed to feel, and anything he
   asked her to remember. Never write "the user" or "the conversation". Never
   mention an app, a system, a model or a session.

"mood" - ONE lowercase word for how it felt: warm, playful, heavy, tense,
         tender, flat, close, distant.

"salience" - 0.0 to 1.0. How much this should still matter in a month.
             0.1 = small talk that could be forgotten.
             0.5 = an ordinary good conversation.
             0.9 = something happened he would expect her to remember.
             Be honest. Most conversations are not 0.9.

RULES FOR "facts" — 0 to 5 durable facts about HIM, or [] when there are none.
Each one: {"subject": "...", "content": "...", "confidence": 0.0}

  subject     A stable lowercase key, dot separated: "job", "dog.name",
              "sister.name", "home.city". The SAME fact must always get the
              SAME subject, because a later contradiction is matched on it —
              "job" today and "employment" next month are two truths that
              never resolve, and she will assert both.
  content     One plain sentence, third person: "He teaches secondary maths."
  confidence  0.0 to 1.0. How certain you are that HE SAID THIS.

  ONLY things that will still be true next month. Not his mood, not what he
  did today, not anything about this conversation.
  NEVER infer one fact from another. "He mentioned the school run" is NOT
  "He has children." If he did not say it in words, it is not a fact.
  If he said nothing durable, return []. An empty list is the normal answer
  for an ordinary conversation.

  A FACT MUST COME FROM A LINE MARKED "HIM". Never from her lines. If SHE
  named his dog, his job or his town and he did not confirm it in his own
  words, it did not happen and it is not a fact. She is sometimes wrong, and
  writing her guess down here is how a wrong guess becomes permanent.

RULES FOR "open_loops" — 0 to 2 short sentences, or [].

  Something he said WOULD HAPPEN that she has not heard the end of, written so
  she could follow it up: "He had a job interview on Thursday."
  Only when he actually said it was coming. Never invent one — an invented
  loop makes her ask about something that never existed, which is worse than
  never asking at all.`;

function clampSalience(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0.4;
  return Math.max(0, Math.min(1, n));
}

/**
 * Summarise one finished conversation. Returns null when there is nothing worth
 * storing or the call fails — an absent memory is a smaller problem than a
 * fabricated one, and nothing downstream should treat this as an error.
 */
export async function summariseEpisode(
  apiKey: string,
  characterName: string,
  history: ChatMessage[],
): Promise<EpisodeSummary | null> {
  const exchanges = history.filter((m) => m.role === "user").length;
  if (exchanges < MIN_TURNS_FOR_EPISODE) return null;

  const transcript = history
    .map((m) => `${m.role === "user" ? "HIM" : characterName.toUpperCase()}: ${m.content}`)
    .join("\n")
    .slice(-12_000); // last ~12k chars — the end of a conversation carries it

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);
  try {
    const resp = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://mia.local",
        "X-Title": "Voice Companion Kit — memory",
      },
      body: JSON.stringify({
        model: SUMMARY_MODEL,
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: `You are summarising for ${characterName}. This is her conversation with him:\n\n${transcript}`,
          },
        ],
        // Low temperature: this is a recording task, not a creative one. The
        // voice belongs to the persona at speaking time, not to the summariser.
        temperature: 0.3,
        max_tokens: 300,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      console.error(
        JSON.stringify({ event: "episode_http_error", status: resp.status, model: SUMMARY_MODEL }),
      );
      return null;
    }
    const body = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = body?.choices?.[0]?.message?.content;
    if (!raw) return null;
    return parseSummary(raw);
  } catch (e) {
    console.error(
      JSON.stringify({ event: "episode_exception", error: (e as Error).message, model: SUMMARY_MODEL }),
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull the object out of whatever the model returned. `response_format` is
 * requested but not honoured by every provider on OpenRouter, so a fenced or
 * prose-wrapped object still has to parse.
 */
export function parseSummary(raw: string): EpisodeSummary | null {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  if (!text.startsWith("{")) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    text = text.slice(start, end + 1);
  }
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  if (!summary) return null;
  const mood = typeof obj.mood === "string" && obj.mood.trim() ? obj.mood.trim().toLowerCase().slice(0, 40) : null;
  return {
    summary: summary.slice(0, 2_000),
    mood,
    salience: clampSalience(obj.salience),
    facts: parseFacts(obj.facts),
    openLoops: parseOpenLoops(obj.open_loops),
  };
}

/** How many of each the writer will accept from one conversation. */
const MAX_FACTS = 5;
const MAX_LOOPS = 2;

/**
 * Facts, defensively.
 *
 * Every one of these becomes an assertion about his life that she will make
 * with total confidence, so a malformed row is not a parse problem, it is a
 * future lie. Anything not clearly well-formed is dropped rather than repaired:
 * the cost of missing a fact is that she asks again, and the cost of inventing
 * one is the bug this whole track exists to remove.
 */
function parseFacts(raw: unknown): ExtractedFact[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtractedFact[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const subject = typeof o.subject === "string" ? o.subject.trim().toLowerCase() : "";
    const content = typeof o.content === "string" ? o.content.trim() : "";
    // A subject has to be a usable key: supersession matches on it exactly.
    if (!/^[a-z][a-z0-9_.]{0,79}$/.test(subject)) continue;
    if (content.length < 3) continue;
    if (seen.has(subject)) continue; // one claim per subject per conversation
    seen.add(subject);
    out.push({ subject, content: content.slice(0, 300), confidence: clampSalience(o.confidence) });
    if (out.length >= MAX_FACTS) break;
  }
  return out;
}

function parseOpenLoops(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is string => typeof s === "string" && s.trim().length > 3)
    .map((s) => s.trim().slice(0, 300))
    .slice(0, MAX_LOOPS);
}
