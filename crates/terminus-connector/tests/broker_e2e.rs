//! End-to-end connector broker conformance (ADR-0035 §2).
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! exit gate: "credential use is exact-operation bound").

use sha2::{Digest, Sha256};
use std::sync::Arc;
use terminus_connector::{AuthStyle, CanonicalOperation, ConnectorBroker, Outcome};
use terminus_egress::{DestinationPolicy, EgressPolicy, EgressProxy, RateLimit};
use terminus_secrets::{
    GrantBinding, GrantIssuer, GrantStore, InMemoryProvider, SecretBroker, WorkloadIdentity,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const KEY: &[u8] = &[42u8; 32];
const CREDENTIAL: &[u8] = b"canary-ghp_ABCDEF_1234567890";
const SECRET_URI: &str = "secret://github/repo-read";

fn egress_for_port_with_limit(port: u16, max_total_bytes: u64) -> EgressProxy {
    let policy = EgressPolicy {
        default_deny: true,
        destinations: vec![DestinationPolicy {
            allowed_host_suffixes: vec!["localhost".to_string()],
            allowed_ports: vec![port],
            allowed_schemes: vec!["http".to_string(), "https".to_string()],
        }],
        deny_private_ips: false,
    };
    EgressProxy::new(
        policy,
        RateLimit {
            bytes_per_second: 10_000_000,
            max_total_bytes,
        },
    )
}

fn binding(port: u16) -> GrantBinding {
    binding_for_scheme(port, "http")
}

fn binding_for_scheme(port: u16, scheme: &str) -> GrantBinding {
    GrantBinding {
        connector_id: "fixture-api".into(),
        destination_host: "localhost".into(),
        destination_port: port,
        scheme: scheme.into(),
        method: "POST".into(),
        path_class: "/repos/{owner}/{repo}/pulls".into(),
        task_id: "task-1".into(),
        effect_id: "eff-1".into(),
    }
}

fn operation(path: &str, port: u16) -> CanonicalOperation {
    CanonicalOperation {
        method: "POST".into(),
        scheme: "http".into(),
        host: "localhost".into(),
        port,
        path: path.into(),
        query: String::new(),
        headers: Vec::new(),
        body: br#"{"title":"fix"}"#.to_vec(),
    }
}

async fn fixture_stack() -> (ConnectorBroker, u16, TcpListener) {
    fixture_stack_with_budget(10_000_000).await
}

async fn fixture_stack_with_budget(max_total_bytes: u64) -> (ConnectorBroker, u16, TcpListener) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let secret_broker = Arc::new(SecretBroker::new());
    let provider = Arc::new(InMemoryProvider::new());
    provider.register(SECRET_URI, CREDENTIAL.to_vec());
    secret_broker.register_provider("github", provider);

    let grants = Arc::new(GrantStore::new());
    let broker = ConnectorBroker::builder(
        secret_broker,
        grants,
        Arc::new(egress_for_port_with_limit(port, max_total_bytes)),
        KEY,
    )
    .connector("fixture-api", AuthStyle::Bearer)
    .build();
    (broker, port, listener)
}

#[tokio::test]
async fn anonymous_connector_is_explicitly_registered() {
    let (broker, _port, _listener) = fixture_stack().await;
    broker
        .register_connector("public-api", AuthStyle::None)
        .unwrap();

    assert!(broker.is_anonymous_connector("public-api").unwrap());
    assert!(!broker.is_anonymous_connector("fixture-api").unwrap());
}

#[tokio::test]
#[ignore = "contacts the public OpenCode endpoint with an invalid generated credential"]
async fn live_opencode_tls_canary_reaches_a_validated_http_response() {
    let secret_broker = Arc::new(SecretBroker::new());
    let provider = Arc::new(InMemoryProvider::new());
    let nonce = format!("{}:{:?}", std::process::id(), std::time::SystemTime::now());
    let credential = hex::encode(Sha256::digest(nonce.as_bytes())).into_bytes();
    let secret_uri = "secret://opencode-test/zen";
    provider.register(secret_uri, credential.clone());
    secret_broker.register_provider("opencode-test", provider);
    let grants = Arc::new(GrantStore::new());
    let egress = EgressProxy::new(
        EgressPolicy {
            default_deny: true,
            destinations: vec![DestinationPolicy {
                allowed_host_suffixes: vec!["opencode.ai".to_string()],
                allowed_ports: vec![443],
                allowed_schemes: vec!["https".to_string()],
            }],
            deny_private_ips: true,
        },
        RateLimit::default(),
    );
    let broker = ConnectorBroker::builder(secret_broker, grants, Arc::new(egress), KEY)
        .connector("opencode-gateway", AuthStyle::Bearer)
        .timeout(std::time::Duration::from_secs(20))
        .build();
    let binding = GrantBinding {
        connector_id: "opencode-gateway".into(),
        destination_host: "opencode.ai".into(),
        destination_port: 443,
        scheme: "https".into(),
        method: "POST".into(),
        path_class: "/zen/v1/chat/completions".into(),
        task_id: "tls-canary".into(),
        effect_id: "tls-canary".into(),
    };
    let grant = GrantIssuer::new(KEY.to_vec())
        .mint(
            WorkloadIdentity {
                workload_id: "tls-canary".into(),
                principal: "tls-canary".into(),
                task_id: "tls-canary".into(),
            },
            secret_uri,
            &credential,
            binding,
            60,
            1,
        )
        .unwrap();
    let response = broker
        .execute(
            &CanonicalOperation {
                method: "POST".into(),
                scheme: "https".into(),
                host: "opencode.ai".into(),
                port: 443,
                path: "/zen/v1/chat/completions".into(),
                query: String::new(),
                headers: vec![
                    ("accept".into(), "application/json".into()),
                    ("content-type".into(), "application/json".into()),
                ],
                body: b"{}".to_vec(),
            },
            &grant,
        )
        .await
        .unwrap();
    assert!(response.receipt.status_code.is_some());
    assert_eq!(response.receipt.destination, "https://opencode.ai:443");
    assert!(!response
        .body
        .windows(credential.len())
        .any(|window| window == credential));
}

/// Serve exactly one HTTP request; return the raw request bytes.
async fn serve_once(listener: TcpListener, response: Vec<u8>) -> Vec<u8> {
    let (mut sock, _) = listener.accept().await.unwrap();
    let mut buf = [0u8; 16384];
    let mut raw = Vec::new();
    loop {
        let n = sock.read(&mut buf).await.unwrap();
        if n == 0 {
            break;
        }
        raw.extend_from_slice(&buf[..n]);
        // Stop once the full request (head + content-length body) arrived.
        if let Some(pos) = find_head_end(&raw) {
            let cl = content_length(&raw[..pos]).unwrap_or(0);
            if raw.len() >= pos + 4 + cl {
                break;
            }
        }
    }
    sock.write_all(&response).await.unwrap();
    raw
}

fn find_head_end(data: &[u8]) -> Option<usize> {
    data.windows(4).position(|w| w == b"\r\n\r\n")
}

fn content_length(head: &[u8]) -> Option<usize> {
    let text = String::from_utf8_lossy(head);
    text.lines()
        .find(|l| l.to_lowercase().starts_with("content-length:"))
        .and_then(|l| l.split(':').nth(1))
        .and_then(|v| v.trim().parse::<usize>().ok())
}

fn mint_grant(port: u16) -> terminus_secrets::ConnectorGrant {
    let issuer = GrantIssuer::new(KEY.to_vec());
    issuer
        .mint(
            WorkloadIdentity {
                workload_id: "wl-1".into(),
                principal: "agent-a".into(),
                task_id: "task-1".into(),
            },
            SECRET_URI,
            CREDENTIAL,
            binding(port),
            300,
            1,
        )
        .unwrap()
}

#[tokio::test]
async fn happy_path_injects_credential_and_returns_receipt() {
    let (broker, port, listener) = fixture_stack().await;
    let grant = mint_grant(port);
    let op = operation("/repos/acme/widget/pulls", port);

    let server = tokio::spawn(serve_once(
        listener,
        b"HTTP/1.1 201 Created\r\nContent-Length: 2\r\n\r\nok".to_vec(),
    ));
    let response = broker.execute(&op, &grant).await.unwrap();
    let receipt = response.receipt;
    let request_bytes = server.await.unwrap();

    assert_eq!(receipt.outcome, Outcome::Accepted);
    assert_eq!(receipt.status_code, Some(201));
    assert_eq!(receipt.task_id, "task-1");
    assert_eq!(receipt.effect_id, "eff-1");
    assert_eq!(receipt.request_bytes, op.body.len());
    assert_eq!(receipt.response_bytes, response.body.len());

    let sent = String::from_utf8_lossy(&request_bytes);
    // Credential injected into the exact bound request...
    assert!(sent.contains("Authorization: Bearer canary-ghp_ABCDEF_1234567890"));
    assert!(sent.starts_with("POST /repos/acme/widget/pulls"));
    // ...and never present in the receipt.
    let receipt_json = serde_json::to_string(&receipt).unwrap();
    assert!(!receipt_json.contains("canary"));
}

#[tokio::test]
async fn replayed_grant_rejected_after_first_use() {
    let (broker, port, listener) = fixture_stack().await;
    let grant = mint_grant(port);
    let op = operation("/repos/acme/widget/pulls", port);

    let server = tokio::spawn(serve_once(
        listener,
        b"HTTP/1.1 201 Created\r\nContent-Length: 2\r\n\r\nok".to_vec(),
    ));
    broker.execute(&op, &grant).await.unwrap();
    server.await.unwrap();

    let second = broker.execute(&op, &grant).await;
    assert!(
        matches!(
            second,
            Err(terminus_connector::ConnectorError::Credential(
                terminus_secrets::SecretError::CapabilityRevoked(_)
            ))
        ),
        "replay must fail"
    );
}

#[tokio::test]
async fn path_outside_class_rejected_before_dispatch() {
    let (broker, port, _listener) = fixture_stack().await;
    let grant = mint_grant(port);
    let op = operation("/admin/settings", port);
    let err = broker.execute(&op, &grant).await.unwrap_err();
    assert!(matches!(
        err,
        terminus_connector::ConnectorError::BindingMismatch(_)
    ));
}

#[tokio::test]
async fn method_change_rejected() {
    let (broker, port, _listener) = fixture_stack().await;
    let grant = mint_grant(port);
    let mut op = operation("/repos/acme/widget/pulls", port);
    op.method = "DELETE".into();
    let err = broker.execute(&op, &grant).await.unwrap_err();
    assert!(matches!(
        err,
        terminus_connector::ConnectorError::BindingMismatch(_)
    ));
}

#[tokio::test]
async fn https_uses_tls_and_records_plaintext_peer_failure_as_uncertain() {
    let (broker, port, _listener) = fixture_stack().await;
    // The fixture is deliberately plaintext. An HTTPS operation must attempt
    // a validated TLS handshake and record the consumed dispatch as uncertain.
    let issuer = GrantIssuer::new(KEY.to_vec());
    let mut https_binding = binding(port);
    https_binding.scheme = "https".into();
    let grant = issuer
        .mint(
            WorkloadIdentity {
                workload_id: "wl-1".into(),
                principal: "agent-a".into(),
                task_id: "task-1".into(),
            },
            SECRET_URI,
            CREDENTIAL,
            https_binding,
            300,
            1,
        )
        .unwrap();
    let mut op = operation("/repos/acme/widget/pulls", port);
    op.scheme = "https".into();
    let response = broker.execute(&op, &grant).await.unwrap();
    assert_eq!(response.receipt.outcome, Outcome::DispatchUncertain);
    assert_eq!(response.receipt.status_code, None);
}

#[tokio::test]
async fn https_request_budget_failure_is_not_dispatched() {
    let (broker, port, _listener) = fixture_stack_with_budget(1).await;
    let issuer = GrantIssuer::new(KEY.to_vec());
    let grant = issuer
        .mint(
            WorkloadIdentity {
                workload_id: "wl-1".into(),
                principal: "agent-a".into(),
                task_id: "task-1".into(),
            },
            SECRET_URI,
            CREDENTIAL,
            binding_for_scheme(port, "https"),
            300,
            1,
        )
        .unwrap();
    let mut op = operation("/repos/acme/widget/pulls", port);
    op.scheme = "https".into();

    let response = broker.execute(&op, &grant).await.unwrap();

    assert_eq!(response.receipt.outcome, Outcome::NotDispatched);
    assert_eq!(response.receipt.status_code, None);
}

#[tokio::test]
async fn scheme_substitution_rejected_by_binding() {
    let (broker, port, _listener) = fixture_stack().await;
    let grant = mint_grant(port);
    let mut rogue = operation("/repos/acme/widget/pulls", port);
    rogue.scheme = "https".into();
    let err = broker.execute(&rogue, &grant).await.unwrap_err();
    assert!(matches!(
        err,
        terminus_connector::ConnectorError::BindingMismatch(_)
    ));
}

#[tokio::test]
async fn cross_destination_rejected_before_dns_or_consumption() {
    let (broker, port, _listener) = fixture_stack().await;
    let grant = mint_grant(port);
    let mut rogue = operation("/repos/acme/widget/pulls", port);
    rogue.host = "evil.example.com".into();
    let err = broker.execute(&rogue, &grant).await.unwrap_err();
    assert!(
        matches!(err, terminus_connector::ConnectorError::BindingMismatch(_)),
        "destination substitution must hit the binding check first"
    );
}

#[tokio::test]
async fn egress_deny_blocks_before_consumption() {
    // Same grant/op agreement as the happy path, but the egress policy
    // allows nothing: the L4 layer independently refuses, and the grant
    // store shows zero consumption.
    let port = 59999;
    let secret_broker = Arc::new(SecretBroker::new());
    let provider = Arc::new(InMemoryProvider::new());
    provider.register(SECRET_URI, CREDENTIAL.to_vec());
    secret_broker.register_provider("github", provider);

    let grants = Arc::new(GrantStore::new());
    let deny_all = EgressPolicy {
        default_deny: true,
        destinations: vec![],
        deny_private_ips: true,
    };
    let broker = ConnectorBroker::builder(
        secret_broker,
        Arc::clone(&grants),
        Arc::new(EgressProxy::new(
            deny_all,
            RateLimit {
                bytes_per_second: 1_000_000,
                max_total_bytes: 1_000_000,
            },
        )),
        KEY,
    )
    .connector("fixture-api", AuthStyle::Bearer)
    .build();

    let grant = mint_grant(port);
    let op = operation("/repos/acme/widget/pulls", port);
    let err = broker.execute(&op, &grant).await.unwrap_err();
    assert!(matches!(err, terminus_connector::ConnectorError::Egress(_)));
    assert_eq!(
        grants.consumed_count(),
        0,
        "refused dispatch must not consume the grant"
    );
}

#[tokio::test]
async fn request_budget_failure_is_not_dispatched() {
    let (broker, port, _listener) = fixture_stack_with_budget(1).await;
    let grant = mint_grant(port);
    let response = broker
        .execute(&operation("/repos/acme/widget/pulls", port), &grant)
        .await
        .unwrap();

    assert_eq!(response.receipt.outcome, Outcome::NotDispatched);
    assert_eq!(response.receipt.status_code, None);
}

#[tokio::test]
async fn credential_digest_mismatch_detected() {
    let (broker, port, _listener) = fixture_stack().await;
    // Mint against material that does not match what the provider holds —
    // the rotation case. The broker must refuse before dispatch.
    let issuer = GrantIssuer::new(KEY.to_vec());
    let stale = issuer
        .mint(
            WorkloadIdentity {
                workload_id: "wl-1".into(),
                principal: "agent-a".into(),
                task_id: "task-1".into(),
            },
            SECRET_URI,
            b"different-material",
            binding(port),
            300,
            1,
        )
        .unwrap();
    let op = operation("/repos/acme/widget/pulls", port);
    let err = broker.execute(&op, &stale).await.unwrap_err();
    assert!(matches!(
        err,
        terminus_connector::ConnectorError::Credential(
            terminus_secrets::SecretError::InvalidGrant(_)
        )
    ));
}

#[tokio::test]
async fn echoed_credential_redacted_from_response() {
    let (broker, port, listener) = fixture_stack().await;
    let grant = mint_grant(port);
    let op = operation("/repos/acme/widget/pulls", port);
    let echo_body = format!(
        "token={{\"access_token\":\"{}\"}}\n",
        String::from_utf8(CREDENTIAL.to_vec()).unwrap()
    );
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
        echo_body.len()
    );
    let mut response = head.into_bytes();
    response.extend_from_slice(echo_body.as_bytes());

    let server = tokio::spawn(serve_once(listener, response));
    let response = broker.execute(&op, &grant).await.unwrap();
    let receipt = response.receipt;
    let _ = server.await.unwrap();

    assert_eq!(receipt.outcome, Outcome::Accepted);
    assert!(
        receipt.response_redactions >= 1,
        "echoed credential must be scrubbed before hashing/storage"
    );
}
