-- Durable reasoning replay.
--
-- Both vendors now require the client to hand a reasoning chain back verbatim
-- when a turn continues through a tool call: OpenAI Responses runs with
-- `store: false`, so the encrypted reasoning item requested through `include`
-- must be replayed immediately before the function call it produced, and
-- Anthropic rejects an assistant turn whose `tool_use` block is not preceded
-- by the signed `thinking` block that produced it.
--
-- That map lived only in the renderer, which is built once per turn and lost
-- on restart — while the tool calls of that same turn stay in `episodes` and
-- get rendered again. Replaying them without their reasoning is an
-- ordering/signature 400, not a downgrade.
--
-- It is stored on the attempt rather than on an episode because the assistant
-- (`model_message`) episode is only written when the response carried text: a
-- response that emitted nothing but tool calls — exactly the case where the
-- replay is mandatory — creates no episode to hang it on. One attempt row is
-- one provider response, which is precisely the scope of the map.
--
-- The payload is provider-opaque: `[{"call_id": ..., "items": [{"id": ...,
-- "encrypted_content": ..., "summary": [...]}]}]`. Nothing reads inside it.

ALTER TABLE provider_attempts
ADD COLUMN reasoning_replay_json TEXT;
