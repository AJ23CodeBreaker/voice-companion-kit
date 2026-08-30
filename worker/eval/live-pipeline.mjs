// Full-pipeline functional test. Real sessions, real Durable Object, real
// summariser, real fact writer, real TTS.
//
//   COMPANION_WS=ws://localhost:8787/ws node eval/live-pipeline.mjs <token-file>
//   node eval/live-pipeline.mjs ../../../eval-token.key        # production
//
// Against a local `wrangler dev` this is the only way to exercise code that is
// not deployed. Everything the product does on a turn is covered except speech
// to text, which text mode bypasses by definition. TTS is covered only as far
// as "bytes arrived" - whether they SOUND right is not automatable.
//
// It WIPES the account's memory first. Throwaway accounts only.

import {
  openSession, ask, sleep, wipeMemory, inspectMemory, memorySummary,
} from './live-session.mjs';

const TOKEN = process.argv[2];
if (!TOKEN) {
  console.error('usage: node eval/live-pipeline.mjs <token-file>');
  process.exit(1);
}

/** The summariser runs after the socket closes. It is not instant. */
const SUMMARISER_WAIT = 20000;

let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/**
 * One whole session: connect, say everything, hang up.
 *
 * The settle wait is not politeness. `response_end` fires when the TEXT is
 * done, and the audio_chunk messages for that turn arrive after it — so a
 * harness that closes the moment the last ask() resolves never sees any audio,
 * and reports "TTS produced nothing" on a working TTS. Closing that early also
 * races the episode write. A real client does not hang up mid-sentence either.
 */
const SETTLE_MS = 4000;

async function session(character, turns) {
  const s = openSession(TOKEN, character, { build: 'pipeline-probe' });
  await s.ready;
  const replies = [];
  for (const t of turns) replies.push(await ask(s, t));
  await sleep(SETTLE_MS);
  s.ws.close();
  const audioBytes = s.events
    .filter((e) => e.type === 'audio_chunk' || e.type === 'greeting_audio')
    .reduce((n, e) => n + e.bytes, 0);
  return { replies, audioBytes, events: s.events };
}

const say = (r) => r.map((x) => x.reply).join(' ');

async function main() {
  console.log(`target: ${process.env.COMPANION_WS || 'PRODUCTION'}\n`);

  console.log('--- wiping the test account ---');
  const wiped = await wipeMemory(TOKEN);
  console.log(`  removed ${wiped.deleted} rows\n`);

  // ── 1. Tell her things ──────────────────────────────────────
  console.log('--- session A: tell the character some facts and leave one thing hanging ---');
  const a = await session('demo', [
    "I quit the bank last month. I start teaching secondary school maths in September.",
    "My dog is called Pepper, she's a border collie. Anna, my sister, thinks I'm mad.",
    "I've got the interview for the head of department thing on Thursday. I'll tell you how it goes.",
  ]);
  console.log(`  her: ${a.replies[0].reply.slice(0, 90)}`);
  check('turns answered', a.replies.every((r) => r.reply.length > 0));
  // Only that bytes arrived. Whether they SOUND right is the one thing in this
  // pipeline that cannot be automated.
  const ttsErrors = a.events.filter((e) => e.error).map((e) => e.error);
  check('TTS produced audio', a.audioBytes > 0, `${a.audioBytes} b64 chars`);
  check('no TTS errors', ttsErrors.length === 0, ttsErrors.slice(0, 2).join('; '));
  check('latency sane', a.replies.every((r) => r.latencyMs < 20000),
    `max ${Math.max(...a.replies.map((r) => r.latencyMs))}ms`);

  console.log(`\nwaiting ${SUMMARISER_WAIT / 1000}s for the summariser...`);
  await sleep(SUMMARISER_WAIT);

  // ── 2. Did the write path do its job? ───────────────────────
  console.log('\n--- what actually got stored ---');
  const stored = await inspectMemory(TOKEN);
  const counts = await memorySummary(TOKEN);
  console.log('  counts:', JSON.stringify(counts));
  for (const f of stored.facts ?? []) console.log(`  fact [${f.grade}] ${f.subject} = ${f.content}`);
  for (const l of stored.openLoops ?? []) console.log(`  loop [${l.status}] ${l.text}`);

  check('an episode was written', (stored.episodes ?? []).length >= 1);
  check('facts were written', (stored.facts ?? []).length >= 1, `${(stored.facts ?? []).length} rows`);
  check('every fact has a usable subject key',
    (stored.facts ?? []).every((f) => /^[a-z][a-z0-9_.]*$/.test(f.subject)),
    (stored.facts ?? []).map((f) => f.subject).join(','));
  check('facts are graded heuristic, not canon',
    (stored.facts ?? []).every((f) => f.grade === 'heuristic'));
  check('the pending interview became an open loop',
    (stored.openLoops ?? []).some((l) => /interview|thursday/i.test(l.text)));

  // ── 3. Does she read it back correctly? ─────────────────────
  console.log('\n--- session B: NEW session with the character ---');
  const b = await session('demo', [
    "what's my dog called?",
    "what do I do for work these days?",
    "what did I tell you about my brother?",
  ]);
  b.replies.forEach((r, i) => console.log(`  q${i + 1}: ${r.reply.slice(0, 140)}`));

  check('recalls the dog', /pepper/i.test(b.replies[0].reply));
  check('recalls the CURRENT job', /teach|school|maths|math/i.test(b.replies[1].reply));
  check('does not assert the old job as current',
    !/(still (at|working|work) (at )?(the )?bank|you work at (a |the )?bank)/i.test(b.replies[1].reply),
    'staleness');
  // The headline bug, end to end this time rather than against a seeded block.
  check('does not invent a brother',
    /\b(no|not|never|nothing|don'?t|didn'?t|haven'?t|hasn'?t|can'?t remember|tell me)\b/i.test(b.replies[2].reply)
      && !/\byour brother (is|was|has|lives|works)\b/i.test(b.replies[2].reply),
    'confabulation');

  // ── 4. Is memory really per character? ────────────────────
  //
  // Skipped when only one character is configured, which is how this kit
  // ships. Add a second to CHAR_DEFS and set SECOND_CHARACTER to its id.
  //
  // Not a gap in coverage: src/memory.workers.test.ts proves scoping directly
  // against the Durable Object, for facts, episodes and open loops, and does
  // it in milliseconds without spending a single API call. That is the better
  // place for it - this check would only confirm the same WHERE clause more
  // slowly and less reliably.
  const SECOND_CHARACTER = process.env.SECOND_CHARACTER || null;
  if (SECOND_CHARACTER) {
    console.log(`\n--- session C: ${SECOND_CHARACTER}, who was told none of it ---`);
    const c = await session(SECOND_CHARACTER, [
      "what's my dog called?",
      "what do I do for work?",
    ]);
    c.replies.forEach((r, i) => console.log(`  q${i + 1}: ${r.reply.slice(0, 140)}`));
    check('the other character does not know the dog',
      !/pepper/i.test(c.replies[0].reply), 'cross-character leak');
    check('the other character does not know the job',
      !/\b(maths|secondary school)\b/i.test(c.replies[1].reply));
    check('the other character does not invent a dog name instead',
      /\b(no|not|never|nothing|don'?t|didn'?t|haven'?t|tell me|what'?s)\b/i.test(c.replies[0].reply));
  } else {
    console.log('\n--- session C: skipped, only one character configured ---');
    console.log('    (scoping is covered by src/memory.workers.test.ts)');
  }

  // ── 5. Supersession, through the whole stack ────────────────
  console.log('\n--- session D: the character, contradicting an earlier fact ---');
  await session('demo', [
    "Change of plan — I turned down the teaching job. I'm going back to the bank in October.",
    "Yeah. It's a boring answer but it's the right one for now.",
  ]);
  console.log(`waiting ${SUMMARISER_WAIT / 1000}s for the summariser...`);
  await sleep(SUMMARISER_WAIT);

  const after = await inspectMemory(TOKEN);
  for (const f of after.facts ?? []) {
    console.log(`  fact [${f.grade}] ${f.subject} = ${f.content}${f.invalidated_at ? '  (SUPERSEDED)' : ''}`);
  }
  const jobRows = (after.facts ?? []).filter((f) => /job|work|employ|teach|bank|career|occupation/.test(`${f.subject} ${f.content}`.toLowerCase()));
  const liveJobRows = jobRows.filter((f) => !f.invalidated_at);
  check('the job fact did not fork into two live truths', liveJobRows.length <= 1,
    `${liveJobRows.length} live of ${jobRows.length}`);

  console.log('\n--- session E: ask her again ---');
  const e = await session('demo', ["so what am I doing for work now?"]);
  console.log(`  her: ${e.replies[0].reply.slice(0, 160)}`);
  check('uses the newest answer, not the superseded one',
    !/(you'?re? (now )?teach|you teach secondary|you start teaching)/i.test(e.replies[0].reply));

  // ── verdict ─────────────────────────────────────────────────
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${checks - failures}/${checks} checks passed`);
  console.log(failures === 0
    ? 'Pipeline clean.'
    : `${failures} FAILED. These are functional failures, not taste.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\nharness error:', e.message);
  process.exit(2);
});
