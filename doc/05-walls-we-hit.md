# 05 — Walls we hit

Every bug here was shipped, believed, and expensive. They are written down
because none of them were findable by reading the code, and most looked like
something else entirely when they happened.

Read the headings. Come back to the details when one of them starts happening
to you.

---

## Voice and streaming

### A container stream cannot be paused by dropping packets

**The symptom:** every session closed its speech-to-text socket before the user
had said anything. The user had to speak twice; the first attempt vanished. One
character never recovered at all — four consecutive closes, zero completed
turns. The error pointed at the network:

```
code 1011  "did not receive audio data or a text message within the timeout window"
```

**The cause:** to stop the transcriber hearing the character's own greeting, the
client dropped microphone blobs while the greeting played.

**MediaRecorder's first blob carries the WebM container header.** Dropping the
early blobs threw away the header, so every blob after it was undecodable. The
transcriber was not receiving quiet audio — it was receiving bytes it could not
parse as audio at all, and timed out.

**The fix: never withhold the audio. Ignore the transcripts instead.** The stream
stays unbroken; the message handler returns early while the greeting plays.

> Anything that needs a microphone to "go quiet" must suppress the **result**,
> not the **feed**. The close codes pointed at the connection, which is what
> made this look like a network problem for far longer than it should have.

### "Ready" must mean audio is genuinely flowing

The UI said *listening* before the microphone was actually streaming — the
socket open was not awaited, and the recorder starts on `onopen`. The first
words of a session could be silently dropped.

A readiness indicator that is optimistic is worse than none, because it moves
the blame to the user: they think they spoke and were ignored.

### `response_end` is not the end of the turn

It fires when the **text** is done. Audio arrives after it. Anything that treats
it as the end — a UI state machine, a test harness — is measuring a truncated
session. In our case it also raced the memory write, so one test run stored
nothing at all and looked like a memory bug.

---

## Prompting

### Never put a copyable example in a prompt whose output is stored

The summariser prompt contained an illustrative example summary. A small model
copied it — nearly verbatim — into **real stored memories**, for days, before
anyone noticed.

Nothing was broken. The output parsed, the pipeline was green, and the memories
were fiction.

If a prompt's output is written to a database, either give no example or make
the example impossible to mistake for a valid answer. This applies to every
extraction prompt you will ever write.

### Line endings are prompt content

Version control rewrote `LF` to `CRLF` on checkout. The persona files changed
byte-for-byte with nobody editing them, which silently invalidated the cached
prompt prefix — a pure cost and latency regression, invisible in every diff.

The generator now normalises to `LF` on read. If any part of your prompt comes
from a file on disk, normalise it.

### Length is demonstrated, not described

"Keep replies short" produces a short *paragraph*. Few-shot examples whose shape
is the instruction work; descriptions of the desired length do not.

### A plausible mechanism is not evidence

Research said streaming text-to-speech sentence by sentence would sound choppy,
and that a two-phase approach would be needed for prosody. We planned the work.

Then someone listened to the real output. It sounds fine. **The prediction was
wrong and the work was never needed.**

Recorded because it is the failure mode that costs the most: a chain of correct
reasoning about how something will sound, which nobody checked by listening.

---

## Memory

### Tell the model what to do when it does *not* know

The single highest-value paragraph in this repo. Asked about a brother that was
never mentioned, the model invented one in **9 of 20 runs** — confident,
specific, unhedged.

Every memory system tells a model what it knows. Almost none tell it how to
behave in the absence of knowledge, and a warm in-character model rewards a
confident guess. One paragraph took invention from ~45% to ~8% with recall
unchanged. [doc/02 §6](02-memory.md)

### Your character's own inventions get written back as facts

The one that would have done real long-term damage. The summariser reads the
whole transcript **including the character's own lines**, so an invention at
speaking time became a stored fact about the user on the next write — laundered
from a passing remark into biography that is never hedged again.

Measured against the old prompt: **0/10 before the fix, 10/10 after.** Every
single run had been doing it.

Only a full-pipeline test could see this. A prompt-level eval cannot — it never
writes anything. [doc/02 §8](02-memory.md)

### A per-connection object cannot hold state that must survive the connection

Working memory was first put in the session Durable Object. That object is
created with `newUniqueId()` — a fresh instance per **connection** — so history
stored there died on exactly the dropped-socket reconnect it existed to
survive.

Obvious in hindsight. It was written down as the design, reviewed, and built
before anyone noticed.

### Supersession only works if the key is stable

Facts are replaced by matching a normalised subject key. Observed in production:
a contradiction wrote both `job` and `job.previous` as live rows. Both true,
answer correct — but the moment a model writes `employment` instead, two live
rows contradict each other and nothing reconciles them.

**Constrain the key in code, not in the prompt.** A prompt rule holds most of
the time, and most of the time is exactly what produces this.

---

## Testing

### Do not act on a three-run result

This caught the project **three times**: two "regressions" that were sampling
noise, and one character-level finding that 5 and 10 runs reversed completely.

LLM evals are stochastic. Three runs is a vibe. Confirming costs about 20 calls
and roughly nothing.

### Before believing a number moved, check the change could reach it

Adding a warmth line appeared to drop one scenario from 18/20 to 15/20. It could
not have: that scenario sat below the threshold where the line appears at all,
and its rendered prompt was **702 characters in both runs, byte for byte
identical**.

Log something that would have to change if the change were real. Prompt size is
what settled it here.

### A harness that reads the wrong field never fails

The audio check read `m.audio`; the server sends `m.data`. Every chunk measured
zero bytes, so "TTS produced nothing" was true whether TTS worked or not. Green
by construction, for as long as it existed.

> **When a check has never once failed, confirm that it *can*.** Break the thing
> deliberately and watch the test go red.

### A test that cries wolf gets ignored

Two assertions here were wrong before they were right, both by being too
narrow — a staleness check that flagged *"torturing teenagers with algebra"* as
a failure because it did not contain the word "teaching".

An over-strict test trains you to ignore the suite, which is worse than not
having it.

### Test the storage layer in the real runtime

Cross-character memory isolation is a privacy promise. Before there were Durable
Object tests, it rested entirely on a `WHERE` clause **nobody had ever
checked** — and no prompt-level eval could see it, because they never touch
storage.

---

## Frontend

### `className = x` destroys state you did not know was there

Text mode was broken **from the day it shipped**. `setState()` did
`document.body.className = s`, so the first call of any session deleted the
`textmode` class and every style with it.

It compounded: the CSS used `:not(.idle)` to mean "a session is running", which
is false in text mode — the conversation is live while the turn state sits idle.
So mid-conversation the app also believed it was back on the home screen.

**Session-ness and turn state are two different things.** Rebuild className from
all of your state, never assign over it.

> This shipped after being "verified structurally". The structure was fine. The
> first real use broke on the first click.

### `/*.html` does not match `/`

A browser visiting a site requests `/`. The host serves `index.html` internally,
but the request path is still `/`. Security headers scoped to `/*.html` reached
**essentially no visitor** — the CSP was, in practice, absent.

Verified with `curl`, which is the only way anyone was ever going to find it.

### `requestAnimationFrame` is throttled when the tab or pane is hidden

A canvas animation looks broken when it is completely fine. Drive frames
manually if you need to check one while it is not visible.

---

## Operations

### An empty log array during a live session means "not flushed yet"

Not "nothing was logged". Cloudflare flushes on disconnect. Hang up before you
conclude your logging is broken.

### `git status` cannot see in-place file corruption

A filesystem fault rewrote file contents without changing size or mtime. `git
status` reported a clean tree. Hash against the stored blob if you suspect it.

### Fail loudly on missing configuration

A missing voice id used to fail silently, per sentence, producing a session that
connected and simply never spoke. It now refuses to start and says why.

Silence is the worst possible failure mode for a voice product: it is
indistinguishable from every other kind of broken.

---

## The pattern

Look back at these and most share a shape: **something was verified in a way
that could not have caught the failure.**

Text mode was verified structurally, not used. The audio check read a field that
never existed. The memory design was reviewed as a document. Streaming TTS was
reasoned about rather than listened to.

The cheapest habit we found is asking, before trusting any green check: *what
would this have to look like if it were broken?* If the answer is "exactly the
same", the check is decoration.
