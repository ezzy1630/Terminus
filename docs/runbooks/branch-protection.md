# Runbook: Branch protection and required checks

## Purpose

Roadmap Phase 0 ("protect the actual default branch"). CI now triggers on
every protected-branch candidate (`main`, `dev`,
`codex/release-blocker-closure`), and `scripts/check-declaration-consistency.ts`
fails when `.github/workflows/ci.yml` stops covering the repository's actual
default branch. The remaining half of the control — GitHub-side branch
protection — must be applied by an administrator in repo settings.

## Why this runbook exists

As of 2026-08-22 the repository is private on the free plan; the branch
protection API returns:

```
{"message":"Upgrade to GitHub Pro or make this repository public to enable this feature."} (HTTP 403)
```

Automation therefore cannot complete the control. An owner applies it manually.

## Procedure (repo owner, ~5 minutes)

1. Open **Settings → Branches → Add branch ruleset** (or *Branch protection
   rule*) for `main`, and repeat for `codex/release-blocker-closure` while it
   remains active.
2. Enable:
   - **Require a pull request before merging** — at minimum when the pusher
     is not the sole owner; if working alone, keep direct pushes but enable
     everything below.
   - **Require status checks to pass before merging**, with these checks from
     `.github/workflows/ci.yml` as *required*:
     - `Setup`
     - `Architecture boundary checks`
     - `Lint, typecheck, codegen drift`
     - `Build (linux-x86_64)`
     - `Unit tests (Rust, linux-x86_64)`
     - `Unit tests (TypeScript, linux-x86_64)`
     - `Integration tests`
     - `Security scans`
     - `Linux enforcement prerequisites`
     - `Linux adversarial sandbox enforcement`
     - `M12 release-gate evidence`
     - `Upstream OpenCode parity`
     - `Protobuf breaking-change check`
   - **Require branches to be up to date before merging.**
   - **Do not allow bypassing the above settings** (including administrators).
3. Verify by opening a PR against `main` and confirming the required checks
   are listed under the merge box.

## Verification

```bash
gh api repos/<owner>/<repo>/branches/main/protection --jq '.required_status_checks.contexts'
```

must list the contexts above (this command is also how you re-check after
GitHub plan changes).

## Rollback

Removing the ruleset restores pre-freeze behavior; do not do this while
ADR-0032 (Phase 0 architecture freeze) is ADOPTED without release-owner +
security-owner sign-off.
