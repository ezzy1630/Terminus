# Claude Code Adapter

The Claude Code adapter profile describes Anthropic's Claude Code
harness as an external worker (SPEC §12.4, §35.11). Forge delegates a
scoped task contract to Claude Code; Forge independently inspects the
final workspace and runs verification — Claude Code's self-report is
not sufficient evidence.

## Capability profile summary

Claude Code has strong typed tool events, complete artifact export,
and native compaction. Its session resume is emulated (Forge
checkpoints and re-creates the session), its cancellation is
best-effort, and its filesystem/network/secret enforcement is weaker
than Forge's. Forge supplies outer sandbox, brokered network, and
brokered secrets.

## When to use

Claude Code is selected for tasks where its implementer strength
outweighs the cost of supplying outer controls. Automation and
licensing constraints may apply (SPEC §41.2); the adapter is disabled
when those constraints are not met.
