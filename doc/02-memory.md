# 02 — Memory

The longest document here, because it is the part worth copying.

---

## 1. The constraints that decide the design

Everything below follows from four facts. A design ignoring them is a design for
a different product.

1. **It is voice.** The budget for real-time conversation is roughly 600ms end to
   end. There is no spare room. **Any memory lookup during a turn comes out of
   her feeling alive.**
2. **It is a companion, not an assistant.** A wrong fact is not an error message,
   it is a broken illusion. Saying *"how's Tom?"* six months after the breakup
   does more damage than saying nothing.
3. **The scale is small.** Facts per user number in the hundreds. They fit in a
   prompt. This removes most of the machinery the field talks about.
4. **The hot path makes exactly one LLM call.** Memory does not get to add one.

### What falls out

| # | Principle | Why |
|---|---|---|
| P1 | Nothing precomputable blocks a turn | The latency budget |
| P2 | Memory loads once at connect, not per turn | A voice session holds an open socket. Load at open, hold for the session, pay zero per turn |
| P3 | Memory is written after the session, never during | Extraction is a model call. It must never sit between speaking and answering |
| P4 | Episodic and semantic are separate and retrieved differently | Facts retrieve by relevance, events by *time*. Collapsing them degrades both |
| P5 | Facts are invalidated, never silently appended over | Staleness in frequently-used facts is fatal for a companion |
| P6 | Stable text early in the prompt, changing text late | Prefix caching |
| P7 | No vector search until the facts stop fitting | For hundreds of facts, retrieval is infrastructure you do not need |

**P7 deserves emphasis.** The reflex reaction to "memory" is a vector database.
At this scale it buys you latency, operational surface and a new failure mode,
in exchange for solving a problem you do not have. Put the facts in the prompt.
Revisit when they stop fitting.

---

## 2. The four stores

| Store | Holds | Lifetime | Written | Read |
|---|---|---|---|---|
| **Working** | This conversation, verbatim | The session | Every turn, locally | Already in the prompt |
| **Episodic** | What happened, per session, with a date | Forever | At session close | At connect |
| **Semantic** | Facts about the user | Until contradicted | At session close | At connect |
| **Bond** | How long, how often, how close | Forever | At session close | At connect |

Working memory is the only one written during a session, and writing it costs no
model call. The other three are written by one background job after hang-up.

---

## 3. Where it lives

One Durable Object per **user**, not per user-per-character:

```ts
env.MEMORY.idFromName(userId)
```

Memory itself is per-character — nothing is shared between characters — but the
character is a **column**, not a separate instance. One instance keeps connect to
a single round trip, keeps the privacy rule in one testable place, and makes
"delete everything about me" one operation rather than nine.

It is SQLite-backed, which matters: real `WHERE` and `ORDER BY` over time is
exactly what episodic memory needs and what a key-value store cannot give you.

### A mistake worth inheriting

The first design put working memory in the per-connection Durable Object. That
object is created with `newUniqueId()` — a fresh instance per *connection* — so
history stored there died on exactly the reconnect it was meant to survive. If
your session object is per-socket, it cannot hold anything that must outlive the
socket.

---

## 4. The state card

At connect, one query assembles everything into a single block, in code, with no
model call. Asking the model to write its own context would be a second call on
the hot path.

```
This is what you remember about him and about the two of you. It is yours —
recall it naturally if it fits... Never recite it, never list it back to him.

If it is not written here, you do not know it and he has never told you. Say so
plainly, or ask him. Never invent a detail to fill a gap...

You have spoken with him 14 times before. You last spoke 3 days ago. You are
past being polite with each other. Warmer, more direct, and you can tease him.

What you know about him:
- He teaches secondary school maths.
- His dog is called Pepper.

Left hanging last time:
- He had the head of department interview on Thursday.
You may ask about one of these, once, if it comes up naturally. If he does not
pick it up, let it go.

Times you have spoken before:
- You last spoke 3 days ago. He was nervous about Thursday but trying not to
  show it. (warm)
```

### Budget it in characters, not episodes

The block is sent on **every turn** and grew with every session: 3078 characters
at five episodes, ~616 each, crossing a 4000-character cap at about seven. Users
were at five.

Capping the *count* of episodes does not fix this, because summary length varies
between sessions. Capping *characters* does, and makes block size independent of
how long she has known someone.

**Episodes are dropped whole, never truncated.** A summary cut off at *"He
finally quit the ba"* is not a shorter memory, it is a false one — and false
memories are the failure this whole area exists to remove. The newest is always
kept, even if it alone busts the budget, and so is the most salient, so the night
that mattered survives a run of chatty sessions.

`selectEpisodesWithinBudget` in `worker/src/memory-text.ts`.

---

## 5. Where the block goes in the prompt

**After the few-shot examples, never inside the system prompt.**

Position 0 is the shared prefix across every user and every session. Personalise
it there and you change the first bytes of every request, destroying prefix reuse
globally. Placed later, the shared prefix stays byte-identical, and because the
block is fixed for the whole session the prefix through it is stable turn to turn
as well.

This is also why **line endings are prompt content**. If your version control
rewrites CRLF on checkout, a persona file can change byte-for-byte without
anyone editing it, silently invalidating the cached prefix. The generator here
normalises to LF for exactly that reason.

---

## 6. The absence rule

The single highest-value paragraph in this repo.

Asked about a brother that was never mentioned, the model invented one in **9 of
20 runs** — confident, specific, unhedged. The block told her what she knew.
Nothing told her what to do when she did not know, and staying warm and in
character rewards a confident guess.

```
If it is not written here, you do not know it and he has never told you. Say so
plainly, or ask him. Never invent a detail to fill a gap — not a name, not a
fact, not a feeling — however well it would fit or however much warmer it would
sound.
```

| Probe, 20 runs | Before | After |
|---|---|---|
| brother | 11/20 | 18/20 |
| job | — | 18/20 |
| where I grew up | — | 19/20 |

The extra two probes exist because the original number was one question and
therefore one phrasing — a fix could have taught the model the word "brother"
rather than the rule. Measure the generalisation, not the headline.

**Recall did not suffer**: 19–20/20. Over-refusal was the real risk and it did
not materialise.

---

## 7. Write grades, and supersession

Facts carry a grade:

| Grade | Meaning | Reaches the prompt |
|---|---|---|
| `reflex` | Said in passing, scene-local | **No** |
| `heuristic` | Inferred by the summariser. Can be wrong | Yes |
| `canon` | Confirmed, or survived several sessions uncontradicted | Yes |

The point of `reflex` is that scene noise can be written down without being
asserted back as biography.

**Everything the summariser writes is `heuristic`.** It was inferred from a
transcript by a model that confabulates. Promotion to canon needs confirmation.

### Supersession

`writeFact` matches on a **normalised subject key** — `job`, `dog.name`,
`sister.name` — and invalidates the previous live row on that key rather than
appending a second truth. *"I bought a car"* then, three months later, *"I sold
it"* is supersession, not decay.

Nothing is deleted. A superseded row is real history, and a hard delete makes a
wrong memory impossible to debug afterwards.

### The weakness to know about

Supersession matches on an **exact** subject. Observed in production: a
contradiction wrote both `job` and `job.previous` as live rows. Both statements
were true and the answer was correct — but the moment a model writes
`employment` or `job.current` instead, two live rows contradict each other and
nothing reconciles them.

**Constrain the subject key in code, not in the prompt.** A prompt rule holds
most of the time, and most of the time is what produces this.

---

## 8. The amplifier

The most important finding here, and only a full-pipeline test caught it.

A character was asked about a dog she had never been told about, invented
**"Barry"**, and the summariser then wrote:

```
dog.name = He has a dog called Barry.
```

as a stored fact about the user.

**The summariser reads the whole transcript, including the character's own
lines.** So a one-in-ten invention on the read side became permanent on the
write side. And a fact is worse than an episode for this: an episode reads as a
recollection, a fact is asserted flat and never hedged again.

The fix is one rule in the extraction prompt — *a fact must come from a line the
user actually said, never from hers.* Measured against the old prompt on the
same transcript: **0/10 before, 10/10 after.** Every single run had been
laundering it.

The residual read-side invention is still around 8%. What is fixed is that it no
longer accumulates. That is the difference between a passing remark and a belief
held for months.

> **If you build a companion with a memory writer, you will hit this.** Test the
> whole pipeline, not the prompt.

---

## 9. Open loops

Something the user said would happen that the character has not heard the end
of. Stored with a due date, surfaced on the card, capped at two, expired after
three weeks.

```
Left hanging last time:
- He had the head of department interview on Thursday.
You may ask about one of these, once, if it comes up naturally. If he does not
pick it up, let it go.
```

Cheapest thing in the entire design and the one users actually notice. Two, not
three: a companion who opens with three unanswered questions is running a status
meeting.

Expiry matters as much as the loop. Asking once is warmth. Asking six weeks
later is evidence she was not listening.

---

## 10. Closeness

Session forty sounded like session one, because nothing in the prompt ever told
her which one she was in. `describeCloseness` derives one line from the session
count and the gap — both already stored — so it needs no table, no writer and no
model call.

It changes **register only**, and a test asserts that: it must never state a fact
or imply one. A warmth signal that licensed assumption would feed the exact bug
the absence rule exists to kill.

This is the cheap version of what larger designs call relationship axes. Start
here. Add numeric axes with damped writes when you can demonstrate the derived
line is not enough — on a five-minute call, most users cannot perceive the
difference.

---

## 11. What was deliberately not built

Ideas from other companion projects that were considered and skipped:

| Idea | Why not |
|---|---|
| Energy / mood / sleep-debt organ state | Nobody feels a sleep cycle in a five-minute call |
| Forgetting curves | Hundreds of facts, not millions. Nothing to forget |
| Off-screen life simulation | A machine that generates plausible unverified detail about a life — the exact shape of the bug above |
| Graph database | Topic slugs first. Revisit when they stop working |

**The reasoning is the same each time: a user on a short voice call cannot
perceive these, and they feel a false statement about their own life
instantly.** Simulation depth is not the differentiator. Not lying is.

---

## 12. Reading order in the code

| File | What |
|---|---|
| `src/memory-text.ts` | The card, the absence rule, the budget. Pure functions, all tested |
| `src/memory.ts` | The Durable Object: schema, supersession, loops |
| `src/episode.ts` | The summariser and the extraction prompt |
| `src/turn.ts` | Where the block goes in the prompt, and why |
| `src/memory.workers.test.ts` | Scoping, supersession, budget, erasure, against a real DO |
