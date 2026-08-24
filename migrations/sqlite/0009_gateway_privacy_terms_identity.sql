-- A boolean admission is not enough to prove which provider terms were
-- reviewed. Rebuild the small local configuration table so the database also
-- enforces the cross-column invariant: workspace content is impossible
-- without both admission and a persisted terms identity. The application
-- additionally requires that identity to match the current deployment.
CREATE TABLE gateway_provider_configurations_v9 (
  id TEXT PRIMARY KEY NOT NULL,
  deployment TEXT NOT NULL CHECK (deployment IN ('zen', 'go')),
  protocol TEXT NOT NULL CHECK (protocol IN ('chat_completions', 'responses', 'messages')),
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 255),
  secret_uri TEXT NOT NULL CHECK (secret_uri IN ('secret://opencode/zen', 'secret://opencode/go')),
  credential_configured INTEGER NOT NULL DEFAULT 0 CHECK (credential_configured IN (0, 1)),
  tools_enabled INTEGER NOT NULL DEFAULT 1 CHECK (tools_enabled IN (0, 1)),
  free_model INTEGER NOT NULL DEFAULT 0 CHECK (free_model IN (0, 1)),
  workspace_access INTEGER NOT NULL DEFAULT 0 CHECK (workspace_access IN (0, 1)),
  privacy_terms_admitted INTEGER NOT NULL DEFAULT 0 CHECK (privacy_terms_admitted IN (0, 1)),
  privacy_terms_version TEXT CHECK (privacy_terms_version IS NULL OR length(privacy_terms_version) BETWEEN 1 AND 128),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (deployment = 'zen' AND secret_uri = 'secret://opencode/zen')
    OR (deployment = 'go' AND secret_uri = 'secret://opencode/go')
  ),
  CHECK (
    workspace_access = 0
    OR (privacy_terms_admitted = 1 AND privacy_terms_version IS NOT NULL)
  )
) STRICT;

INSERT INTO gateway_provider_configurations_v9 (
  id, deployment, protocol, model, secret_uri, credential_configured,
  tools_enabled, free_model, workspace_access, privacy_terms_admitted,
  privacy_terms_version, revision, updated_by, created_at, updated_at
)
SELECT
  id, deployment, protocol, model, secret_uri, credential_configured,
  tools_enabled, free_model,
  0,
  privacy_terms_admitted,
  NULL,
  revision + CASE WHEN workspace_access = 1 THEN 1 ELSE 0 END,
  CASE WHEN workspace_access = 1 THEN 'migration:0009_gateway_privacy_terms_identity' ELSE updated_by END,
  created_at,
  CASE WHEN workspace_access = 1 THEN CURRENT_TIMESTAMP ELSE updated_at END
FROM gateway_provider_configurations;

DROP TABLE gateway_provider_configurations;
ALTER TABLE gateway_provider_configurations_v9 RENAME TO gateway_provider_configurations;
