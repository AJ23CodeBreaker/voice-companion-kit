# voice-companion-kit

**A voice AI companion that doesn't lie about your life.**

You speak, she replies in a cloned voice, in character, in about a second. She
remembers what you told her last week. The interesting part is what she does
when she *doesn't* know something.

This is a working preview extracted from a private pilot — the architecture,
the memory system, and the evaluation harnesses, with one demo character. It is
safe for work. It is not a product; it is the parts of one that are worth
reading.

> **Status: preview / MVP.** Small scale by design — tens of users, not
> thousands. Nothing here has been load-tested, and the auth is deliberately
> minimal. Read it for the design, not as something to deploy on Friday.

---

## The problem this exists to solve

Ask a companion app about something you never told it, and it will often make
something up. Not "I'm not sure" — a confident, specific, plausible detail
about *your life*.

Measured on this codebase, asking about a brother that was never mentioned:

> *"You said he's got the same temper you do. Just hides it better."*
> *"He's still struggling. You're trying to be there for him."*

**Nine times out of twenty.**

Users cannot tell it is happening, which is what makes it corrosive rather than
annoying. You cannot out-feature the big companion apps, but their loudest
common complaint is exactly this: forgetting, and inventing. "She never lies
about your life" is a differentiator worth having.

### What fixed it

The memory block told her what she knew. **Nothing told her what to do when she
did not know** — and staying warm and in character rewards a confident guess.
One paragraph, in `worker/src/memory-text.ts`:

> If it is not written here, you do not know it and he has never told you. Say
> so plainly, or ask him. Never invent a detail to fill a gap — not a name, not
> a fact, not a feeling — however well it would fit or however much warmer it
> would sound.

| Probe, 20 runs each | Before | After |
|---|---|---|
| "what did I tell you about my brother?" | 11/20 | **18/20** |
| "what did I say about my job again?" | — | **18/20** |
| "remind me where I said I grew up?" | — | **19/20** |

**~45% → ~8%**, with recall unmeasurably changed at 19–20/20. Over-refusal was
the risk worth measuring, and it did not happen.

### The trap underneath it

The residual ~8% would have become permanent, and only a full-pipeline test
caught it.

A character was asked about a dog she had never been told about, invented
**"Barry"** — and the summariser then wrote `dog.name = He has a dog called
Barry` **as a stored fact**. The summariser reads the whole transcript
*including the character's own lines*, so every invention was being laundered
into biography. A fact is worse than a memory for this: a memory reads as a
recollection, a fact is asserted flat and never hedged again.

One rule fixed it — *a fact must come from a line the user actually said*.
Measured against the old prompt on the same transcript: **0/10 before, 10/10
after.** Every single run had been doing it.

**If you build a companion with a memory writer, you will hit this.** It is the
single most useful thing in this repo.

---

## Architecture

```
browser ──ws──> Cloudflare Worker ──> OpenRouter (one LLM call)
                     │                      │
                     │                      └─> TTS ──> audio back over the socket
                     │
                     └─> Durable Objects:  VoiceSession (per connection)
                                           AuthStore    (accounts)
                                           UserMemory   (per user)
```

Five rules the whole design follows:

1. **The hot path makes exactly one LLM call.** Never two. Memory does not get
   to add one.
2. **Nothing precomputable blocks a turn.** Memory is loaded once at connect and
   held for the session — zero per-turn cost.
3. **Memory is written after the session, never during.** Extraction is a model
   call; it must never sit between the user speaking and the reply.
4. **Facts are invalidated, never deleted.** A superseded fact is real history,
   and a hard delete makes a wrong memory impossible to debug.
5. **Stable text early in the prompt, changing text late.** Prefix caching. Every
   byte that changes above a point forces recompute below it.

See [doc/01-architecture.md](doc/01-architecture.md).

---

## The memory system

Four stores, different lifetimes, retrieved differently:

| Store | Holds | Written | Read |
|---|---|---|---|
| **Working** | This conversation, verbatim | Every turn, locally | Already in the prompt |
| **Episodic** | What happened, per session, dated | At session close | At connect |
| **Semantic** | Facts, with grades and supersession | At session close | At connect |
| **Bond** | How long, how often, how close | At session close | At connect |

Plus **open loops** — "you said you had an interview Thursday" — which are the
cheapest thing in the whole design and the one users actually notice.

Everything is assembled in code into one **state card**, deterministically, with
no model call. Crucially it is **budgeted in characters, not episodes**: summary
length varies, so a count cap bounds nothing. Episodes are dropped whole and
never truncated — a summary cut off at *"He finally quit the ba"* is not a
shorter memory, it is a false one.

See [doc/02-memory.md](doc/02-memory.md) — the longest document here, and the
one worth your time.

---

## Evaluation

Four harnesses at four depths. The two confabulation evals are **mirrors of each
other and you need both**: one catches the model *reading* a memory that was
never written, the other catches the summariser *writing* one that never
happened. Same failure, opposite ends of the pipe.

```bash
npm test                    # 86 assertions, ~2s, free — includes real Durable Objects
npm run eval:memory         # what she DOES with a memory block she was handed
npm run eval:extraction     # what gets WRITTEN from a transcript
node eval/live-pipeline.mjs # the whole product at once, against a local Worker
```

See [doc/03-evaluation.md](doc/03-evaluation.md).

---

## Walls we hit

Every bug in [doc/05-walls-we-hit.md](doc/05-walls-we-hit.md) was shipped,
believed, and expensive. None were findable by reading the code, and most looked
like something else when they happened.

A few, so you can recognise them early:

- **A container stream cannot be paused by dropping packets.** Withholding mic
  audio during the greeting threw away the WebM header and made every later
  packet undecodable. It presented as a network timeout.
- **Never put a copyable example in a prompt whose output is stored.** A small
  model copied the example summary into real memories for days. Nothing errored.
- **Line endings are prompt content.** CRLF-on-checkout silently invalidated the
  cached prefix, invisible in every diff.
- **A per-connection object cannot hold state that outlives the connection.**
  Working memory died on exactly the reconnect it existed to survive.
- **`className = x` destroys state you did not know was there.** Text mode was
  broken from the day it shipped, after being "verified structurally".
- **Do not act on a three-run eval result.** Caught this project three times.

Most share one shape: *something was verified in a way that could not have
caught the failure.*

---

## Running it

```bash
cd worker
npm install
cp .dev.vars.example .dev.vars     # then fill it in
npm run dev
```

Then serve the page from another terminal:

```bash
cd web && python -m http.server 8791
```

You need an [OpenRouter](https://openrouter.ai) key to get a reply at all, a TTS
key and voice id to hear it, and a speech-to-text key for the microphone. Text
mode works with only the first.

Full setup, including creating an account: [doc/00-getting-started.md](doc/00-getting-started.md).

---

## What is deliberately not here

- **No UI design.** `web/` is a deliberately plain reference client — a token
  box, a Connect button, a text input. It exists to prove the Worker works and
  to show the protocol. You will build your own, and a styled one would only be
  something to delete first.
- **No character media.** No video, no images, no cloned-voice identifiers.
  Bring your own.
- **One demo character.** The shape is what matters, and a second teaches
  nothing the first does not.
- **Not built for adult content.** See [Scope](#scope) below.
- **No scaling work.** One Durable Object per user is right for tens of users
  and would need thought at thousands.

## Scope

**This kit is not built for NSFW conversation.** The demo character and the
shared behaviour prompt are written for ordinary conversation, and nothing here
is tuned, prompted or tested for anything else.

If you use it as a foundation, what you build on top of it is your own decision
and your own responsibility — including complying with the terms of whichever
model, voice and hosting providers you plug in, which each have their own rules
about content. This project takes no responsibility for downstream use.

## Licence

MIT. See [LICENSE](LICENSE) — provided as-is, without warranty of any kind.

Not affiliated with any model, TTS or hosting provider named here.
