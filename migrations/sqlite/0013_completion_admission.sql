-- Durable completion-record admission intent.
-- A PREPARED record contains the immutable completion data but does not claim
-- task completion until its candidate branch and verified turn are admitted in
-- the same transaction as the task transition.

ALTER TABLE completion_records
ADD COLUMN admission_state TEXT NOT NULL DEFAULT 'COMMITTED'
CHECK (admission_state IN ('PREPARED', 'COMMITTED', 'QUARANTINED'));

ALTER TABLE completion_records
ADD COLUMN candidate_branch_id TEXT;

CREATE UNIQUE INDEX completion_records_candidate_branch
ON completion_records(candidate_branch_id)
WHERE candidate_branch_id IS NOT NULL;

CREATE INDEX completion_records_admission_state
ON completion_records(admission_state, generated_at);
