-- The provider's terminal reason for one attempt.
--
-- `settleResponse` has always carried `finishReason`, but it was only ever
-- published onto the semantic event log; the attempt row did not keep it. Any
-- reader that wanted to know why a turn stopped therefore had to replay
-- `turn.response_validating` events and re-derive it — a second copy of the
-- rule, in another language, that loses every attempt whose event was pruned.
--
-- Values are the provider-neutral projection: stop | tool_use | length |
-- error | cancelled | refusal. Null means the attempt never settled.

ALTER TABLE provider_attempts
ADD COLUMN finish_reason TEXT;
