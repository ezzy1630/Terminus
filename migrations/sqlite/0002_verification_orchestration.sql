-- M8: completion records, finding lifecycle, worktree leases, AC bindings.

ALTER TABLE verification_nodes ADD COLUMN acceptance_criterion_id TEXT;
ALTER TABLE verification_nodes ADD COLUMN depends_on_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE verification_edges ADD COLUMN kind TEXT NOT NULL DEFAULT 'depends';

CREATE TABLE IF NOT EXISTS completion_records (
    id                      TEXT PRIMARY KEY,
    task_id                 TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
    contract_version        INTEGER NOT NULL,
    final_revision          TEXT NOT NULL,
    status                  TEXT NOT NULL CHECK (status IN ('completed')),
    criteria_json           TEXT NOT NULL,
    verification_plan_id    TEXT NOT NULL REFERENCES verification_plans(id),
    unresolved_risks_json   TEXT NOT NULL,
    accepted_risks_json     TEXT NOT NULL,
    external_effects_json   TEXT NOT NULL,
    cost_micros             INTEGER NOT NULL,
    duration_seconds        INTEGER NOT NULL,
    final_checkpoint_json   TEXT NOT NULL,
    generated_at            BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS completion_records_plan
ON completion_records(verification_plan_id);

CREATE TABLE IF NOT EXISTS review_findings (
    id                      TEXT PRIMARY KEY,
    task_id                 TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    delegation_id           TEXT,
    verification_plan_id    TEXT,
    title                   TEXT NOT NULL,
    body                    TEXT NOT NULL,
    severity                TEXT NOT NULL,
    lifecycle               TEXT NOT NULL,
    affected_paths_json     TEXT NOT NULL,
    evidence_json           TEXT NOT NULL,
    created_at              BIGINT NOT NULL,
    updated_at              BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS review_findings_task_lifecycle
ON review_findings(task_id, lifecycle);

CREATE TABLE IF NOT EXISTS worktree_leases (
    id                      TEXT PRIMARY KEY,
    task_id                 TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    agent_id                TEXT,
    delegation_id           TEXT,
    path                    TEXT NOT NULL,
    base_revision           TEXT NOT NULL,
    head_revision           TEXT NOT NULL,
    owned_path_prefixes_json TEXT NOT NULL,
    status                  TEXT NOT NULL,
    created_at              BIGINT NOT NULL,
    updated_at              BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS worktree_leases_task_status
ON worktree_leases(task_id, status);
