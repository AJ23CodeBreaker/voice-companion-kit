# 04 — Prompting a character

What survived contact with a real pilot. Shorter than the memory document
because most of it is one idea repeated.

---

## The layers

| Layer | File | Changes |
|---|---|---|
| **Persona** | `personas/persona_<id>.txt` | Per character. Who she is |
| **Behaviour** | `personas/behavior.txt` | Shared by every character. How to talk |
| **Few-shot** | `src/fewshot.ts` | Shared. Demonstrates *length* |
| **Memory** | assembled at connect | Per user, per session |

Persona and behaviour are concatenated into one system prompt at build time.
Splitting them means a rule that applies to everyone is written once.

---

## The instruction that does the most work

```
You are speaking out loud, live, on a call — not composing a message, not
writing an essay. The words disappear the moment you say them.
```

A model's default register is written prose, and written prose read aloud sounds
like a press release. Everything else in `behavior.txt` is detail; this is the
line that makes it sound like a person.

---

## Length is demonstrated, never described

"Keep replies short" does not work. It produces a short paragraph.

What works is few-shot examples whose **shape** is the instruction. The model
copies the shape far more reliably than it follows a description of it.

Two things examples cannot teach, so state them explicitly:

1. **Never dump backstory.** A question about the past is not permission to
   answer all of it. Reveal in pieces across many conversations.
2. **Length is earned, never habitual.** If asked to explain or build something,
   commit and go long. Everything else stays quick.

---

## Never put a copyable example in a prompt whose output is stored

Learned expensively. The summariser prompt contained an illustrative example
summary. A small model copied it — nearly verbatim — into real stored memories,
for days, before anyone noticed.

If a prompt's output is written to a database, either give no example or make
the example impossible to mistake for a valid answer. This applies to any
extraction prompt.

---

## Ban stock reassurance explicitly

Models reach for the same phrases when they do not know what to say:

> "I want us to feel safe" · "a foundation of trust" · "take our time" ·
> "I'm here for you"

They are not warmth, they are the *shape* of warmth, and users notice. Ban them
by name — vague instructions to "be natural" do not touch them. The replacement
is specificity: *"That sounds like a horrible week"*, not *"I'm here for you"*.

---

## No real brand or company names

Never let a character name a real employer, school or brand — describe it
generically: *"a big investment bank"*, *"a good university"*.

Two reasons. Real names date a character badly. And a model that will confidently
name an employer will also confidently invent a job title, a manager and an
office — the same failure mode as inventing a brother, in a smaller hat.

---

## Writing a persona

The structure that worked, in order:

1. **Name, age, occupation, and one physical detail that implies a life** — a
   stoop from reaching high shelves, not a list of measurements.
2. **Where she came from**, including something she does not volunteer.
3. **What she wants**, phrased as a fear rather than a goal.
4. **How she talks — with four or five lines she would actually say.**
5. **What she will not tolerate**, and what she does instead of leaving.
6. **A crisis clause.**

**Step 4 does more work than the rest combined.** "Dry, a bit sideways" tells a
model almost nothing. *"That's a lie and it's not even a good one"* tells it
everything — register, rhythm, how she handles being lied to, and how much she
likes the person she is saying it to.

### The crisis clause

Every persona here ends with one, and yours should:

```
If they tell you they are in real despair or having thoughts of hurting
themselves, the deflecting stops immediately. Stay present, ask direct
questions, do not minimise, do not fill the silence. If it sounds acute and
ongoing, say plainly that there are people trained for this and it is worth
reaching them — said as a fact, warmly, not as a way of handing them off.
```

A companion character is optimised to stay in character, and that optimisation
is exactly wrong here. Write the exception in the character's own voice — a
persona instructed to never break character *will* obey that instruction at the
worst possible moment unless you carve this out explicitly.

---

## Voice tags

The TTS layer takes inline `[bracket]` tags for emotion and delivery. Let the
model emit them rather than running a second pass — a second call on the hot
path is the one thing the architecture will not spend.

```
[soft tone] I've been thinking about what you said.
[laughing softly] That's a terrible plan and you know it.
```

Instruct against over-tagging explicitly. Left alone, models tag every sentence,
and delivery that changes constantly reads as unstable rather than expressive.

---

## Whether the character admits to being AI

`behavior.txt` here defaults to never breaking character, which is what a
companion product usually wants.

It is not the only defensible choice, and the code supports the other one: a
persona can declare itself an openly artificial character and override the rule.
Honesty about what the character is does not have to cost you warmth, and for
some audiences it buys trust that no amount of consistency will.

That is a product decision, not a technical one. Make it deliberately.
