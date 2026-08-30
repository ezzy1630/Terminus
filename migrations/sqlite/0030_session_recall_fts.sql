-- Exact same-task session recall uses FTS5 for discovery while immutable
-- artifacts remain the source of truth. The side table records which source
-- identity was indexed so lazy backfill can repair missing or stale rows.

CREATE VIRTUAL TABLE IF NOT EXISTS session_turn_fts USING fts5(
    task_id UNINDEXED,
    thread_id UNINDEXED,
    turn_id UNINDEXED,
    turn_sequence UNINDEXED,
    completed_at UNINDEXED,
    user_text,
    assistant_text,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS session_turn_fts_state (
    turn_id          TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
    task_id          TEXT NOT NULL,
    thread_id        TEXT NOT NULL,
    turn_sequence    INTEGER NOT NULL CHECK (turn_sequence > 0),
    source_identity  TEXT NOT NULL,
    complete         INTEGER NOT NULL CHECK (complete IN (0, 1)),
    indexed_at       INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS session_turn_fts_state_scope
ON session_turn_fts_state(task_id, thread_id, turn_sequence DESC);

CREATE TRIGGER IF NOT EXISTS session_turn_fts_state_delete
AFTER DELETE ON session_turn_fts_state
BEGIN
    DELETE FROM session_turn_fts WHERE turn_id = OLD.turn_id;
END;
