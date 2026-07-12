# Oh My Pi Adapter

The Oh My Pi adapter profile describes an enhanced variant of the Pi
terminal agent as an external worker (SPEC §12.4, §35.11). It is a
permanent baseline (SPEC §41.2) for comparison against Pi.

## Capability profile summary

Oh My Pi improves on Pi with partial tool interception, emulated
session resume, and native compaction. Its context visibility remains
opaque and its filesystem/network/secret enforcement is still weaker
than Terminus's. Terminus supplies outer sandbox, brokered network, and
brokered secrets.

## When to use

Oh My Pi is selected as a baseline for cohort comparisons. The
comparison between Pi and Oh My Pi isolates the contribution of
context management and partial tool interception to a minimal
harness.

## Research value

The Pi vs Oh My Pi comparison is one of the "minimal harness"
experiments in SPEC §3.7. Oh My Pi's native compaction is a key
differentiator: it lets the harness survive longer tasks without
Terminus's outer checkpointing, which is a useful signal in long-horizon
evaluations.
