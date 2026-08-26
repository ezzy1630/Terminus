# ADR-0049: Cron scheduler and deterministic background jobs

- **Status:** ADOPTED
- **Date:** 2026-08-26
- **Decision owner:** scheduler / control plane owner
- **Supersedes:** none
- **Related:** SPEC §29, §32; ADR-0033; ADR-0034

## Context

Agents and systems frequently need scheduled background operations, including recurring workspace audits, cache warmups, repository syncs, and periodic verification checks. Autonomous frameworks such as Hermes implement lightweight cron scheduling with interval and cron grammars.

Previously, Terminus lacked a unified schedule grammar and evaluation engine.

## Decision

1. Adopt `@terminus/cron` as the canonical scheduling engine:
   - Supports 5-field standard cron expressions (`minute hour dom month dow`).
   - Supports interval schedules (`everyMs`).
   - Supports daily fixed-time schedules (`daily@HH:MM` UTC).
   - Timezone-free UTC-only semantics.
   - Catchup protection to avoid thundering herds when the scheduler wakes after sleep or downtime.
2. Control plane exposes `/v1/cron` endpoints for scheduled job management and dispatching tasks on due triggers.

## Consequences

- Recurring jobs have a deterministic, auditable next-run schedule.
- All scheduled executions emit semantic events (`cron.job_due`, `cron.job_completed`).
