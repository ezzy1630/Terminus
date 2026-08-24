-- Durable control-plane-owned local provider configuration. This record is
-- deliberately credential-free; execution remains kernel-brokered.
CREATE TABLE IF NOT EXISTS provider_configurations (
  id TEXT PRIMARY KEY NOT NULL,
  program TEXT NOT NULL,
  args_json TEXT NOT NULL,
  model TEXT NOT NULL,
  timeout_seconds INTEGER NOT NULL,
  tools_enabled INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
