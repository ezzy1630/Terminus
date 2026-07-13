# terminus-egress

Egress proxy with destination allowlist and private-IP denial.

`EgressProxy` authorizes outbound destinations against an `EgressPolicy`
(allowlist of host suffixes, ports, and schemes), denies private/loopback/
link-local IPs even when the hostname is allowlisted, and enforces a shared
per-task byte budget. On Unix, `EgressBroker` accepts a bounded request over a
private Unix socket, resolves and authorizes every destination address, opens
the approved numeric TCP connection, and relays opaque bytes through that
budget. It performs no TLS interception (SPEC.md Section 13.3, 27.3).
