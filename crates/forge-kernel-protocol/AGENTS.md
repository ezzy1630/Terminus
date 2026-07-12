# AGENTS.md — forge-kernel-protocol

## Local rules

- **No I/O.** This crate MUST stay pure: no filesystem, no network, no time,
  no randomness except via the `uuid` crate for ID generation helpers.
- **Wire compatibility.** Every `#[derive(Serialize, Deserialize)]` here is
  part of the cross-process contract. Renames require a migration entry.
  Tagged enums use `#[serde(tag = "kind", rename_all = "snake_case")]` so
  JSON remains stable and human-readable.
- **Error codes are public.** `ErrorCode` variants are part of the public API.
  Never reuse a variant name; deprecate and add a new one instead.
- **No panics.** No `unwrap`/`expect`/`panic!`. No `unsafe`.
- **Versioning.** `RequestContext` and `EffectIntent` MUST gain fields
  additively; existing fields keep their semantics.
