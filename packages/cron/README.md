# @terminus/cron

Deterministic, UTC-only schedule parsing and next-run evaluation for background jobs (ADR-0049).

## Features

- Standard 5-field cron parsing (`minute hour day-of-month month day-of-week`).
- Interval scheduling (`every 5m`, `every 2h`, `every 1d`).
- Daily fixed-time scheduling (`daily@14:30` in UTC).
- Catchup clamping: prevents burst execution storms after service downtime.
- Pure schedule evaluation functions (`computeNextRunAt`, `dueJobs`, `advanceJob`).
- Fail-closed Zod schemas for all schedule types.
