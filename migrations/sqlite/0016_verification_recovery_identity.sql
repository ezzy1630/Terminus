-- Persist the complete immutable verification identity needed to resume a
-- verifier after a control-plane restart without replaying the provider.

ALTER TABLE verification_plans
ADD COLUMN environment_digest TEXT;

ALTER TABLE verification_results
ADD COLUMN command_or_query TEXT;

ALTER TABLE verification_results
ADD COLUMN exit_code INTEGER;

ALTER TABLE verification_results
ADD COLUMN structured_observations_json TEXT;

ALTER TABLE verification_results
ADD COLUMN artifacts_json TEXT;

ALTER TABLE verification_results
ADD COLUMN verifier_version TEXT;
