# 00 — Getting started

Fifteen minutes to a reply, longer if you want to hear it.

---

## What you need

| | For | Required? |
|---|---|---|
| [OpenRouter](https://openrouter.ai) key | The reply itself | **Yes** |
| A TTS key + voice id | Hearing her | For voice |
| [Deepgram](https://deepgram.com) key | The microphone | For voice |
| Node 20.19+ | Everything | **Yes** |

Text mode needs only the first. Start there — it is also how the eval harnesses
run, so you get the whole memory system without touching audio.

---

## 1. The Worker

```bash
cd worker
npm install
cp .dev.vars.example .dev.vars
```

Fill in `.dev.vars`. At minimum:

```
OPENROUTER_API_KEY=sk-or-...
APP_SHARED_KEY=<a long random string you invent>
```

`APP_SHARED_KEY` gates account creation. Anyone holding it can create accounts on
your Worker, so treat it as a secret and do not commit it — `.dev.vars` is
gitignored.

```bash
npm run dev
```

That runs a real Worker locally in miniflare, with real Durable Objects and real
SQLite. It is not a mock.

---

## 2. An account

Registration is admin-gated by design; there is no open signup.

```bash
curl -X POST http://localhost:8787/auth/register \
  -H "X-Admin-Key: <your APP_SHARED_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"username":"you","password":"a-long-password"}'
```

Then log in. **Note the `Origin` header** — without it this returns 403, because
a terminal sends none and the allowlist check is real:

```bash
curl -X POST http://localhost:8787/auth/login \
  -H "Origin: http://localhost:8791" \
  -H "Content-Type: application/json" \
  -d '{"username":"you","password":"a-long-password"}'
```

That returns a token. Save it to a file if you want to run the pipeline harness.

> `/auth/register` is deliberately **not** origin-checked, which is why creating
> an account from curl works while logging in looks broken until you add the
> header.

---

## 3. The page

```bash
cd web
python -m http.server 8791
```

Open http://localhost:8791 and sign in.

`web/config.js` already points at `localhost:8787`. If you move either side,
update it **and** add the new frontend origin to `ALLOWED_ORIGINS` in
`worker/src/index.ts` — otherwise the socket is refused, which is the check
working.

---

## 4. Hearing her

The demo character ships with **no voice id**, on purpose — voice ids are
account-specific and are not portable. Set one:

```
FISH_API_KEY=...
FISH_VOICE_ID=...
```

Any character with an empty literal falls back to `FISH_VOICE_ID`, so this is
enough. To pin a voice per character, put it in `CHAR_DEFS` in
`scripts/generate-personas.mjs` and re-run `npm run build`.

Without a voice configured the session refuses to start and says so. That is
better than streaming silence.

---

## 5. Check it works

```bash
npm test            # 86 assertions, no keys needed
npm run eval:memory -- --budget-only    # free: prompt growth curve only
```

Then, with the Worker running and a token file:

```bash
node eval/live-pipeline.mjs path/to/token.key
```

That has a real conversation, hangs up, waits for the summariser, and checks what
was stored — facts, open loops, supersession, recall in a fresh session. **It
erases the account's memory first**, so use a throwaway account.

---

## Adding your own character

Two files and a row.

1. `personas/persona_<id>.txt` — who she is. Read `persona_demo.txt` for the
   shape: appearance, history, how she talks *with example lines*, what she will
   not tolerate, and a crisis clause.
2. `personas/greetings_<id>.txt` — one is spoken before the user says anything.
   Write plenty; repetition is what makes a greeting feel canned.
3. A row in `CHAR_DEFS` in `scripts/generate-personas.mjs`.

Then `npm run build`. No frontend change is needed — the picker is served from
`/characters`.

**The example lines in a persona do more work than the description.** "Dry, a
bit sideways" tells a model almost nothing. Four lines she would actually say
tells it everything.

---

## Deploying

```bash
npx wrangler login
npm run deploy
```

Set secrets on the deployed Worker separately — `.dev.vars` is local only:

```bash
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put APP_SHARED_KEY
```

Then add your real frontend origin to `ALLOWED_ORIGINS` and redeploy.

### Before you put the page on the public internet

`web/_headers` carries the security headers — CSP, framing, referrer policy. It
works as-is on Netlify and Cloudflare Pages; translate it for other hosts.

**Edit the two `YOUR-WORKER.workers.dev` placeholders in it first.** The
`connect-src` line is the one that matters: it scopes outbound connections to
your Worker and your speech provider, so injected script still cannot post your
users' conversations elsewhere. Left unedited, the page cannot reach your Worker
at all.

### A note on cost

Durable Objects have historically required Cloudflare's paid Workers plan. The
terms change; check the current pricing before you plan around it. `wrangler
dev` runs the whole stack locally for free either way, so you can evaluate all
of this before that question matters.

> **Always redeploy after editing any `.txt` in `personas/`.** They are compiled
> into the bundle at build time, so an edit alone changes nothing.
