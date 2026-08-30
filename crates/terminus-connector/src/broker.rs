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
use crate::receipt::{ConnectorReceipt, ConnectorResponse, Outcome};
use crate::stream::{until_cancelled, CancelToken, ResponseHead, StreamingRedactor};
use reqwest::header::{HeaderName, HeaderValue, ACCEPT, USER_AGENT};
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
    /// No credential at all (public endpoints, e.g. the built-in
    /// `web-fetch` connector). Grants still pin host/method/path and are
    /// consumed once; only the credential step is skipped.
    None,
}

/// Async-aware sink for incremental response bodies. Boxing keeps the
/// object-safe signature simple; the hot path (no sink) never allocates.
pub trait ChunkSink: Send {
    /// Delivered exactly once, before the first body byte, with the status
    /// code, content type, and allowlisted response headers. A consumer can
    /// classify the response (rate limits, `x-codex-turn-state`, sticky
    /// routing) without waiting for the terminal receipt. The default
    /// implementation ignores the head.
    fn on_head(
        &mut self,
        head: crate::stream::ResponseHead,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), ConnectorError>> + Send + '_>>
    {
        let _ = head;
        Box::pin(std::future::ready(Ok(())))
    }

    fn on_chunk(
        &mut self,
        bytes: &[u8],
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), ConnectorError>> + Send + '_>>;
}

/// Concrete, lifetime-carrying sink wrapper used on the dispatch path so
/// borrowed sinks flow through nested futures without trait-object lifetime
/// propagation.
///
/// It also owns the incremental credential redaction: bytes handed to
/// `send` are scrubbed here, chunk boundary by chunk boundary, so a
/// credentialed response streams instead of being buffered whole so it can
/// be scrubbed once at the end.
pub struct DispatchSink<'a> {
    inner: Option<&'a mut dyn ChunkSink>,
    redactor: StreamingRedactor,
    cancel: CancelToken,
}

impl std::fmt::Debug for DispatchSink<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DispatchSink")
            .field("streaming", &self.inner.is_some())
            .finish_non_exhaustive()
    }
}

impl<'a> DispatchSink<'a> {
    fn new(
        inner: Option<&'a mut dyn ChunkSink>,
        literals: &[(String, String)],
        cancel: CancelToken,
    ) -> Self {
        Self {
            inner,
            redactor: StreamingRedactor::new(literals),
            cancel,
        }
    }

    /// Forward the response head and decide whether emissions align to SSE
    /// event boundaries.
    pub(crate) async fn head(&mut self, head: ResponseHead) -> Result<(), ConnectorError> {
        self.redactor.align_events(head.is_event_stream());
        match self.inner.as_deref_mut() {
            Some(sink) => sink.on_head(head).await,
            None => Ok(()),
        }
    }

    pub async fn send(&mut self, bytes: &[u8]) -> Result<(), ConnectorError> {
        if self.inner.is_none() {
            return Ok(());
        }
        let scrubbed = self.redactor.push(bytes);
        self.emit(scrubbed).await
    }

    /// Release the carry buffer at end of stream. Anything still withheld
    /// for the straddling-secret window is redacted and emitted here.
    pub(crate) async fn finish(&mut self) -> Result<(), ConnectorError> {
        if self.inner.is_none() {
            return Ok(());
        }
        let scrubbed = self.redactor.flush();
        self.emit(scrubbed).await
    }

    async fn emit(&mut self, scrubbed: Vec<u8>) -> Result<(), ConnectorError> {
        if scrubbed.is_empty() {
            return Ok(());
        }
        if self.cancel.is_cancelled() {
            return Err(ConnectorError::Cancelled);
        }
        match self.inner.as_deref_mut() {
            Some(sink) => sink.on_chunk(&scrubbed).await,
            None => Ok(()),
        }
    }
}

/// How a connector's destination host is decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostPolicy {
    /// The connector always talks to this fixed set of hosts. Exact match or
    /// dot-suffix match (`api.example.com` matches the suffix `example.com`).
    Fixed(Vec<String>),
    /// The host is chosen per stored provider account and pinned in the
    /// grant's `allowed_hosts` at mint time. Dispatch admits only hosts
    /// listed there, so one account never widens another account's reach.
    PerGrant,
}

/// Bounded timeouts for one connector. Long model streams need a large total
/// budget without letting a silent upstream hold the socket open, so the
/// stream is additionally bounded by a gap (first-byte/idle) timeout.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConnectorTimeouts {
    /// Hard ceiling on the whole exchange.
    pub total: Duration,
    /// Maximum gap between response bytes, including the wait for the
    /// response head. `None` keeps only the total-duration bound.
    pub idle: Option<Duration>,
}

impl ConnectorTimeouts {
    pub fn total(total: Duration) -> Self {
        Self { total, idle: None }
    }

    pub fn with_idle(total: Duration, idle: Duration) -> Self {
        Self {
            total,
            idle: Some(idle),
        }
    }
}

/// Per-connector capabilities and bounds (design §4(f)). Everything the
/// broker will inject, admit, return, or refuse for one connector id.
#[derive(Debug, Clone)]
pub struct ConnectorDescriptor {
    /// How the resolved credential is presented.
    pub auth: AuthStyle,
    /// Timeouts; `None` uses the broker default.
    pub timeouts: Option<ConnectorTimeouts>,
    /// Extra request headers the CALLER may set, beyond the global
    /// `accept`/`content-type`/`anthropic-version` allowlist.
    pub allowed_request_headers: Vec<String>,
    /// Headers injected by the broker. Callers can never set or override
    /// these: a caller header with the same name is rejected.
    pub static_headers: Vec<(String, String)>,
    /// Response headers surfaced on the receipt. Exact names, or a trailing
    /// `*` wildcard (`x-codex-*`). Everything else is dropped.
    pub response_headers: Vec<String>,
    /// Per-connector request-body ceiling; `None` uses the broker default.
    pub max_request_bytes: Option<usize>,
    /// Per-connector response-body ceiling; `None` uses the broker default.
    pub max_response_bytes: Option<usize>,
    /// Which destinations this connector may reach.
    pub hosts: HostPolicy,
}

impl ConnectorDescriptor {
    /// A descriptor with no extra capabilities: broker defaults for every
    /// bound, no caller headers beyond the global allowlist, no injected
    /// headers, no response headers surfaced.
    pub fn new(auth: AuthStyle) -> Self {
        Self {
            auth,
            timeouts: None,
            allowed_request_headers: Vec::new(),
            static_headers: Vec::new(),
            response_headers: Vec::new(),
            max_request_bytes: None,
            max_response_bytes: None,
            hosts: HostPolicy::Fixed(Vec::new()),
        }
    }

    #[must_use]
    pub fn with_timeouts(mut self, timeouts: ConnectorTimeouts) -> Self {
        self.timeouts = Some(timeouts);
        self
    }

    #[must_use]
    pub fn with_allowed_request_headers<I, S>(mut self, headers: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.allowed_request_headers = headers
            .into_iter()
            .map(|h| h.into().to_ascii_lowercase())
            .collect();
        self
    }

    #[must_use]
    pub fn with_static_headers<I, N, V>(mut self, headers: I) -> Self
    where
        I: IntoIterator<Item = (N, V)>,
        N: Into<String>,
        V: Into<String>,
    {
        self.static_headers = headers
            .into_iter()
            .map(|(n, v)| (n.into(), v.into()))
            .collect();
        self
    }

    #[must_use]
    pub fn with_response_headers<I, S>(mut self, headers: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.response_headers = headers
            .into_iter()
            .map(|h| h.into().to_ascii_lowercase())
            .collect();
        self
    }

    #[must_use]
    pub fn with_bounds(mut self, max_request_bytes: usize, max_response_bytes: usize) -> Self {
        self.max_request_bytes = Some(max_request_bytes);
        self.max_response_bytes = Some(max_response_bytes);
        self
    }

    #[must_use]
    pub fn with_hosts(mut self, hosts: HostPolicy) -> Self {
        self.hosts = hosts;
        self
    }

    /// Fixed hosts this connector may reach; empty for `PerGrant`.
    pub fn fixed_hosts(&self) -> &[String] {
        match &self.hosts {
            HostPolicy::Fixed(hosts) => hosts.as_slice(),
            HostPolicy::PerGrant => &[],
        }
    }
}

/// Default bounds. Every byte count is enforced; unbounded I/O is
/// prohibited (SPEC §24.1).
const DEFAULT_MAX_REQUEST_BYTES: usize = 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const DEFAULT_TIMEOUT_SECS: u64 = 10;
const CONNECTOR_USER_AGENT: &str = concat!("terminus-connector/", env!("CARGO_PKG_VERSION"));

/// Caller-supplied request headers are bounded in count and size so the
/// header block cannot become an unmetered side channel.
const MAX_REQUEST_HEADERS: usize = 32;
const MAX_REQUEST_HEADER_VALUE_BYTES: usize = 4096;
/// Receipt response-header bounds. Anything larger is dropped and audited
/// rather than truncated.
const MAX_RESPONSE_HEADERS: usize = 32;
/// Matches the request-side bound. Opaque routing tokens such as
/// `x-codex-turn-state` are dropped rather than truncated when oversized, so
/// the bound has to be generous enough that a legitimate value survives.
const MAX_RESPONSE_HEADER_VALUE_BYTES: usize = 4096;

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
        f.debug_struct("ConnectorBrokerBuilder")
            .finish_non_exhaustive()
    }
}

impl ConnectorBrokerBuilder {
    /// Register a connector descriptor at build time.
    pub fn connector(self, id: impl Into<String>, auth: AuthStyle) -> Self {
        self.connector_descriptor(id, ConnectorDescriptor::new(auth))
    }

    /// Register a connector with a bounded timeout distinct from the broker
    /// default. Long-lived model streams need a larger bound than metadata
    /// lookups, while remaining explicitly finite and broker-owned.
    pub fn connector_with_timeout(
        self,
        id: impl Into<String>,
        auth: AuthStyle,
        timeout: Duration,
    ) -> Self {
        self.connector_descriptor(
            id,
            ConnectorDescriptor::new(auth).with_timeouts(ConnectorTimeouts::total(timeout)),
        )
    }

    /// Register a fully specified descriptor: headers, bounds, timeouts, and
    /// host policy in one place.
    pub fn connector_descriptor(
        mut self,
        id: impl Into<String>,
        descriptor: ConnectorDescriptor,
    ) -> Self {
        self.connectors.insert(id.into(), descriptor);
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
        self.register_descriptor(id, ConnectorDescriptor::new(auth))
    }

    /// Register a fully specified descriptor at runtime.
    pub fn register_descriptor(
        &self,
        id: impl Into<String>,
        descriptor: ConnectorDescriptor,
    ) -> Result<(), ConnectorError> {
        if let AuthStyle::NamedHeader(name) = &descriptor.auth {
            let forbidden = ["authorization"];
            if name.is_empty() || forbidden.contains(&name.to_lowercase().as_str()) {
                return Err(ConnectorError::Protocol(format!(
                    "invalid auth header name `{name}`"
                )));
            }
        }
        for (name, value) in &descriptor.static_headers {
            HeaderName::from_bytes(name.as_bytes()).map_err(|_| {
                ConnectorError::Protocol(format!("invalid static header name `{name}`"))
            })?;
            HeaderValue::from_str(value).map_err(|_| {
                ConnectorError::Protocol(format!("invalid static header value for `{name}`"))
            })?;
        }
        self.connectors
            .write()
            .map_err(|_| ConnectorError::Protocol("connector registry poisoned".into()))?
            .insert(id.into(), descriptor);
        Ok(())
    }

    /// Descriptor for a registered connector id.
    pub fn descriptor(&self, id: &str) -> Result<ConnectorDescriptor, ConnectorError> {
        self.connectors
            .read()
            .map_err(|_| ConnectorError::Protocol("connector registry poisoned".into()))?
            .get(id)
            .cloned()
            .ok_or_else(|| ConnectorError::UnknownConnector(id.to_string()))
    }

    /// Union of every registered connector's fixed hosts. The kernel derives
    /// its L4 egress allowlist from this so a registered connector is never
    /// dead on arrival, and an unregistered host is never admitted.
    pub fn registered_hosts(&self) -> Result<std::collections::BTreeSet<String>, ConnectorError> {
        let registry = self
            .connectors
            .read()
            .map_err(|_| ConnectorError::Protocol("connector registry poisoned".into()))?;
        Ok(registry
            .values()
            .flat_map(|descriptor| descriptor.fixed_hosts().iter().cloned())
            .collect())
    }

    /// Return whether a registered connector deliberately omits credentials.
    /// The kernel uses this to keep an empty secret URI bound to an explicit
    /// anonymous connector descriptor rather than to a caller-selected id.
    pub fn is_anonymous_connector(&self, id: &str) -> Result<bool, ConnectorError> {
        let descriptor = self
            .connectors
            .read()
            .map_err(|_| ConnectorError::Protocol("connector registry poisoned".into()))?
            .get(id)
            .cloned()
            .ok_or_else(|| ConnectorError::UnknownConnector(id.to_string()))?;
        Ok(matches!(descriptor.auth, AuthStyle::None))
    }

    /// Execute one grant-bound operation end to end.
    /// Buffered dispatch: identical semantics to `execute_streaming` with a
    /// disabled sink. Prefer `execute` when the caller cannot consume
    /// incrementally.
    pub async fn execute(
        &self,
        op: &CanonicalOperation,
        grant: &ConnectorGrant,
    ) -> Result<ConnectorResponse, ConnectorError> {
        self.execute_with_sink(op, grant, None::<&mut dyn ChunkSink>, &CancelToken::new())
            .await
    }

    /// Incremental dispatch: response body chunks reach the sink as they
    /// arrive — already credential-scrubbed, with a carry buffer spanning
    /// chunk boundaries — while authorization, one-time consumption, bounded
    /// capture, and the returned receipt stay identical to [`Self::execute`].
    ///
    /// `cancel` tears the in-flight request down: the HTTP response is
    /// dropped, the connection closes, and the call returns
    /// [`ConnectorError::Cancelled`].
    pub async fn execute_streaming<S: ChunkSink>(
        &self,
        op: &CanonicalOperation,
        grant: &ConnectorGrant,
        sink: &mut S,
        cancel: &CancelToken,
    ) -> Result<ConnectorResponse, ConnectorError> {
        self.execute_with_sink(op, grant, Some(sink), cancel).await
    }

    async fn execute_with_sink(
        &self,
        op: &CanonicalOperation,
        grant: &ConnectorGrant,
        sink: Option<&mut dyn ChunkSink>,
        cancel: &CancelToken,
    ) -> Result<ConnectorResponse, ConnectorError> {
        // A token that is already cancelled must not consume the grant or
        // touch the wire: nothing has happened yet, so nothing is uncertain.
        if cancel.is_cancelled() {
            return Err(ConnectorError::Cancelled);
        }
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
        let timeouts = descriptor
            .timeouts
            .unwrap_or_else(|| ConnectorTimeouts::total(self.timeout));
        let max_request_bytes = descriptor
            .max_request_bytes
            .unwrap_or(self.max_request_bytes);
        let max_response_bytes = descriptor
            .max_response_bytes
            .unwrap_or(self.max_response_bytes);
        // Exact-operation binding: destination must match the mint-time
        // pin before any DNS resolution, credential work, or consumption.
        if op.host != binding.destination_host
            || op.port != binding.destination_port
            || !op.scheme.eq_ignore_ascii_case(&binding.scheme)
        {
            return Err(ConnectorError::BindingMismatch(format!(
                "destination {}:{}/{} != {}:{}/{}",
                op.scheme,
                op.host,
                op.port,
                binding.scheme,
                binding.destination_host,
                binding.destination_port
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

        // Descriptor host policy + per-account allowlist. `Fixed` connectors
        // may only reach the hosts they were registered with; `PerGrant`
        // connectors may only reach hosts the control plane pinned into this
        // grant, so one provider account never widens another's reach.
        authorize_host(&descriptor, binding, &op.host)?;

        // -- 2. Transport and caller-header safety -------------------------
        if !op.scheme.eq_ignore_ascii_case("http") && !op.scheme.eq_ignore_ascii_case("https") {
            return Err(ConnectorError::Protocol(format!(
                "unsupported scheme {}",
                op.scheme
            )));
        }
        validate_headers(&op.headers, &descriptor)?;

        // -- 3. Resolve credential inside the trusted boundary -----------
        // Anonymous connectors (`AuthStyle::None`) skip this step entirely;
        // every other style resolves the secret and pins its digest.
        let credential: Option<(String, String)> = if matches!(descriptor.auth, AuthStyle::None) {
            None
        } else {
            // `request_async`, never `request`: the OS keychain read behind
            // this is synchronous host work that can park for as long as a
            // SecurityAgent approval prompt is on screen. Resolving it on a
            // tokio worker thread stalls every other task on the runtime and
            // surfaces to the control plane as an unexplained
            // `DEADLINE_EXCEEDED`.
            let handle = self
                .secret_broker
                .request_async(&claims.secret_uri, &claims.workload.workload_id)
                .await?;
            if handle.digest() != claims.credential_digest {
                return Err(terminus_secrets::SecretError::InvalidGrant(
                    "credential rotated since grant issuance; mint a fresh grant".into(),
                )
                .into());
            }
            match &descriptor.auth {
                AuthStyle::Bearer => Some(handle.http_header_pair("Bearer")?),
                AuthStyle::NamedHeader(name) => Some(handle.named_header_pair(name)?),
                AuthStyle::None => None,
            }
        };
        let (header_name, header_value) = match &credential {
            Some(pair) => (pair.0.clone(), pair.1.clone()),
            None => (String::new(), String::new()),
        };

        // -- 4. Bounded body ---------------------------------------------
        if op.body.len() > max_request_bytes {
            return Err(ConnectorError::BodyTooLarge {
                limit: max_request_bytes,
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
        // Response scrubbing: echoed credential material never escapes. The
        // literal set is fixed BEFORE dispatch so the streaming sink can
        // scrub incrementally; the buffered path applies the same set to the
        // captured body below, and the two results are byte-identical.
        let mut literals: Vec<(String, String)> = Vec::new();
        if !header_value.is_empty() {
            literals.push(("connector-credential".to_string(), header_value.clone()));
            if let Some(bare) = header_value.strip_prefix("Bearer ") {
                literals.push(("connector-credential-bare".to_string(), bare.to_string()));
            }
        }
        let streaming = sink.is_some();
        let dispatch_sink = DispatchSink::new(sink, &literals, cancel.clone());
        let dispatch = tokio::time::timeout(timeouts.total, async {
            let ctx = DispatchContext {
                op,
                addresses,
                egress: &self.egress,
                max_response_bytes,
                timeouts,
                static_headers: &descriptor.static_headers,
                response_header_allowlist: &descriptor.response_headers,
                cancel,
            };
            if op.scheme.eq_ignore_ascii_case("https") {
                dispatch_https(ctx, &header_name, &header_value, dispatch_sink).await
            } else {
                dispatch_http(ctx, &header_name, &header_value, dispatch_sink).await
            }
        })
        .await;

        let mut redactor = Redactor::new();
        for (id, literal) in &literals {
            redactor.add_literal(id.clone(), literal.clone());
        }

        let (status_code, response_bytes, content_type, response_headers, wire_error) =
            match dispatch {
                Ok(Ok(outcome)) => (
                    Some(outcome.status_code),
                    outcome.body,
                    outcome.content_type,
                    outcome.response_headers,
                    None,
                ),
                Ok(Err(e)) => (None, Vec::new(), None, Vec::new(), Some(e)),
                Err(_elapsed) => (
                    None,
                    Vec::new(),
                    None,
                    Vec::new(),
                    Some(ConnectorError::Protocol(format!(
                        "dispatch exceeded the connector total-duration bound of {}s",
                        timeouts.total.as_secs()
                    ))),
                ),
            };
        let (scrubbed, redactions) = redactor.redact(&response_bytes);

        let outcome = match (&wire_error, status_code.unwrap_or(0)) {
            (Some(ConnectorError::RequestNotDispatched(_)), _) => Outcome::NotDispatched,
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
            request_bytes: op.body.len(),
            status_code,
            response_sha256: if response_bytes.is_empty() {
                None
            } else {
                Some(hash_bytes(&scrubbed))
            },
            response_bytes: scrubbed.len(),
            response_redactions: redactions,
            outcome,
            response_headers,
        };

        if let Some(e) = wire_error {
            // Either the dispatch loop observed the token, or it lost a
            // race with it between grant consumption and the first await.
            let cancelled = matches!(e, ConnectorError::Cancelled) || cancel.is_cancelled();
            let message = match receipt.outcome {
                Outcome::NotDispatched => "connector dispatch not dispatched",
                _ if cancelled => "connector dispatch cancelled",
                _ => "connector dispatch uncertain",
            };
            tracing::warn!(
                target: "terminus_connector_audit",
                grant_id = %receipt.grant_id,
                effect_id = %receipt.effect_id,
                task_id = %receipt.task_id,
                connector_id = %receipt.connector_id,
                destination = %receipt.destination,
                request_bytes = receipt.request_bytes,
                response_bytes = receipt.response_bytes,
                outcome = ?receipt.outcome,
                streamed = streaming,
                consumed_at = consumed.consumed_at_unix,
                "{message}: {e}"
            );
            // Cancellation is the caller's own decision, not an upstream
            // failure: surface it distinctly so the transport can answer
            // CANCELLED instead of an ambiguous unsettled receipt.
            if cancelled {
                return Err(ConnectorError::Cancelled);
            }
        } else {
            tracing::info!(
                target: "terminus_connector_audit",
                grant_id = %receipt.grant_id,
                effect_id = %receipt.effect_id,
                task_id = %receipt.task_id,
                connector_id = %receipt.connector_id,
                destination = %receipt.destination,
                request_bytes = receipt.request_bytes,
                response_bytes = receipt.response_bytes,
                status = ?receipt.status_code,
                outcome = ?receipt.outcome,
                "connector dispatch recorded"
            );
        }
        Ok(ConnectorResponse {
            receipt,
            body: scrubbed,
            content_type,
        })
    }
}

/// Headers every connector's caller may set.
const GLOBAL_ALLOWED_REQUEST_HEADERS: &[&str] = &["accept", "content-type", "anthropic-version"];

fn validate_headers(
    headers: &[(String, String)],
    descriptor: &ConnectorDescriptor,
) -> Result<(), ConnectorError> {
    if headers.len() > MAX_REQUEST_HEADERS {
        return Err(ConnectorError::Protocol(format!(
            "request carries {} headers; the connector admits at most {MAX_REQUEST_HEADERS}",
            headers.len()
        )));
    }
    for (name, value) in headers {
        let normalized = name.to_ascii_lowercase();
        // Broker-injected headers are never caller-overridable: reject the
        // name outright rather than letting a later insert decide.
        if descriptor
            .static_headers
            .iter()
            .any(|(static_name, _)| static_name.eq_ignore_ascii_case(&normalized))
        {
            return Err(ConnectorError::Protocol(format!(
                "request header `{name}` is injected by the connector and cannot be set by the caller"
            )));
        }
        let admitted = GLOBAL_ALLOWED_REQUEST_HEADERS.contains(&normalized.as_str())
            || descriptor
                .allowed_request_headers
                .iter()
                .any(|allowed| allowed == &normalized);
        if !admitted {
            return Err(ConnectorError::Protocol(format!(
                "request header `{name}` is not admitted"
            )));
        }
        if value.len() > MAX_REQUEST_HEADER_VALUE_BYTES {
            return Err(ConnectorError::Protocol(format!(
                "request header `{name}` value exceeds {MAX_REQUEST_HEADER_VALUE_BYTES} bytes"
            )));
        }
        HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| ConnectorError::Protocol(format!("invalid request header {name}")))?;
        HeaderValue::from_str(value)
            .map_err(|_| ConnectorError::Protocol(format!("invalid value for header {name}")))?;
    }
    Ok(())
}

/// Exact-or-dot-suffix host match, matching the L4 egress semantics.
fn host_matches(host: &str, pattern: &str) -> bool {
    host.eq_ignore_ascii_case(pattern)
        || host
            .to_ascii_lowercase()
            .ends_with(&format!(".{}", pattern.to_ascii_lowercase()))
}

/// Enforce the descriptor host policy and any per-grant account allowlist.
fn authorize_host(
    descriptor: &ConnectorDescriptor,
    binding: &terminus_secrets::GrantBinding,
    host: &str,
) -> Result<(), ConnectorError> {
    match &descriptor.hosts {
        HostPolicy::Fixed(hosts) if !hosts.is_empty() => {
            if !hosts.iter().any(|pattern| host_matches(host, pattern)) {
                return Err(ConnectorError::BindingMismatch(format!(
                    "connector {} does not admit host {host}",
                    binding.connector_id
                )));
            }
        }
        HostPolicy::Fixed(_) => {}
        HostPolicy::PerGrant => {
            if binding.allowed_hosts.is_empty() {
                return Err(ConnectorError::BindingMismatch(format!(
                    "connector {} requires a per-account allowed_hosts list on the grant",
                    binding.connector_id
                )));
            }
        }
    }
    // A non-empty per-grant list narrows further for every host policy.
    if !binding.allowed_hosts.is_empty()
        && !binding
            .allowed_hosts
            .iter()
            .any(|pattern| host_matches(host, pattern))
    {
        return Err(ConnectorError::BindingMismatch(format!(
            "host {host} is not in the grant's account host allowlist"
        )));
    }
    Ok(())
}

/// Response header names that are NEVER surfaced, whatever a descriptor
/// lists. Credential and session material must not cross the boundary even
/// by a mis-specified allowlist.
const RESPONSE_HEADER_DENYLIST: &[&str] = &[
    "authorization",
    "proxy-authorization",
    "set-cookie",
    "set-cookie2",
    "www-authenticate",
    "proxy-authenticate",
];

/// Does a response header name match an allowlist entry? Entries are exact
/// lowercase names or a trailing-`*` prefix (`x-codex-*`). The denylist wins
/// over every allowlist entry, including a wildcard.
fn response_header_admitted(name: &str, allowlist: &[String]) -> bool {
    if RESPONSE_HEADER_DENYLIST.contains(&name) {
        return false;
    }
    allowlist
        .iter()
        .any(|pattern| match pattern.strip_suffix('*') {
            Some(prefix) => name.starts_with(prefix),
            None => name == pattern,
        })
}

/// Project the upstream response headers onto the connector's allowlist.
/// Values are bounded; anything oversized is dropped and audited rather than
/// truncated into a misleading value.
fn filter_response_headers(
    headers: &reqwest::header::HeaderMap,
    allowlist: &[String],
) -> Vec<(String, String)> {
    if allowlist.is_empty() {
        return Vec::new();
    }
    let mut admitted = Vec::new();
    for (name, value) in headers {
        if admitted.len() >= MAX_RESPONSE_HEADERS {
            tracing::warn!(
                target: "terminus_connector_audit",
                "response header allowlist matched more than {MAX_RESPONSE_HEADERS} headers; \
                 the remainder were dropped"
            );
            break;
        }
        let lowered = name.as_str().to_ascii_lowercase();
        if !response_header_admitted(&lowered, allowlist) {
            continue;
        }
        let Ok(text) = value.to_str() else {
            continue;
        };
        if text.len() > MAX_RESPONSE_HEADER_VALUE_BYTES {
            tracing::warn!(
                target: "terminus_connector_audit",
                header = %lowered,
                bytes = text.len(),
                "dropped an allowlisted response header whose value exceeded the bound"
            );
            continue;
        }
        admitted.push((lowered, text.to_string()));
    }
    admitted
}

/// What one dispatch produced. Response headers are already filtered to the
/// connector's allowlist.
struct DispatchOutcome {
    status_code: u16,
    body: Vec<u8>,
    content_type: Option<String>,
    response_headers: Vec<(String, String)>,
}

/// Parameters shared by the HTTP/HTTPS dispatch paths (clippy arg budget).
struct DispatchContext<'a> {
    op: &'a CanonicalOperation,
    addresses: Vec<std::net::SocketAddr>,
    egress: &'a EgressProxy,
    max_response_bytes: usize,
    timeouts: ConnectorTimeouts,
    static_headers: &'a [(String, String)],
    response_header_allowlist: &'a [String],
    /// Torn down by the caller: every await in the dispatch loop races it,
    /// so cancelling drops the response and closes the connection instead
    /// of letting an unread completion run to the total-duration bound.
    cancel: &'a CancelToken,
}

/// Bound one await by the connector's idle (gap) timeout when configured.
async fn within_idle<T, F>(
    timeouts: ConnectorTimeouts,
    what: &str,
    future: F,
) -> Result<T, ConnectorError>
where
    F: std::future::Future<Output = Result<T, ConnectorError>>,
{
    match timeouts.idle {
        Some(idle) => match tokio::time::timeout(idle, future).await {
            Ok(result) => result,
            Err(_) => Err(ConnectorError::Protocol(format!(
                "{what} exceeded the connector idle bound of {}s",
                idle.as_secs()
            ))),
        },
        None => future.await,
    }
}

async fn dispatch_https(
    ctx: DispatchContext<'_>,
    credential_header_name: &str,
    credential_header_value: &str,
    mut sink: DispatchSink<'_>,
) -> Result<DispatchOutcome, ConnectorError> {
    let DispatchContext {
        op,
        addresses,
        egress,
        max_response_bytes,
        timeouts,
        static_headers,
        response_header_allowlist,
        cancel,
    } = ctx;
    if cancel.is_cancelled() {
        return Err(ConnectorError::RequestNotDispatched(
            "cancelled before dispatch".to_string(),
        ));
    }
    // The reqwest-level timeout stays the TOTAL bound. Streaming responses
    // are additionally bounded per gap by `within_idle` below, so a silent
    // upstream cannot hold the socket for the whole total budget.
    let connect_timeout = timeouts.idle.unwrap_or(timeouts.total);
    let client = reqwest::Client::builder()
        .https_only(true)
        .no_proxy()
        .connect_timeout(connect_timeout)
        .timeout(timeouts.total)
        .resolve_to_addrs(&op.host, &addresses)
        .build()
        .map_err(|error| ConnectorError::Protocol(format!("TLS client setup failed: {error}")))?;
    let url = if op.query.is_empty() {
        format!("https://{}:{}{}", op.host, op.port, op.path)
    } else {
        format!("https://{}:{}{}?{}", op.host, op.port, op.path, op.query)
    };
    let method = reqwest::Method::from_bytes(op.method.as_bytes())
        .map_err(|_| ConnectorError::Protocol("invalid HTTP method".to_string()))?;
    let mut request = client.request(method, url);
    if !credential_header_name.is_empty() {
        let credential_name = HeaderName::from_bytes(credential_header_name.as_bytes())
            .map_err(|_| ConnectorError::Protocol("invalid credential header".to_string()))?;
        let credential_value = HeaderValue::from_str(credential_header_value)
            .map_err(|_| ConnectorError::Protocol("invalid credential value".to_string()))?;
        request = request.header(credential_name, credential_value);
    }
    for (name, value) in &op.headers {
        request = request.header(name, value);
    }
    let mut request = request.body(op.body.clone()).build().map_err(|error| {
        ConnectorError::Protocol(format!("HTTPS request setup failed: {error}"))
    })?;
    // Broker-injected identity headers overwrite anything already present:
    // caller headers with these names were rejected in `validate_headers`,
    // so this insert is the single authority for their value.
    inject_static_headers(request.headers_mut(), static_headers)?;
    ensure_request_defaults(&mut request);
    let request_bytes = serialized_request_bytes(&request, op.body.len())
        .map_err(|error| ConnectorError::RequestNotDispatched(error.to_string()))?;
    reserve_request_exact(egress, request_bytes)?;
    let mut response = within_idle(
        timeouts,
        "waiting for the response head",
        until_cancelled(cancel, async {
            client.execute(request).await.map_err(|error| {
                ConnectorError::Protocol(format!("HTTPS dispatch failed: {error}"))
            })
        }),
    )
    .await?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(ToString::to_string);
    let response_headers = filter_response_headers(response.headers(), response_header_allowlist);
    // Metadata first: the consumer classifies status and rate-limit/routing
    // headers before a single body byte, instead of at the terminal receipt.
    sink.head(ResponseHead {
        status_code: status,
        content_type: content_type.clone(),
        headers: response_headers.clone(),
    })
    .await?;
    let mut body = Vec::new();
    loop {
        // The idle bound is per CHUNK and covers only the wait for upstream
        // bytes; the sink send below is deliberately outside it so a slow
        // consumer applies TCP backpressure instead of tripping the gap
        // timeout. The total bound still caps the whole exchange.
        let chunk = within_idle(
            timeouts,
            "waiting for the next response chunk",
            until_cancelled(cancel, async {
                response.chunk().await.map_err(|error| {
                    ConnectorError::Protocol(format!("HTTPS response failed: {error}"))
                })
            }),
        )
        .await?;
        let Some(chunk) = chunk else { break };
        let next = body.len().saturating_add(chunk.len());
        if next > max_response_bytes {
            return Err(ConnectorError::ResponseTooLarge {
                limit: max_response_bytes,
                actual: next,
            });
        }
        reserve_exact(egress, chunk.len())?;
        until_cancelled(cancel, sink.send(&chunk)).await?;
        body.extend_from_slice(&chunk);
    }
    until_cancelled(cancel, sink.finish()).await?;
    Ok(DispatchOutcome {
        status_code: status,
        body,
        content_type,
        response_headers,
    })
}

fn inject_static_headers(
    headers: &mut reqwest::header::HeaderMap,
    static_headers: &[(String, String)],
) -> Result<(), ConnectorError> {
    for (name, value) in static_headers {
        let name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| {
            ConnectorError::Protocol(format!("invalid static header name `{name}`"))
        })?;
        let value = HeaderValue::from_str(value).map_err(|_| {
            ConnectorError::Protocol(format!("invalid static header value for `{name}`"))
        })?;
        headers.insert(name, value);
    }
    Ok(())
}

fn ensure_request_defaults(request: &mut reqwest::Request) {
    let headers = request.headers_mut();
    headers
        .entry(ACCEPT)
        .or_insert(HeaderValue::from_static("*/*"));
    headers
        .entry(USER_AGENT)
        .or_insert(HeaderValue::from_static(CONNECTOR_USER_AGENT));
}

fn serialized_request_bytes(
    request: &reqwest::Request,
    body_len: usize,
) -> Result<usize, ConnectorError> {
    let target_len =
        request.url().path().len() + request.url().query().map_or(0, |query| 1 + query.len());
    let host = request
        .url()
        .host_str()
        .ok_or_else(|| ConnectorError::Protocol("HTTPS request has no host".to_string()))?;
    let host = match request.url().port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };
    let mut bytes = request.method().as_str().len() + 1 + target_len + 1 + "HTTP/1.1\r\n".len();
    let mut has_host = false;
    let mut has_content_length = false;
    for (name, value) in request.headers() {
        has_host |= name.as_str().eq_ignore_ascii_case("host");
        has_content_length |= name.as_str().eq_ignore_ascii_case("content-length");
        bytes = bytes
            .checked_add(name.as_str().len() + 2 + value.as_bytes().len() + 2)
            .ok_or_else(|| ConnectorError::Protocol("HTTPS request size overflow".to_string()))?;
    }
    if !has_host {
        bytes = bytes
            .checked_add("Host: ".len() + host.len() + 2)
            .ok_or_else(|| ConnectorError::Protocol("HTTPS request size overflow".to_string()))?;
    }
    if !has_content_length {
        bytes = bytes
            .checked_add("Content-Length: ".len() + body_len.to_string().len() + 2)
            .ok_or_else(|| ConnectorError::Protocol("HTTPS request size overflow".to_string()))?;
    }
    bytes = bytes
        .checked_add(2 + body_len)
        .ok_or_else(|| ConnectorError::Protocol("HTTPS request size overflow".to_string()))?;
    Ok(bytes)
}

fn reserve_exact(egress: &EgressProxy, bytes: usize) -> Result<(), ConnectorError> {
    let requested = u64::try_from(bytes)
        .map_err(|_| ConnectorError::Protocol("byte count exceeds u64".to_string()))?;
    egress.reserve_exact(requested).map_err(Into::into)
}

fn reserve_request_exact(egress: &EgressProxy, bytes: usize) -> Result<(), ConnectorError> {
    reserve_exact(egress, bytes)
        .map_err(|error| ConnectorError::RequestNotDispatched(error.to_string()))
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
    for (name, value) in &op.headers {
        h.update(name.to_ascii_lowercase().as_bytes());
        h.update(b":");
        h.update(value.as_bytes());
        h.update(b"|");
    }
    h.update(&op.body);
    hex::encode(h.finalize())
}

async fn dispatch_http(
    ctx: DispatchContext<'_>,
    header_name: &str,
    header_value: &str,
    mut sink: DispatchSink<'_>,
) -> Result<DispatchOutcome, ConnectorError> {
    let DispatchContext {
        op,
        addresses,
        egress,
        max_response_bytes,
        timeouts,
        static_headers,
        response_header_allowlist,
        cancel,
    } = ctx;
    if cancel.is_cancelled() {
        return Err(ConnectorError::RequestNotDispatched(
            "cancelled before dispatch".to_string(),
        ));
    }
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
        "{} {}{} HTTP/1.1\r\nHost: {}\r\nContent-Length: {}\r\nConnection: close\r\n",
        op.method,
        op.path,
        query,
        op.host,
        op.body.len()
    )
    .into_bytes();
    if !header_name.is_empty() {
        request.extend_from_slice(header_name.as_bytes());
        request.extend_from_slice(b": ");
        request.extend_from_slice(header_value.as_bytes());
        request.extend_from_slice(b"\r\n");
    }
    for (name, value) in &op.headers {
        request.extend_from_slice(name.as_bytes());
        request.extend_from_slice(b": ");
        request.extend_from_slice(value.as_bytes());
        request.extend_from_slice(b"\r\n");
    }
    for (name, value) in static_headers {
        request.extend_from_slice(name.as_bytes());
        request.extend_from_slice(b": ");
        request.extend_from_slice(value.as_bytes());
        request.extend_from_slice(b"\r\n");
    }
    request.extend_from_slice(b"\r\n");
    request.extend_from_slice(&op.body);

    reserve_request_exact(egress, request.len())?;
    stream.write_all(&request).await?;

    // Read the bounded response head + body. Body bytes are emitted to the
    // sink as they arrive once the head boundary is known; the head itself
    // is buffered until then so the sink never sees wire framing.
    let mut raw = Vec::with_capacity(4096);
    let mut buf = [0u8; 8192];
    let mut emitted = 0usize;
    let mut body_started = false;
    let mut head_meta: Option<ParsedHead> = None;
    loop {
        // Per-chunk gap bound, raced against cancellation. The sink send is
        // outside it so consumer backpressure never counts as an idle stall.
        let n = within_idle(
            timeouts,
            "waiting for the next response chunk",
            until_cancelled(cancel, async {
                stream.read(&mut buf).await.map_err(ConnectorError::from)
            }),
        )
        .await?;
        if n == 0 {
            break;
        }
        reserve_exact(egress, n)?;
        raw.extend_from_slice(&buf[..n]);
        match find_double_crlf(&raw) {
            Some(split) if !body_started => {
                body_started = true;
                let meta = parse_head(&raw[..split], response_header_allowlist)?;
                sink.head(ResponseHead {
                    status_code: meta.0,
                    content_type: meta.1.clone(),
                    headers: meta.2.clone(),
                })
                .await?;
                head_meta = Some(meta);
                until_cancelled(cancel, sink.send(&raw[split + 4..])).await?;
                emitted = raw.len();
            }
            _ if body_started => {
                let pending = raw[emitted..].to_vec();
                until_cancelled(cancel, sink.send(&pending)).await?;
                emitted = raw.len();
            }
            _ => {}
        }
        if raw.len() > max_response_bytes {
            return Err(ConnectorError::ResponseTooLarge {
                limit: max_response_bytes,
                actual: raw.len(),
            });
        }
    }
    until_cancelled(cancel, sink.finish()).await?;

    let split = find_double_crlf(&raw)
        .ok_or_else(|| ConnectorError::Protocol("malformed HTTP response head".into()))?;
    let body = raw[split + 4..].to_vec();
    let (status_code, content_type, response_headers) = match head_meta {
        Some(meta) => meta,
        None => parse_head(&raw[..split], response_header_allowlist)?,
    };

    Ok(DispatchOutcome {
        status_code,
        body,
        content_type,
        response_headers,
    })
}

/// Status code, content type, and the allowlisted response headers parsed
/// out of a plaintext response head.
type ParsedHead = (u16, Option<String>, Vec<(String, String)>);

/// Parse the plaintext response head into status, content type, and the
/// allowlisted response headers.
fn parse_head(head_bytes: &[u8], allowlist: &[String]) -> Result<ParsedHead, ConnectorError> {
    let head = String::from_utf8_lossy(head_bytes).to_string();
    let status_code = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| ConnectorError::Protocol("missing HTTP status line".into()))?;
    let content_type = head.lines().skip(1).find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("content-type")
            .then(|| value.trim().to_string())
    });
    Ok((
        status_code,
        content_type,
        filter_head_response_headers(&head, allowlist),
    ))
}

/// Response-header projection for the plaintext path, which parses the head
/// itself. Same allowlist and bounds as the HTTPS path.
fn filter_head_response_headers(head: &str, allowlist: &[String]) -> Vec<(String, String)> {
    if allowlist.is_empty() {
        return Vec::new();
    }
    let mut admitted = Vec::new();
    for line in head.lines().skip(1) {
        if admitted.len() >= MAX_RESPONSE_HEADERS {
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        if !response_header_admitted(&name, allowlist) {
            continue;
        }
        if value.len() > MAX_RESPONSE_HEADER_VALUE_BYTES {
            tracing::warn!(
                target: "terminus_connector_audit",
                header = %name,
                bytes = value.len(),
                "dropped an allowlisted response header whose value exceeded the bound"
            );
            continue;
        }
        admitted.push((name, value.to_string()));
    }
    admitted
}

fn find_double_crlf(data: &[u8]) -> Option<usize> {
    data.windows(4).position(|w| w == b"\r\n\r\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_size_includes_explicit_default_headers() {
        let client = reqwest::Client::builder().https_only(true).build().unwrap();
        let mut request = client
            .post("https://example.com:443/health")
            .body(b"body".to_vec())
            .build()
            .unwrap();
        let without_defaults = serialized_request_bytes(&request, 4).unwrap();

        ensure_request_defaults(&mut request);

        assert_eq!(
            request.headers().get(ACCEPT),
            Some(&HeaderValue::from_static("*/*"))
        );
        assert_eq!(
            request.headers().get(USER_AGENT),
            Some(&HeaderValue::from_static(CONNECTOR_USER_AGENT))
        );
        let with_defaults = serialized_request_bytes(&request, 4).unwrap();
        let expected_added =
            "accept: */*\r\n".len() + format!("user-agent: {CONNECTOR_USER_AGENT}\r\n").len();
        assert_eq!(with_defaults - without_defaults, expected_added);
    }

    fn descriptor_admitting(headers: &[&str]) -> ConnectorDescriptor {
        ConnectorDescriptor::new(AuthStyle::Bearer)
            .with_allowed_request_headers(headers.iter().copied())
    }

    #[test]
    fn descriptor_request_headers_are_matched_case_insensitively() {
        // The provider feature-flag headers arrive from the renderers in
        // their documented casing (`anthropic-beta`, `OpenAI-Beta`); the
        // allowlist stores lowercase and the check normalizes, so both spell
        // the same admitted name.
        let descriptor = descriptor_admitting(&["anthropic-beta", "openai-beta"]);
        for name in [
            "anthropic-beta",
            "Anthropic-Beta",
            "ANTHROPIC-BETA",
            "OpenAI-Beta",
            "openai-beta",
        ] {
            let outcome = validate_headers(&[(name.to_string(), "value".to_string())], &descriptor);
            assert!(outcome.is_ok(), "{name} must be admitted: {outcome:?}");
        }
    }

    #[test]
    fn request_headers_outside_the_descriptor_allowlist_are_rejected() {
        let descriptor = descriptor_admitting(&["anthropic-beta", "openai-beta"]);
        for name in [
            // The Codex minimum-version gate: admitting it invites a hard
            // 400 on every backend rollout.
            "version",
            "x-oai-attestation",
            "x-codex-routing-hint",
            "x-openai-internal-codex-responses-lite",
            "authorization",
            "cookie",
        ] {
            let error = validate_headers(&[(name.to_string(), "v".to_string())], &descriptor)
                .expect_err("{name} must not be admitted");
            assert!(
                format!("{error}").contains("not admitted"),
                "{name}: {error}"
            );
        }
    }

    #[test]
    fn globally_admitted_headers_need_no_descriptor_entry() {
        let descriptor = ConnectorDescriptor::new(AuthStyle::None);
        for name in ["Accept", "content-type", "Anthropic-Version"] {
            let outcome = validate_headers(&[(name.to_string(), "v".to_string())], &descriptor);
            assert!(
                outcome.is_ok(),
                "{name} must be globally admitted: {outcome:?}"
            );
        }
    }
}
