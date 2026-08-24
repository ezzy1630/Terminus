-- Durable control-plane-owned local provider configuration. This record is
-- deliberately credential-free; execution remains kernel-brokered.
CREATE TABLE IF NOT EXISTS provider_configurations (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) BETWEEN 1 AND 255),
  program TEXT NOT NULL CHECK (length(trim(program)) BETWEEN 1 AND 255),
  args_json TEXT NOT NULL CHECK (json_valid(args_json) = 1),
  model TEXT NOT NULL CHECK (length(trim(model)) BETWEEN 1 AND 255),
  timeout_seconds INTEGER NOT NULL CHECK (timeout_seconds BETWEEN 1 AND 3600),
  tools_enabled INTEGER NOT NULL DEFAULT 0 CHECK (tools_enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by TEXT NOT NULL CHECK (length(trim(updated_by)) BETWEEN 1 AND 255),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
