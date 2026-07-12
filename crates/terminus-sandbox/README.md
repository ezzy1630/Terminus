# terminus-sandbox

Sandbox backend trait and manager for the Terminus kernel.

`SandboxBackend` is a trait with one honest method — `enforcement_report()`
— that lists which features are enforced, degraded, and unsupported. The
default `LocalRestrictiveBackend` is honest about what it does and does not
provide: process groups, env sanitization, and a working-dir jail are
enforced; filesystem isolation, seccomp, and user/mount namespaces are
explicitly listed as unsupported. `SandboxManager` selects a backend per
profile and fails closed when no backend can satisfy a profile (SPEC.md
Section 13.3, 13.4).

Platform-specific backends live in `terminus-sandbox-linux`,
`terminus-sandbox-macos`, `terminus-sandbox-windows`, and
`terminus-sandbox-container`.
