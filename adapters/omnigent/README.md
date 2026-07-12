# Omnigent Adapter

The Omnigent adapter profile describes a multi-model orchestrator as
an external worker (SPEC §12.4, §35.11). Omnigent delegates subtasks
to several inner agents; Terminus treats the inner orchestration as a
black box.

## Capability profile summary

Omnigent has opaque context visibility, partial tool interception,
emulated session resume, parsed typed results, and native compaction.
Its filesystem/network/secret enforcement is weaker than Terminus's; Terminus
supplies outer controls.

## When to use

Omnigent is selected for parallelizable, multi-language tasks where
multi-model orchestration is expected to help. It is NOT selected for
security-sensitive tasks: the opaque multi-model routing means Terminus
cannot attribute outcomes to a specific inner model, which complicates
audit.

## Attribution gap

Because Omnigent's multi-model routing is opaque, the eval lab records
each Omnigent run with `attribution: opaque_inner_routing`. This is a
known limitation; the promotion gate treats Omnigent results as
product-comparison evidence, not as harness-controlled evidence.
