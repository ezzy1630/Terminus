# ADR-0048: Interactive question tool and decision protocol

- **Status:** ADOPTED
- **Date:** 2026-08-26
- **Decision owner:** agent UX owner
- **Supersedes:** none
- **Related:** SPEC §11, §34; ADR-0012; ADR-0043

## Context

Autonomous coding agents frequently encounter ambiguous user intent, mutually exclusive implementation choices, or breaking design alternatives that cannot be resolved safely by inspecting the codebase alone. In field-proven harnesses (such as OpenCode and Hermes), agents use an interactive `question` tool to solicit decisions or structured clarifications from the user.

Previously, Terminus supported question events in attention coordination, but lacked a formal ACI tool contract and schema for the model to invoke directly.

## Decision

1. Add `question` tool to `@terminus/aci`:
   - `questionInputSchema`: `{ question: string, options?: string[], multiple?: boolean, header?: string }`.
   - `questionResultSchema`: `{ question_id: string, status: "asked" | "answered" | "dismissed", answer?: string, selected_options?: string[] }`.
   - Tool definition with `sideEffectClass: "none"`, `trustLevel: "builtin"`, and policy tags `["interactive", "user_input"]`.
2. Add tool schema in `schemas/tools/question.json`.
3. Support question execution via `QuestionToolExecutor` and attention question endpoints (`/v2/questions` / `/v2/attention/questions`).

## Consequences

- The model has a first-class, structured mechanism to request clarification without hallucinating answers or performing unauthorized exploratory changes.
- Questions emit semantic events (`question.asked`, `question.answered`, `question.dismissed`) and appear in session rollouts.
