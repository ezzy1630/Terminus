-- Crash-safe checkpoint publication across the Prisma and kernel artifact
-- stores. PREPARED rows are durable reconciliation intents and are never
-- exposed as live checkpoints. Existing rows were already published and
-- therefore migrate to COMMITTED.

ALTER TABLE checkpoints
ADD COLUMN admission_state TEXT NOT NULL DEFAULT 'PREPARED'
CHECK (admission_state IN ('PREPARED', 'COMMITTED', 'QUARANTINED'));

-- Rows from earlier versions were already visible before admission state
-- existed. Preserve that legacy fact while every new omitted value now fails
-- safe as PREPARED.
UPDATE checkpoints SET admission_state = 'COMMITTED';

-- Preserve the exact canonical contract when a Task is addressed through both
-- ARP projections. NULL means the version originated in v1 and must be mapped
-- conservatively.
ALTER TABLE task_contract_versions
ADD COLUMN v2_projection_json TEXT;

CREATE INDEX IF NOT EXISTS checkpoints_admission_created
ON checkpoints(admission_state, created_at);
