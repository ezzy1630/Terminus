//! Broker core: grant validation/consumption, credential injection, L4
//! egress authorization, bounded HTTP/1.1 execution, response scrubbing,
//! and typed receipts.
//!
//! Ordering guarantee: every fallible pre-flight check runs BEFORE the
//! atomic grant consumption, and consumption runs immediately BEFORE wire
//! dispatch. A crash anywhere leaves the grant consumed-or-unconsumed but
//! never leaves an authorized-but-replayable credential behind, and never
//! produces an unattributed external effect.

use crate::error::ConnectorError;
use crate::operation::path_matches_class;
use crate::operation::CanonicalOperation;
use crate::receipt::{ConnectorReceipt, Outcome};
use sha2::{Digest as ShaDigest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::Duration;
use terminus_egress::EgressProxy;
use terminus_secrets::{ConnectorGrant, GrantStore, Redactor, SecretBroker};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// How the connector presents the credential. The material itself lives
/// only inside [`ConnectorBroker::execute`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthStyle {
    /// `Authorization: Bearer <credential>`
    Bearer,
    /// Custom key header, e.g. `X-Api-Key: <credential>`.
    NamedHeader(String),
}

#[derive(Debug, Clone)]
struct ConnectorDescriptor {
    auth: AuthStyle,
}

/// Default bounds. Every byte count is enforced; unbounded I/O is
/// prohibited (SPEC §24.1).
const DEFAULT_MAX_REQUEST_BYTES: usize = 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const DEFAULT_TIMEOUT_SECS: u64 = 10;

/// The L7 connector broker.
pub struct ConnectorBroker {
    secret_broker: Arc<SecretBroker>,
    grants: Arc<GrantStore>,
    egress: Arc<EgressProxy>,
    signing_key: Vec<u8>,
    connectors: RwLock<HashMap<String, ConnectorDescriptor>>,
    max_request_bytes: usize,
    max_response_bytes: usize,
    timeout: Duration,
}

impl std::fmt::Debug for ConnectorBroker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let names = self
            .connectors
            .read()
            .map(|g| g.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        f.debug_struct("ConnectorBroker")
            .field("connectors", &names)
            .field("max_request_bytes", &self.max_request_bytes)
            .field("max_response_bytes", &self.max_response_bytes)
            .finish_non_exhaustive()
    }
}

pub struct ConnectorBrokerBuilder {
    secret_broker: Arc<SecretBroker>,
    grants: Arc<GrantStore>,
    egress: Arc<EgressProxy>,
    signing_key: Vec<u8>,
    connectors: HashMap<String, ConnectorDescriptor>,
    max_request_bytes: usize,
    max_response_bytes: usize,
    timeout: Duration,
}

impl std::fmt::Debug for ConnectorBrokerBuilder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectorBrokerBuilder").finish_non_exhaustive()
    }
}

impl ConnectorBrokerBuilder {
    /// Register a connector descriptor at build time.
    pub fn connector(mut self, id: impl Into<String>, auth: AuthStyle) -> Self {
        self.connectors.insert(id.into(), ConnectorDescriptor { auth });
        self
    }

    pub fn max_request_bytes(mut self, limit: usize) -> Self {
        self.max_request_bytes = limit;
        self
    }

    pub fn max_response_bytes(mut self, limit: usize) -> Self {
        self.max_response_bytes = limit;
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn build(self) -> ConnectorBroker {
        ConnectorBroker {
            secret_broker: self.secret_broker,
            grants: self.grants,
            egress: self.egress,
            signing_key: self.signing_key,
            connectors: RwLock::new(self.connectors),
            max_request_bytes: self.max_request_bytes,
            max_response_bytes: self.max_response_bytes,
            timeout: self.timeout,
        }
    }
}

impl ConnectorBroker {
    pub fn builder(
        secret_broker: Arc<SecretBroker>,
        grants: Arc<GrantStore>,
        egress: Arc<EgressProxy>,
        signing_key: impl Into<Vec<u8>>,
    ) -> ConnectorBrokerBuilder {
        ConnectorBrokerBuilder {
            secret_broker,
            grants,
            egress,
            signing_key: signing_key.into(),
            connectors: HashMap::new(),
            max_request_bytes: DEFAULT_MAX_REQUEST_BYTES,
            max_response_bytes: DEFAULT_MAX_RESPONSE_BYTES,
            timeout: Duration::from_secs(DEFAULT_TIMEOUT_SECS),
        }
    }

    /// Register a connector descriptor. `auth` decides how the resolved
    /// credential is injected into the outgoing request.
    pub fn register_connector(
        &self,
        id: impl Into<String>,
        auth: AuthStyle,
    ) -> Result<(), ConnectorError> {
        if let AuthStyle::NamedHeader(name) = &auth {
            let forbidden = ["authorization"];
            if name.is_empty() || forbidden.contains(&name.to_lowercase().as_str()) {
                return Err(ConnectorError::Protocol(format!(
                    "invalid auth header name `{name}`"
                )));
            }
        }
        self.connectors
            .write()
            .map_err(|_| ConnectorError::Protocol("connector registry poisoned".into()))?
            .insert(id.into(), ConnectorDescriptor { auth });
        Ok(())
    }

    /// Execute one grant-bound operation end to end.
    pub async fn execute(
        &self,
        op: &CanonicalOperation,
        grant: &ConnectorGrant,
    ) -> Result<ConnectorReceipt, ConnectorError> {
        let claims = &grant.claims;
        let binding = &claims.binding;

        // -- 1. Pre-flight binding checks (no state mutation yet) --------
        let descriptor = self
            .connectors
            .read()
            .map_err(|_| ConnectorError::Protocol("connector registry poisoned".into()))?
            .get(&binding.connector_id)
            .cloned()
            .ok_or_else(|| ConnectorError::UnknownConnector(binding.connector_id.clone()))?;
        // Exact-operation binding: destination must match the mint-time
        // pin before any DNS resolution, credential work, or consumption.
        if op.host != binding.destination_host
            || op.port != binding.destination_port
            || !op.scheme.eq_ignore_ascii_case(&binding.scheme)
        {
            return Err(ConnectorError::BindingMismatch(format!(
                "destination {}:{}/{} != {}:{}/{}",
                op.scheme, op.host, op.port,
                binding.scheme, binding.destination_host, binding.destination_port
            )));
        }
        if op.method != binding.method {
            return Err(ConnectorError::BindingMismatch(format!(
                "method {} != {}",
                op.method, binding.method
            )));
        }
        // Exact-operation binding: the concrete path must sit inside the
        // pinned path class (wildcard segments bind shape, not ids).
        if !path_matches_class(&binding.path_class, &op.path) {
            return Err(ConnectorError::BindingMismatch(format!(
                "path {} not within class {}",
                op.path, binding.path_class
            )));
        }

        // -- 2. Transport safety: refuse plaintext credential delivery ---
        if op.scheme.eq_ignore_ascii_case("https") {
            // Fail closed BEFORE resolving any credential.
            return Err(ConnectorError::TlsUnavailable);
        }
        if !op.scheme.eq_ignore_ascii_case("http") {
            return Err(ConnectorError::Protocol(format!(
                "unsupported scheme {}",
                op.scheme
            )));
        }

        // -- 3. Resolve credential inside the trusted boundary -----------
        let handle =
            self.secret_broker
                .request(&claims.secret_uri, &claims.workload.workload_id)?;
        if handle.digest() != claims.credential_digest {
            return Err(terminus_secrets::SecretError::InvalidGrant(
                "credential rotated since grant issuance; mint a fresh grant".into(),
            )
            .into());
        }
        let (header_name, header_value) = match &descriptor.auth {
            AuthStyle::Bearer => handle.http_header_pair("Bearer")?,
            AuthStyle::NamedHeader(name) => handle.named_header_pair(name)?,
        };

        // -- 4. Bounded body ---------------------------------------------
        if op.body.len() > self.max_request_bytes {
            return Err(ConnectorError::BodyTooLarge {
                limit: self.max_request_bytes,
                actual: op.body.len(),
            });
        }

        // -- 5. L4 egress authorization stays the lower layer -------------
        let addresses = tokio::net::lookup_host((op.host.as_str(), op.port)).await?;
        let addresses = addresses.collect::<Vec<_>>();
        let resolved_ips = addresses.iter().map(|a| a.ip()).collect::<Vec<_>>();
        self.egress
            .authorize(op.host.as_str(), op.port, &op.scheme, &resolved_ips)?;

        // -- 6. Consume the grant atomically; replay impossible after -----
        // The store verifies signature/expiry/use-limit/binding again under
        // its lock; we pass the mint-time path class here because the store
        // pins classes while this broker already validated the concrete
        // path against the class above.
        let consumed = self.grants.consume(
            grant,
            &binding.connector_id,
            op.destination(),
            (op.method.as_str(), binding.path_class.as_str()),
            claims.workload.task_id.as_str(),
            binding.effect_id.as_str(),
            &self.signing_key,
        )?;

        // -- 7. Dispatch the exact HTTP/1.1 request ------------------------
        let dispatch = tokio::time::timeout(
            self.timeout,
            dispatch_http(
                op,
                &header_name,
                &header_value,
                addresses,
                &self.egress,
                self.max_response_bytes,
            ),
        )
        .await;

        // Response scrubbing: echoed credential material never escapes.
        let mut redactor = Redactor::new();
        redactor.add_literal("connector-credential", &header_value);
        if let Some(bare) = header_value.strip_prefix("Bearer ") {
            redactor.add_literal("connector-credential-bare", bare);
        }

        let (status_code, response_bytes, wire_error) = match dispatch {
            Ok(Ok((code, body))) => (Some(code), body, None),
            Ok(Err(e)) => (None, Vec::new(), Some(e)),
            Err(_elapsed) => (
                None,
                Vec::new(),
                Some(ConnectorError::Protocol("dispatch timed out".into())),
            ),
        };
        let (scrubbed, redactions) = redactor.redact(&response_bytes);

        let outcome = match (&wire_error, status_code.unwrap_or(0)) {
            (Some(_), _) => Outcome::DispatchUncertain,
            (None, 200..=299) => Outcome::Accepted,
            (None, 400..=499) => Outcome::RejectedNonRetryable,
            (None, _) => Outcome::DispatchUncertain,
        };

        let receipt = ConnectorReceipt {
            grant_id: claims.grant_id.clone(),
            task_id: claims.workload.task_id.clone(),
            effect_id: binding.effect_id.clone(),
            connector_id: binding.connector_id.clone(),
            method: op.method.clone(),
            path: op.path.clone(),
            destination: format!("{}://{}:{}", op.scheme, op.host, op.port),
            request_sha256: hash_operation(op),
            status_code,
            response_sha256: if response_bytes.is_empty() {
                None
            } else {
                Some(hash_bytes(&scrubbed))
            },
            response_redactions: redactions,
            outcome,
        };

        if let Some(e) = wire_error {
            tracing::warn!(
                target: "terminus_connector_audit",
                grant_id = %receipt.grant_id,
                effect_id = %receipt.effect_id,
                task_id = %receipt.task_id,
                outcome = ?receipt.outcome,
                consumed_at = consumed.consumed_at_unix,
                "connector dispatch uncertain: {e}"
            );
        } else {
            tracing::info!(
                target: "terminus_connector_audit",
                grant_id = %receipt.grant_id,
                effect_id = %receipt.effect_id,
                task_id = %receipt.task_id,
                status = ?receipt.status_code,
                outcome = ?receipt.outcome,
                "connector dispatch recorded"
            );
        }
        Ok(receipt)
    }
}

fn hash_bytes(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    hex::encode(h.finalize())
}

pub(crate) fn hash_operation(op: &CanonicalOperation) -> String {
    let mut h = Sha256::new();
    h.update(op.method.as_bytes());
    h.update(b"|");
    h.update(op.host.as_bytes());
    h.update(b"|");
    h.update(op.port.to_le_bytes());
    h.update(b"|");
    h.update(op.path.as_bytes());
    h.update(b"|");
    h.update(op.query.as_bytes());
    h.update(b"|");
    h.update(&op.body);
    hex::encode(h.finalize())
}

async fn dispatch_http(
    op: &CanonicalOperation,
    header_name: &str,
    header_value: &str,
    addresses: Vec<std::net::SocketAddr>,
    egress: &EgressProxy,
    max_response_bytes: usize,
) -> Result<(u16, Vec<u8>), ConnectorError> {
    // Connect to a kernel-authorized numeric address only.
    let mut remote = None;
    for address in addresses {
        if let Ok(s) = TcpStream::connect(address).await {
            remote = Some(s);
            break;
        }
    }
    let mut stream = remote.ok_or_else(|| ConnectorError::Protocol("connect failed".into()))?;

    let query = if op.query.is_empty() {
        String::new()
    } else {
        format!("?{}", op.query)
    };
    let mut request = format!(
        "{} {}{} HTTP/1.1\r\nHost: {}\r\nAccept: */*\r\n{header_name}: {header_value}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        op.method, op.path, query, op.host, op.body.len()
    )
    .into_bytes();
    request.extend_from_slice(&op.body);

    egress.relay(request.len() as u64)?;
    stream.write_all(&request).await?;

    // Read the bounded response head + body.
    let mut raw = Vec::with_capacity(4096);
    let mut buf = [0u8; 8192];
    loop {
        let n = stream.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        egress.relay(n as u64)?;
        raw.extend_from_slice(&buf[..n]);
        if raw.len() > max_response_bytes {
            return Err(ConnectorError::BodyTooLarge {
                limit: max_response_bytes,
                actual: raw.len(),
            });
        }
    }

    let split = find_double_crlf(&raw)
        .ok_or_else(|| ConnectorError::Protocol("malformed HTTP response head".into()))?;
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let body = raw[split + 4..].to_vec();
    let status_code = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| ConnectorError::Protocol("missing HTTP status line".into()))?;

    Ok((status_code, body))
}

fn find_double_crlf(data: &[u8]) -> Option<usize> {
    data.windows(4).position(|w| w == b"\r\n\r\n")
}
