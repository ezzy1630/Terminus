-- Persist an explicit in-flight candidate-branch admission state.
--
-- A branch can cross an external merge boundary before the control process
-- records ADMITTED. ADMITTING prevents a restart from treating that branch as
-- OPEN and issuing a duplicate merge. Recovery moves it to MANUAL_REVIEW
-- unless a future adapter supplies a trusted merge receipt.

CREATE TABLE candidate_branches_recovery (
    id                    TEXT PRIMARY KEY,
    task_id               TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    attempt_id            TEXT NOT NULL,
    actor_principal       TEXT NOT NULL,
    worktree_path         TEXT NOT NULL,
    epoch                 INTEGER NOT NULL,
    base_revision         TEXT NOT NULL,
    head_revision         TEXT NOT NULL,
    scope_digest          TEXT NOT NULL,
    effect_ids_json       TEXT NOT NULL,
    proof_json            TEXT,
    status                TEXT NOT NULL CHECK (status IN ('OPEN','ADMITTING','ADMITTED','REJECTED','MANUAL_REVIEW')),
    created_at            BIGINT NOT NULL,
    updated_at            BIGINT NOT NULL
);

INSERT INTO candidate_branches_recovery (
    id, task_id, attempt_id, actor_principal, worktree_path, epoch,
    base_revision, head_revision, scope_digest, effect_ids_json, proof_json,
    status, created_at, updated_at
)
SELECT
    id, task_id, attempt_id, actor_principal, worktree_path, epoch,
    base_revision, head_revision, scope_digest, effect_ids_json, proof_json,
    status, created_at, updated_at
FROM candidate_branches;

DROP TABLE candidate_branches;
ALTER TABLE candidate_branches_recovery RENAME TO candidate_branches;

CREATE INDEX candidate_branches_task_status
ON candidate_branches(task_id, status);
