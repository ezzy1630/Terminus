-- Evidence may record a skipped verification.
--
-- `VerificationResultStatus` has always been pass | fail | error | skipped |
-- blocked, and a predicate with no runner in the workspace (a scratch repo
-- with no test command, say) settles as `skipped`. The evidence table's CHECK
-- never admitted that value, so `persistClaimEvidenceGraphToPrisma` failed
-- with a raw SQLite constraint error — after the model had finished the work
-- and written its answer — and the turn was reported as a non-retryable
-- PROVIDER_EXECUTION_FAILED. Every turn in a repository without a detected
-- test runner died this way.
--
-- SQLite cannot alter a CHECK in place, so the table is rebuilt with the same
-- columns (from 0003, untouched since) and the complete status vocabulary,
-- keeping 'waived' for human-accepted claims. Rows are carried across
-- verbatim. `evidence` is only ever a child table (claims ← evidence), so
-- dropping and renaming it violates no foreign key.

CREATE TABLE evidence_next (
    id                    TEXT PRIMARY KEY,
    claim_id              TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
    kind                  TEXT NOT NULL,
    summary               TEXT NOT NULL,
    source_revision       TEXT NOT NULL,
    environment_hash      TEXT,
    verifier_result       TEXT NOT NULL CHECK (verifier_result IN ('pass','fail','error','skipped','blocked','waived')),
    artifact_ref          TEXT,
    metadata_json         TEXT NOT NULL,
    observed_at           BIGINT NOT NULL
);

INSERT INTO evidence_next (
    id, claim_id, kind, summary, source_revision, environment_hash,
    verifier_result, artifact_ref, metadata_json, observed_at
)
SELECT
    id, claim_id, kind, summary, source_revision, environment_hash,
    verifier_result, artifact_ref, metadata_json, observed_at
FROM evidence;

DROP TABLE evidence;

ALTER TABLE evidence_next RENAME TO evidence;

CREATE INDEX IF NOT EXISTS evidence_claim ON evidence(claim_id);
