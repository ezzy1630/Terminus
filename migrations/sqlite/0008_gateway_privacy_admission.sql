-- Workspace content may cross a gateway only after the operator records that
-- the provider's current privacy/retention terms were admitted.
ALTER TABLE gateway_provider_configurations
  ADD COLUMN privacy_terms_admitted INTEGER NOT NULL DEFAULT 0
  CHECK (privacy_terms_admitted IN (0, 1));

-- Existing workspace-enabled rows predate the admission bit. Disable that
-- capability until an operator explicitly re-saves the configuration.
UPDATE gateway_provider_configurations
SET workspace_access = 0,
    revision = revision + 1,
    updated_at = CURRENT_TIMESTAMP,
    updated_by = 'migration:0008_gateway_privacy_admission'
WHERE workspace_access = 1 AND privacy_terms_admitted = 0;
