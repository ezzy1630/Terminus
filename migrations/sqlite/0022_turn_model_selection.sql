-- Per-turn model selection (H7) and durable gateway model discovery (H4).
--
-- H7: a turn currently runs whatever the single `gateway_provider_configurations`
-- row names. A client that wants a different admitted model for one turn has to
-- rewrite global configuration, which races every other turn in the process.
-- The selection is therefore recorded on the turn itself, so `GET /v1/turns/:id`
-- and the transcript can report which model actually produced the response, and
-- a session carries the default a client picked so the desktop does not have to
-- re-send it on every message.
--
-- H4: model discovery lived only in process memory and was warmed exclusively by
-- `GET /v1/provider-models`. A restarted control plane therefore failed every
-- turn with "configured gateway model <id> has no admitted discovery record"
-- until something happened to call that route. The last successful discovery is
-- now durable, so a restart reuses it until it is refreshed.

ALTER TABLE turns ADD COLUMN selected_model TEXT;
ALTER TABLE turns ADD COLUMN selected_reasoning_effort TEXT;

ALTER TABLE sessions ADD COLUMN default_model TEXT;
ALTER TABLE sessions ADD COLUMN default_reasoning_effort TEXT;

-- One row per gateway deployment. `result_json` is the exact
-- `ProviderModelsResult` that discovery admitted, including the rejection list,
-- so a restart can explain why an expected model is missing without another
-- round trip. It never contains credential material: discovery returns model
-- identity and capability metadata only.
-- `updated_at` is a Prisma DateTime, stored as 64-bit epoch milliseconds. The
-- schema engine reads a bare INTEGER declaration as a 32-bit INT and rejects
-- every write with P2023 (see migrations 0018 and 0021), so the column is
-- declared BIGINT. SQLite STRICT tables do not admit BIGINT, so this table
-- keeps explicit CHECK constraints instead of STRICT, matching that precedent.
CREATE TABLE provider_model_discoveries (
    deployment    TEXT PRIMARY KEY NOT NULL CHECK (deployment IN ('zen', 'go')),
    result_json   TEXT NOT NULL CHECK (json_valid(result_json) = 1),
    model_count   INTEGER NOT NULL CHECK (model_count >= 0),
    observed_at   TEXT NOT NULL CHECK (length(trim(observed_at)) BETWEEN 1 AND 64),
    updated_at    BIGINT NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
);
