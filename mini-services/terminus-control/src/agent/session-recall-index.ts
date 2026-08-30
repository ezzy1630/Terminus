import { Database } from "bun:sqlite";
import { SESSION_RECALL_SOURCE_MAX_CHARS } from "./session-recall.js";
import { sessionRecallFtsQueryTerms } from "./session-recall-query.js";

export interface SessionRecallIndexDocument {
  readonly turnId: string;
  readonly taskId: string;
  readonly threadId: string;
  readonly sequence: number;
  readonly completedAt: string | null;
  readonly userText: string;
  readonly assistantText: string;
  readonly sourceIdentity: string;
  readonly complete: boolean;
}

export interface SessionRecallIndexState {
  readonly sourceIdentity: string;
  readonly complete: boolean;
}

export interface SessionRecallIndexHit {
  readonly turnId: string;
  readonly sequence: number;
  /** Raw FTS5 BM25 score. Lower is a stronger match. */
  readonly rawScore: number;
}

export interface SessionRecallIndexSearch {
  readonly taskId: string;
  readonly threadId: string;
  readonly query: string;
  readonly beforeSequence: number;
  readonly fromSequenceInclusive: number;
  readonly limit: number;
}

interface StateRow {
  readonly turn_id: string;
  readonly source_identity: string;
  readonly complete: number;
}

interface HitRow {
  readonly turn_id: string;
  readonly turn_sequence: number | string;
  readonly raw_score: number;
}

/**
 * Durable lexical discovery for exact session artifacts.
 *
 * The FTS row is only an index. Callers hydrate every hit from its immutable
 * artifact URI before returning it to the model. Missing tables or corrupt
 * rows therefore degrade to the bounded scan path instead of becoming an
 * authority source.
 */
export class SessionRecallFtsIndex {
  constructor(private readonly database: Database) {}

  currentStates(turnIds: readonly string[]): ReadonlyMap<string, SessionRecallIndexState> {
    if (turnIds.length === 0) return new Map();
    if (turnIds.length > 50) throw new Error("session recall index state lookup exceeds 50 turns");
    const placeholders = turnIds.map(() => "?").join(", ");
    const rows = this.database.query(
      `SELECT turn_id, source_identity, complete
       FROM session_turn_fts_state
       WHERE turn_id IN (${placeholders})`,
    ).all(...turnIds) as StateRow[];
    return new Map(rows.map((row) => [row.turn_id, {
      sourceIdentity: row.source_identity,
      complete: row.complete === 1,
    }]));
  }

  upsert(document: SessionRecallIndexDocument): void {
    this.upsertMany([document]);
  }

  upsertMany(documents: readonly SessionRecallIndexDocument[]): void {
    if (documents.length === 0) return;
    if (documents.length > 50) throw new Error("session recall index batch exceeds 50 turns");
    documents.forEach(assertDocument);
    if (new Set(documents.map((document) => document.turnId)).size !== documents.length) {
      throw new Error("session recall index batch contains duplicate turn ids");
    }
    const deleteRow = this.database.query("DELETE FROM session_turn_fts WHERE turn_id = ?");
    const insertRow = this.database.query(
        `INSERT INTO session_turn_fts (
           task_id, thread_id, turn_id, turn_sequence, completed_at, user_text, assistant_text
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
    const upsertState = this.database.query(
        `INSERT INTO session_turn_fts_state (
           turn_id, task_id, thread_id, turn_sequence, source_identity, complete, indexed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(turn_id) DO UPDATE SET
           task_id = excluded.task_id,
           thread_id = excluded.thread_id,
           turn_sequence = excluded.turn_sequence,
           source_identity = excluded.source_identity,
           complete = excluded.complete,
           indexed_at = excluded.indexed_at`,
      );
    const transaction = this.database.transaction((values: readonly SessionRecallIndexDocument[]) => {
      const indexedAt = Date.now();
      for (const value of values) {
        deleteRow.run(value.turnId);
        insertRow.run(
          value.taskId,
          value.threadId,
          value.turnId,
          value.sequence,
          value.completedAt,
          value.userText,
          value.assistantText,
        );
        upsertState.run(
          value.turnId,
          value.taskId,
          value.threadId,
          value.sequence,
          value.sourceIdentity,
          value.complete ? 1 : 0,
          indexedAt,
        );
      }
    });
    transaction.immediate(documents);
  }

  search(input: SessionRecallIndexSearch): readonly SessionRecallIndexHit[] {
    assertSearch(input);
    const match = ftsMatchExpression(input.query);
    if (match === null) return [];
    const rows = this.database.query(
      `SELECT
         turn_id,
         turn_sequence,
         bm25(session_turn_fts, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0) AS raw_score
       FROM session_turn_fts
       WHERE session_turn_fts MATCH ?
         AND task_id = ?
         AND thread_id = ?
         AND CAST(turn_sequence AS INTEGER) >= ?
         AND CAST(turn_sequence AS INTEGER) < ?
       ORDER BY raw_score ASC, CAST(turn_sequence AS INTEGER) DESC
       LIMIT ?`,
    ).all(
      match,
      input.taskId,
      input.threadId,
      input.fromSequenceInclusive,
      input.beforeSequence,
      input.limit,
    ) as HitRow[];
    return rows.map((row) => ({
      turnId: row.turn_id,
      sequence: Number(row.turn_sequence),
      rawScore: row.raw_score,
    }));
  }
}

/** Quote normalized terms so punctuation cannot become FTS5 query syntax. */
export function ftsMatchExpression(query: string): string | null {
  const terms = sessionRecallFtsQueryTerms(query);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(" OR ");
}

function assertDocument(document: SessionRecallIndexDocument): void {
  for (const [name, value] of [
    ["turnId", document.turnId],
    ["taskId", document.taskId],
    ["threadId", document.threadId],
    ["sourceIdentity", document.sourceIdentity],
  ] as const) {
    if (value.trim().length === 0) throw new Error(`session recall index ${name} must not be blank`);
  }
  if (!Number.isSafeInteger(document.sequence) || document.sequence < 1) {
    throw new Error("session recall index sequence must be a positive safe integer");
  }
  if (
    Array.from(document.userText).length > SESSION_RECALL_SOURCE_MAX_CHARS
    || Array.from(document.assistantText).length > SESSION_RECALL_SOURCE_MAX_CHARS
  ) {
    throw new Error(`session recall index source exceeds ${SESSION_RECALL_SOURCE_MAX_CHARS} characters`);
  }
}

function assertSearch(input: SessionRecallIndexSearch): void {
  if (input.taskId.trim().length === 0 || input.threadId.trim().length === 0) {
    throw new Error("session recall index search requires task and thread scope");
  }
  if (input.query.trim().length === 0 || input.query.length > 256) {
    throw new Error("session recall index query must contain between 1 and 256 characters");
  }
  if (!Number.isSafeInteger(input.beforeSequence) || input.beforeSequence < 1) {
    throw new Error("session recall index beforeSequence must be a positive safe integer");
  }
  if (!Number.isSafeInteger(input.fromSequenceInclusive) || input.fromSequenceInclusive < 1) {
    throw new Error("session recall index fromSequenceInclusive must be a positive safe integer");
  }
  if (input.fromSequenceInclusive >= input.beforeSequence) {
    throw new Error("session recall index search range must not be empty");
  }
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50) {
    throw new Error("session recall index limit must be between 1 and 50");
  }
}
