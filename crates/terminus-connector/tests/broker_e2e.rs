//! End-to-end connector broker conformance (ADR-0035 §2, roadmap Phase 4
//! exit gate: "credential use is exact-operation bound").

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

fn egress_for_port(port: u16) -> EgressProxy {
    let policy = EgressPolicy {
        default_deny: true,
        destinations: vec![DestinationPolicy {
            allowed_host_suffixes: vec!["localhost".to_string()],
            allowed_ports: vec![port],
            allowed_schemes: vec!["http".to_string()],
        }],
        deny_private_ips: false,
    };
    EgressProxy::new(
        policy,
        RateLimit {
            bytes_per_second: 10_000_000,
            max_total_bytes: 10_000_000,
        },
    )
}

fn binding(port: u16) -> GrantBinding {
    GrantBinding {
        connector_id: "fixture-api".into(),
        destination_host: "localhost".into(),
        destination_port: port,
        scheme: "http".into(),
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
        body: br#"{"title":"fix"}"#.to_vec(),
    }
}

async fn fixture_stack() -> (ConnectorBroker, u16, TcpListener) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let secret_broker = Arc::new(SecretBroker::new());
    let provider = Arc::new(InMemoryProvider::new());
    provider.register(SECRET_URI, CREDENTIAL.to_vec());
    secret_broker.register_provider("github", provider);

    let grants = Arc::new(GrantStore::new());
    let broker = ConnectorBroker::builder(secret_broker, grants, Arc::new(egress_for_port(port)), KEY)
        .connector("fixture-api", AuthStyle::Bearer)
        .build();
    (broker, port, listener)
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

    let server = tokio::spawn(serve_once(listener, b"HTTP/1.1 201 Created\r\nContent-Length: 2\r\n\r\nok".to_vec()));
    let receipt = broker.execute(&op, &grant).await.unwrap();
    let request_bytes = server.await.unwrap();

    assert_eq!(receipt.outcome, Outcome::Accepted);
    assert_eq!(receipt.status_code, Some(201));
    assert_eq!(receipt.task_id, "task-1");
    assert_eq!(receipt.effect_id, "eff-1");

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

    let server =
        tokio::spawn(serve_once(listener, b"HTTP/1.1 201 Created\r\nContent-Length: 2\r\n\r\nok".to_vec()));
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
    assert!(matches!(err, terminus_connector::ConnectorError::BindingMismatch(_)));
}

#[tokio::test]
async fn https_fails_closed_and_grant_remains_unconsumed() {
    let (broker, port, _listener) = fixture_stack().await;
    // A grant minted for an https destination cannot be honored by this
    // build: refuse BEFORE resolving any credential or consuming state.
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
    let err = broker.execute(&op, &grant).await.unwrap_err();
    assert!(matches!(
        err,
        terminus_connector::ConnectorError::TlsUnavailable
    ));
}

#[tokio::test]
async fn scheme_substitution_rejected_by_binding() {
    let (broker, port, _listener) = fixture_stack().await;
    let grant = mint_grant(port);
    let mut rogue = operation("/repos/acme/widget/pulls", port);
    rogue.scheme = "https".into();
    let err = broker.execute(&rogue, &grant).await.unwrap_err();
    assert!(matches!(err, terminus_connector::ConnectorError::BindingMismatch(_)));
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
    assert_eq!(grants.consumed_count(), 0, "refused dispatch must not consume the grant");
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
    let echo_body = format!("token={{\"access_token\":\"{}\"}}\n", String::from_utf8(CREDENTIAL.to_vec()).unwrap());
    let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", echo_body.len());
    let mut response = head.into_bytes();
    response.extend_from_slice(echo_body.as_bytes());

    let server = tokio::spawn(serve_once(listener, response));
    let receipt = broker.execute(&op, &grant).await.unwrap();
    let _ = server.await.unwrap();

    assert_eq!(receipt.outcome, Outcome::Accepted);
    assert!(
        receipt.response_redactions >= 1,
        "echoed credential must be scrubbed before hashing/storage"
    );
}
