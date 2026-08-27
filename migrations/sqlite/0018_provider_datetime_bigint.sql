-- Prisma's SQLite connector treats DateTime values as 64-bit integer epoch
-- milliseconds. Migration 0011 converted the provider tables away from TEXT,
-- but used INTEGER, which Prisma's schema engine exposes as a 32-bit INT. A
-- fresh provider configuration then fails when the current epoch is written.
-- Rebuild both provider tables with the BIGINT declaration used by the core
-- schema and preserve every existing timestamp value. SQLite STRICT tables do
-- not admit the BIGINT declaration, so these tables retain the explicit
-- column and CHECK constraints without STRICT, matching the core timestamp
-- tables.

CREATE TABLE provider_configurations_v18 (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) BETWEEN 1 AND 255),
  program TEXT NOT NULL CHECK (length(trim(program)) BETWEEN 1 AND 255),
  args_json TEXT NOT NULL CHECK (json_valid(args_json) = 1),
  model TEXT NOT NULL CHECK (length(trim(model)) BETWEEN 1 AND 255),
  timeout_seconds INTEGER NOT NULL CHECK (timeout_seconds BETWEEN 1 AND 3600),
  tools_enabled INTEGER NOT NULL DEFAULT 0 CHECK (tools_enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by TEXT NOT NULL CHECK (length(trim(updated_by)) BETWEEN 1 AND 255),
  created_at BIGINT NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  updated_at BIGINT NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
);

INSERT INTO provider_configurations_v18 (
  id, program, args_json, model, timeout_seconds, tools_enabled, revision,
  updated_by, created_at, updated_at
)
SELECT
  id, program, args_json, model, timeout_seconds, tools_enabled, revision,
  updated_by,
  CASE
    WHEN typeof(created_at) IN ('integer', 'real') THEN CAST(created_at AS INTEGER)
    WHEN trim(created_at) <> '' AND trim(created_at) NOT GLOB '*[^0-9]*' THEN CAST(trim(created_at) AS INTEGER)
    ELSE CAST(ROUND((julianday(trim(created_at)) - 2440587.5) * 86400000.0) AS INTEGER)
  END,
  CASE
    WHEN typeof(updated_at) IN ('integer', 'real') THEN CAST(updated_at AS INTEGER)
    WHEN trim(updated_at) <> '' AND trim(updated_at) NOT GLOB '*[^0-9]*' THEN CAST(trim(updated_at) AS INTEGER)
    ELSE CAST(ROUND((julianday(trim(updated_at)) - 2440587.5) * 86400000.0) AS INTEGER)
  END
FROM provider_configurations;

DROP TABLE provider_configurations;
ALTER TABLE provider_configurations_v18 RENAME TO provider_configurations;

CREATE TABLE gateway_provider_configurations_v18 (
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
  created_at BIGINT NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  updated_at BIGINT NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  CHECK (
    (deployment = 'zen' AND secret_uri = 'secret://opencode/zen')
    OR (deployment = 'go' AND secret_uri = 'secret://opencode/go')
  ),
  CHECK (
    workspace_access = 0
    OR (privacy_terms_admitted = 1 AND privacy_terms_version IS NOT NULL)
  )
);

INSERT INTO gateway_provider_configurations_v18 (
  id, deployment, protocol, model, secret_uri, credential_configured,
  tools_enabled, free_model, workspace_access, privacy_terms_admitted,
  privacy_terms_version, revision, updated_by, created_at, updated_at
)
SELECT
  id, deployment, protocol, model, secret_uri, credential_configured,
  tools_enabled, free_model, workspace_access, privacy_terms_admitted,
  privacy_terms_version, revision, updated_by,
  CASE
    WHEN typeof(created_at) IN ('integer', 'real') THEN CAST(created_at AS INTEGER)
    WHEN trim(created_at) <> '' AND trim(created_at) NOT GLOB '*[^0-9]*' THEN CAST(trim(created_at) AS INTEGER)
    ELSE CAST(ROUND((julianday(trim(created_at)) - 2440587.5) * 86400000.0) AS INTEGER)
  END,
  CASE
    WHEN typeof(updated_at) IN ('integer', 'real') THEN CAST(updated_at AS INTEGER)
    WHEN trim(updated_at) <> '' AND trim(updated_at) NOT GLOB '*[^0-9]*' THEN CAST(trim(updated_at) AS INTEGER)
    ELSE CAST(ROUND((julianday(trim(updated_at)) - 2440587.5) * 86400000.0) AS INTEGER)
  END
FROM gateway_provider_configurations;

DROP TABLE gateway_provider_configurations;
ALTER TABLE gateway_provider_configurations_v18 RENAME TO gateway_provider_configurations;
