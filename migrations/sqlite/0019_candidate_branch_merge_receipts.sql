-- Retain the trusted external merge outcome that resolves an ADMITTING branch.
-- The control plane never accepts this field from a public caller; it is
-- populated only after an adopted adapter verifies the immutable receipt.

ALTER TABLE candidate_branches
ADD COLUMN merge_receipt_json TEXT;
