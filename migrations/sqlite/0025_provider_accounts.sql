-- Connected provider accounts.
--
-- Terminus routed every turn through a fixed chain: a vendor-direct
-- environment configuration, else the singleton `gateway_provider_configurations`
-- row, else a local NDJSON command. A machine that already holds several usable
-- credentials (a ChatGPT login held by the Codex CLI, an OpenCode auth store
-- with one entry per provider) could therefore reach exactly one of them, and
-- choosing a different model meant rewriting global configuration.
--
-- Each usable credential becomes one row here: what it is, where it lives
-- (an opaque kernel secret capability URI — never key bytes), which wire
-- protocol and connector reach it, and whether it is currently usable. A turn
-- names an account; a session may default to one; exactly one row may be the
-- installation default.
--
-- `discovered_at`, `last_verified_at`, `expires_at`, `created_at` and
-- `updated_at` are Prisma DateTime columns. The schema engine reads a bare
-- INTEGER declaration as a 32-bit INT and rejects every write with P2023 (see
-- migrations 0018, 0021 and 0022), so they are declared BIGINT. SQLite STRICT
-- tables do not admit BIGINT, so these tables carry explicit CHECK constraints
-- instead of STRICT, matching that precedent.

CREATE TABLE provider_accounts (
  id               TEXT PRIMARY KEY NOT NULL,           -- uuid v7
  source           TEXT NOT NULL UNIQUE,                -- 'opencode:<id>' | 'codex-chatgpt' | 'zen'
  display_name     TEXT NOT NULL,
  vendor_id        TEXT NOT NULL,                       -- models.dev provider id; 'openai' for codex; 'opencode' for zen
  auth_kind        TEXT NOT NULL CHECK (auth_kind IN ('api','oauth','wellknown','chatgpt','anonymous')),
  credential_uri   TEXT NOT NULL DEFAULT '',            -- '' = anonymous
  fingerprint      TEXT NOT NULL DEFAULT '',
  base_url         TEXT NOT NULL,
  host             TEXT NOT NULL,
  protocol         TEXT NOT NULL CHECK (protocol IN ('chat_completions','responses','messages')),
  connector_id     TEXT NOT NULL,
  render_profile   TEXT NOT NULL CHECK (render_profile IN ('openai_compatible','openai_responses','anthropic_messages','chatgpt_codex','zen_gateway')),
  status           TEXT NOT NULL CHECK (status IN ('connected','expired','error','unsupported','disconnected')),
  status_detail    TEXT NOT NULL DEFAULT '',
  billing          TEXT NOT NULL CHECK (billing IN ('subscription','free','paid','unknown')),
  metadata_json    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json) = 1),  -- never secrets
  is_default       INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  discovered_at    BIGINT NOT NULL,
  last_verified_at BIGINT,
  expires_at       BIGINT,
  revision         INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at       BIGINT NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  updated_at       BIGINT NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);

-- At most one installation default. A partial unique index states the
-- invariant in the schema rather than in whichever writer happens to run.
CREATE UNIQUE INDEX provider_accounts_default ON provider_accounts(is_default) WHERE is_default = 1;

-- Last successful per-account model discovery. `result_json` holds the exact
-- admitted list plus the rejection list, so a restart can explain a missing
-- model without another round trip. It never contains credential material:
-- discovery returns model identity and capability metadata only.
CREATE TABLE provider_account_model_discoveries (
  account_id   TEXT PRIMARY KEY NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
  result_json  TEXT NOT NULL CHECK (json_valid(result_json) = 1),
  model_count  INTEGER NOT NULL CHECK (model_count >= 0),
  observed_at  TEXT NOT NULL,
  updated_at   BIGINT NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);

-- Which account produced this turn, and which account a session routes to by
-- default. Null keeps the legacy chain, so existing rows keep working.
ALTER TABLE turns    ADD COLUMN selected_provider_account_id TEXT;
ALTER TABLE sessions ADD COLUMN default_provider_account_id  TEXT;
