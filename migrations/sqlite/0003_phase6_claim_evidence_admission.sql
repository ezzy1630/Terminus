-- Phase 6: immutable claim/evidence graph and durable candidate admission.

CREATE TABLE IF NOT EXISTS claims (
    id                    TEXT PRIMARY KEY,
    task_id               TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    statement             TEXT NOT NULL,
    required_evidence_kind TEXT NOT NULL,
    status                TEXT NOT NULL CHECK (status IN ('PROPOSED','SATISFIED','WAIVED','DISPUTED')),
    evidence_ids_json     TEXT NOT NULL,
    waived_rationale      TEXT,
    created_at            BIGINT NOT NULL,
    updated_at            BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS claims_task_status ON claims(task_id, status);

CREATE TABLE IF NOT EXISTS evidence (
    id                    TEXT PRIMARY KEY,
    claim_id              TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
    kind                  TEXT NOT NULL,
    summary               TEXT NOT NULL,
    source_revision       TEXT NOT NULL,
    environment_hash      TEXT,
    verifier_result       TEXT NOT NULL CHECK (verifier_result IN ('pass','fail','error','blocked','waived')),
    artifact_ref          TEXT,
    metadata_json         TEXT NOT NULL,
    observed_at           BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS evidence_claim ON evidence(claim_id);

CREATE TABLE IF NOT EXISTS candidate_branches (
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
    status                TEXT NOT NULL CHECK (status IN ('OPEN','ADMITTED','REJECTED')),
    created_at            BIGINT NOT NULL,
    updated_at            BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS candidate_branches_task_status
ON candidate_branches(task_id, status);
