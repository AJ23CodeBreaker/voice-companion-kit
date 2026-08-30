# 01 — Architecture

```
browser
  │  WebSocket (text or 16kHz PCM)
  ▼
Cloudflare Worker ──────────────────────────────────────────┐
  │                                                         │
  ├─ VoiceSession  (Durable Object, one per CONNECTION)      │
  │     turn count, interrupt state, streaming              │
  │                                                         │
  ├─ AuthStore     (Durable Object, one, named)              │
  │     accounts, session tokens                            │
  │                                                         │
  ├─ UserMemory    (Durable Object, one per USER)            │
  │     working / episodic / semantic / bond, SQLite        │
  │                                                         │
  ├──> speech-to-text  (streaming, voice mode only)          │
  ├──> one LLM call    (OpenRouter)                          │
  └──> text-to-speech  (per sentence, streamed back) ────────┘
```

---

## The one-call rule

**The hot path makes exactly one LLM call. Always.**

This is the constraint everything else bends around. It is why memory is
assembled in code rather than written by a model, why extraction happens after
hang-up, and why there is no retrieval step. Every feature request that would
add a second call gets redesigned or dropped.

The budget it is protecting: roughly 600ms end to end for conversation to feel
alive — ~150–300ms turn detection, 150–400ms to first token, 100–200ms to first
audio, plus network. There is no room for a second round trip.

---

## Three Durable Objects, three lifetimes

| Object | Instances | Lives for | Holds |
|---|---|---|---|
| `VoiceSession` | One per connection (`newUniqueId()`) | The socket | Turn count, interrupt state |
| `AuthStore` | One, named `"global"` | Forever | Accounts, tokens |
| `UserMemory` | One per user (`idFromName(userId)`) | Forever | All four memory stores |

**The distinction is load-bearing.** `VoiceSession` is per-*connection*, so
anything stored there dies on reconnect. Working memory was originally put
there and vanished on exactly the dropped-socket case it existed to survive.

`AuthStore` is a single named instance on purpose: token validation needs strong
consistency, and one instance gives it for free.

---

## Streaming, and why sentences

The reply is streamed from the model, split into sentences, and each sentence is
sent to TTS as soon as it is complete. Audio for sentence one is playing while
sentence three is still being generated.

Two consequences worth knowing:

**`response_end` is not the end of the turn.** It fires when the *text* is done.
Audio chunks arrive after it. Anything that treats it as the end — a test
harness, a UI state machine — is wrong.

**Barge-in suppresses the result, not the feed.** When the user starts speaking
mid-reply, you cannot un-send audio and you cannot pause a container stream by
dropping packets. The in-flight TTS requests are aborted and their output
discarded; the stream itself is left alone.

---

## Auth

Deliberately minimal, and worth understanding before you deploy it.

- Username and password, PBKDF2-hashed, in `AuthStore`.
- Login returns a bearer token with an expiry.
- `/auth/register` is **admin-gated** by a shared key — this is a private-pilot
  design, not open signup.
- **`/ws` and `/auth/login` both reject a request whose `Origin` is not on the
  allowlist.** That is a real boundary: it stops another site opening an
  authenticated socket in a signed-in user's browser.

> A terminal sends **no** `Origin` header, so the eval harnesses pass
> `Origin: http://localhost` explicitly. `/auth/register` is not origin-checked,
> which is why creating an account from curl works while logging in appears
> broken. This costs everyone an hour exactly once.

---

## Prompt assembly

Order matters, and the reason is caching:

```
1. system    persona + behaviour        ← identical for every user
2. few-shot  style demonstrations       ← identical for every user
3. system    the memory block           ← per user, fixed for the session
4. history   working memory
5. system    behaviour reminder          ← every N turns
6. user      the message
```

Everything above line 3 is byte-identical across all users and all sessions, so
it caches. The memory block is fixed for the whole session, so the prefix
through it is stable turn to turn as well.

Put the memory block in the system prompt at position 0 and you change the first
bytes of every request, destroying prefix reuse for everyone. This is the single
easiest performance mistake to make here.

`worker/src/turn.ts` is 90 lines and is the whole story.

---

## Personas are generated, not read

A Worker has no filesystem. `scripts/generate-personas.mjs` reads
`personas/*.txt` and emits a TypeScript module with the text embedded.

Two benefits beyond necessity: a bad persona edit fails the **build** rather than
the first conversation after deploy, and the `.txt` files stay the single source
of truth so a writer can edit them without touching code.

It normalises CRLF to LF on the way in. That is not tidiness — a stray carriage
return changes the system prompt byte-for-byte and silently invalidates the
cached prefix.

---

## Swapping providers

Each external service is one file:

| File | Service |
|---|---|
| `src/llm.ts` | OpenRouter |
| `src/tts.ts` | Fish Audio |
| `src/deepgram.ts` | Deepgram |

The speech-to-text key is never sent to the browser — the Worker mints a
short-lived one per connection via `GET /deepgram-token`. Do the same with
whatever you swap in.
