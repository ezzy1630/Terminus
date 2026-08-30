//! Kernel-level streaming and cancellation for CREDENTIALED connector
//! dispatch (Harness audit 2026-08-29, Phase 0 item 8).
//!
//! Before this, `ConnectorService::execute_streaming` degraded any grant with
//! a non-empty secret URI to the buffered `execute` path and handed the sink
//! one chunk after the fact, because credential-echo redaction only ran on
//! the complete body. Time-to-first-token therefore equalled
//! time-to-last-token for every provider call, and a stop button could not
//! reach the provider.
//!
//! Proven here, through the real `ConnectorService` (capability check, grant
//! consumption, egress authorization, receipt):
//! 1. a credentialed stream delivers its first body chunk before the upstream
//!    has finished writing the body;
//! 2. the response head (status + allowlisted headers) reaches the sink
//!    before the first body byte;
//! 3. a credential echoed back and split across two TCP writes is still
//!    redacted, and the streamed bytes equal the scrubbed buffered body;
//! 4. cancelling mid-stream tears the connection down promptly and settles
//!    the call with the `Cancelled` error code (gRPC `CANCELLED`).

#![allow(clippy::unwrap_used, clippy::expect_used)]
#![cfg(test)]

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tempfile::tempdir;
use terminus_authz::{OperationClass, Scope, TokenBinder};
use terminus_connector::{
    CancelToken, CanonicalOperation, ChunkSink, ConnectorError, ResponseHead,
};
use terminus_egress::{DestinationPolicy, EgressPolicy, RateLimit};
use terminus_kernel::KernelHandle;
use terminus_kernel_protocol::RequestContext;
use terminus_secrets::{GrantBinding, InMemoryProvider};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const SECRET_URI: &str = "secret://fixture/stream-canary";
const CREDENTIAL: &str = "canary-credential-not-a-secret";
const SSE_HEAD: &[u8] =
    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nx-request-id: req-42\r\nConnection: close\r\n\r\n";

type SinkFuture<'a> =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), ConnectorError>> + Send + 'a>>;

#[derive(Clone, Default)]
struct Recorder {
    head: Arc<Mutex<Option<ResponseHead>>>,
    head_before_body: Arc<Mutex<bool>>,
    chunks: Arc<Mutex<Vec<Vec<u8>>>>,
    first_chunk_at: Arc<Mutex<Option<Instant>>>,
    cancel_on_first_chunk: Option<CancelToken>,
}

impl Recorder {
    fn body(&self) -> Vec<u8> {
        self.chunks.lock().unwrap().concat()
    }
}

impl ChunkSink for Recorder {
    fn on_head(&mut self, head: ResponseHead) -> SinkFuture<'_> {
        let slot = self.head.clone();
        let ordering = self.head_before_body.clone();
        let chunks = self.chunks.clone();
        Box::pin(async move {
            *ordering.lock().unwrap() = chunks.lock().unwrap().is_empty();
            *slot.lock().unwrap() = Some(head);
            Ok(())
        })
    }

    fn on_chunk(&mut self, bytes: &[u8]) -> SinkFuture<'_> {
        let payload = bytes.to_vec();
        let chunks = self.chunks.clone();
        let first = self.first_chunk_at.clone();
        let cancel = self.cancel_on_first_chunk.clone();
        Box::pin(async move {
            {
                let mut guard = first.lock().unwrap();
                if guard.is_none() {
                    *guard = Some(Instant::now());
                }
            }
            chunks.lock().unwrap().push(payload);
            if let Some(token) = cancel {
                token.cancel();
            }
            Ok(())
        })
    }
}

struct Fixture {
    kernel: KernelHandle,
    _dir: tempfile::TempDir,
    listener: Option<TcpListener>,
    port: u16,
}

async fn fixture() -> Fixture {
    let dir = tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let kernel = KernelHandle::new_with_egress_policy(
        dir.path().to_path_buf(),
        EgressPolicy {
            default_deny: true,
            destinations: vec![DestinationPolicy {
                allowed_host_suffixes: vec!["localhost".to_string()],
                allowed_ports: vec![port],
                allowed_schemes: vec!["http".to_string()],
            }],
            // Loopback fixture; the L7 grant binding is the authority here.
            deny_private_ips: false,
        },
        RateLimit {
            bytes_per_second: 10_000_000,
            max_total_bytes: 10_000_000,
        },
    )
    .unwrap();
    let provider = Arc::new(InMemoryProvider::new());
    provider.register(SECRET_URI, CREDENTIAL.as_bytes().to_vec());
    kernel
        .secrets
        .broker()
        .register_provider("fixture", provider);
    kernel
        .connectors
        .register_descriptor(
            "fixture-stream",
            terminus_connector::ConnectorDescriptor::new(terminus_connector::AuthStyle::Bearer)
                .with_response_headers(["x-request-id", "retry-after"]),
        )
        .unwrap();
    Fixture {
        kernel,
        _dir: dir,
        listener: Some(listener),
        port,
    }
}

fn binder() -> TokenBinder {
    TokenBinder {
        principal: "stream-principal".to_string(),
        session_id: "stream-session".to_string(),
        task_id: "stream-task".to_string(),
        workspace_id: "stream-ws".to_string(),
        kernel_instance_id: String::new(),
    }
}

fn ctx(token: &str) -> RequestContext {
    let mut ctx = RequestContext::new("stream-request");
    ctx.capability_token = token.to_string();
    ctx.task_id = "stream-task".to_string();
    ctx.actor_id = "stream-principal".to_string();
    ctx.session_id = "stream-session".to_string();
    ctx.workspace_id = "stream-ws".to_string();
    ctx
}

fn token(fx: &Fixture, nonce: &str) -> String {
    fx.kernel
        .token_issuer
        .mint(
            binder(),
            vec![OperationClass::Secret, OperationClass::Network],
            Scope {
                workspace_paths: Vec::new(),
                network_destinations: vec![format!("localhost:{}", fx.port)],
                secret_capabilities: vec![SECRET_URI.to_string()],
            },
            None,
            nonce,
        )
        .and_then(|t| t.encode())
        .unwrap()
}

fn binding(fx: &Fixture, effect: &str) -> GrantBinding {
    GrantBinding {
        connector_id: "fixture-stream".into(),
        destination_host: "localhost".into(),
        destination_port: fx.port,
        scheme: "http".into(),
        method: "POST".into(),
        path_class: "/v1/messages".into(),
        task_id: "stream-task".into(),
        effect_id: effect.into(),
        allowed_hosts: Vec::new(),
    }
}

fn operation(fx: &Fixture) -> CanonicalOperation {
    CanonicalOperation {
        method: "POST".into(),
        scheme: "http".into(),
        host: "localhost".into(),
        port: fx.port,
        path: "/v1/messages".into(),
        query: String::new(),
        headers: Vec::new(),
        body: br#"{"stream":true}"#.to_vec(),
    }
}

/// Mint a real connector grant through the kernel's `ConnectorService`.
fn grant(fx: &Fixture, capability: &str, effect: &str) -> terminus_secrets::ConnectorGrant {
    fx.kernel
        .connectors
        .mint_grant(&ctx(capability), SECRET_URI, binding(fx, effect), 300, 1)
        .unwrap()
}

/// Serve one request, then write `pieces` with `gap` between them and close.
/// Returns the instant the last piece hit the socket.
async fn serve_pieces(listener: TcpListener, pieces: Vec<Vec<u8>>, gap: Duration) -> Instant {
    let (mut sock, _) = listener.accept().await.unwrap();
    drain_request(&mut sock).await;
    sock.write_all(SSE_HEAD).await.unwrap();
    for (index, piece) in pieces.iter().enumerate() {
        if index > 0 {
            tokio::time::sleep(gap).await;
        }
        sock.write_all(piece).await.unwrap();
        sock.flush().await.unwrap();
    }
    let done = Instant::now();
    drop(sock);
    done
}

/// Serve one request, write a single event, then report how long it took to
/// observe the client's disconnect.
async fn serve_then_await_disconnect(listener: TcpListener) -> Duration {
    let (mut sock, _) = listener.accept().await.unwrap();
    drain_request(&mut sock).await;
    sock.write_all(SSE_HEAD).await.unwrap();
    sock.write_all(b"event: delta\ndata: {\"index\":0,\"text\":\"first of many tokens\"}\n\n")
        .await
        .unwrap();
    sock.flush().await.unwrap();
    let wrote_at = Instant::now();
    let mut buf = [0u8; 4096];
    loop {
        match sock.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
    }
    wrote_at.elapsed()
}

async fn drain_request(sock: &mut tokio::net::TcpStream) {
    let mut buf = [0u8; 16384];
    let mut raw = Vec::new();
    loop {
        let n = sock.read(&mut buf).await.unwrap();
        if n == 0 {
            break;
        }
        raw.extend_from_slice(&buf[..n]);
        if let Some(pos) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&raw[..pos]).to_lowercase();
            let length = head
                .lines()
                .find(|line| line.starts_with("content-length:"))
                .and_then(|line| line.split(':').nth(1))
                .and_then(|value| value.trim().parse::<usize>().ok())
                .unwrap_or(0);
            if raw.len() >= pos + 4 + length {
                break;
            }
        }
    }
}

#[tokio::test]
async fn a_credentialed_stream_reaches_the_sink_before_the_body_completes() {
    let mut fx = fixture().await;
    let listener = fx.listener.take().unwrap();
    let capability = token(&fx, "stream-nonce-1");
    let grant = grant(&fx, &capability, "eff-stream-1");
    let op = operation(&fx);

    let first = b"event: delta\ndata: {\"index\":0,\"text\":\"hello\"}\n\n".to_vec();
    let second = b"event: done\ndata: [DONE]\n\n".to_vec();
    let gap = Duration::from_millis(600);
    let server = tokio::spawn(serve_pieces(
        listener,
        vec![first.clone(), second.clone()],
        gap,
    ));

    let mut recorder = Recorder::default();
    let started = Instant::now();
    let response = fx
        .kernel
        .connectors
        .execute_streaming(
            &ctx(&capability),
            &op,
            &grant,
            &mut recorder,
            &CancelToken::new(),
        )
        .await
        .unwrap();
    let total = started.elapsed();
    let last_write = server.await.unwrap();

    let first_at = recorder
        .first_chunk_at
        .lock()
        .unwrap()
        .expect("the sink received a body chunk");
    assert!(
        first_at < last_write,
        "the kernel must forward bytes before the upstream finished the body"
    );
    assert!(
        first_at.duration_since(started) < gap,
        "time-to-first-chunk was {:?}; the whole call took {total:?}",
        first_at.duration_since(started)
    );

    // Metadata first: status and allowlisted headers, before any body byte.
    assert!(*recorder.head_before_body.lock().unwrap());
    let head = recorder.head.lock().unwrap().clone().expect("head");
    assert_eq!(head.status_code, 200);
    assert!(head.is_event_stream());
    assert!(head
        .headers
        .iter()
        .any(|(name, value)| name == "x-request-id" && value == "req-42"));

    let mut expected = first;
    expected.extend_from_slice(&second);
    assert_eq!(recorder.body(), expected);
    assert_eq!(response.body, expected);
    assert_eq!(response.receipt.status_code, Some(200));
    // The same headers are on the terminal receipt for the buffered path.
    assert!(response
        .receipt
        .response_headers
        .iter()
        .any(|(name, _)| name == "x-request-id"));
}

#[tokio::test]
async fn an_echoed_credential_split_across_writes_is_redacted_in_the_stream() {
    let mut fx = fixture().await;
    let listener = fx.listener.take().unwrap();
    let capability = token(&fx, "stream-nonce-2");
    let grant = grant(&fx, &capability, "eff-stream-2");
    let op = operation(&fx);

    let event = format!("event: echo\ndata: {{\"seen\":\"{CREDENTIAL}\"}}\n\n");
    let cut = event.find(CREDENTIAL).unwrap() + CREDENTIAL.len() / 2;
    let server = tokio::spawn(serve_pieces(
        listener,
        vec![
            event.as_bytes()[..cut].to_vec(),
            event.as_bytes()[cut..].to_vec(),
        ],
        Duration::from_millis(80),
    ));

    let mut recorder = Recorder::default();
    let response = fx
        .kernel
        .connectors
        .execute_streaming(
            &ctx(&capability),
            &op,
            &grant,
            &mut recorder,
            &CancelToken::new(),
        )
        .await
        .unwrap();
    let _ = server.await.unwrap();

    let streamed = String::from_utf8_lossy(&recorder.body()).to_string();
    assert!(
        !streamed.contains(CREDENTIAL),
        "the credential straddled a chunk boundary and leaked: {streamed}"
    );
    assert!(streamed.contains("***REDACTED:"), "no marker: {streamed}");
    // Streamed bytes are byte-identical to the scrubbed buffered body.
    assert_eq!(recorder.body(), response.body);
    assert!(response.receipt.response_redactions >= 1);
}

#[tokio::test]
async fn cancelling_mid_stream_settles_as_cancelled_and_drops_the_connection() {
    let mut fx = fixture().await;
    let listener = fx.listener.take().unwrap();
    let capability = token(&fx, "stream-nonce-3");
    let grant = grant(&fx, &capability, "eff-stream-3");
    let op = operation(&fx);

    let server = tokio::spawn(serve_then_await_disconnect(listener));
    let cancel = CancelToken::new();
    let mut recorder = Recorder {
        cancel_on_first_chunk: Some(cancel.clone()),
        ..Default::default()
    };

    let result = fx
        .kernel
        .connectors
        .execute_streaming(&ctx(&capability), &op, &grant, &mut recorder, &cancel)
        .await;
    let disconnect_after = tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .expect("the fixture observed the disconnect")
        .unwrap();

    let error = result.expect_err("a cancelled stream must not settle Ok");
    assert_eq!(
        error.code(),
        terminus_kernel_protocol::ErrorCode::Cancelled,
        "cancellation must carry the Cancelled code so the transport answers gRPC CANCELLED"
    );
    assert!(
        disconnect_after < Duration::from_secs(1),
        "the upstream must observe the disconnect promptly, took {disconnect_after:?}"
    );
    assert!(
        !recorder.chunks.lock().unwrap().is_empty(),
        "the test must cancel MID-stream, not before dispatch"
    );
}
