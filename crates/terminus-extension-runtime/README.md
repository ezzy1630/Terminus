# terminus-extension-runtime

WASI extension host (stub) for the Terminus kernel.

`WasiExtensionHost` reports whether a WASI runtime is available, validates
`ExtensionManifest`s structurally, and (when a runtime is linked) executes
extensions. In this build the host reports "WASI runtime not available in
this build" and `execute` fails closed. Manifest validation is real and runs
in every build so malformed manifests are rejected before reaching the host.
See SPEC.md Section 35.
