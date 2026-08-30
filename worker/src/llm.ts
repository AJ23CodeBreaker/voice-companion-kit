// Port of the OpenRouter streaming call + retry/fallback logic from
// stream_turn() in orchestrator_modal.py.

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Primary: Hermes 4 70B — successor to Hermes 3, better steerability/lower
// refusal rate per OpenRouter's own listing, same price tier and 131K
// context. Reasoning mode is off by default so this adds no latency vs
// Hermes 3 (see CHANGELOG.md for the model-selection writeup).
// Fallback: Dolphin 70B (also uncensored).
const LLM_CANDIDATES = [
  "nousresearch/hermes-4-70b",
  "cognitivecomputations/dolphin-llama-3.1-70b",
];

// If OpenRouter opens the stream and then goes silent without closing it,
// give up after this long instead of hanging the turn indefinitely.
const STREAM_IDLE_TIMEOUT_MS = 20000;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /**
   * Optional speaker label. Used to mark few-shot demonstrations as
   * "example_user"/"example_assistant" (the OpenAI convention for stopping a
   * model treating examples as real conversation history). Models that don't
   * support it ignore the field, so the bookend system messages in
   * fewshot.ts carry the same meaning in plain text as a fallback.
   */
  name?: string;
}

export interface StreamLlmOptions {
  apiKey: string;
  messages: ChatMessage[];
  onToken: (token: string) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface StreamLlmResult {
  fullReply: string;
  ttftMs: number | null;
}

interface OpenRouterStreamChunk {
  choices?: Array<{ delta?: { content?: string } }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(retry: number): number {
  // 1s, 2s, 4s — capped, instead of a flat linear ramp, so a real outage
  // backs off instead of hammering OpenRouter at a fixed cadence.
  return Math.min(1000 * 2 ** retry, 8000);
}

class StreamReadTimeoutError extends Error {
  constructor(ms: number) {
    super(`LLM stream stalled — no data for ${ms}ms`);
    this.name = "StreamReadTimeoutError";
  }
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StreamReadTimeoutError(ms)), ms);
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export async function streamLlmReply(opts: StreamLlmOptions): Promise<StreamLlmResult> {
  const tStart = Date.now();
  let fullReply = "";
  let ttftMs: number | null = null;
  let success = false;

  for (const model of LLM_CANDIDATES) {
    if (success) break;

    for (let retry = 0; retry < 3; retry++) {
      if (retry > 0) await sleep(backoffMs(retry));

      let resp: Response;
      try {
        resp = await fetch(OPENROUTER_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://mia.local",
            "X-Title": "Voice Companion Kit",
          },
          body: JSON.stringify({
            model,
            messages: opts.messages,
            stream: true,
            temperature: 0.85,
            top_p: 0.95,
            // Hard ceiling backstop — see CHANGELOG.md 2026-08-10.
            max_tokens: 250,
          }),
          signal: opts.signal,
        });
      } catch (e) {
        if ((e as Error).name === "AbortError") throw e;
        if (retry === 2) break; // exhausted retries on this candidate
        continue;
      }

      if (resp.status === 429) {
        if (retry === 2) break; // exhausted retries — try next candidate
        continue;
      }
      if (!resp.ok) {
        // Any other non-OK status (5xx etc.): don't fail the whole turn —
        // move on to the next candidate model instead. Previously this
        // threw immediately, which meant the documented Dolphin fallback
        // never actually ran on a transient primary-model error.
        const body = await resp.text();
        console.error(
          JSON.stringify({ event: "llm_http_error", model, status: resp.status, body: body.slice(0, 300) }),
        );
        break;
      }

      // ── Stream SSE ──────────────────────────────────────────
      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        while (true) {
          const { done, value } = await readWithTimeout(reader, STREAM_IDLE_TIMEOUT_MS);
          if (done) break;
          buf += decoder.decode(value, { stream: true });

          let idx: number;
          while ((idx = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith("data: ")) continue;
            const dataStr = line.slice(6);
            if (dataStr === "[DONE]") continue;
            let chunk: OpenRouterStreamChunk;
            try {
              chunk = JSON.parse(dataStr);
            } catch {
              continue;
            }
            const token = chunk?.choices?.[0]?.delta?.content;
            if (!token) continue;
            if (ttftMs === null) ttftMs = Date.now() - tStart;
            fullReply += token;
            await opts.onToken(token);
          }
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") throw e;
        console.error(JSON.stringify({ event: "llm_stream_error", model, error: (e as Error).message }));
        try {
          await reader.cancel();
        } catch {
          /* best-effort cleanup */
        }
        // Treat a stalled/broken stream like a failed attempt: retry this
        // model (if retries remain) or fall through to the next candidate.
        if (retry === 2) break;
        continue;
      }

      success = true;
      break;
    }
  }

  if (!success) {
    throw new Error("She is temporarily busy (rate-limited). Please try again in a moment.");
  }

  return { fullReply, ttftMs };
}

// ── Route warming ─────────────────────────────────────────────
// Measured 2026-08-19: median TTFT fell 980ms → 756ms → 363ms across three
// live sessions purely in run order, and turn 1's p90 was 4101ms against
// 1103ms from turn 4 onward (doc/14-latency.md). The cost is a cold route at
// OpenRouter, and it lands on the first thing the user says — the worst
// possible place for it.
//
// So we spend one throwaway call at connect, while the loading bar is still
// running and nobody is waiting on it. The reply is discarded; the point is
// the round trip, not the text.
//
// Deliberately NOT the greeting itself. The greeting is a canned line that
// goes straight to TTS and never touches OpenRouter, so it cannot warm
// anything. Making the greeting LLM-generated would instead put a cold
// multi-second TTFT on the critical path — the exact problem being solved.
const WARM_TIMEOUT_MS = 8000;

export interface WarmResult {
  ok: boolean;
  ms: number;
  model: string;
  error?: string;
}

/**
 * Fire a minimal request at the primary model to warm the provider route.
 * Never throws — a failed warm-up is a missed optimisation, not an error,
 * and must never affect the session it was meant to speed up.
 */
export async function warmLlmRoute(apiKey: string, signal?: AbortSignal): Promise<WarmResult> {
  const model = LLM_CANDIDATES[0];
  const t0 = Date.now();
  // Only the primary model is warmed. The fallback is by definition the
  // path we do not expect to take, and warming it would double the cost of
  // a call whose entire value is that it is cheap.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), WARM_TIMEOUT_MS);
  const onOuterAbort = () => timeout.abort();
  signal?.addEventListener("abort", onOuterAbort);
  try {
    const resp = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://mia.local",
        "X-Title": "Voice Companion Kit",
      },
      // Same shape as a real turn (streamed, same model) so it warms the
      // same path, but capped at a single token so it costs almost nothing.
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        max_tokens: 1,
      }),
      signal: timeout.signal,
    });
    // Drain and discard. Leaving the body unread would leak the connection.
    if (resp.body) await resp.arrayBuffer();
    return { ok: resp.ok, ms: Date.now() - t0, model, ...(resp.ok ? {} : { error: `HTTP ${resp.status}` }) };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, model, error: (e as Error).message };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}
