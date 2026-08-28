-- Prisma's SQLite connector treats DateTime values as 64-bit integer epoch
-- milliseconds. Migration 0018 rebuilt the provider tables away from INTEGER,
-- which the schema engine exposes as a 32-bit INT, but `repair_attempts` was
-- created by 0012 with the same INTEGER declaration and was missed. Every
-- `tx.repairAttempt.create()` therefore fails with P2023 ("Value <epoch> does
-- not fit in an INT column"), which aborts the turn that opened the repair —
-- a turn only reaches this path after the provider call has already
-- succeeded, so the failure reads as a provider or kernel fault.
--
-- Rebuild the table with the BIGINT declaration used by the core timestamp
-- tables and preserve every existing row. SQLite STRICT tables do not admit
-- the BIGINT declaration, so the rebuilt table drops STRICT and retains the
-- explicit CHECK constraints instead, matching the core timestamp tables and
-- the precedent set by 0018.

CREATE TABLE repair_attempts_v21 (
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
    environment_digest      TEXT,
    remaining_budget_json   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(remaining_budget_json) = 1),
    created_at              BIGINT NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
    started_at              BIGINT,
    completed_at            BIGINT,
    terminal_reason_json    TEXT CHECK (terminal_reason_json IS NULL OR json_valid(terminal_reason_json) = 1),
    UNIQUE(task_id, attempt_number)
);

INSERT INTO repair_attempts_v21 (
    id, task_id, parent_turn_id, repair_turn_id, lease_key, attempt_number,
    max_attempts, state, directive_artifact, failed_node_ids_json,
    failure_signatures_json, changed_files_json, source_revision,
    environment_digest, remaining_budget_json, created_at, started_at,
    completed_at, terminal_reason_json
)
SELECT
    id, task_id, parent_turn_id, repair_turn_id, lease_key, attempt_number,
    max_attempts, state, directive_artifact, failed_node_ids_json,
    failure_signatures_json, changed_files_json, source_revision,
    environment_digest, remaining_budget_json,
    CASE
        WHEN typeof(created_at) IN ('integer', 'real') THEN CAST(created_at AS INTEGER)
        WHEN trim(created_at) <> '' AND trim(created_at) NOT GLOB '*[^0-9]*' THEN CAST(trim(created_at) AS INTEGER)
        ELSE CAST(ROUND((julianday(trim(created_at)) - 2440587.5) * 86400000.0) AS INTEGER)
    END,
    CASE
        WHEN started_at IS NULL THEN NULL
        WHEN typeof(started_at) IN ('integer', 'real') THEN CAST(started_at AS INTEGER)
        WHEN trim(started_at) <> '' AND trim(started_at) NOT GLOB '*[^0-9]*' THEN CAST(trim(started_at) AS INTEGER)
        ELSE CAST(ROUND((julianday(trim(started_at)) - 2440587.5) * 86400000.0) AS INTEGER)
    END,
    CASE
        WHEN completed_at IS NULL THEN NULL
        WHEN typeof(completed_at) IN ('integer', 'real') THEN CAST(completed_at AS INTEGER)
        WHEN trim(completed_at) <> '' AND trim(completed_at) NOT GLOB '*[^0-9]*' THEN CAST(trim(completed_at) AS INTEGER)
        ELSE CAST(ROUND((julianday(trim(completed_at)) - 2440587.5) * 86400000.0) AS INTEGER)
    END,
    terminal_reason_json
FROM repair_attempts;

DROP TABLE repair_attempts;
ALTER TABLE repair_attempts_v21 RENAME TO repair_attempts;

CREATE INDEX repair_attempts_task_state
    ON repair_attempts(task_id, state);
CREATE INDEX repair_attempts_parent_turn
    ON repair_attempts(parent_turn_id);
