//! The kernel's built-in connector table (design §4(f)).
//!
//! One place decides, per connector id: how the credential is presented,
//! which hosts it may reach, how long a call may take, which request headers
//! the caller may set, which headers the broker injects, which response
//! headers are surfaced on the receipt, and the request/response byte
//! ceilings. The L4 egress allowlist is derived from the same table, so a
//! registered connector is never dead on arrival and an unregistered host is
//! never admitted.

use std::time::Duration;
use terminus_connector::{AuthStyle, ConnectorDescriptor, ConnectorTimeouts, HostPolicy};
use terminus_egress::{DestinationPolicy, EgressPolicy};

/// Total budget for a model call, including a full streamed completion.
const MODEL_TOTAL_TIMEOUT: Duration = Duration::from_secs(300);
/// Maximum gap between response bytes (and the wait for the response head).
/// A stalled upstream fails here instead of holding the whole total budget.
const MODEL_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
/// Gateway calls are unary and metadata-shaped; they keep the prior bound.
const GATEWAY_TIMEOUT: Duration = Duration::from_secs(120);

/// Per-descriptor bounds for model traffic. Requests carry compiled context;
/// responses carry a full streamed completion.
const MODEL_MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;
const MODEL_MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;

/// Rate-limit, routing, and correlation headers Terminus reads back from
/// model providers. Nothing here can carry credential material, and the
/// broker denies `authorization`/`set-cookie` outright regardless of what a
/// descriptor lists. Entries are exact lowercase names or a trailing-`*`
/// prefix. These are surfaced twice on a streamed dispatch: once in the
/// leading metadata frame (before the first body byte, so retry pacing and
/// routing are known immediately) and once on the terminal receipt.
const MODEL_RESPONSE_HEADERS: &[&str] = &[
    "retry-after",
    "x-ratelimit-*",
    "anthropic-ratelimit-*",
    "anthropic-organization-id",
    "openai-processing-ms",
    "request-id",
    "x-request-id",
];
/// Hosts admitted regardless of which connectors are registered. `opencode.ai`
/// is the historical gateway floor; `models.dev` is the model-catalog source
/// fetched through `web-fetch`. Kept as Rust constants so no shipped
/// JavaScript artifact carries them.
pub const EGRESS_FLOOR_HOSTS: &[&str] = &["opencode.ai", "models.dev"];

const GATEWAY_HOST: &str = "opencode.ai";
const OPENAI_API_HOST: &str = "api.openai.com";
const ANTHROPIC_API_HOST: &str = "api.anthropic.com";

/// Feature-flag headers the caller may set on any model connector.
///
/// Anthropic gates Claude 5 features (interleaved thinking, extended
/// context, tool-search) behind `anthropic-beta`, and OpenAI gates
/// Responses-API features behind `OpenAI-Beta`. The kernel rejected both,
/// which made every 2026 provider feature unreachable from the control
/// plane. Neither header can carry credential material; both are matched
/// case-insensitively by the broker.
const MODEL_BETA_REQUEST_HEADERS: &[&str] = &["anthropic-beta", "openai-beta"];

/// Request headers the caller may set on the OpenCode gateway.
///
/// The Zen gateway serves its anonymous free tier only to clients whose
/// `user-agent` names OpenCode; under the broker's default agent every
/// anonymous dispatch came back `429 FreeUsageLimitError`. The wire identity
/// is the caller's decision, so the header is admitted rather than injected.
const OPENCODE_GATEWAY_REQUEST_HEADERS: &[&str] = &["user-agent"];

fn model_response_headers() -> Vec<String> {
    MODEL_RESPONSE_HEADERS
        .iter()
        .map(|h| (*h).to_string())
        .collect()
}

fn model_descriptor(auth: AuthStyle, hosts: HostPolicy) -> ConnectorDescriptor {
    ConnectorDescriptor::new(auth)
        .with_timeouts(ConnectorTimeouts::with_idle(
            MODEL_TOTAL_TIMEOUT,
            MODEL_IDLE_TIMEOUT,
        ))
        .with_bounds(MODEL_MAX_REQUEST_BYTES, MODEL_MAX_RESPONSE_BYTES)
        .with_response_headers(model_response_headers())
        .with_allowed_request_headers(MODEL_BETA_REQUEST_HEADERS.iter().copied())
        .with_hosts(hosts)
}

/// Every connector the kernel registers, in registration order.
#[must_use]
pub fn default_connector_registry() -> Vec<(&'static str, ConnectorDescriptor)> {
    let gateway_hosts = HostPolicy::Fixed(vec![GATEWAY_HOST.to_string()]);
    vec![
        (
            // Zen is a model transport like any other: it proxies OpenAI- and
            // Anthropic-family models and returns their pacing headers. With
            // no response allowlist, `retry-after` and `x-ratelimit-*` were
            // dropped at the broker and the control plane had to guess its
            // backoff on every 429.
            "opencode-gateway",
            ConnectorDescriptor::new(AuthStyle::Bearer)
                .with_timeouts(ConnectorTimeouts::total(GATEWAY_TIMEOUT))
                .with_hosts(gateway_hosts.clone())
                .with_response_headers(model_response_headers())
                .with_allowed_request_headers(OPENCODE_GATEWAY_REQUEST_HEADERS.iter().copied()),
        ),
        (
            "opencode-gateway-anonymous",
            ConnectorDescriptor::new(AuthStyle::None)
                .with_timeouts(ConnectorTimeouts::total(GATEWAY_TIMEOUT))
                .with_hosts(gateway_hosts)
                .with_response_headers(model_response_headers())
                .with_allowed_request_headers(OPENCODE_GATEWAY_REQUEST_HEADERS.iter().copied()),
        ),
        (
            "openai-responses",
            model_descriptor(
                AuthStyle::Bearer,
                HostPolicy::Fixed(vec![OPENAI_API_HOST.to_string()]),
            ),
        ),
        (
            "openai-chat",
            model_descriptor(
                AuthStyle::Bearer,
                HostPolicy::Fixed(vec![OPENAI_API_HOST.to_string()]),
            ),
        ),
        (
            "anthropic-messages",
            model_descriptor(
                AuthStyle::NamedHeader("x-api-key".into()),
                HostPolicy::Fixed(vec![ANTHROPIC_API_HOST.to_string()]),
            ),
        ),
        (
            // OpenAI-wire-compatible third-party endpoints. The host comes
            // from the stored provider account and is pinned per grant.
            "openai-compatible",
            model_descriptor(AuthStyle::Bearer, HostPolicy::PerGrant),
        ),
        (
            // Public fetches; no credential and no descriptor host pin — the
            // L4 egress allowlist is the only gate.
            "web-fetch",
            ConnectorDescriptor::new(AuthStyle::None),
        ),
    ]
}

/// The L4 egress allowlist implied by `descriptors`, unioned with
/// [`EGRESS_FLOOR_HOSTS`]. Every entry is https/443.
#[must_use]
pub fn connector_egress_policy(
    descriptors: &[(&'static str, ConnectorDescriptor)],
) -> EgressPolicy {
    let mut hosts: std::collections::BTreeSet<String> = EGRESS_FLOOR_HOSTS
        .iter()
        .map(|host| (*host).to_string())
        .collect();
    for (_, descriptor) in descriptors {
        hosts.extend(descriptor.fixed_hosts().iter().cloned());
    }
    EgressPolicy {
        default_deny: true,
        destinations: vec![DestinationPolicy {
            allowed_host_suffixes: hosts.into_iter().collect(),
            allowed_ports: vec![443],
            allowed_schemes: vec!["https".to_string()],
        }],
        deny_private_ips: true,
    }
}

/// Union `policy` with the connector-derived allowlist. Callers that supply
/// a narrower development policy still reach every registered connector; the
/// derived hosts are a floor, never a replacement.
#[must_use]
pub fn with_connector_egress_floor(mut policy: EgressPolicy) -> EgressPolicy {
    let derived = connector_egress_policy(&default_connector_registry());
    policy.destinations.extend(derived.destinations);
    policy
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn egress_allowlist_covers_every_registered_connector_host() {
        let registry = default_connector_registry();
        let policy = connector_egress_policy(&registry);
        for (id, descriptor) in &registry {
            for host in descriptor.fixed_hosts() {
                assert!(
                    policy.matches(host, 443, "https"),
                    "connector {id} host {host} is not admitted by the derived egress policy"
                );
            }
        }
        for host in EGRESS_FLOOR_HOSTS {
            assert!(
                policy.matches(host, 443, "https"),
                "floor host {host} denied"
            );
        }
        for host in [OPENAI_API_HOST, ANTHROPIC_API_HOST] {
            assert!(
                policy.matches(host, 443, "https"),
                "{host} must be admitted"
            );
        }
    }

    #[test]
    fn unregistered_hosts_stay_denied() {
        let policy = connector_egress_policy(&default_connector_registry());
        for host in [
            "evil.example.com",
            "integrate.api.nvidia.com",
            "api.openai.com.evil.com",
            "chatgpt.com",
            "auth.openai.com",
        ] {
            assert!(!policy.matches(host, 443, "https"), "{host} must be denied");
        }
        // Non-443 and plaintext stay denied for admitted hosts too.
        assert!(!policy.matches(OPENAI_API_HOST, 80, "https"));
        assert!(!policy.matches(OPENAI_API_HOST, 443, "http"));
    }

    #[test]
    fn model_connectors_use_idle_bounded_long_timeouts() {
        for (id, descriptor) in default_connector_registry() {
            if !matches!(
                id,
                "openai-responses" | "openai-chat" | "anthropic-messages" | "openai-compatible"
            ) {
                continue;
            }
            let timeouts = descriptor
                .timeouts
                .unwrap_or_else(|| panic_free_default(id));
            assert_eq!(timeouts.total, MODEL_TOTAL_TIMEOUT, "{id} total");
            assert_eq!(timeouts.idle, Some(MODEL_IDLE_TIMEOUT), "{id} idle");
            assert_eq!(
                descriptor.max_request_bytes,
                Some(MODEL_MAX_REQUEST_BYTES),
                "{id} request bound"
            );
            assert_eq!(
                descriptor.max_response_bytes,
                Some(MODEL_MAX_RESPONSE_BYTES),
                "{id} response bound"
            );
        }
    }

    fn panic_free_default(id: &str) -> ConnectorTimeouts {
        // A model connector without explicit timeouts is a registry bug; make
        // the assertion below fail loudly instead of unwrapping.
        let _ = id;
        ConnectorTimeouts::total(Duration::ZERO)
    }

    /// Registry lookup that fails the assertion rather than unwrapping.
    fn descriptor_for(id: &str) -> ConnectorDescriptor {
        default_connector_registry()
            .into_iter()
            .find(|(registered, _)| *registered == id)
            .map_or_else(
                || ConnectorDescriptor::new(AuthStyle::None),
                |(_, descriptor)| descriptor,
            )
    }

    #[test]
    fn retired_subscription_connectors_are_not_registered_or_admitted() {
        let registry = default_connector_registry();
        assert!(!registry.iter().any(|(id, _)| *id == "chatgpt-codex"));
        assert!(!registry.iter().any(|(id, _)| *id == "openai-oauth"));
        let policy = connector_egress_policy(&registry);
        assert!(!policy.matches("chatgpt.com", 443, "https"));
        assert!(!policy.matches("auth.openai.com", 443, "https"));
    }

    #[test]
    fn opencode_gateway_lets_the_caller_state_its_user_agent() {
        // The Zen gateway gates its anonymous free tier on this header; under
        // the broker default every anonymous dispatch is 429.
        for id in ["opencode-gateway", "opencode-gateway-anonymous"] {
            let gateway = descriptor_for(id);
            assert!(
                gateway
                    .allowed_request_headers
                    .iter()
                    .any(|header| header == "user-agent"),
                "caller must be able to set user-agent on {id}"
            );
            assert!(
                gateway.static_headers.is_empty(),
                "{id} must not inject identity headers, found {:?}",
                gateway.static_headers
            );
        }
    }

    #[test]
    fn every_model_connector_admits_the_provider_beta_headers() {
        // Without these the Claude 5 / GPT-5.6 feature flags are
        // unreachable: the broker rejected `anthropic-beta` and
        // `OpenAI-Beta` outright.
        for id in [
            "openai-responses",
            "openai-chat",
            "anthropic-messages",
            "openai-compatible",
        ] {
            let descriptor = descriptor_for(id);
            for header in MODEL_BETA_REQUEST_HEADERS {
                assert!(
                    descriptor
                        .allowed_request_headers
                        .iter()
                        .any(|h| h == header),
                    "{id} must admit {header}"
                );
            }
        }
        // The credential-free public paths gain nothing from them.
        let id = "web-fetch";
        let descriptor = descriptor_for(id);
        assert!(
            descriptor.allowed_request_headers.is_empty(),
            "{id} must not widen its caller-header allowlist"
        );
    }

    #[test]
    fn every_model_transport_surfaces_retry_and_rate_limit_headers() {
        // The Zen gateway descriptors carried no response allowlist at all,
        // so `retry-after` and `x-ratelimit-*` were dropped at the broker and
        // the control plane backed off blind on every 429.
        for id in [
            "opencode-gateway",
            "opencode-gateway-anonymous",
            "openai-responses",
            "openai-chat",
            "anthropic-messages",
            "openai-compatible",
        ] {
            let descriptor = descriptor_for(id);
            for pattern in MODEL_RESPONSE_HEADERS {
                assert!(
                    descriptor.response_headers.iter().any(|p| p == pattern),
                    "{id} must surface {pattern}"
                );
            }
            for forbidden in ["authorization", "set-cookie", "cookie", "*"] {
                assert!(
                    !descriptor.response_headers.iter().any(|p| p == forbidden),
                    "{id} must not surface {forbidden}"
                );
            }
        }
    }

    #[test]
    fn openai_compatible_takes_its_host_from_the_grant() {
        let compatible = descriptor_for("openai-compatible");
        assert_eq!(compatible.hosts, HostPolicy::PerGrant);
        assert!(compatible.fixed_hosts().is_empty());
        assert!(compatible.static_headers.is_empty());
    }
}
