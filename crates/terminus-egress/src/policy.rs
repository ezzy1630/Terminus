use serde::{Deserialize, Serialize};
use std::net::IpAddr;

/// Per-destination policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DestinationPolicy {
    /// Host suffix patterns that match the destination's hostname.
    pub allowed_host_suffixes: Vec<String>,
    /// Ports permitted (empty means all).
    pub allowed_ports: Vec<u16>,
    /// Schemes permitted (e.g. `https`).
    pub allowed_schemes: Vec<String>,
}

impl Default for DestinationPolicy {
    fn default() -> Self {
        Self {
            allowed_host_suffixes: Vec::new(),
            allowed_ports: Vec::new(),
            allowed_schemes: vec!["https".to_string()],
        }
    }
}

/// The top-level egress policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EgressPolicy {
    pub default_deny: bool,
    pub destinations: Vec<DestinationPolicy>,
    /// If true, private/link-local/loopback IPs are always denied even when
    /// the hostname is allowlisted.
    pub deny_private_ips: bool,
}

impl Default for EgressPolicy {
    fn default() -> Self {
        Self {
            default_deny: true,
            destinations: Vec::new(),
            deny_private_ips: true,
        }
    }
}

impl EgressPolicy {
    /// Returns true if the destination matches any allowlist entry.
    pub fn matches(&self, host: &str, port: u16, scheme: &str) -> bool {
        for d in &self.destinations {
            if !d.allowed_schemes.is_empty() && !d.allowed_schemes.iter().any(|s| s == scheme) {
                continue;
            }
            if !d.allowed_ports.is_empty() && !d.allowed_ports.contains(&port) {
                continue;
            }
            for suffix in &d.allowed_host_suffixes {
                if host == suffix || host.ends_with(&format!(".{suffix}")) {
                    return true;
                }
            }
        }
        false
    }

    /// Returns true if the IP is private, loopback, or link-local.
    pub fn is_private_ip(ip: IpAddr) -> bool {
        match ip {
            IpAddr::V4(v4) => is_private_ipv4(v4),
            IpAddr::V6(v6) => {
                // IPv4-mapped IPv6 addresses can otherwise bypass the IPv4
                // private-range checks when a resolver returns `::ffff:x.y.z.w`.
                let segments = v6.segments();
                let is_ipv4_mapped =
                    segments[..5].iter().all(|segment| *segment == 0) && segments[5] == 0xffff;
                if is_ipv4_mapped {
                    if let Some(v4) = v6.to_ipv4() {
                        return is_private_ipv4(v4);
                    }
                }
                v6.is_loopback()
                    || v6.is_unspecified()
                    || {
                        let segs = v6.segments();
                        // fc00::/7 unique local address
                        (segs[0] & 0xfe00) == 0xfc00
                    }
                    || {
                        let segs = v6.segments();
                        // fe80::/10 link-local
                        (segs[0] & 0xffc0) == 0xfe80
                    }
            }
        }
    }
}

fn is_private_ipv4(ip: std::net::Ipv4Addr) -> bool {
    ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_unspecified()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_allowlist_exact() {
        let policy = EgressPolicy {
            default_deny: true,
            destinations: vec![DestinationPolicy {
                allowed_host_suffixes: vec!["api.github.com".to_string()],
                allowed_ports: vec![443],
                allowed_schemes: vec!["https".to_string()],
            }],
            deny_private_ips: true,
        };
        assert!(policy.matches("api.github.com", 443, "https"));
        assert!(!policy.matches("api.github.com", 80, "https"));
        assert!(!policy.matches("api.github.com", 443, "http"));
        assert!(!policy.matches("evil.com", 443, "https"));
    }

    #[test]
    fn matches_allowlist_suffix() {
        let policy = EgressPolicy {
            default_deny: true,
            destinations: vec![DestinationPolicy {
                allowed_host_suffixes: vec!["github.com".to_string()],
                allowed_ports: vec![],
                allowed_schemes: vec![],
            }],
            deny_private_ips: true,
        };
        assert!(policy.matches("api.github.com", 443, "https"));
        assert!(policy.matches("github.com", 22, "ssh"));
        assert!(!policy.matches("evilexample.com", 443, "https"));
    }

    #[test]
    fn private_ip_detection() {
        assert!(EgressPolicy::is_private_ip("127.0.0.1".parse().unwrap()));
        assert!(EgressPolicy::is_private_ip("10.0.0.1".parse().unwrap()));
        assert!(EgressPolicy::is_private_ip("192.168.1.1".parse().unwrap()));
        assert!(EgressPolicy::is_private_ip("169.254.1.1".parse().unwrap()));
        assert!(EgressPolicy::is_private_ip("::1".parse().unwrap()));
        assert!(EgressPolicy::is_private_ip("fe80::1".parse().unwrap()));
        assert!(EgressPolicy::is_private_ip("fc00::1".parse().unwrap()));
        assert!(EgressPolicy::is_private_ip(
            "::ffff:127.0.0.1".parse().unwrap()
        ));
        assert!(EgressPolicy::is_private_ip(
            "::ffff:10.0.0.1".parse().unwrap()
        ));
        assert!(EgressPolicy::is_private_ip(
            "::ffff:169.254.169.254".parse().unwrap()
        ));
        assert!(!EgressPolicy::is_private_ip("8.8.8.8".parse().unwrap()));
        assert!(!EgressPolicy::is_private_ip(
            "2606:4700:4700::1111".parse().unwrap()
        ));
    }
}
