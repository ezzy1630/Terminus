# forge-egress

Egress proxy with destination allowlist and private-IP denial.

`EgressProxy` authorizes outbound destinations against an `EgressPolicy`
(allowlist of host suffixes, ports, and schemes), denies private/loopback/
link-local IPs even when the hostname is allowlisted, and enforces per-task
byte and rate budgets. The actual TCP relay is a stub that respects the
allowlist; no real TLS interception is performed (SPEC.md Section 13.3,
27.3).
