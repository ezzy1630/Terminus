# OpenHands Adapter

The OpenHands adapter profile describes the OpenHands open-source
coding agent as an external worker (SPEC §12.4, §35.11). OpenHands is
a permanent baseline (SPEC §41.2).

## Capability profile summary

OpenHands has partial context visibility, partial tool interception,
native typed results, complete artifact export, reliable cancellation,
and native compaction. Its filesystem/network/secret enforcement is
weaker than Terminus's; Terminus supplies outer controls.

## When to use

OpenHands is selected as a baseline for cohort comparisons and as a
reference point for open-source-harness research. Its complete
artifact export makes it a strong comparison point for Terminus's own
artifact pipeline.

## Open-source parity

OpenHands is open-source; its source code is auditable. The adapter
profile is therefore more trustworthy than proprietary-harness
profiles, but the same outer-control requirements apply: Terminus never
trusts an external harness to enforce filesystem, network, or secret
controls.
