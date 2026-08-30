// UserMemory — one SQLite-backed Durable Object per user.
//
// Implements phases 1 and 2 of doc/09-memory-design.md:
//
//   Phase 1 — WORKING memory. The live conversation lives here instead of in
//             the browser, so it survives a refresh and a dropped socket.
//   Phase 2 — EPISODIC memory. One summary row per finished conversation, plus
//             a "last time we spoke" line at connect.
//
// Phase 3 (semantic facts) is NOT implemented. The `facts` table is created
// because migrating an empty table later is free and migrating a populated one
// is not, and `loadContext` already reads from it — so phase 3 is a write path
// and a prompt section, not a schema change.
//
// ── One instance per USER, not per user-per-character ────────────────────────
// Memory itself is per-character (ADR-022: nothing is shared between them), but
// the character is a COLUMN, not a separate instance. One instance keeps connect
// to a single round trip, keeps the privacy rule in one testable place, and makes
// DELETE /memory one operation instead of nine.
//
// ── Why not VoiceSession ─────────────────────────────────────────────────────
// doc/09 §6 said working memory should live in `VoiceSession`. It cannot:
// `index.ts` creates that with `newUniqueId()`, a fresh instance per CONNECTION,
// so history stored there dies on exactly the reconnect it was meant to survive.
// Keyed by userId here instead. See the correction note in doc/09.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import type { ChatMessage } from "./llm";
import {
  renderMemoryBlock,
  mergeEpisodes,
  EPISODES_RECENT,
  EPISODES_SALIENT,
} from "./memory-text";

/** Verbatim turns kept in the prompt. doc/09 §6. */
export const WORKING_KEEP_TURNS = 20;
/** Facts in the prompt. Phase 3 — the cap exists now so it is not forgotten. */
const FACTS_IN_PROMPT = 40;
/** Hard ceiling on a single stored message, mirroring session.ts. */
const MAX_CONTENT_LEN = 4_000;
/** Open loops on the card. Two, because three is a status meeting. */
const OPEN_LOOPS_IN_PROMPT = 2;
/** After this, an unanswered loop is evidence she is not listening, not warmth. */
const LOOP_MAX_AGE_MS = 21 * 24 * 60 * 60 * 1000;

/**
 * How much a fact is trusted, and therefore what it is allowed to do.
 *
 * `reflex`    — said in passing, scene-local. Never reaches the prompt.
 * `heuristic` — inferred by the summariser. Can be wrong; supersedable.
 * `canon`     — he confirmed it, or it survived several sessions uncontradicted.
 */
export type FactGrade = "reflex" | "heuristic" | "canon";

export interface EpisodeInput {
  characterId: string;
  startedAt: number;
  endedAt: number;
  turnCount: number;
  summary: string;
  mood: string | null;
  salience: number;
}

export class UserMemory extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Synchronous in the constructor is the documented pattern for DO SQLite —
    // every later method can assume the schema exists.
    this.migrate();
  }

  private migrate() {
    // WORKING memory. The live conversation, per character.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS working (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id TEXT    NOT NULL,
        role         TEXT    NOT NULL,   -- 'user' | 'assistant'
        content      TEXT    NOT NULL,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS working_char ON working(character_id, id);
    `);

    // EPISODIC. One row per finished conversation.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS episodes (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id TEXT    NOT NULL,
        started_at   INTEGER NOT NULL,
        ended_at     INTEGER NOT NULL,
        turn_count   INTEGER NOT NULL,
        summary      TEXT    NOT NULL,
        mood         TEXT,
        salience     REAL    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS episodes_recent  ON episodes(character_id, ended_at DESC);
      CREATE INDEX IF NOT EXISTS episodes_salient ON episodes(character_id, salience DESC);
    `);

    // SEMANTIC. Phase 3 writes this; loadContext already reads it.
    // Facts are INVALIDATED, never deleted (ADR-019) — a superseded fact is
    // real history, and a hard delete makes a wrong memory undebuggable.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id   TEXT    NOT NULL,
        subject        TEXT    NOT NULL,
        content        TEXT    NOT NULL,
        confidence     REAL    NOT NULL,
        learned_at     INTEGER NOT NULL,
        invalidated_at INTEGER,
        superseded_by  INTEGER,
        use_count      INTEGER NOT NULL DEFAULT 0,
        last_used_at   INTEGER
      );
      CREATE INDEX IF NOT EXISTS facts_live    ON facts(character_id, invalidated_at);
      CREATE INDEX IF NOT EXISTS facts_subject ON facts(subject, invalidated_at);
    `);

    // BOND. Phase 4 hook — free to fill from day one, and the gap since
    // last_seen_at is what produces "you last spoke three days ago".
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS bond (
        character_id TEXT PRIMARY KEY,
        sessions     INTEGER NOT NULL DEFAULT 0,
        total_turns  INTEGER NOT NULL DEFAULT 0,
        first_met_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
    `);

    // OPEN LOOPS. Something he said would happen that she has not heard the end
    // of. "How did Thursday go?" is the cheapest thing in the whole memory
    // design and the one a user actually notices.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS open_loops (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id TEXT    NOT NULL,
        text         TEXT    NOT NULL,
        created_at   INTEGER NOT NULL,
        due_at       INTEGER,
        asked_at     INTEGER,           -- she has raised it once
        resolved_at  INTEGER,           -- he answered, or it expired
        status       TEXT    NOT NULL DEFAULT 'open'
      );
      CREATE INDEX IF NOT EXISTS loops_live ON open_loops(character_id, status, created_at DESC);
    `);

    // Write grades (chronicler's idea, doc/09 phase 3). A fact learned in
    // passing must not outrank one he confirmed. Added by ALTER rather than in
    // the CREATE above because deployed instances already have the table and
    // CREATE TABLE IF NOT EXISTS silently does nothing to them.
    this.addColumnIfMissing("facts", "grade", "TEXT NOT NULL DEFAULT 'heuristic'");
  }

  /**
   * Additive migration for a table that already exists in the field.
   *
   * SQLite has no ADD COLUMN IF NOT EXISTS, and this runs in every constructor,
   * so the second call must be a no-op rather than an error. Checked against
   * PRAGMA rather than caught, because swallowing every ALTER failure would also
   * swallow a genuinely broken migration.
   */
  private addColumnIfMissing(table: string, column: string, decl: string): void {
    const cols = this.sql
      .exec<{ name: string }>(`PRAGMA table_info(${table})`)
      .toArray()
      .map((c) => c.name);
    if (cols.includes(column)) return;
    this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }

  // ── Phase 1: working memory ─────────────────────────────────

  /** The live conversation with this character, oldest first. */
  async getWorking(characterId: string, limit = WORKING_KEEP_TURNS * 2): Promise<ChatMessage[]> {
    const rows = this.sql
      .exec<{ role: string; content: string }>(
        `SELECT role, content FROM working
          WHERE character_id = ?
          ORDER BY id DESC
          LIMIT ?`,
        characterId,
        Math.max(1, limit),
      )
      .toArray();
    // Pulled newest-first so the LIMIT keeps the RECENT end, then reversed —
    // ordering ascending with a LIMIT would keep the oldest turns instead.
    return rows
      .reverse()
      .filter((r) => r.role === "user" || r.role === "assistant")
      .map((r) => ({ role: r.role as "user" | "assistant", content: r.content }));
  }

  /** Append one exchange. Called after a turn completes, never during it. */
  async appendTurn(characterId: string, userText: string, assistantText: string): Promise<void> {
    const now = Date.now();
    if (userText) {
      this.sql.exec(
        `INSERT INTO working (character_id, role, content, created_at) VALUES (?, 'user', ?, ?)`,
        characterId,
        userText.slice(0, MAX_CONTENT_LEN),
        now,
      );
    }
    if (assistantText) {
      this.sql.exec(
        `INSERT INTO working (character_id, role, content, created_at) VALUES (?, 'assistant', ?, ?)`,
        characterId,
        assistantText.slice(0, MAX_CONTENT_LEN),
        now,
      );
    }
    // Trim well beyond the prompt window rather than exactly to it. The extra
    // rows are what the episode summary reads at session end, and they cost
    // nothing to keep for the length of one conversation.
    this.sql.exec(
      `DELETE FROM working
        WHERE character_id = ?
          AND id <= COALESCE((
            SELECT id FROM working WHERE character_id = ?
             ORDER BY id DESC LIMIT 1 OFFSET ?
          ), -1)`,
      characterId,
      characterId,
      WORKING_KEEP_TURNS * 6,
    );
  }

  /** Clear the live conversation — used once its episode has been recorded. */
  async clearWorking(characterId: string): Promise<void> {
    this.sql.exec(`DELETE FROM working WHERE character_id = ?`, characterId);
  }

  // ── Phase 2: episodic memory ────────────────────────────────

  async addEpisode(e: EpisodeInput): Promise<void> {
    this.sql.exec(
      `INSERT INTO episodes (character_id, started_at, ended_at, turn_count, summary, mood, salience)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      e.characterId,
      e.startedAt,
      e.endedAt,
      e.turnCount,
      e.summary.slice(0, MAX_CONTENT_LEN),
      e.mood ? e.mood.slice(0, 40) : null,
      Math.max(0, Math.min(1, e.salience)),
    );
  }

  /** Session counters. Cheap, and phase 4 needs them to already exist. */
  async recordSession(characterId: string, turnCount: number): Promise<void> {
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO bond (character_id, sessions, total_turns, first_met_at, last_seen_at)
            VALUES (?, 1, ?, ?, ?)
       ON CONFLICT(character_id) DO UPDATE SET
            sessions     = sessions + 1,
            total_turns  = total_turns + excluded.total_turns,
            last_seen_at = excluded.last_seen_at`,
      characterId,
      turnCount,
      now,
      now,
    );
  }

  // ── Phase 3: semantic facts ─────────────────────────────────

  /**
   * Write a fact, superseding whatever it replaces.
   *
   * `subject` is the normalised key — `employment`, `sister.name` — and it is
   * what makes this a supersession rather than an append. Two rows claiming a
   * different employer are not two memories, they are one memory and one lie,
   * and `loadContext` has no way to tell which is current. So the old row is
   * invalidated here, at write time, where the answer is known.
   *
   * Nothing is deleted: ADR-019. A superseded fact is real history, and a hard
   * delete makes a wrong memory impossible to debug afterwards.
   */
  async writeFact(input: {
    characterId: string;
    subject: string;
    content: string;
    confidence: number;
    grade?: FactGrade;
  }): Promise<{ superseded: number }> {
    const now = Date.now();
    const subject = input.subject.trim().toLowerCase().slice(0, 80);
    const content = input.content.slice(0, MAX_CONTENT_LEN);
    const grade: FactGrade = input.grade ?? "heuristic";

    const live = this.sql
      .exec<{ id: number; content: string }>(
        `SELECT id, content FROM facts
          WHERE character_id = ? AND subject = ? AND invalidated_at IS NULL`,
        input.characterId,
        subject,
      )
      .toArray();

    // Re-stating a fact she already holds is not a supersession. Without this
    // check every repeat mention would invalidate the row and write an
    // identical one, and use_count — which orders the prompt — would reset.
    const identical = live.find((f) => f.content === content);
    if (identical) {
      this.sql.exec(`UPDATE facts SET last_used_at = ? WHERE id = ?`, now, identical.id);
      return { superseded: 0 };
    }

    this.sql.exec(
      `INSERT INTO facts (character_id, subject, content, confidence, learned_at, grade)
            VALUES (?, ?, ?, ?, ?, ?)`,
      input.characterId,
      subject,
      content,
      Math.max(0, Math.min(1, input.confidence)),
      now,
      grade,
    );
    const newId = this.sql
      .exec<{ id: number }>(`SELECT last_insert_rowid() AS id`)
      .toArray()[0]!.id;

    for (const old of live) {
      this.sql.exec(
        `UPDATE facts SET invalidated_at = ?, superseded_by = ? WHERE id = ?`,
        now,
        newId,
        old.id,
      );
    }
    return { superseded: live.length };
  }

  // ── Open loops ──────────────────────────────────────────────

  /** Something he said would happen, that she has not heard the end of. */
  async addOpenLoop(characterId: string, text: string, dueAt?: number): Promise<void> {
    this.sql.exec(
      `INSERT INTO open_loops (character_id, text, created_at, due_at) VALUES (?, ?, ?, ?)`,
      characterId,
      text.slice(0, 300),
      Date.now(),
      dueAt ?? null,
    );
  }

  /**
   * The loops worth putting on the card: still open, newest first, capped.
   *
   * Capped at two deliberately. A companion who opens with three unanswered
   * questions is running a status meeting, not a conversation.
   */
  async getOpenLoops(characterId: string, limit = OPEN_LOOPS_IN_PROMPT): Promise<string[]> {
    return this.sql
      .exec<{ text: string }>(
        `SELECT text FROM open_loops
          WHERE character_id = ? AND status = 'open'
          ORDER BY created_at DESC LIMIT ?`,
        characterId,
        limit,
      )
      .toArray()
      .map((r) => r.text);
  }

  /** She raised it, or he answered it, or it went stale. Either way it is done. */
  async closeOpenLoop(id: number, status: "asked" | "resolved" | "archived"): Promise<void> {
    this.sql.exec(
      `UPDATE open_loops SET status = ?, resolved_at = ? WHERE id = ?`,
      status,
      Date.now(),
      id,
    );
  }

  /**
   * Expire loops nobody ever closed. An unanswered question is a fair thing to
   * ask once; six weeks later it is just evidence that she is not listening.
   */
  async expireStaleLoops(maxAgeMs = LOOP_MAX_AGE_MS): Promise<{ expired: number }> {
    const cutoff = Date.now() - maxAgeMs;
    const doomed = this.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM open_loops WHERE status = 'open' AND created_at < ?`,
        cutoff,
      )
      .toArray()[0]?.n ?? 0;
    this.sql.exec(
      `UPDATE open_loops SET status = 'archived', resolved_at = ?
        WHERE status = 'open' AND created_at < ?`,
      Date.now(),
      cutoff,
    );
    return { expired: doomed };
  }

  // ── Read path: one round trip at connect ────────────────────

  /**
   * Everything the session needs, in ONE call. doc/09 §4: the block is built
   * once and held for the whole connection, so the per-turn cost is zero.
   */
  async loadContext(characterId: string): Promise<{
    memoryBlock: string;
    history: ChatMessage[];
    episodeCount: number;
    factCount: number;
    loopCount: number;
  }> {
    const history = await this.getWorking(characterId);
    // The SQL lives here; the prose lives in memory-text.renderMemoryBlock, so
    // the eval harness renders the byte-identical block rather than a copy of
    // it. Same reasoning as buildTurnMessages in turn.ts.

    // Bond: the gap since last time. doc/09 s4 calls this one line more
    // valuable for the feeling of continuity than any individual fact.
    const bond = this.sql
      .exec<{ sessions: number; last_seen_at: number }>(
        `SELECT sessions, last_seen_at FROM bond WHERE character_id = ?`,
        characterId,
      )
      .toArray()[0];

    // Facts. Only live rows, and never `reflex` — that grade exists precisely
    // so scene noise can be written down without reaching the prompt.
    const facts = this.sql
      .exec<{ content: string }>(
        `SELECT content FROM facts
          WHERE character_id = ? AND invalidated_at IS NULL AND grade <> 'reflex'
          ORDER BY use_count DESC, learned_at DESC
          LIMIT ?`,
        characterId,
        FACTS_IN_PROMPT,
      )
      .toArray()
      .map((f) => f.content);

    const openLoops = await this.getOpenLoops(characterId);

    // Episodes: recent for continuity, salient so the night that mattered does
    // not fall off the end after a few chatty sessions. `salience` is selected,
    // not just ordered by, because the budget filter needs it to decide which
    // single episode to keep when it has to start dropping.
    const recent = this.sql
      .exec<EpisodeRow>(
        `SELECT id, ended_at, summary, mood, salience FROM episodes
          WHERE character_id = ? ORDER BY ended_at DESC LIMIT ?`,
        characterId,
        EPISODES_RECENT,
      )
      .toArray();
    const salient = this.sql
      .exec<EpisodeRow>(
        `SELECT id, ended_at, summary, mood, salience FROM episodes
          WHERE character_id = ? ORDER BY salience DESC, ended_at DESC LIMIT ?`,
        characterId,
        EPISODES_SALIENT,
      )
      .toArray();

    const merged = mergeEpisodes(recent, salient);
    const memoryBlock = renderMemoryBlock({ bond, facts, episodes: merged, openLoops });
    return {
      memoryBlock,
      history,
      episodeCount: merged.length,
      factCount: facts.length,
      loopCount: openLoops.length,
    };
  }

  /**
   * Erase everything for this user. The privacy obligation in doc/09 §8 — part
   * of shipping memory, not a later nicety. Deliberately total: facts are
   * invalidated rather than deleted during normal operation, but a user asking
   * to be forgotten means gone, not flagged.
   */
  async forgetAll(): Promise<{ deleted: number }> {
    let deleted = 0;
    for (const t of ["working", "episodes", "facts", "bond", "open_loops"]) {
      const before = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`).toArray()[0]?.n ?? 0;
      this.sql.exec(`DELETE FROM ${t}`);
      deleted += before;
    }
    return { deleted };
  }

  /**
   * What she actually remembers, in full. Inspection exists for the same
   * reason DELETE does — but it also turned out to be the only way to debug
   * a wrong memory: the first real test had her confuse two similar things,
   * and without this the summaries were invisible.
   */
  async inspect(): Promise<{
    episodes: Array<{ character_id: string; ended_at: number; summary: string; mood: string | null; salience: number; turn_count: number }>;
    facts: Array<{ character_id: string; subject: string; content: string; grade: string; invalidated_at: number | null }>;
    openLoops: Array<{ character_id: string; text: string; status: string; created_at: number }>;
    bond: Array<{ character_id: string; sessions: number; total_turns: number; last_seen_at: number }>;
  }> {
    return {
      episodes: this.sql
        .exec(`SELECT character_id, ended_at, summary, mood, salience, turn_count
                 FROM episodes ORDER BY ended_at DESC LIMIT 50`)
        .toArray() as never,
      facts: this.sql
        .exec(`SELECT character_id, subject, content, grade, invalidated_at
                 FROM facts ORDER BY learned_at DESC LIMIT 100`)
        .toArray() as never,
      openLoops: this.sql
        .exec(`SELECT character_id, text, status, created_at
                 FROM open_loops ORDER BY created_at DESC LIMIT 50`)
        .toArray() as never,
      bond: this.sql
        .exec(`SELECT character_id, sessions, total_turns, last_seen_at FROM bond`)
        .toArray() as never,
    };
  }

  /** Inspection, for the same reason DELETE exists — see doc/06. */
  async summary(): Promise<Record<string, number>> {
    const count = (t: string) =>
      this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`).toArray()[0]?.n ?? 0;
    return {
      working: count("working"),
      episodes: count("episodes"),
      facts: count("facts"),
      open_loops: count("open_loops"),
      characters: count("bond"),
    };
  }
}

// Index signature required by SqlStorage.exec<T>'s constraint.
interface EpisodeRow extends Record<string, SqlStorageValue> {
  id: number;
  ended_at: number;
  summary: string;
  mood: string | null;
  salience: number;
}
