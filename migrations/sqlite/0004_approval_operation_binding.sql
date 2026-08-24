-- Preserve the exact normalized operation that an approval hash authorizes.
-- Nullable only for migration compatibility: legacy rows remain fail-closed
-- for allow decisions because they have no verifiable binding.

ALTER TABLE approvals ADD COLUMN operation_json TEXT;
ALTER TABLE approvals ADD COLUMN decision TEXT;
