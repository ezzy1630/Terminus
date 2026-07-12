# AGENTS.md — terminus-policy

## Local rules

- **Strictest rule wins.** When multiple rules match a command, the engine
  MUST combine decisions with `Decision::combine`. `Deny > Prompt >
  AllowWithConstraints > Allow`.
- **Default deny.** If no rule matches, the engine MUST return `Deny`. There
  is no implicit allow.
- **Pure engine.** `PolicyEngine::evaluate` MUST NOT perform I/O or call out
  to other crates that perform effects. Loading YAML is the only I/O the
  engine performs, and only at construction time.
- **Rule identifiers are public.** Rule `id`s appear in audit logs and
  capability tokens; never reuse an id.
- **No `unsafe`, no panics.**
- **Effect taxonomy is fixed.** `EffectType` matches SPEC.md Section 27.3
  exactly. Add new effects only via SPEC amendment.
