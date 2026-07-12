# Trust boundaries and non-bypassability

This document covers the trust-zone model (SPEC §27.2), the non-bypassability invariant (SPEC §5.2, §26.3), the effect taxonomy (§27.3), and the bypass register (§27.5). For the full threat/control matrix, see `docs/security/threat-model.md`.

## The non-bypassability invariant (SPEC §5.2, §26.3 #1)

> **No model-facing process, TypeScript module, plugin, skill script, MCP server, or external agent can directly spawn a host process, mutate a file, access a secret, or open a network connection outside the Rust broker.**

This is the most important architectural invariant. It is enforced structurally:

- The control plane receives a read-only or virtualized view.
- Direct Node/Bun subprocess and filesystem APIs are disallowed in production builds (architecture-boundary check, SPEC §42.5).
- Plugins run in separate processes with declared capabilities (ADR-0019).
- All workspace writes go through snapshot/edit transactions (ADR-0013).
- All outbound sockets use a destination-aware proxy (ADR-0015).
- Secrets are short-lived process capabilities, never environment-wide values (ADR-0016).

## Trust zones (SPEC §27.2)

| Zone | Examples | Trust | Ambient authority |
|---|---|---|---|
| **Z0** | Kernel policy engine, secret broker, sandbox broker | Highest | Narrowly defined host capabilities |
| **Z1** | Control plane (`forge-control`), signed first-party clients, Next.js dashboard | Trusted but non-privileged | No raw process/filesystem/network authority |
| **Z2** | Built-in tools (read/search/patch/exec/inspect/job/capability), code-intelligence workers, LSP/DAP/index | Constrained | Explicit kernel grants only |
| **Z3** | First-party plugins and external harness adapters | Partially trusted | Declared capabilities only |
| **Z4** | Third-party plugins, MCP servers, external harnesses (Codex/Claude Code/Pi/OpenHands) | Untrusted | Isolated capability grants only |
| **Z5** | Model output, repository text, web content, issues, logs, tool descriptions | Untrusted data | None |

**Data flow rule:** Data may move from a lower-trust zone to a higher-trust decision only through validation and policy. Text originating in Z5 MUST NOT become authority merely because a model repeats it (SPEC §26.3 #8, §36.15).

## Process topology (SPEC §27.1)

```
forge client(s)                                [Z1, presentation only]
    │ HTTPS/UDS HTTP + SSE
    ▼
forge-control (TypeScript, Z1)                 [trusted, non-privileged]
    │ gRPC over Unix domain socket
    ▼
forge-kernel (Rust, Z0)                        [privileged, non-bypassable]
    ├── sandboxed command/job processes        [Z2, kernel grants]
    ├── LSP/DAP/index workers                  [Z2, kernel grants]
    ├── plugin/WASI workers                    [Z3/Z4, declared capabilities]
    ├── MCP server processes                   [Z4, isolated grants]
    └── external harness adapter processes     [Z4, isolated grants]

forge-eval (Python)                            [offline, reads exports only]
```

## Effect taxonomy (SPEC §27.3)

Every requested effect is classified into one of:

```
READ_LOCAL
WRITE_LOCAL
EXECUTE_LOCAL
NETWORK_READ
NETWORK_WRITE
EXTERNAL_STATE_READ
EXTERNAL_STATE_WRITE
SECRET_USE
PROCESS_CONTROL
SANDBOX_ADMIN
PLUGIN_ADMIN
CREDENTIAL_ADMIN
```

Each effect also records: resource identity, requested scope, operation class, reversibility, idempotency class, data trust/confidentiality labels, user-intent linkage, policy decision, approval decision, settlement state, and evidence artifact.

## Security control layers (SPEC §36.3)

```
user intent and task contract
        ↓
semantic effect classification
        ↓
policy decision
        ↓
human approval where required
        ↓
kernel capability authorization
        ↓
OS sandbox and resource limits
        ↓
secret/network brokers
        ↓
audit, evidence, and reconciliation
```

**No single layer substitutes for another.** Approval does not disable sandboxing. Sandboxing does not imply the action is authorized.

## Non-bypassability tests (SPEC §27.4)

The build includes tests that deliberately attempt to bypass the kernel from:

- ordinary TypeScript code;
- an OpenCode-derived plugin hook;
- a local project plugin;
- an npm plugin;
- an MCP server;
- an external harness adapter;
- a model-generated script;
- an LSP or formatter process;
- a child process that forks or daemonizes;
- a symlink or path traversal;
- a direct socket connection;
- environment-variable secret access.

A supported configuration passes only when each attempt is denied or routed through an audited kernel capability. These tests are required before any release may call the effect boundary non-bypassable. See `docs/security/non-bypassability-tests.md` for the test plan.

## Bootstrap trust exception (SPEC §27.5)

During the first migration stage, inherited OpenCode code may still contain direct effect paths. Those paths are inventoried in `docs/security/effect-bypass-register.yaml` with: `id`, `owner`, `source`, `effect`, `reason`, `containment`, `removal_milestone`, `test`, `status`.

The release gate is not "zero entries immediately"; it is "**no unknown entries, every entry contained, and all entries removed before the secure-default milestone (M4)**."

## Architecture-boundary checks (SPEC §42.5)

The build mechanically checks for:

- forbidden TypeScript imports;
- Cargo dependency cycles and forbidden crate edges;
- direct Node/Bun process, filesystem, socket, or environment access outside approved bridge modules;
- direct provider SDK use outside provider packages;
- raw SQL outside storage repositories/migrations;
- model-visible strings outside versioned prompt/tool-description locations;
- untyped event emission;
- direct secret environment reads;
- checked-in generated-file drift.

These checks run in CI alongside the non-bypassability tests.

## Related documents

- `docs/security/threat-model.md` — threat actors and threat/control matrix.
- `docs/security/effect-bypass-register.yaml` — bootstrap bypass inventory.
- `docs/security/non-bypassability-tests.md` — the test plan.
- `docs/runbooks/security-incident.md` — incident response.
- `docs/runbooks/sandbox-unavailable.md` — degraded-mode handling.
- `SECURITY.md` — security policy and reporting.
