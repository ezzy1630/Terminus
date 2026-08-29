-- Sessions carry a real permission level.
--
-- `default_permission_profile` was written as 'secure-local-default' on every
-- session and read by nothing: the agent was authorized for any call the task
-- contract admitted, which is full access. The value now selects one of three
-- levels — full-access | auto | ask — enforced at tool settlement, and the
-- legacy id is rewritten to the level it always behaved as.

UPDATE sessions
SET default_permission_profile = 'full-access'
WHERE default_permission_profile = 'secure-local-default';
