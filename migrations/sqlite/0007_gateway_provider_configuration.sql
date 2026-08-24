-- OpenCode Zen/Go gateway selection. Credential bytes live in the OS
-- credential store and never enter this table.
CREATE TABLE IF NOT EXISTS gateway_provider_configurations (
  id TEXT PRIMARY KEY NOT NULL,
  deployment TEXT NOT NULL CHECK (deployment IN ('zen', 'go')),
  protocol TEXT NOT NULL CHECK (protocol IN ('chat_completions', 'responses', 'messages')),
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 255),
  secret_uri TEXT NOT NULL CHECK (secret_uri IN ('secret://opencode/zen', 'secret://opencode/go')),
  credential_configured INTEGER NOT NULL DEFAULT 0 CHECK (credential_configured IN (0, 1)),
  tools_enabled INTEGER NOT NULL DEFAULT 1 CHECK (tools_enabled IN (0, 1)),
  free_model INTEGER NOT NULL DEFAULT 0 CHECK (free_model IN (0, 1)),
  workspace_access INTEGER NOT NULL DEFAULT 0 CHECK (workspace_access IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (deployment = 'zen' AND secret_uri = 'secret://opencode/zen')
    OR (deployment = 'go' AND secret_uri = 'secret://opencode/go')
  )
) STRICT;
