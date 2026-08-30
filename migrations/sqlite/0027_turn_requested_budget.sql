-- Per-turn budgets, set by the caller.
--
-- `POST /v1/turns` parsed its body with a bare cast: a caller that sent a
-- budget got a 201 and no budget, because unknown keys were dropped in
-- silence. The only budget a turn could have was the fixed one the server
-- wrote into the task contract, so an evaluation harness could not bound a
-- single turn's steps, tokens, or spend — and could not tell that it had
-- failed to.
--
-- The column holds what the caller asked for, verbatim and already validated:
-- `{"max_steps": 40, "max_tokens": "250000", "max_cost_micros": "5000000"}`.
-- It is a request, not an entitlement — the loop takes the *lower* of it and
-- the task contract's budget, and the hard step ceiling (200) still binds.
-- Null means "no per-turn budget was requested".

ALTER TABLE turns
ADD COLUMN requested_budget_json TEXT;
