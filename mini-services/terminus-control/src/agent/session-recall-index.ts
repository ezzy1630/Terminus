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

export interface SessionRecallIndexRepository {
  currentStates(turnIds: readonly string[]): ReadonlyMap<string, SessionRecallIndexState>;
  upsertMany(documents: readonly SessionRecallIndexDocument[]): void;
  search(input: {
    readonly taskId: string;
    readonly threadId: string;
    readonly matchExpression: string;
    readonly beforeSequence: number;
    readonly fromSequenceInclusive: number;
    readonly limit: number;
  }): readonly SessionRecallIndexHit[];
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
  constructor(private readonly repository: SessionRecallIndexRepository) {}

  currentStates(turnIds: readonly string[]): ReadonlyMap<string, SessionRecallIndexState> {
    if (turnIds.length > 50) throw new Error("session recall index state lookup exceeds 50 turns");
    return this.repository.currentStates(turnIds);
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
    this.repository.upsertMany(documents);
  }

  search(input: SessionRecallIndexSearch): readonly SessionRecallIndexHit[] {
    assertSearch(input);
    const match = ftsMatchExpression(input.query);
    if (match === null) return [];
    return this.repository.search({
      taskId: input.taskId,
      threadId: input.threadId,
      matchExpression: match,
      fromSequenceInclusive: input.fromSequenceInclusive,
      beforeSequence: input.beforeSequence,
      limit: input.limit,
    });
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
