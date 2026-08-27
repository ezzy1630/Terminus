-- Durable verification-repair identity and lease association.
-- A repair attempt is a first-class continuation, not an inference from the
-- latest semantic event. Its lease key lets restart recovery claim exactly
-- one execution owner with a fencing token.

CREATE TABLE repair_attempts (
    id                      TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) BETWEEN 1 AND 255),
    task_id                 TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    parent_turn_id          TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    repair_turn_id          TEXT UNIQUE REFERENCES turns(id) ON DELETE SET NULL,
    lease_key               TEXT NOT NULL UNIQUE REFERENCES leases(lease_key) ON DELETE CASCADE,
    attempt_number          INTEGER NOT NULL CHECK (attempt_number > 0),
    max_attempts            INTEGER NOT NULL CHECK (max_attempts >= attempt_number),
    state                   TEXT NOT NULL CHECK (state IN ('PENDING', 'ADMITTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'ABORTED', 'SUPERSEDED')),
    directive_artifact      TEXT NOT NULL CHECK (length(trim(directive_artifact)) BETWEEN 1 AND 255),
    failed_node_ids_json    TEXT NOT NULL CHECK (json_valid(failed_node_ids_json) = 1),
    failure_signatures_json TEXT NOT NULL CHECK (json_valid(failure_signatures_json) = 1),
    changed_files_json      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(changed_files_json) = 1),
    source_revision         TEXT NOT NULL CHECK (length(trim(source_revision)) BETWEEN 1 AND 255),
    environment_digest     TEXT,
    remaining_budget_json   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(remaining_budget_json) = 1),
    created_at              INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
    started_at              INTEGER,
    completed_at            INTEGER,
    terminal_reason_json    TEXT CHECK (terminal_reason_json IS NULL OR json_valid(terminal_reason_json) = 1),
    UNIQUE(task_id, attempt_number)
) STRICT;

CREATE INDEX repair_attempts_task_state
    ON repair_attempts(task_id, state);

CREATE INDEX repair_attempts_parent_turn
    ON repair_attempts(parent_turn_id);
