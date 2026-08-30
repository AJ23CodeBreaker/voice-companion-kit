// Sentence extraction and tag stripping for streamed LLM output.
//
// Originally ported from the Modal backend (orchestrator_modal.py), which was
// removed on 2026-08-19. The Worker is now the only runtime — there is no
// second implementation to keep this in sync with.

const SENT_END = /(?<![A-Z])(?<![A-Z][a-z])(?<!\d)[.!?]+(?=\s)/;
// Matches both (parenthesis) tags (Fish Audio S1) and [bracket] tags (S2/S2.1).
const EMOTION_TAG = /\([^)]{1,40}\)|\[[^\]]{1,40}\]/g;
const ACTION_TAG = /\*[^*]+\*/g;
const EARLY_SPLIT = /[,;]\s+/;

const BANNED_PHRASES =
  /\bi'?m an? (ai\b|artificial intelligence|language model|chatbot)|\bi (?:can(?:'?t| ?not)) (?:actually )?(?:hear|see|feel)\b|\bi (?:don'?t|do not) have a body\b|\bi can only (?:read|process) text\b|\bas an ai\b/i;

export function stripForDisplay(text: string): string {
  return text.replace(EMOTION_TAG, "").replace(/\s{2,}/g, " ").trim();
}

export function stripForTts(text: string): string {
  return text.replace(ACTION_TAG, "").replace(/\s{2,}/g, " ").trim();
}

export function stripAllTags(text: string): string {
  return text
    .replace(EMOTION_TAG, "")
    .replace(ACTION_TAG, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function isBannedPhrase(text: string): boolean {
  return BANNED_PHRASES.test(text);
}

/**
 * If buf[:pos] has an unclosed '(' or '[', extend pos to include the
 * matching closer — handles both (parenthesis) and [bracket] emotion tags.
 * Returns the (possibly extended) position, or -1 if no closer found.
 */
function closeTag(buf: string, pos: number): number {
  const prefix = buf.slice(0, pos);
  const count = (s: string, ch: string) => s.split(ch).length - 1;
  const parenOpen = count(prefix, "(") > count(prefix, ")");
  const bracketOpen = count(prefix, "[") > count(prefix, "]");
  if (!parenOpen && !bracketOpen) return pos;

  const candidates: number[] = [];
  if (parenOpen) {
    const c = buf.indexOf(")", pos);
    if (c !== -1) candidates.push(c);
  }
  if (bracketOpen) {
    const c = buf.indexOf("]", pos);
    if (c !== -1) candidates.push(c);
  }
  if (candidates.length === 0) return -1;
  return Math.min(...candidates) + 1;
}

export interface SplitResult {
  sentence: string;
  remainder: string;
}

/**
 * Four triggers in priority order:
 *   1. Sentence-ending punctuation (.!?) — cleanest split, always preferred.
 *   2. Comma/semicolon early-split — fire TTS mid-sentence after ~25 chars.
 *   3. Word-fragment — 8+ complete words after 400ms pause since last TTS fire.
 *   4. Hard force-split at 200 chars.
 * All splits are guarded so we never cut inside an emotion tag.
 */
export function extractSentence(buf: string, elapsedSinceLastTtsMs: number): SplitResult {
  // 1. Sentence-ending punctuation
  const m = SENT_END.exec(buf);
  if (m && m.index >= 8) {
    const pos = closeTag(buf, m.index + m[0].length);
    if (pos > 0) {
      return { sentence: buf.slice(0, pos).trim(), remainder: buf.slice(pos).trimStart() };
    }
  }

  // 2. Comma / semicolon early-split (>=25 chars before, >=15 chars after)
  const mE = EARLY_SPLIT.exec(buf);
  if (mE && mE.index >= 25 && buf.length - (mE.index + mE[0].length) >= 15) {
    const pos = closeTag(buf, mE.index + 1); // keep the comma
    if (pos > 0 && buf.length - pos >= 15) {
      return { sentence: buf.slice(0, pos).trim(), remainder: buf.slice(pos).trimStart() };
    }
  }

  // 3. Word-fragment: 8+ complete words (followed by whitespace — excludes a
  // possibly-partial token at the very end of the streamed buffer) after a
  // 400ms pause since the last TTS fire.
  if (elapsedSinceLastTtsMs >= 400) {
    const complete: RegExpExecArray[] = [];
    const re = /\S+/g;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(buf)) !== null) {
      if (mm.index + mm[0].length < buf.length) complete.push(mm);
    }
    if (complete.length >= 8) {
      let pos = complete[7].index + complete[7][0].length;
      pos = closeTag(buf, pos);
      if (pos > 0) {
        return { sentence: buf.slice(0, pos).trim(), remainder: buf.slice(pos).trimStart() };
      }
    }
  }

  // 4. Force-split long buffers
  if (buf.length > 200) {
    const split = buf.slice(0, 200).lastIndexOf(" ");
    if (split > 80) {
      const pos = closeTag(buf, split);
      if (pos > 0) {
        return { sentence: buf.slice(0, pos).trim(), remainder: buf.slice(pos).trimStart() };
      }
    }
  }

  return { sentence: "", remainder: buf };
}
