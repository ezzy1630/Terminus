-- Durable provider-account credential authorization.
--
-- Discovery describes a candidate. It does not authorize the discovered
-- credential or a future catalog destination. These columns keep the observed
-- tuple separate from the exact credential and destination the user approved,
-- and make keyring import/revocation recoverable across crashes.

ALTER TABLE provider_accounts ADD COLUMN catalog_digest TEXT NOT NULL DEFAULT '';
ALTER TABLE provider_accounts ADD COLUMN credential_fingerprint TEXT NOT NULL DEFAULT ''
  CHECK (length(credential_fingerprint) IN (0, 64));
ALTER TABLE provider_accounts ADD COLUMN approved_base_url TEXT NOT NULL DEFAULT '';
ALTER TABLE provider_accounts ADD COLUMN approved_catalog_digest TEXT NOT NULL DEFAULT ''
  CHECK (approved_catalog_digest = '' OR (
    length(approved_catalog_digest) = 71
    AND substr(approved_catalog_digest, 1, 7) = 'sha256:'
  ));
ALTER TABLE provider_accounts ADD COLUMN secret_state TEXT NOT NULL DEFAULT 'none'
  CHECK (secret_state IN ('none', 'import_pending', 'bound', 'revoke_pending'));
ALTER TABLE provider_accounts ADD COLUMN secret_operation_id TEXT NOT NULL DEFAULT '';
