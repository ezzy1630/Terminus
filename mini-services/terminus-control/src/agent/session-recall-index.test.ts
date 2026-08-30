import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  SqliteDatabaseAdapter,
  SqliteSessionRecallIndexRepository,
  type SqliteValue,
} from "@terminus/task-runtime";
import {
  SESSION_RECALL_SOURCE_MAX_CHARS,
} from "./session-recall.js";
import {
  sessionRecallLexicalScore,
  sessionRecallMatchStart,
} from "./session-recall-query.js";
import {
  SessionRecallFtsIndex,
  ftsMatchExpression,
  type SessionRecallIndexDocument,
} from "./session-recall-index.js";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const MIGRATION = readFileSync(
  join(ROOT, "migrations", "sqlite", "0030_session_recall_fts.sql"),
  "utf8",
);

function recallIndex(database: Database): SessionRecallFtsIndex {
  const port = new SqliteDatabaseAdapter({
    exec: (sql) => database.exec(sql),
    query: (sql) => {
      const statement = database.query(sql);
      return {
        get: (...parameters: SqliteValue[]) => statement.get(...parameters),
        all: (...parameters: SqliteValue[]) => statement.all(...parameters),
        run: (...parameters: SqliteValue[]) => ({ changes: statement.run(...parameters).changes }),
      };
    },
    transaction: (operation) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = operation();
        database.exec("COMMIT");
        return result;
      } catch (error: unknown) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  });
  return new SessionRecallFtsIndex(new SqliteSessionRecallIndexRepository(port));
}

function fixture(): { readonly database: Database; readonly index: SessionRecallFtsIndex } {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("CREATE TABLE turns (id TEXT PRIMARY KEY) STRICT");
  database.exec(MIGRATION);
  return { database, index: recallIndex(database) };
}

function document(overrides: Partial<SessionRecallIndexDocument> = {}): SessionRecallIndexDocument {
  return {
    turnId: "turn-1",
    taskId: "task-1",
    threadId: "thread-1",
    sequence: 1,
    completedAt: "2026-08-30T00:00:00.000Z",
    userText: "Find the profile cache identity bug",
    assistantText: "The stable prefix hash was repaired",
    sourceIdentity: "sha256:source-1",
    complete: true,
    ...overrides,
  };
}

function insertTurn(database: Database, id: string): void {
  database.query("INSERT INTO turns (id) VALUES (?)").run(id);
}

describe("session recall FTS5 index", () => {
  test("ranks exact text inside one task/thread and bounded sequence window", () => {
    const { database, index } = fixture();
    try {
      for (const id of ["turn-1", "turn-2", "turn-other-task", "turn-other-thread"]) insertTurn(database, id);
      index.upsert(document());
      index.upsert(document({
        turnId: "turn-2", sequence: 2, userText: "profile profile cache",
        assistantText: "cache identity and stable prefix",
        sourceIdentity: "sha256:source-2",
      }));
      index.upsert(document({
        turnId: "turn-other-task", taskId: "task-2", sequence: 3,
        sourceIdentity: "sha256:source-3",
      }));
      index.upsert(document({
        turnId: "turn-other-thread", threadId: "thread-2", sequence: 4,
        sourceIdentity: "sha256:source-4",
      }));

      const hits = index.search({
        taskId: "task-1",
        threadId: "thread-1",
        query: "profile cache",
        fromSequenceInclusive: 1,
        beforeSequence: 3,
        limit: 10,
      });
      expect(hits.map((hit) => hit.turnId)).toEqual(["turn-2", "turn-1"]);
      expect(hits.every((hit) => Number.isFinite(hit.rawScore))).toBe(true);
    } finally {
      database.close();
    }
  });

  test("upsert replaces stale text and records source completeness", () => {
    const { database, index } = fixture();
    try {
      insertTurn(database, "turn-1");
      index.upsert(document({ userText: "obsolete sentinel", complete: false }));
      expect(index.search({
        taskId: "task-1", threadId: "thread-1", query: "obsolete",
        fromSequenceInclusive: 1, beforeSequence: 2, limit: 5,
      })).toHaveLength(1);
      expect(index.currentStates(["turn-1"]).get("turn-1")).toEqual({
        sourceIdentity: "sha256:source-1",
        complete: false,
      });

      index.upsert(document({
        userText: "replacement sentinel",
        sourceIdentity: "sha256:source-2",
        complete: true,
      }));
      expect(index.search({
        taskId: "task-1", threadId: "thread-1", query: "obsolete",
        fromSequenceInclusive: 1, beforeSequence: 2, limit: 5,
      })).toEqual([]);
      expect(index.search({
        taskId: "task-1", threadId: "thread-1", query: "replacement",
        fromSequenceInclusive: 1, beforeSequence: 2, limit: 5,
      }).map((hit) => hit.turnId)).toEqual(["turn-1"]);
      expect(index.currentStates(["turn-1"]).get("turn-1")).toEqual({
        sourceIdentity: "sha256:source-2",
        complete: true,
      });
    } finally {
      database.close();
    }
  });

  test("batch upsert preserves bounded Unicode, combining marks, and separator matches", () => {
    const { database, index } = fixture();
    try {
      insertTurn(database, "turn-1");
      for (const id of ["turn-2", "turn-3", "turn-4", "turn-5"]) insertTurn(database, id);
      index.upsertMany([
        document({ userText: "The café cache uses foo bar identity." }),
        document({
          turnId: "turn-2",
          sequence: 2,
          sourceIdentity: "sha256:source-2",
          userText: "unrelated text",
        }),
        document({
          turnId: "turn-3", sequence: 3, sourceIdentity: "sha256:source-3",
          userText: "किताब",
        }),
        document({
          turnId: "turn-4", sequence: 4, sourceIdentity: "sha256:source-4",
          userText: "தமிழ்",
        }),
        document({
          turnId: "turn-5", sequence: 5, sourceIdentity: "sha256:source-5",
          userText: "مُدَوَّنَة",
        }),
      ]);
      expect(index.search({
        taskId: "task-1",
        threadId: "thread-1",
        query: "cafe foo_bar",
        fromSequenceInclusive: 1,
        beforeSequence: 6,
        limit: 10,
      }).map((hit) => hit.turnId)).toEqual(["turn-1"]);
      for (const [query, expected] of [
        ["किताब", "turn-3"],
        ["தமிழ்", "turn-4"],
        ["مُدَوَّنَة", "turn-5"],
      ] as const) {
        expect(index.search({
          taskId: "task-1",
          threadId: "thread-1",
          query,
          fromSequenceInclusive: 1,
          beforeSequence: 6,
          limit: 10,
        }).map((hit) => hit.turnId)).toEqual([expected]);
      }
    } finally {
      database.close();
    }
  });

  test("turn deletion removes the side-table and FTS rows", () => {
    const { database, index } = fixture();
    try {
      insertTurn(database, "turn-1");
      index.upsert(document());
      database.query("DELETE FROM turns WHERE id = ?").run("turn-1");
      expect(index.currentStates(["turn-1"]).size).toBe(0);
      expect(index.search({
        taskId: "task-1", threadId: "thread-1", query: "profile",
        fromSequenceInclusive: 1, beforeSequence: 2, limit: 5,
      })).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("reopens a durable index without rebuilding it", () => {
    const directory = mkdtempSync(join(tmpdir(), "terminus-recall-index-"));
    const path = join(directory, "recall.db");
    try {
      const first = new Database(path);
      first.exec("PRAGMA foreign_keys = ON");
      first.exec("CREATE TABLE turns (id TEXT PRIMARY KEY) STRICT");
      first.exec(MIGRATION);
      insertTurn(first, "turn-1");
      recallIndex(first).upsert(document());
      first.close();

      const reopened = new Database(path);
      try {
        expect(recallIndex(reopened).search({
          taskId: "task-1",
          threadId: "thread-1",
          query: "profile cache",
          fromSequenceInclusive: 1,
          beforeSequence: 2,
          limit: 5,
        }).map((hit) => hit.turnId)).toEqual(["turn-1"]);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("normalizes punctuation into quoted FTS terms", () => {
    expect(ftsMatchExpression(" Profile hash (cache)? ")).toBe('"profile"* OR "hash"* OR "cache"*');
    expect(ftsMatchExpression("café foo_bar")).toBe('"café"* OR "foo"* OR "bar"*');
    expect(ftsMatchExpression("---")).toBeNull();
    expect(ftsMatchExpression(" ")).toBeNull();
  });

  test("uses token-prefix rather than arbitrary substring matches", () => {
    const { database, index } = fixture();
    try {
      insertTurn(database, "profile-turn");
      index.upsert(document({ turnId: "profile-turn", sequence: 1, userText: "profile" }));
      expect(index.search({
        taskId: "task-1",
        threadId: "thread-1",
        query: "file",
        beforeSequence: 2,
        fromSequenceInclusive: 1,
        limit: 10,
      })).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("keeps exact reranking aligned with unicode61 simple folds", () => {
    const { database, index } = fixture();
    const pairs = [
      ["long-s", "ſcope", "scope"],
      ["theta", "ϑ", "θ"],
      ["phi", "ϕ", "φ"],
      ["pi", "ϖ", "π"],
      ["kappa", "ϰ", "κ"],
      ["rho", "ϱ", "ρ"],
      ["micro", "µ", "μ"],
    ] as const;
    try {
      for (const [offset, [name, source]] of pairs.entries()) {
        const turnId = `fold-${name}`;
        insertTurn(database, turnId);
        index.upsert(document({ turnId, sequence: offset + 1, userText: source }));
      }
      for (const [name, source, query] of pairs) {
        expect(index.search({
          taskId: "task-1",
          threadId: "thread-1",
          query,
          beforeSequence: pairs.length + 1,
          fromSequenceInclusive: 1,
          limit: 20,
        }).map((hit) => hit.turnId)).toContain(`fold-${name}`);
        expect(sessionRecallLexicalScore(source, query)).toBeGreaterThan(0);
        expect(sessionRecallMatchStart(source, query)).toBe(0);
      }
    } finally {
      database.close();
    }
  });

  test("removes complete Latin diacritics without collapsing other scripts", () => {
    const { database, index } = fixture();
    const latinPairs = [
      ["o-horn", "ộ", "o"],
      ["a-dot", "ậ", "a"],
      ["a-breve", "ắ", "a"],
      ["a-circumflex", "ấ", "a"],
    ] as const;
    try {
      for (const [offset, [name, source]] of latinPairs.entries()) {
        const turnId = `diacritic-${name}`;
        insertTurn(database, turnId);
        index.upsert(document({ turnId, sequence: offset + 1, userText: source }));
      }
      for (const [name, source, query] of latinPairs) {
        expect(index.search({
          taskId: "task-1",
          threadId: "thread-1",
          query,
          beforeSequence: latinPairs.length + 1,
          fromSequenceInclusive: 1,
          limit: 20,
        }).map((hit) => hit.turnId)).toContain(`diacritic-${name}`);
        expect(sessionRecallLexicalScore(source, query)).toBeGreaterThan(0);
      }
    } finally {
      database.close();
    }
  });

  test("bounds indexed source text by Unicode code points, not UTF-16 code units", () => {
    const { database, index } = fixture();
    try {
      insertTurn(database, "turn-1");
      const astralText = "😀".repeat(SESSION_RECALL_SOURCE_MAX_CHARS);
      expect(() => index.upsert(document({ userText: astralText }))).not.toThrow();
      expect(() => index.upsert(document({ userText: `${astralText}a` }))).toThrow(
        `session recall index source exceeds ${SESSION_RECALL_SOURCE_MAX_CHARS} characters`,
      );
    } finally {
      database.close();
    }
  });
});
