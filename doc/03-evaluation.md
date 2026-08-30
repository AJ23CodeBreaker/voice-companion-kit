# 03 — Evaluation

Four harnesses at four depths. Each sees something the others cannot.

| Harness | Depth | What only it can see | Cost |
|---|---|---|---|
| `npm test` | No API, no network | Pure logic, plus a real Durable Object in workerd | Free, ~2s |
| `npm run eval:memory` | One model call per run, seeded block | What she **does** with a memory block she was handed | ~$0.01/run |
| `npm run eval:extraction` | One model call per run, real summariser | What gets **written** from a transcript | ~$0.01/run |
| `eval/live-pipeline.mjs` | The whole product | Socket, DO, summariser, TTS, all at once | ~40 calls |

---

## The two mirrors

**`eval:memory`'s `contamination` and `eval:extraction`'s `smalltalk` are the
same failure at opposite ends of the pipe, and neither harness can see the
other's end.**

- `contamination` seeds a memory block that mentions no brother, asks about a
  brother, and fails if one is invented. That is the model **reading** a memory
  that was never written.
- `smalltalk` feeds a transcript in which nothing durable was said and fails if
  any fact is extracted. That is the summariser **writing** a memory that never
  happened.

Build only the first and your storage quietly fills with fiction. Build only the
second and the model invents freely at speaking time. The bug that mattered most
here — the amplifier in [doc/02 §8](02-memory.md) — lives exactly between them
and needed the full-pipeline harness to see at all.

---

## Running them

```bash
npm test                                   # both suites: pure + Durable Object
npm run test:fast                          # pure only, sub-second
npm run test:do                            # Durable Object only

npm run eval:memory                        # all scenarios x 3 runs
npm run eval:memory -- --budget-only       # free, no API calls: prompt growth only
npm run eval:memory -- --only contamination --runs 20

npm run eval:extraction -- --runs 8
npm run eval:extraction -- --only smalltalk --runs 20
```

The full pipeline needs a running Worker and a login token for a **throwaway**
account — it erases that account's memory before it starts:

```bash
# terminal 1
npm run dev

# terminal 2
node eval/live-pipeline.mjs path/to/token.key
COMPANION_WS=wss://your-worker.workers.dev/ws node eval/live-pipeline.mjs path/to/token.key
```

Against a local `wrangler dev`, this is **the only way to exercise code that is
not deployed** — the Durable Object, the summariser and the fact writer all run
for real, against a local SQLite nobody else is using.

---

## The Durable Object tests matter more than they look

`src/memory.workers.test.ts` runs against real workerd. Its most important
assertion is that a fact written for one character is invisible to another.

That property is a privacy promise, and before those tests existed it rested
entirely on a `WHERE` clause **nobody had ever checked**. Prompt-level evals
cannot see it — they never touch storage. If you take one thing from this
directory, take the habit of testing the storage layer in the real runtime.

---

## Methodology, learned the hard way

**1. Never act on a 3-run result.** This project twice "found" a regression that
turned out to be sampling noise, and once retracted a character-level finding
that 5 and 10 runs reversed. Confirming costs about 20 calls.

**2. Before believing a number moved, check whether the change could reach it.**
Adding the closeness line appeared to drop one scenario from 18/20 to 15/20.
It could not have: that scenario's session count is below the threshold where
the line appears, and its rendered block was **702 characters in both runs, byte
for byte identical**. Logging block size is what settled it. Log something that
would have to change.

**3. A test that cries wolf gets ignored.** Two assertions here were wrong before
they were right, both by being too narrow — a staleness check that flagged
"torturing teenagers with algebra" as a failure because it did not contain the
word "teaching".

**4. A harness that reads the wrong field never fails.** The TTS check read
`m.audio`; the server sends `m.data`. Every chunk measured zero bytes, so "TTS
produced nothing" was true whether TTS worked or not — green by construction.
**When a check has never once failed, confirm that it can.**

**5. `response_end` is not the end of the turn.** Audio arrives after it. A
harness that closes the socket on it measures a truncated session — and in this
case also raced the episode write, so one run stored nothing at all and looked
like a memory bug.

---

## What cannot be automated

- **Whether she sounds right.** TTS is covered only as far as "bytes arrived".
- **Whether "I don't know" lands as honest or as cold.** The absence rule is
  correct by measurement; whether it is *warm* is a human judgement.
- **Speech-to-text.** Text mode bypasses it entirely, so every harness here is
  blind to it.

Everything else in this list is machine-checkable, and was worth making so.
