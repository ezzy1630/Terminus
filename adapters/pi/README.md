# Pi Adapter

The Pi adapter profile describes the Pi minimal terminal agent as an
external worker (SPEC §12.4, §35.11). Pi is a serious competitor on
simple tasks (SPEC §3.7) and a permanent baseline (SPEC §41.2).

## Capability profile summary

Pi has opaque context visibility, no tool interception, and no native
filesystem/network/secret enforcement. Forge wraps Pi in a strict
outer sandbox and supplies brokered network and secrets. Pi has no
native session resume (Forge emulates it via checkpointing) and no
native compaction.

## When to use

Pi is selected as a baseline for cohort comparisons and as a
"minimal harness" reference point in research experiments. It is
NOT selected for production tasks: its opaque context and missing
controls mean Forge must compensate for every effect.

## Research value

Pi's strength on simple tasks despite its minimalism is a key signal
in the harness-component research (SPEC §3.1). Comparing Pi to
Forge-full and Forge-minimal isolates the contribution of the
Context Compiler, the verification plan, and the orchestration layer.
