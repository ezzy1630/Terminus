-- Provider-attempt identity and response metadata.
-- Existing rows stay nullable for honest legacy provenance. New control-plane
-- attempts require the fingerprint and kernel idempotency key at the writer.

ALTER TABLE provider_attempts
ADD COLUMN request_fingerprint TEXT
CHECK (request_fingerprint IS NULL OR length(trim(request_fingerprint)) BETWEEN 1 AND 255);

ALTER TABLE provider_attempts
ADD COLUMN provider_idempotency_key TEXT
CHECK (provider_idempotency_key IS NULL OR length(trim(provider_idempotency_key)) BETWEEN 1 AND 255);

ALTER TABLE provider_attempts
ADD COLUMN provider_request_id TEXT
CHECK (provider_request_id IS NULL OR length(trim(provider_request_id)) BETWEEN 1 AND 255);

ALTER TABLE provider_attempts
ADD COLUMN continuation_id TEXT
CHECK (continuation_id IS NULL OR length(trim(continuation_id)) BETWEEN 1 AND 255);

CREATE UNIQUE INDEX provider_attempts_provider_idempotency_key
ON provider_attempts(provider_idempotency_key)
WHERE provider_idempotency_key IS NOT NULL;

CREATE INDEX provider_attempts_request_fingerprint
ON provider_attempts(request_fingerprint)
WHERE request_fingerprint IS NOT NULL;
