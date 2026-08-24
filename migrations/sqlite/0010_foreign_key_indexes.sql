-- SQLite does not index foreign-key columns automatically, so every lookup
-- that joins or filters on an FK column previously required a full table
-- scan. The worst offender is the control plane's pending-approval poll,
-- which filters approvals by task_id on every request. Add covering indexes
-- for the FK columns with query traffic; purely additive, so both fresh and
-- upgraded databases converge to the same shape.

CREATE INDEX IF NOT EXISTS approvals_task_id
ON approvals(task_id);

CREATE INDEX IF NOT EXISTS side_effects_tool_call_id
ON side_effects(tool_call_id);

CREATE INDEX IF NOT EXISTS jobs_task_id
ON jobs(task_id);

CREATE INDEX IF NOT EXISTS capability_activations_session_id
ON capability_activations(session_id);

CREATE INDEX IF NOT EXISTS capability_activations_task_id
ON capability_activations(task_id);

CREATE INDEX IF NOT EXISTS tool_calls_provider_attempt_id
ON tool_calls(provider_attempt_id);
