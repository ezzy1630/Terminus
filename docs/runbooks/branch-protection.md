# Runbook: branch protection and required checks

## Purpose

Protect the public repository's default branch with a small set of required
checks. CI still runs on the declared branch candidates (`main`, `dev`, and
`codex/release-blocker-closure`), but this runbook only applies a required rule
to `main` unless another branch becomes an active release target.

## Current state

Verified on 2026-08-23 for `ezzy1630/Terminus`:

- the repository is public;
- no ruleset exists;
- `main` has no branch-protection rule.

Re-check before changing the settings:

```bash
gh api repos/ezzy1630/Terminus/rulesets --jq '.[].name'
gh api repos/ezzy1630/Terminus/branches/main/protection --jq '.required_status_checks.contexts'
```

The second command returns HTTP 404 until branch protection is configured.

## Procedure

1. Open **Settings → Rules → Rulesets → New branch ruleset** for `main`.
2. Enable:
   - pull requests before merging;
   - required status checks;
   - branch must be up to date before merging;
   - block force pushes;
   - block branch deletion.
3. Make these checks required:
   - `Architecture boundary checks`
   - `Lint, typecheck, codegen drift`
   - `Platform (linux-x86_64)`
   - `Unit tests (Python eval)`
   - `Integration tests`
   - `Security scans`
   - `End-to-end public path`
   - `M12 release-gate evidence`
   - `Upstream OpenCode parity`
   - `Protobuf breaking-change check`
4. Do not require the informational platform entries, the container build, the
   conditional eval smoke job, or the nightly Linux enforcement probes.
5. Leave an emergency administrator bypass available and record any use of it.
   Do not require code-owner approval while `@ezzy1630` is the sole owner.

## Verification

Open a pull request against `main` and confirm that the required checks appear
in the merge box. Then verify the configured contexts:

```bash
gh api repos/ezzy1630/Terminus/branches/main/protection \
  --jq '.required_status_checks.contexts'
```

## Rollback

Remove the ruleset only for an intentional repository-maintenance window.
Restore it before merging normal feature changes.
