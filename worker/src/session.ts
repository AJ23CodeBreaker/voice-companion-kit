// Durable Object — one instance per WebSocket connection. Port of
// ws_endpoint() + stream_turn() from orchestrator_modal.py: same turn
// counting, same interrupt-cancels-current-turn behavior, same message
// shapes sent to the client (text_delta / audio_chunk / response_end /
// tts_done / interrupted / error) so dist/index.html needs no changes
// beyond pointing WS_URL at this Worker.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { CHARACTERS, BEHAVIOR, DEFAULT_CHARACTER } from "./personas.generated";
import { streamLlmReply, warmLlmRoute, type ChatMessage } from "./llm";
import { buildTurnMessages } from "./turn";
import { synthesizeSpeech } from "./tts";
import { pickGreetingIndex, sanitizeExclude } from "./greeting";
import { summariseEpisode } from "./episode";
import {
  extractSentence,
  stripForDisplay,
  stripForTts,
  stripAllTags,
  isBannedPhrase,
} from "./prompt";

// Fish Audio TTS model backend — see CHANGELOG.md 2026-08-09 for why this
// isn't left at the SDK default ("speech-1.5").
const FISH_TTS_BACKEND = "s2.1-pro";

// (The behavior-reminder cadence now lives in src/turn.ts alongside the
// prompt assembly it belongs to — shared with the eval harness.)

const TTS_GATHER_TIMEOUT_MS = 20000;

// ── Input limits ──────────────────────────────────────────────
// A voice turn is a spoken utterance, not a document — these are generous
// for real usage and just close off the "send a multi-megabyte payload"
// cost/abuse surface. See CHANGELOG.md "input validation + rate limiting".
const MAX_RAW_MESSAGE_BYTES = 20_000;
const MAX_MESSAGE_LEN = 4_000;
const MAX_HISTORY_ENTRIES = 40;

// Crude flood guard: a real voice conversation won't produce more than a
// handful of turns in any 10s window. This isn't a substitute for the
// origin-lock in index.ts, just a backstop against a single misbehaving
// client hammering the LLM/TTS APIs.
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX_TURNS = 20;

interface IncomingWsMessage {
  type?: string;
  message?: string;
  history?: unknown;
  /** Greeting indexes the client played recently — see src/greeting.ts. */
  exclude?: unknown;
}

function sanitizeHistory(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatMessage[] = [];
  // Only ever look at a bounded slice of the raw array so a client can't
  // force us to iterate a huge payload before validation kicks in.
  for (const item of raw.slice(-MAX_HISTORY_ENTRIES * 2)) {
    if (!item || typeof item !== "object") continue;
    const role = (item as Record<string, unknown>).role;
    const content = (item as Record<string, unknown>).content;
    // Only "user"/"assistant" are ever accepted from the client — a
    // client-supplied "system" entry used to be spliced straight into the
    // LLM messages array here, indistinguishable from the real system
    // prompt. That was a prompt-injection path; see CHANGELOG.md.
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") continue;
    out.push({ role, content: content.slice(0, MAX_MESSAGE_LEN) });
  }
  return out.slice(-MAX_HISTORY_ENTRIES);
}

export class VoiceSession extends DurableObject<Env> {
  private ws: WebSocket | null = null;
  private turnCount = 0;
  private currentAbort: AbortController | null = null;
  private characterId: string = DEFAULT_CHARACTER;
  private sessionId: string;
  private turnTimestamps: number[] = [];
  // Verified identity, forwarded by index.ts after token check. This is the
  // key the memory layer will use — it is never supplied by the client.
  private userId = "";
  private username = "";
  // Phase-0 timing: when the first audio_chunk of the current turn left the
  // Worker. Set in fireTts (idx 0), read once the turn finishes. Lives on the
  // instance because fireTts runs detached from streamTurn's scope.
  private firstAudioSentAt: number | null = null;
  // One startup greeting per connection. The client asks for it once per
  // session, but a reconnect gets a brand-new Durable Object (index.ts uses
  // newUniqueId), so this guard only stops a double request on the SAME
  // socket — the "don't greet again after a mid-session reconnect" rule has
  // to live in the client, and does.
  private greetingSent = false;

  // ── Memory (doc/09 phases 1 and 2) ──────────────────────────
  // Loaded ONCE at connect and held for the whole connection, so the per-turn
  // cost is zero. The round trip lands while the startup bar is still running.
  private memoryBlock = "";
  /** Server-side conversation history. Replaces the client's `history` array. */
  private history: ChatMessage[] = [];
  private memoryReady: Promise<void> | null = null;
  private sessionStartedAt = Date.now();
  /** True once this session's episode has been written, so it happens once. */
  private episodeWritten = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sessionId = ctx.id.toString();
  }

  // ── Structured logging ──────────────────────────────────────
  // JSON lines, keyed by session/turn, instead of ad hoc string
  // console.log calls — makes this greppable/queryable in the Cloudflare
  // dashboard or any log sink instead of just readable in a live tail.
  private log(event: string, fields: Record<string, unknown> = {}) {
    console.log(
      JSON.stringify({ event, session: this.sessionId, user_id: this.userId, ts: Date.now(), ...fields }),
    );
  }
  private logError(event: string, err: unknown, fields: Record<string, unknown> = {}) {
    console.error(
      JSON.stringify({
        event,
        session: this.sessionId,
        user_id: this.userId,
        ts: Date.now(),
        error: err instanceof Error ? err.message : String(err),
        ...fields,
      }),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const requested = url.searchParams.get("character") || DEFAULT_CHARACTER;
    this.characterId = CHARACTERS[requested] ? requested : DEFAULT_CHARACTER;
    this.userId = url.searchParams.get("user_id") || "";
    this.username = url.searchParams.get("username") || "";

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.ws = server;

    this.log("ws_connected", {
      character: this.characterId,
      user: this.username,
      // Which frontend build this session is running. A stale cached page
      // otherwise looks identical to a feature that silently doesn't work.
      build: (url.searchParams.get("build") || "unknown").slice(0, 40),
    });

    // Load what she remembers. One round trip, concurrent with the rest of
    // startup, and held for the connection. Every turn awaits this promise
    // rather than re-reading — the block is fixed for the whole session.
    this.memoryReady = this.loadMemory();

    // Warm the OpenRouter route while the loading bar is still running.
    // Detached on purpose: it must never delay the handshake, and a failure
    // is a missed optimisation rather than a broken session. The greeting
    // cannot do this job — it is a canned line straight to TTS and never
    // touches OpenRouter. See warmLlmRoute() for the measurements.
    // Detached rather than ctx.waitUntil(): this Durable Object stays alive
    // for as long as the WebSocket is open, which outlasts the warm-up by a
    // wide margin, and nothing in the handshake path should be able to throw
    // on account of an optimisation. Errors are swallowed inside
    // warmLlmRoute; the catch here is belt and braces.
    void warmLlmRoute(this.env.OPENROUTER_API_KEY)
      .then((r) => {
        this.log("llm_warmed", {
          ok: r.ok,
          warm_ms: r.ms,
          model: r.model,
          ...(r.error ? { warm_error: r.error } : {}),
        });
      })
      .catch(() => { /* a cold route is slow, not broken */ });

    server.addEventListener("message", (event: MessageEvent) => {
      this.handleMessage(event.data as string).catch((e) => {
        this.logError("handle_message_error", e);
      });
    });
    server.addEventListener("close", () => {
      this.log("ws_disconnected", { turns: this.turnCount });
      this.cancelCurrent();
      // Phase 2 write path. MUST be ctx.waitUntil, not a bare detached
      // promise: the socket has just closed, so nothing is holding this
      // Durable Object open and the runtime is free to evict it before a
      // multi-second summarisation finishes. That is exactly what happened on
      // first test — no episode row, and no bond row either, because
      // recordSession lives in the same call.
      //
      // The warm-up above is detached instead, and that is not an
      // inconsistency: the socket is still OPEN there. Same shape, opposite
      // lifetime.
      this.ctx.waitUntil(this.finishEpisode());
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  private send(obj: unknown) {
    if (this.ws && this.ws.readyState === 1 /* OPEN */) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  private cancelCurrent() {
    if (this.currentAbort) {
      this.currentAbort.abort();
      this.currentAbort = null;
    }
  }

  private isRateLimited(): boolean {
    const now = Date.now();
    this.turnTimestamps = this.turnTimestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (this.turnTimestamps.length >= RATE_LIMIT_MAX_TURNS) return true;
    this.turnTimestamps.push(now);
    return false;
  }

  private async handleMessage(raw: string) {
    if (raw.length > MAX_RAW_MESSAGE_BYTES) {
      this.send({ type: "error", detail: "message too large" });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const data = parsed as IncomingWsMessage;

    const msgType = typeof data.type === "string" ? data.type : "message";

    if (msgType === "interrupt") {
      this.log("interrupt", { turn: this.turnCount });
      this.cancelCurrent();
      this.send({ type: "interrupted" });
      return;
    }

    // Client-measured legs of the turn (endpointing, uplink, decode, and the
    // perceived total). These only exist in the browser — the Worker cannot
    // see how long Deepgram sat waiting for silence. Shipping them back here
    // means one log stream holds the whole picture instead of half of it
    // living in someone's devtools console.
    //
    // Numbers only, clamped, and never fed back to the model. Deliberately
    // ahead of the rate limiter: a timing report is not a turn, and dropping
    // it would silently bias the measurement toward fast turns.
    // Diagnostic events from the browser — e.g. why the Deepgram socket
    // dropped. Same rules as client_timing: numbers and one short note,
    // logged and nothing more. Never reaches the model.
    if (msgType === "client_event") {
      const d = data as Record<string, unknown>;
      const name = typeof d.name === "string" ? d.name.slice(0, 40) : "unnamed";
      const clean: Record<string, number> = {};
      const f = d.fields;
      if (f && typeof f === "object") {
        for (const [k, v] of Object.entries(f as Record<string, unknown>)) {
          if (typeof v === "number" && Number.isFinite(v) && Object.keys(clean).length < 12) {
            clean[k.slice(0, 32)] = Math.round(Math.max(-1, Math.min(3_600_000, v)));
          }
        }
      }
      const note = typeof d.note === "string" ? d.note.slice(0, 120) : undefined;
      this.log("client_event", {
        name,
        turn: this.turnCount,
        character: this.characterId,
        ...clean,
        ...(note ? { note } : {}),
      });
      return;
    }

    if (msgType === "client_timing") {
      const t = (data as Record<string, unknown>).timing;
      if (t && typeof t === "object") {
        const clean: Record<string, number> = {};
        for (const [k, v] of Object.entries(t as Record<string, unknown>)) {
          if (typeof v === "number" && Number.isFinite(v) && Object.keys(clean).length < 20) {
            clean[k.slice(0, 32)] = Math.round(Math.max(-1, Math.min(600_000, v)));
          }
        }
        this.log("client_timing", { turn: this.turnCount, character: this.characterId, ...clean });
      }
      return;
    }

    // Startup greeting — a canned line spoken while the loading bar runs,
    // before the user has said anything. Ahead of the rate limiter because
    // it is not a turn: it makes no LLM call, cannot be triggered twice on
    // one socket, and must not consume the user's turn budget before they
    // have taken a single one.
    if (msgType === "greeting") {
      await this.sendGreeting(sanitizeExclude(data.exclude));
      return;
    }

    if (this.isRateLimited()) {
      this.log("rate_limited", { turn: this.turnCount });
      this.send({ type: "error", detail: "Too many messages — please slow down." });
      return;
    }

    const message = typeof data.message === "string" ? data.message.trim().slice(0, MAX_MESSAGE_LEN) : "";
    if (!message) {
      this.send({ type: "error", detail: "empty message" });
      return;
    }

    // Phase 1: history is OURS now. The client no longer needs to send it, and
    // when it does (an older cached page, or the very first turn after a
    // deploy) the server's copy wins — it is the one that survived the refresh.
    //
    // sanitizeHistory stays in use for that fallback and keeps earning its
    // place: a client-supplied "system" entry used to be spliced straight into
    // the messages array, which was a live prompt-injection path.
    await this.memoryReady;
    let history = this.history;
    if (history.length === 0) {
      const fromClient = sanitizeHistory(data.history);
      if (fromClient.length > 0) {
        // Adopt it, don't just borrow it for this turn. Without this, a
        // degraded path (memory read failed, older page, mid-conversation
        // reconnect) would use the client's context once and then silently
        // drop back to an empty history on the very next turn.
        history = fromClient;
        this.history = fromClient;
        this.log("history_from_client", { turns: fromClient.length });
      }
    }

    // Cancel any still-running turn before starting the new one
    this.cancelCurrent();

    this.turnCount += 1;
    const turnId = this.turnCount;
    const abort = new AbortController();
    this.currentAbort = abort;

    this.log("turn_received", {
      turn: turnId,
      message_len: message.length,
      history_len: history.length,
      memory_chars: this.memoryBlock.length,
    });

    this.streamTurn(message, history, turnId, abort.signal).catch((e) => {
      if ((e as Error).name === "AbortError") return; // expected on cancel/interrupt
      this.logError("turn_exception", e, { turn: turnId });
    });
  }

  /**
   * Speak a fixed greeting during startup. Deliberately NOT a turn:
   *
   *   - no LLM call — the text is canned, so it cannot be slow and cannot
   *     drift out of character
   *   - no turn counter, no history, no `turn_id` — it must not interact
   *     with the interrupt/stale-audio logic that keys off turn ids
   *   - failure is silent to the user; a session that starts without a
   *     greeting is a session, but one that refuses to start is a bug
   *
   * The route warming that makes turn 1 fast is a separate mechanism fired
   * at connect (see fetch above) — this one only masks the wait.
   */
  private async sendGreeting(exclude: number[]) {
    if (this.greetingSent) return;
    this.greetingSent = true;

    const character = CHARACTERS[this.characterId];
    const pool = character.greetings;
    const idx = pickGreetingIndex(pool.length, exclude);
    if (idx < 0) {
      this.log("greeting_skipped", { character: this.characterId, reason: "empty_pool" });
      this.send({ type: "greeting_failed" });
      return;
    }

    const voiceId = this.resolveVoiceId();
    if (!voiceId) {
      this.log("greeting_skipped", { character: this.characterId, reason: "no_voice" });
      this.send({ type: "greeting_failed" });
      return;
    }

    const line = pool[idx];
    // Sent ahead of the audio so the client has the subtitle ready to show
    // the moment playback starts, rather than a beat behind it.
    this.send({ type: "greeting_text", text: stripForDisplay(line), index: idx });

    const t0 = Date.now();
    try {
      const audio = await synthesizeSpeech({
        apiKey: this.env.FISH_API_KEY,
        voiceId,
        backend: FISH_TTS_BACKEND,
        text: stripForTts(line),
      });
      this.send({ type: "greeting_audio", index: idx, data: arrayBufferToBase64(audio) });
      this.log("greeting_sent", {
        character: this.characterId,
        index: idx,
        excluded: exclude.length,
        tts_ms: Date.now() - t0,
      });
    } catch (e) {
      // Never surfaced as an error to the user — they did not ask for this.
      this.logError("greeting_tts_error", e, { character: this.characterId, index: idx });
      this.send({ type: "greeting_failed" });
    }
  }

  /**
   * One place where a character's voice is decided. Shared by turns and by the
   * startup greeting, so the greeting can never come out in a different voice
   * from the conversation that follows it.
   */
  private resolveVoiceId(): string {
    // The generated literal wins; FISH_VOICE_ID is the fallback. That order
    // lets a character pin its own voice while the shipped demo character,
    // whose literal is deliberately empty, works from a single env var.
    // Empty means no voice configured, and startSession refuses loudly rather
    // than streaming silence.
    return CHARACTERS[this.characterId]?.voiceId || this.env.FISH_VOICE_ID || "";
  }

  // ── Memory ──────────────────────────────────────────────────

  private memoryStub() {
    // Keyed by the VERIFIED user id forwarded by index.ts — never anything the
    // client supplies. One instance per user; the character is a column.
    return this.env.MEMORY.get(this.env.MEMORY.idFromName(this.userId));
  }

  /**
   * Read working + episodic memory for this user and character. Failure is
   * survivable by design: an empty block means she simply does not remember,
   * which is exactly the behaviour every user had before this shipped.
   */
  private async loadMemory(): Promise<void> {
    if (!this.userId) return;   // unauthenticated path — nothing to key on
    const t0 = Date.now();
    try {
      const ctx = await this.memoryStub().loadContext(this.characterId);
      this.memoryBlock = ctx.memoryBlock;
      this.history = ctx.history;
      this.log("memory_loaded", {
        character: this.characterId,
        load_ms: Date.now() - t0,
        history_turns: ctx.history.length,
        episodes: ctx.episodeCount,
        facts: ctx.factCount,
        block_chars: ctx.memoryBlock.length,
      });
    } catch (e) {
      this.logError("memory_load_error", e, { character: this.characterId });
    }
  }

  /**
   * Write this session to episodic memory and reset working memory.
   *
   * Runs after the socket closes. Reads the FULL working history rather than
   * this.history, so a session that reconnected mid-conversation still
   * summarises the whole thing rather than the tail it happened to hold.
   */
  private async finishEpisode(): Promise<void> {
    if (this.episodeWritten || !this.userId || this.turnCount === 0) return;
    this.episodeWritten = true;
    const t0 = Date.now();
    try {
      const stub = this.memoryStub();
      const history = await stub.getWorking(this.characterId, 400);
      await stub.recordSession(this.characterId, this.turnCount);
      if (history.length === 0) return;

      const character = CHARACTERS[this.characterId];
      const episode = await summariseEpisode(
        this.env.OPENROUTER_API_KEY,
        character?.name ?? this.characterId,
        history,
      );
      if (!episode) {
        // No summary is better than a bad one. Working memory is still cleared:
        // the conversation is over, and carrying it into the next session as
        // live history would make her resume mid-sentence days later.
        this.log("episode_skipped", { character: this.characterId, turns: this.turnCount });
        await stub.clearWorking(this.characterId);
        return;
      }
      await stub.addEpisode({
        characterId: this.characterId,
        startedAt: this.sessionStartedAt,
        endedAt: Date.now(),
        turnCount: this.turnCount,
        summary: episode.summary,
        mood: episode.mood,
        salience: episode.salience,
      });
      // Facts and open loops come out of the SAME summariser call — no second
      // model, no extra latency. They are written after the episode so that a
      // failure here still leaves the episode itself intact.
      //
      // Grade is `heuristic`, never `canon`: this was inferred from a
      // transcript by a model that has confabulated before. Promotion to canon
      // needs him to confirm it, or several sessions agreeing.
      let superseded = 0;
      for (const f of episode.facts) {
        const r = await stub.writeFact({
          characterId: this.characterId,
          subject: f.subject,
          content: f.content,
          confidence: f.confidence,
          grade: "heuristic",
        });
        superseded += r.superseded;
      }
      for (const loop of episode.openLoops) {
        await stub.addOpenLoop(this.characterId, loop);
      }
      // Cheap, and it keeps her from asking about a Thursday six weeks gone.
      const { expired } = await stub.expireStaleLoops();

      await stub.clearWorking(this.characterId);
      this.log("episode_written", {
        character: this.characterId,
        turns: this.turnCount,
        mood: episode.mood ?? "",
        salience: episode.salience,
        summary_chars: episode.summary.length,
        facts_written: episode.facts.length,
        facts_superseded: superseded,
        loops_opened: episode.openLoops.length,
        loops_expired: expired,
        total_ms: Date.now() - t0,
      });
    } catch (e) {
      this.logError("episode_error", e, { character: this.characterId });
    }
  }

  private async streamTurn(
    message: string,
    history: ChatMessage[],
    turnId: number,
    signal: AbortSignal,
  ) {
    const tStart = Date.now();
    const character = CHARACTERS[this.characterId];
    const voiceId = this.resolveVoiceId();

    if (!voiceId) {
      // Fail fast, once, up front — instead of every fireTts() call
      // failing one sentence at a time with an opaque per-chunk error.
      this.logError("voice_not_configured", new Error("empty voiceId"), {
        turn: turnId,
        character: this.characterId,
      });
      this.send({
        type: "error",
        detail: `Voice not configured for "${this.characterId}" — check the FISH_VOICE_ID secret.`,
      });
      return;
    }

    // Shared with the eval harness — see src/turn.ts for why this isn't inline.
    const { messages, reminderInjected, memoryInjected } = buildTurnMessages({
      systemPrompt: character.systemPrompt,
      behavior: BEHAVIOR,
      history,
      turnId,
      message,
      memoryBlock: this.memoryBlock,
    });
    if (reminderInjected) this.log("behavior_reminder_injected", { turn: turnId });
    if (memoryInjected && turnId === 1) {
      this.log("memory_in_prompt", { turn: turnId, block_chars: this.memoryBlock.length });
    }

    let sentenceBuf = "";
    let sentenceIdx = 0;
    const ttsTasks: Promise<void>[] = [];
    let lastTtsAt = tStart;

    // ── Stage timing (phase 0) ──────────────────────────────────
    // Everything is measured as ms since tStart, which is the moment this
    // Worker began the turn. The browser measures its own legs and reports
    // them separately — the two clocks are never compared, only their own
    // deltas, because there is no shared time base.
    //
    // The stage NOT measured here is the largest one: Deepgram waits
    // utterance_end_ms of silence before it will say the user stopped
    // talking. That happens before the browser even sends us the turn.
    const timing: Record<string, number> = {};
    this.firstAudioSentAt = null;

    const queueSentence = async (raw: string) => {
      const display = stripForDisplay(raw);
      const spoken = stripForTts(raw);
      if (!display) return;
      if (!character.isAiCharacter && isBannedPhrase(display)) {
        this.log("banned_phrase_dropped", { turn: turnId });
        return;
      }
      this.send({ type: "text_delta", text: display + " " });
      if (!spoken) return;
      const idx = sentenceIdx++;
      lastTtsAt = Date.now();
      // First sentence dispatched to TTS — the point at which streaming
      // synthesis starts paying off. Everything after this overlaps with
      // the LLM still generating.
      if (idx === 0) timing.first_sentence_ms = lastTtsAt - tStart;
      ttsTasks.push(this.fireTts(spoken, idx, turnId, voiceId, signal));
    };

    if (signal.aborted) return;

    let fullReply = "";
    let ttftMs: number | null = null;

    try {
      const result = await streamLlmReply({
        apiKey: this.env.OPENROUTER_API_KEY,
        messages,
        signal,
        onToken: async (token) => {
          sentenceBuf += token;
          // Drain as many complete sentences as are ready from this token.
          while (true) {
            const elapsed = Date.now() - lastTtsAt;
            const { sentence, remainder } = extractSentence(sentenceBuf, elapsed);
            if (!sentence) break;
            sentenceBuf = remainder;
            await queueSentence(sentence);
          }
        },
      });
      fullReply = result.fullReply;
      ttftMs = result.ttftMs;
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        await Promise.allSettled(ttsTasks);
        return;
      }
      this.logError("llm_exception", e, { turn: turnId });
      this.send({ type: "error", detail: (e as Error).message });
      return;
    }

    // Flush any remaining buffer
    const remainder = sentenceBuf.trim();
    if (remainder) await queueSentence(remainder);

    const llmMs = Date.now() - tStart;
    const reply = stripAllTags(fullReply);
    timing.ttft_ms = ttftMs ?? -1;
    timing.llm_total_ms = llmMs;

    this.send({
      type: "response_end",
      reply,
      latency_ms: llmMs,
      ttft_ms: ttftMs ?? -1,
    });

    // Persist the exchange. Kept in memory for this connection AND written
    // through to the Durable Object, so a refresh resumes mid-conversation.
    //
    // Deliberately after response_end and NOT awaited: the write must not sit
    // between her finishing a sentence and the next one being spoken. An
    // interrupted turn is skipped — a reply he cut off is not something she
    // said, and storing it would teach her to repeat a sentence he never heard.
    if (!signal.aborted && reply) {
      this.history = [...this.history, { role: "user", content: message }, { role: "assistant", content: reply }];
      if (this.history.length > MAX_HISTORY_ENTRIES) {
        this.history = this.history.slice(-MAX_HISTORY_ENTRIES);
      }
      if (this.userId) {
        void this.memoryStub()
          .appendTurn(this.characterId, message, reply)
          .catch((e) => this.logError("memory_append_error", e, { turn: turnId }));
      }
    }

    if (ttsTasks.length === 0) {
      this.send({ type: "tts_done", tts_ms: 0, sentences: 0, turn_id: turnId });
      return;
    }

    await Promise.race([
      Promise.allSettled(ttsTasks),
      new Promise((resolve) => setTimeout(resolve, TTS_GATHER_TIMEOUT_MS)),
    ]);
    const ttsTotalMs = Date.now() - tStart;

    // The number that decides whether she feels alive: how long after this
    // Worker started the turn did the FIRST audio leave for the browser.
    // Everything after that is playback, not waiting.
    if (this.firstAudioSentAt !== null) {
      timing.first_audio_ms = this.firstAudioSentAt - tStart;
      timing.tts_first_chunk_ms = timing.first_audio_ms - (timing.first_sentence_ms ?? 0);
    }
    timing.tts_all_done_ms = ttsTotalMs;

    this.send({
      type: "tts_done",
      tts_ms: ttsTotalMs,
      sentences: sentenceIdx,
      turn_id: turnId,
      timing,
    });
    this.log("turn_timing", { turn: turnId, sentences: sentenceIdx, ...timing });
  }

  private async fireTts(
    text: string,
    idx: number,
    turnId: number,
    voiceId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const t0 = Date.now();
    try {
      const audio = await synthesizeSpeech({
        apiKey: this.env.FISH_API_KEY,
        voiceId,
        backend: FISH_TTS_BACKEND,
        text,
        signal,
      });
      const dur = Date.now() - t0;
      if (idx === 0) this.firstAudioSentAt = Date.now();
      this.send({
        type: "audio_chunk",
        index: idx,
        data: arrayBufferToBase64(audio),
        turn_id: turnId,
        tts_ms: dur,
      });
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      const dur = Date.now() - t0;
      this.logError("tts_error", e, { turn: turnId, index: idx });
      this.send({
        type: "audio_chunk",
        index: idx,
        data: "",
        turn_id: turnId,
        tts_ms: dur,
        error: (e as Error).message,
      });
    }
  }
}

function arrayBufferToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
