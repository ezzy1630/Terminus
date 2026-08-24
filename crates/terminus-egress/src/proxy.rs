use crate::error::EgressError;
use crate::policy::EgressPolicy;
use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// Per-task rate limit.
#[derive(Debug, Clone)]
pub struct RateLimit {
    pub bytes_per_second: u64,
    pub max_total_bytes: u64,
}

impl Default for RateLimit {
    fn default() -> Self {
        Self {
            bytes_per_second: 1_000_000,
            max_total_bytes: 100_000_000,
        }
    }
}

#[derive(Debug)]
struct AtomicCounter {
    bytes_transferred: AtomicU64,
}

/// The egress proxy. Resolves destinations, enforces allowlist + private-IP
/// denial + byte/rate limits. Socket creation remains owned by the kernel;
/// callers must resolve and authorize every destination address before any
/// connection attempt.
#[derive(Debug, Clone)]
pub struct EgressProxy {
    policy: Arc<EgressPolicy>,
    rate_limit: RateLimit,
    counter: Arc<AtomicCounter>,
}

impl EgressProxy {
    pub fn new(policy: EgressPolicy, rate_limit: RateLimit) -> Self {
        Self {
            policy: Arc::new(policy),
            rate_limit,
            counter: Arc::new(AtomicCounter {
                bytes_transferred: AtomicU64::new(0),
            }),
        }
    }

    pub fn policy(&self) -> &EgressPolicy {
        &self.policy
    }

    /// Authorize a destination. Returns `Ok(())` if allowed, `Err` with a
    /// typed reason if not.
    pub fn authorize(
        &self,
        host: &str,
        port: u16,
        scheme: &str,
        resolved_ips: &[IpAddr],
    ) -> Result<(), EgressError> {
        if self.policy.default_deny && !self.policy.matches(host, port, scheme) {
            return Err(EgressError::Denied(format!("{scheme}://{host}:{port}")));
        }
        // An allowlist match alone is not sufficient: proceeding without a
        // concrete address would allow the eventual socket call to perform an
        // unchecked second lookup (and make DNS rebinding invisible to the
        // policy decision).
        if resolved_ips.is_empty() {
            return Err(EgressError::Dns(format!(
                "no addresses resolved for {host}:{port}"
            )));
        }
        if self.policy.deny_private_ips {
            for ip in resolved_ips {
                if EgressPolicy::is_private_ip(*ip) {
                    return Err(EgressError::PrivateDestination(format!("{ip}")));
                }
            }
        }
        Ok(())
    }

    /// Re-verify DNS resolution results across connection reuse to prevent DNS rebinding attacks.
    pub fn verify_pinned_resolution(
        &self,
        host: &str,
        port: u16,
        scheme: &str,
        pinned_ips: &[IpAddr],
        current_ips: &[IpAddr],
    ) -> Result<(), EgressError> {
        self.authorize(host, port, scheme, current_ips)?;
        for ip in current_ips {
            if !pinned_ips.contains(ip) {
                return Err(EgressError::Denied(format!(
                    "DNS rebinding detected for {host}: IP set changed"
                )));
            }
        }
        Ok(())
    }

    /// Reserve `bytes` from the shared relay budget. The Unix broker calls
    /// this before each write; other transports must do the same rather than
    /// treating authorization as permission for unmetered I/O.
    pub fn relay(&self, bytes: u64) -> Result<u64, EgressError> {
        // A load followed by fetch_add can oversubscribe the shared task
        // budget when both relay directions make progress concurrently.
        // Reserve the allowance with compare_exchange instead.
        loop {
            let current = self.counter.bytes_transferred.load(Ordering::Acquire);
            if current >= self.rate_limit.max_total_bytes {
                return Err(EgressError::ByteBudgetExceeded);
            }
            let allowed = std::cmp::min(
                bytes,
                self.rate_limit.max_total_bytes.saturating_sub(current),
            );
            let next = current.saturating_add(allowed);
            if self
                .counter
                .bytes_transferred
                .compare_exchange(current, next, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                return Ok(allowed);
            }
        }
    }

    /// Reserve an entire byte count without consuming a partial allowance.
    /// This is for request boundaries where sending only part of a request is
    /// not a valid dispatch. A failed reservation leaves the counter intact.
    pub fn reserve_exact(&self, bytes: u64) -> Result<(), EgressError> {
        loop {
            let current = self.counter.bytes_transferred.load(Ordering::Acquire);
            if bytes > self.rate_limit.max_total_bytes.saturating_sub(current) {
                return Err(EgressError::ByteBudgetExceeded);
            }
            let next = current.saturating_add(bytes);
            if self
                .counter
                .bytes_transferred
                .compare_exchange(current, next, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                return Ok(());
            }
        }
    }

    pub fn bytes_transferred(&self) -> u64 {
        self.counter.bytes_transferred.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::{DestinationPolicy, EgressPolicy};
    use std::net::IpAddr;

    fn policy() -> EgressPolicy {
        EgressPolicy {
            default_deny: true,
            destinations: vec![DestinationPolicy {
                allowed_host_suffixes: vec!["api.github.com".to_string()],
                allowed_ports: vec![443],
                allowed_schemes: vec!["https".to_string()],
            }],
            deny_private_ips: true,
        }
    }

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn allowlisted_destination_authorized() {
        let proxy = EgressProxy::new(policy(), RateLimit::default());
        proxy
            .authorize("api.github.com", 443, "https", &[ip("140.82.121.6")])
            .unwrap();
    }

    #[test]
    fn non_allowlisted_destination_denied() {
        let proxy = EgressProxy::new(policy(), RateLimit::default());
        let err = proxy
            .authorize("evil.example", 443, "https", &[ip("93.184.216.34")])
            .unwrap_err();
        assert!(matches!(err, EgressError::Denied(_)));
    }

    #[test]
    fn private_ip_denied_even_when_allowlisted() {
        let proxy = EgressProxy::new(policy(), RateLimit::default());
        let err = proxy
            .authorize("api.github.com", 443, "https", &[ip("127.0.0.1")])
            .unwrap_err();
        assert!(matches!(err, EgressError::PrivateDestination(_)));
    }

    #[test]
    fn unresolved_destination_is_denied_even_when_allowlisted() {
        let proxy = EgressProxy::new(policy(), RateLimit::default());
        let err = proxy
            .authorize("api.github.com", 443, "https", &[])
            .unwrap_err();
        assert!(matches!(err, EgressError::Dns(_)));
    }

    #[test]
    fn byte_budget_enforced() {
        let proxy = EgressProxy::new(
            policy(),
            RateLimit {
                bytes_per_second: 1_000_000,
                max_total_bytes: 100,
            },
        );
        assert_eq!(proxy.relay(60).unwrap(), 60);
        assert_eq!(proxy.relay(60).unwrap(), 40);
        let err = proxy.relay(10).unwrap_err();
        assert!(matches!(err, EgressError::ByteBudgetExceeded));
    }

    #[test]
    fn exact_reservation_does_not_consume_partial_budget() {
        let proxy = EgressProxy::new(
            policy(),
            RateLimit {
                bytes_per_second: 1_000_000,
                max_total_bytes: 100,
            },
        );
        assert_eq!(proxy.relay(60).unwrap(), 60);
        assert!(matches!(
            proxy.reserve_exact(50),
            Err(EgressError::ByteBudgetExceeded)
        ));
        assert_eq!(proxy.bytes_transferred(), 60);
        proxy.reserve_exact(40).unwrap();
        assert_eq!(proxy.bytes_transferred(), 100);
    }

    #[test]
    fn test_dns_rebinding_defense() {
        let proxy = EgressProxy::new(policy(), RateLimit::default());
        let pinned = vec![ip("140.82.121.6")];
        let ok_current = vec![ip("140.82.121.6")];
        assert!(proxy
            .verify_pinned_resolution("api.github.com", 443, "https", &pinned, &ok_current)
            .is_ok());

        let rebound_current = vec![ip("192.168.1.1")];
        let err = proxy
            .verify_pinned_resolution("api.github.com", 443, "https", &pinned, &rebound_current)
            .unwrap_err();
        assert!(matches!(err, EgressError::PrivateDestination(_)));

        let rebound_public = vec![ip("93.184.216.34")];
        let err2 = proxy
            .verify_pinned_resolution("api.github.com", 443, "https", &pinned, &rebound_public)
            .unwrap_err();
        assert!(matches!(err2, EgressError::Denied(_)));
    }
}
