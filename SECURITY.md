# Terminus security policy

## Trust zones (SPEC §27.2)

Terminus enforces a strict trust-zone model. Data may move from a lower-trust zone to a higher-trust decision only through validation and policy. Text originating in Z5 MUST NOT become authority merely because a model repeats it.

| Zone | Examples | Trust | Ambient authority |
|---|---|---|---|
| **Z0** | Kernel policy engine, secret broker, sandbox broker | Highest | Narrowly defined host capabilities |
| **Z1** | Control plane (`terminus-control`), signed first-party clients, Next.js dashboard | Trusted but non-privileged | No raw process/filesystem/network authority |
| **Z2** | Built-in tools (read/search/patch/exec/inspect/job/capability), code-intelligence workers, LSP/DAP/index | Constrained | Explicit kernel grants only |
| **Z3** | First-party plugins and external harness adapters | Partially trusted | Declared capabilities only |
| **Z4** | Third-party plugins, MCP servers, external harnesses (Codex/Claude Code/Pi/OpenHands) | Untrusted | Isolated capability grants only |
| **Z5** | Model output, repository text, web content, issues, logs, tool descriptions | Untrusted data | None |

## Non-bypassability invariant (SPEC §5.2, §26.3)

> **No model-facing process, TypeScript module, plugin, skill script, MCP server, or external agent can directly spawn a host process, mutate a file, access a secret, or open a network connection outside the Rust broker.**

Enforced structurally:

- The control plane receives a read-only or virtualized view.
- Direct Node/Bun subprocess and filesystem APIs are disallowed in production builds (architecture-boundary check).
- Plugins run in separate processes with declared capabilities.
- All workspace writes go through snapshot/edit transactions.
- All outbound sockets use a destination-aware proxy.
- Secrets are short-lived process capabilities, never environment-wide values.

`docs/security/non-bypassability-tests.md` defines the required bypass suite. The dedicated `tests/security/bypass/` fixtures are not all present, so the repository MUST NOT treat the full non-bypassability claim as proven. Any release making that claim must implement and pass every required fixture.

## Threat model (SPEC §36.2, Appendix I.1)

Terminus assumes the following may be malicious or compromised:

- Model output (Z5).
- Prompt injection in source, issues, documentation, web pages, logs, images, or tool descriptions.
- A malicious repository author.
- A compromised npm/PyPI/crate/MCP/skill package.
- A malicious plugin or external harness.
- An attacker with access to a remote Terminus endpoint.
- Another tenant in a shared execution environment.
- Accidental user approval or misconfiguration.
- A compromised provider or leaked provider response.

**Out of scope:** Terminus does not claim to defend a user from a fully compromised host administrator. This boundary is stated explicitly at startup when remote multi-tenant mode is enabled.

Threat/control mappings are normative in `docs/security/threat-model.md` and Appendix I.1.

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

No single layer substitutes for another. Approval does not disable sandboxing. Sandboxing does not imply the action is authorized.

## Effect classification (SPEC §27.3)

Every requested effect is classified into one of: `READ_LOCAL`, `WRITE_LOCAL`, `EXECUTE_LOCAL`, `NETWORK_READ`, `NETWORK_WRITE`, `EXTERNAL_STATE_READ`, `EXTERNAL_STATE_WRITE`, `SECRET_USE`, `PROCESS_CONTROL`, `SANDBOX_ADMIN`, `PLUGIN_ADMIN`, `CREDENTIAL_ADMIN`. Each effect records resource identity, scope, operation class, reversibility, idempotency class, trust/confidentiality labels, user-intent linkage, policy decision, approval decision, settlement state, and evidence artifact.

## Retired bootstrap trust exception (SPEC §27.5)

ADR-0039 removed the inherited OpenCode source and retired its exception. `docs/security/effect-bypass-register.yaml` now records no active entries. A direct effect path in first-party code is a release-blocking defect; the tombstone does not prove whole-system non-bypassability or historical parity.

## Reporting security issues

**Do not open public GitHub issues for security vulnerabilities.**

Email: `security@terminus.local` (replace with the project's security contact before public release).

Please include:

- Description of the issue and potential impact.
- Affected component (kernel, control, plugin host, MCP, public API, etc.).
- Reproduction steps or proof of concept.
- Affected versions/commits.
- Suggested fix if any.

We acknowledge within 5 business days and aim to ship a fix or mitigation within 90 days for high-severity issues. Coordinated disclosure is honored.

## Supported versions

| Version | Supported | Notes |
|---|---|---|
| `0.1.x` (development) | Security fixes only | Pre-release; not for production |
| `0.x` preview | Security fixes only | Opt-in experimental features allowed |
| `1.0.x` stable | Full support | Once released |

See `CHANGELOG.md` for the current release and `docs/plans/roadmap.md` for milestone status.

## Security testing tiers (SPEC §46.10)

- **Per-PR:** static policy tests, path traversal regressions, secret redaction fixtures, extension manifest validation, dependency/secret scans.
- **Nightly (dedicated Linux runner):** namespace/sandbox escape, network proxy bypass, process-tree escape, kernel fuzz corpus, malicious MCP/plugin suite.
- **Release:** full adversarial benchmark, external penetration-test findings resolved or accepted, signed artifact verification, clean-room install/upgrade/downgrade.

Run locally with `just security` for the per-PR subset. Nightly suites are in `tests/security/`.

## Supply chain (SPEC §36.17, §46.14)

- `cargo deny` license/advisory/ban/source checks (see `deny.toml`).
- `npm audit` / `bun audit` triage policy.
- Lockfile integrity; SBOM generation per release.
- Container image scanning for `evals/environments/*.lock`.
- Forbidden lifecycle-script checks (no `postinstall` from third-party packages in production builds).
- Pinned, checksum-verified code generators (SPEC §45.2).
- Descriptor hashes for MCP servers, skills, and plugins; reauthorization on change.
