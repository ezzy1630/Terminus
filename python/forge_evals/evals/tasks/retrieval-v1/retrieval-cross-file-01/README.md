# retrieval-cross-file-01

Archetype: Cross-file task requiring references or dependencies.
The agent must update `src/client.py` and trace references across the codebase to update call sites in `src/api.py`, `src/cli.py`, and `src/scheduler.py`.
Hidden tests verify negative retry count validation, scheduler batch retry configurations, and integration across modules.
