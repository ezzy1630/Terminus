# AGENTS.md — terminus-git

## Local rules

- **No ambient config.** Every git command MUST set
  `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_TEMPLATE_DIR=`
  (empty), and `core.hooksPath=/dev/null`.
- **No credential prompts.** `GIT_TERMINAL_PROMPT=0` is mandatory.
- **Through ProcessManager.** Never spawn git directly. Every invocation
  goes through `forge_process::ProcessManager` so policy and audit apply.
- **No `unsafe`.** No panics.
- **Protected paths.** `forge_fs::SafePath` is used for any path the model
  influences; `.git` writes are gated by policy.
