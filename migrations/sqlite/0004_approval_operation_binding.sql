-- Preserve the exact normalized operation that an approval hash authorizes.
-- Nullable only for migration compatibility: legacy rows remain fail-closed
-- for allow decisions because they have no verifiable binding.

ALTER TABLE approvals ADD COLUMN operation_json TEXT;
ALTER TABLE approvals ADD COLUMN decision TEXT;

-- Legacy allowed rows without the exact operation they authorize cannot be
-- replayed safely. Quarantine them as denied before enforcing the invariant.
UPDATE approvals
SET status = 'denied',
    decision = 'deny_once',
    resolved_at = COALESCE(resolved_at, CAST(strftime('%s', 'now') AS INTEGER)),
    rationale = CASE
      WHEN rationale IS NULL OR length(trim(rationale)) = 0
        THEN 'quarantined: legacy approval had no operation binding'
      ELSE rationale || ' [quarantined: missing operation binding]'
    END
WHERE (status = 'allowed' OR COALESCE(decision, '') LIKE 'allow%')
  AND (operation_json IS NULL OR length(trim(operation_json)) = 0 OR json_valid(operation_json) = 0 OR json_type(operation_json) <> 'object');

CREATE TRIGGER IF NOT EXISTS approvals_require_operation_binding_insert
BEFORE INSERT ON approvals
WHEN (NEW.status = 'allowed' OR COALESCE(NEW.decision, '') LIKE 'allow%')
  AND (NEW.operation_json IS NULL OR length(trim(NEW.operation_json)) = 0 OR json_valid(NEW.operation_json) = 0 OR json_type(NEW.operation_json) <> 'object')
BEGIN
  SELECT RAISE(ABORT, 'allowed approval requires a valid operation binding');
END;

CREATE TRIGGER IF NOT EXISTS approvals_require_operation_binding_update
BEFORE UPDATE OF status, decision, operation_json ON approvals
WHEN (NEW.status = 'allowed' OR COALESCE(NEW.decision, '') LIKE 'allow%')
  AND (NEW.operation_json IS NULL OR length(trim(NEW.operation_json)) = 0 OR json_valid(NEW.operation_json) = 0 OR json_type(NEW.operation_json) <> 'object')
BEGIN
  SELECT RAISE(ABORT, 'allowed approval requires a valid operation binding');
END;
