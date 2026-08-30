# Documentation

Five documents. If you read one, read [02 — Memory](02-memory.md); it is the
part of this repo worth copying.

| | | |
|---|---|---|
| **00** | [Getting started](00-getting-started.md) | Keys, an account, a reply. Fifteen minutes |
| **01** | [Architecture](01-architecture.md) | Three Durable Objects, one LLM call, why the prompt is ordered as it is |
| **02** | [Memory](02-memory.md) | The four stores, the state card, the absence rule, **the amplifier** |
| **03** | [Evaluation](03-evaluation.md) | Four harnesses, and the methodology mistakes that cost real time |
| **04** | [Prompting](04-prompting.md) | Writing a character that sounds like a person |

---

## The three ideas worth taking, if you take nothing else

**1. Tell the model what to do when it does *not* know.**
Every memory system tells a model what it knows. Almost none tell it how to
behave in the absence of knowledge — and a warm, in-character model rewards a
confident guess. One paragraph took invention from ~45% to ~8%.
[doc/02 §6](02-memory.md)

**2. Your character's own inventions get laundered into stored facts.**
If your summariser reads the whole transcript — and it does — then anything the
character invents becomes biography on the next write. A one-in-ten speaking
error becomes a permanent belief. Measured: **0/10 before the fix, 10/10 after.**
[doc/02 §8](02-memory.md)

**3. Budget the prompt in characters, not in items.**
Summary length varies, so capping the *number* of remembered episodes bounds
nothing. And drop them whole — a memory truncated mid-sentence is not a shorter
memory, it is a false one. [doc/02 §4](02-memory.md)

---

## What is measured, and what is asserted

Numbers in these documents come from harnesses in `worker/eval/` and can be
re-run. Where something is unverified it says so.

The one thing repeatedly learned the hard way: **do not act on a three-run
result.** It produced two false regressions and one false character-level finding
in this project before the rule stuck. [doc/03](03-evaluation.md)
