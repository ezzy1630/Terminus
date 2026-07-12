# ADR-0015: Proxy-only default network egress

- **Status:** ADOPTED
- **Date:** 2025-07-11
- **Decision owner:** security runtime
- **Supersedes:** none
- **Related:** SPEC §13.6, §36.12

## Context

If sandboxed processes can open direct sockets, they can exfiltrate secrets, contact disallowed destinations, bypass DNS-based allowlists, and hit private addresses (SSRF). The default policy must fail closed: no direct sockets, all egress through a destination-aware proxy.

OpenCode's upstream does not enforce this. Codex's Linux sandbox does (network namespace with no interfaces). The MCP spec explicitly says tool descriptions should be treated as untrusted and that protocol-level enforcement is insufficient (SPEC §3.6).

## Decision

Adopt **proxy-only default network egress** per SPEC §13.6 and §36.12:

1. **No direct sockets** — sandboxed processes have no network namespace interfaces (Linux) or equivalent denial on macOS/Windows. `network.direct_sockets: deny` in the default policy (SPEC §36.4).
2. **Proxy required** — all egress goes through the Terminus egress proxy (`crates/terminus-egress`). `network.proxy_required: true`.
3. **Destination allowlist** — `network.destinations: []` by default (deny all). Capability-scoped allowlists grant specific destinations (e.g., `github.com`, `pypi.org`) per ADR-0016.
4. **Brokered DNS** — `network.dns: brokered`. DNS resolution happens in the proxy, not in the sandbox, preventing DNS rebinding and private-address SSRF.
5. **Private-address denial** — the proxy denies RFC 1918, loopback, link-local, and other private ranges unless an explicit capability grants them.
6. **Rate limits** — per-destination rate limits prevent abuse.
7. **Fail-closed** — if the proxy is unavailable, egress fails closed (no fallthrough to direct sockets).

Implementation: `crates/terminus-egress` (proxy, policy, destination allowlist). The default network policy is `policies/network/default.yaml`.

## Alternatives

- **Direct sockets with firewall rules.** Rejected: host firewall is outside Terminus's control; cannot enforce per-task allowlists; harder to audit.
- **Allow direct sockets by default.** Rejected (SPEC §49.6): violates non-bypassability; enables exfiltration.
- **Proxy with DNS in sandbox.** Rejected: DNS rebinding; private-address SSRF.
- **No network at all by default.** Rejected: too restrictive for legitimate research/web-fetch capabilities; the proxy model allows scoped grants.

## Consequences

- Every outbound connection goes through the proxy, which logs destination, capability, task, and bytes.
- Network capabilities are explicit (`capability-packs/web-browser`, etc.); without one, egress is denied.
- DNS happens in the proxy; sandbox processes see only the proxy's IP.
- Rate limits prevent runaway egress.
- The proxy is a single point of failure for egress; it fails closed.

## Security Impact

Critical. This is what prevents model-generated scripts from exfiltrating secrets or contacting disallowed destinations. The non-bypassability tests (SPEC §27.4) include direct-socket and DNS-rebinding attempts.

## Evaluation Plan

- Network proxy bypass tests (nightly, SPEC §46.10): raw socket, DNS rebinding, private address, IPv6 bypass.
- Destination allowlist tests: allowlisted destination succeeds; non-allowlisted fails closed.
- Rate-limit tests: burst traffic is throttled.
- Fail-closed tests: proxy down → egress denied (no fallthrough).

## Migration

The egress proxy is introduced in M4 (SPEC §48.7). OpenCode's direct network paths are removed or routed through the proxy (ADR-0002, `docs/security/effect-bypass-register.yaml`).

## Rollback

If the proxy proves too restrictive for a legitimate use case, grant a capability for the specific destination (do not disable the proxy globally). If the proxy proves too slow, optimize it (do not bypass it — that violates non-bypassability).
