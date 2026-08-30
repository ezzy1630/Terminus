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

/// Wire identity for `chatgpt-codex` is a CALLER decision, not a kernel one.
///
/// Live probing (Research/ChatGPT_OAuth_And_Codex_Wire_2026-08-28 §1) showed
/// `version` is a minimum-version GATE, not an identity claim: a stale value
/// returns `400 "requires a newer version of Codex"`, while omitting it is
/// ungated. `originator` and `User-Agent` change nothing on the measured
/// account and are a per-account ToS decision. So the kernel injects no
/// identity headers here; the control plane sets `originator` and
/// `user-agent` per request through the caller-header allowlist below.
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
/// Additionally surfaced for the ChatGPT Codex backend: usage windows,
/// credits, plan type, sticky turn routing (`x-codex-turn-state`, echoed on
/// the next request of the same turn), and the model-catalog ETag.
const CODEX_RESPONSE_HEADERS: &[&str] = &["x-codex-*", "x-models-*"];

/// Hosts admitted regardless of which connectors are registered. `opencode.ai`
/// is the historical gateway floor; `models.dev` is the model-catalog source
/// fetched through `web-fetch`. Kept as Rust constants so no shipped
/// JavaScript artifact carries them.
pub const EGRESS_FLOOR_HOSTS: &[&str] = &["opencode.ai", "models.dev"];

const GATEWAY_HOST: &str = "opencode.ai";
const OPENAI_API_HOST: &str = "api.openai.com";
const ANTHROPIC_API_HOST: &str = "api.anthropic.com";
const CHATGPT_HOST: &str = "chatgpt.com";
const OPENAI_AUTH_HOST: &str = "auth.openai.com";

/// Request headers the caller may set on `chatgpt-codex`.
///
/// This is the "Recommended Terminus header set" from
/// `Research/ChatGPT_OAuth_And_Codex_Wire_2026-08-28.md` §1.2 — the
/// Codex-identical subset minus pure telemetry — with `Authorization`
/// removed because the broker injects it, and `Content-Type`/`Accept`
/// removed because they are globally admitted.
///
/// `originator` and `user-agent` are admitted (not injected) because
/// presenting as the Codex CLI versus as Terminus is a per-account product
/// decision. `session-id` is stable per Terminus session, `thread-id` per
/// thread, and `x-client-request-id` carries the same value as `thread-id`.
/// `x-codex-turn-state` is echoed back from an earlier response in the same
/// turn and omitted on the first request.
///
/// Deliberately NOT admitted, per the same research pass:
/// - `version` — a minimum-version GATE, not an identity claim. A stale
///   value hard-400s ("requires a newer version of Codex") on every backend
///   rollout; omitting it is ungated.
/// - `x-oai-attestation` — device attestation Terminus cannot produce.
/// - `x-codex-routing-hint`, `x-openai-internal-*` — internal routing and
///   residency controls with no defined contract for third parties.
const CHATGPT_CODEX_REQUEST_HEADERS: &[&str] = &[
    "chatgpt-account-id",
    "session-id",
    "thread-id",
    "x-codex-turn-state",
    "x-client-request-id",
    "accept-encoding",
    "originator",
    "user-agent",
];

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
/// anonymous dispatch came back `429 FreeUsageLimitError`. As with
/// `chatgpt-codex`, the wire identity is the caller's decision, so the header
/// is admitted rather than injected here.
const OPENCODE_GATEWAY_REQUEST_HEADERS: &[&str] = &["user-agent"];

/// OAuth token calls are small and synchronous; they get a tight bound.
const OAUTH_TOTAL_TIMEOUT: Duration = Duration::from_secs(30);
const OAUTH_IDLE_TIMEOUT: Duration = Duration::from_secs(15);

fn model_response_headers() -> Vec<String> {
    MODEL_RESPONSE_HEADERS
        .iter()
        .map(|h| (*h).to_string())
        .collect()
}

fn codex_response_headers() -> Vec<String> {
    MODEL_RESPONSE_HEADERS
        .iter()
        .chain(CODEX_RESPONSE_HEADERS.iter())
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
            // Borrows a ChatGPT subscription through the Codex backend. No
            // broker-injected identity: the caller chooses `originator` and
            // `user-agent` per account, and `version` is deliberately never
            // sent (it gates on a minimum CLI version).
            "chatgpt-codex",
            model_descriptor(
                AuthStyle::Bearer,
                HostPolicy::Fixed(vec![CHATGPT_HOST.to_string()]),
            )
            .with_allowed_request_headers(
                CHATGPT_CODEX_REQUEST_HEADERS
                    .iter()
                    .copied()
                    .chain(MODEL_BETA_REQUEST_HEADERS.iter().copied()),
            )
            .with_response_headers(codex_response_headers()),
        ),
        (
            // Token exchange, refresh, and revocation for the ChatGPT
            // credential. Bearer-less: the refresh/authorization material is
            // in the request body, so there is nothing for the broker to
            // inject. Runs in the kernel so the control plane never talks to
            // `auth.openai.com` directly.
            "openai-oauth",
            ConnectorDescriptor::new(AuthStyle::None)
                .with_timeouts(ConnectorTimeouts::with_idle(
                    OAUTH_TOTAL_TIMEOUT,
                    OAUTH_IDLE_TIMEOUT,
                ))
                .with_hosts(HostPolicy::Fixed(vec![OPENAI_AUTH_HOST.to_string()])),
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
        for host in [
            CHATGPT_HOST,
            OPENAI_AUTH_HOST,
            OPENAI_API_HOST,
            ANTHROPIC_API_HOST,
        ] {
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
        ] {
            assert!(!policy.matches(host, 443, "https"), "{host} must be denied");
        }
        // Non-443 and plaintext stay denied for admitted hosts too.
        assert!(!policy.matches(CHATGPT_HOST, 80, "https"));
        assert!(!policy.matches(CHATGPT_HOST, 443, "http"));
    }

    #[test]
    fn model_connectors_use_idle_bounded_long_timeouts() {
        for (id, descriptor) in default_connector_registry() {
            if !matches!(
                id,
                "openai-responses"
                    | "openai-chat"
                    | "anthropic-messages"
                    | "chatgpt-codex"
                    | "openai-compatible"
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
    fn chatgpt_codex_injects_no_identity_headers() {
        // The backend gates on `version`, and originator/User-Agent are a
        // per-account decision: the kernel must inject none of them.
        let codex = descriptor_for("chatgpt-codex");
        assert!(
            codex.static_headers.is_empty(),
            "chatgpt-codex must not inject static headers, found {:?}",
            codex.static_headers
        );
        assert!(
            !codex.allowed_request_headers.iter().any(|h| h == "version"),
            "`version` must never be sent: it is a minimum-version gate"
        );
        for header in ["originator", "user-agent"] {
            assert!(
                codex.allowed_request_headers.iter().any(|h| h == header),
                "caller must be able to set {header}"
            );
        }
        assert_eq!(
            codex.fixed_hosts(),
            [CHATGPT_HOST.to_string()],
            "token endpoints belong to the openai-oauth connector"
        );
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
    fn openai_oauth_is_bearerless_and_pinned_to_the_auth_host() {
        let oauth = descriptor_for("openai-oauth");
        assert!(matches!(oauth.auth, AuthStyle::None));
        assert_eq!(oauth.fixed_hosts(), [OPENAI_AUTH_HOST.to_string()]);
        assert!(oauth.static_headers.is_empty());
        assert!(oauth.response_headers.is_empty());
        // `content-type` is already globally admitted, so no extra caller
        // headers are needed for the form-encoded and JSON token calls.
        assert!(oauth.allowed_request_headers.is_empty());
        assert_eq!(
            oauth.timeouts,
            Some(ConnectorTimeouts::with_idle(
                OAUTH_TOTAL_TIMEOUT,
                OAUTH_IDLE_TIMEOUT
            ))
        );
    }

    #[test]
    fn caller_headers_and_response_allowlist_match_the_design() {
        let codex = descriptor_for("chatgpt-codex");
        for header in CHATGPT_CODEX_REQUEST_HEADERS {
            assert!(
                codex.allowed_request_headers.iter().any(|h| h == header),
                "missing caller header {header}"
            );
        }
        // Exactly what the control plane reads back for the Codex dialect:
        // sticky turn routing, usage windows, the catalog ETag, retry
        // pacing, rate limits, and request correlation.
        for pattern in [
            "x-codex-*",
            "x-models-*",
            "retry-after",
            "x-ratelimit-*",
            "anthropic-ratelimit-*",
            "anthropic-organization-id",
            "request-id",
            "x-request-id",
        ] {
            assert!(
                codex.response_headers.iter().any(|p| p == pattern),
                "missing response header pattern {pattern}"
            );
        }
        // Credential and session material is never surfaced, and no
        // descriptor may opt into it.
        for forbidden in ["authorization", "set-cookie", "*"] {
            assert!(
                !codex.response_headers.iter().any(|p| p == forbidden),
                "response allowlist must not carry {forbidden}"
            );
        }
    }

    #[test]
    fn chatgpt_codex_admits_the_recommended_wire_header_set_and_nothing_else() {
        // Source of truth: Research/ChatGPT_OAuth_And_Codex_Wire_2026-08-28
        // §1.2 "Recommended Terminus header set".
        let codex = descriptor_for("chatgpt-codex");
        for header in [
            "chatgpt-account-id",
            "originator",
            "user-agent",
            "session-id",
            "thread-id",
            "x-client-request-id",
            "x-codex-turn-state",
        ] {
            assert!(
                codex.allowed_request_headers.iter().any(|h| h == header),
                "the Codex dialect cannot send {header}"
            );
        }
        // `Authorization` is broker-injected, `Content-Type`/`Accept` are
        // globally admitted: none of them belongs in the descriptor.
        for header in [
            // A minimum-version GATE, not an identity claim: a stale value
            // hard-400s on every backend rollout.
            "version",
            // Device attestation Terminus cannot produce.
            "x-oai-attestation",
            "x-codex-routing-hint",
            "x-openai-internal-codex-responses-lite",
            "x-openai-internal-codex-residency",
            "authorization",
        ] {
            assert!(
                !codex.allowed_request_headers.iter().any(|h| h == header),
                "{header} must never be caller-settable on chatgpt-codex"
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
            "chatgpt-codex",
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
        for id in ["openai-oauth", "web-fetch"] {
            let descriptor = descriptor_for(id);
            assert!(
                descriptor.allowed_request_headers.is_empty(),
                "{id} must not widen its caller-header allowlist"
            );
        }
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
            "chatgpt-codex",
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
