//! Server-side RPC deadlines (SPEC §31.3 step 9).
//!
//! `RequestContext.deadline` has always been enforced when a caller supplies
//! one, but every observed client left it unset, so the check was dead code
//! and a wedged handler could pin a kernel worker forever. This layer gives
//! every RPC a budget whether or not the caller asked for one: a short one
//! for metadata-shaped calls, the long-running ceiling for streams, tools,
//! and process/job work.
//!
//! The budget bounds BOTH the response future and the response body, so a
//! server-streaming RPC that never terminates is closed with
//! `DEADLINE_EXCEEDED` rather than held open.

#![cfg_attr(test, allow(clippy::expect_used, clippy::unwrap_used))]

use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use http::{Request, Response};
use http_body::{Body, Frame};
use terminus_kernel::RpcDeadlineClass;
use tonic::Status;
use tower::{Layer, Service};

/// gRPC method paths whose work legitimately runs long: streams, model
/// dispatch, process/job supervision, extension invocation, and repository
/// indexing. Everything else is metadata-shaped and gets the unary budget.
const LONG_RUNNING_SERVICES: &[&str] = &[
    "terminus.kernel.v1.ProcessService",
    "terminus.kernel.v1.JobService",
    "terminus.kernel.v1.ConnectorService",
    "terminus.kernel.v1.ExtensionRuntimeService",
    "terminus.kernel.v1.CodeIntelligenceService",
    "terminus.kernel.v1.PatchService",
    "terminus.kernel.v1.ArtifactIngestService",
];

/// Classify a gRPC path (`/pkg.Service/Method`) into a deadline class.
pub fn classify_path(path: &str) -> RpcDeadlineClass {
    let service = path.trim_start_matches('/').split('/').next().unwrap_or("");
    if LONG_RUNNING_SERVICES.contains(&service) {
        RpcDeadlineClass::LongRunning
    } else {
        RpcDeadlineClass::Unary
    }
}

/// Budget for a request, honoring a caller-supplied `grpc-timeout` header
/// when it is shorter than the class default.
pub fn budget_for(path: &str, client_timeout: Option<Duration>) -> Duration {
    let class_budget = classify_path(path).default_budget();
    match client_timeout {
        Some(client) => client.min(class_budget),
        None => class_budget,
    }
}

/// Parse the gRPC `grpc-timeout` header (`<value><unit>`), per the gRPC HTTP/2
/// spec. Returns `None` for an absent or unparseable value; enforcement then
/// falls back to the class default.
pub fn parse_grpc_timeout(headers: &http::HeaderMap) -> Option<Duration> {
    let raw = headers.get("grpc-timeout")?.to_str().ok()?;
    let (digits, unit) = raw.split_at(raw.len().checked_sub(1)?);
    let value: u64 = digits.parse().ok()?;
    let nanos = match unit {
        "H" => value.checked_mul(3_600_000_000_000)?,
        "M" => value.checked_mul(60_000_000_000)?,
        "S" => value.checked_mul(1_000_000_000)?,
        "m" => value.checked_mul(1_000_000)?,
        "u" => value.checked_mul(1_000)?,
        "n" => value,
        _ => return None,
    };
    Some(Duration::from_nanos(nanos))
}

/// Tower layer applying [`budget_for`] to every request.
#[derive(Debug, Clone, Copy, Default)]
pub struct DeadlineLayer;

impl<S> Layer<S> for DeadlineLayer {
    type Service = DeadlineService<S>;

    fn layer(&self, inner: S) -> Self::Service {
        DeadlineService { inner }
    }
}

#[derive(Debug, Clone)]
pub struct DeadlineService<S> {
    inner: S,
}

impl<S, ReqBody, ResBody> Service<Request<ReqBody>> for DeadlineService<S>
where
    S: Service<Request<ReqBody>, Response = Response<ResBody>>,
    S::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
    ResBody: Body,
    ResBody::Error: From<Status>,
{
    type Response = Response<DeadlineBody<ResBody>>;
    type Error = Box<dyn std::error::Error + Send + Sync>;
    type Future = DeadlineFuture<S::Future, ResBody>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx).map_err(Into::into)
    }

    fn call(&mut self, request: Request<ReqBody>) -> Self::Future {
        let path = request.uri().path().to_string();
        let budget = budget_for(&path, parse_grpc_timeout(request.headers()));
        DeadlineFuture {
            // Boxed so the inner future can be re-pinned across polls without
            // `unsafe` structural projection. One allocation per RPC is far
            // cheaper than the work the RPC itself does.
            inner: Box::pin(self.inner.call(request)),
            sleep: Box::pin(tokio::time::sleep(budget)),
            path,
            budget,
            _body: std::marker::PhantomData,
        }
    }
}

/// Response future that fails with `DEADLINE_EXCEEDED` if the handler does
/// not produce a response within the budget, and hands the remaining budget
/// to the response body.
pub struct DeadlineFuture<F, ResBody> {
    inner: Pin<Box<F>>,
    sleep: Pin<Box<tokio::time::Sleep>>,
    path: String,
    budget: Duration,
    _body: std::marker::PhantomData<fn() -> ResBody>,
}

impl<F, ResBody> std::fmt::Debug for DeadlineFuture<F, ResBody> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeadlineFuture")
            .field("path", &self.path)
            .field("budget", &self.budget)
            .finish_non_exhaustive()
    }
}

impl<F, E, ResBody> Future for DeadlineFuture<F, ResBody>
where
    F: Future<Output = Result<Response<ResBody>, E>>,
    E: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    type Output = Result<Response<DeadlineBody<ResBody>>, Box<dyn std::error::Error + Send + Sync>>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        if let Poll::Ready(result) = this.inner.as_mut().poll(cx) {
            let deadline = tokio::time::Instant::now() + this.budget;
            return Poll::Ready(result.map_err(Into::into).map(|response| {
                response.map(|body| DeadlineBody {
                    inner: Box::pin(body),
                    sleep: Box::pin(tokio::time::sleep_until(deadline)),
                    expired: false,
                })
            }));
        }
        if this.sleep.as_mut().poll(cx).is_ready() {
            tracing::warn!(
                target: "terminus_kernel_audit",
                event = "rpc.deadline_exceeded",
                path = %this.path,
                budget_ms = this.budget.as_millis() as u64,
                "kernel RPC exceeded its server-side deadline before responding"
            );
            return Poll::Ready(Err(Box::new(Status::deadline_exceeded(format!(
                "kernel RPC {} exceeded its {}s server-side deadline",
                this.path,
                this.budget.as_secs()
            )))
                as Box<dyn std::error::Error + Send + Sync>));
        }
        Poll::Pending
    }
}

/// Response body bounded by the same deadline. Once the budget elapses the
/// stream terminates with a `DEADLINE_EXCEEDED` error instead of hanging.
pub struct DeadlineBody<B> {
    // Boxed for the same reason as the response future: re-pinning across
    // polls without `unsafe` structural projection.
    inner: Pin<Box<B>>,
    sleep: Pin<Box<tokio::time::Sleep>>,
    expired: bool,
}

impl<B> std::fmt::Debug for DeadlineBody<B> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeadlineBody")
            .field("expired", &self.expired)
            .finish_non_exhaustive()
    }
}

impl<B> Body for DeadlineBody<B>
where
    B: Body,
    B::Error: From<Status>,
{
    type Data = B::Data;
    type Error = B::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        let this = self.get_mut();
        if this.expired {
            return Poll::Ready(None);
        }
        if this.sleep.as_mut().poll(cx).is_ready() {
            this.expired = true;
            tracing::warn!(
                target: "terminus_kernel_audit",
                event = "rpc.stream_deadline_exceeded",
                "kernel RPC stream exceeded its server-side deadline"
            );
            return Poll::Ready(Some(Err(B::Error::from(Status::deadline_exceeded(
                "kernel RPC stream exceeded its server-side deadline",
            )))));
        }
        this.inner.as_mut().poll_frame(cx)
    }

    fn is_end_stream(&self) -> bool {
        self.expired || self.inner.is_end_stream()
    }

    fn size_hint(&self) -> http_body::SizeHint {
        self.inner.size_hint()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_rpcs_get_the_unary_budget() {
        for path in [
            "/terminus.kernel.v1.KernelInfoService/Health",
            "/terminus.kernel.v1.WorkspaceService/Register",
            "/terminus.kernel.v1.PolicyService/Evaluate",
            "/terminus.kernel.v1.SecretService/Mint",
            "/terminus.kernel.v1.NetworkService/Decide",
            "/terminus.kernel.v1.FileService/Read",
            "/terminus.kernel.v1.SandboxService/Report",
        ] {
            assert_eq!(classify_path(path), RpcDeadlineClass::Unary, "{path}");
            assert_eq!(budget_for(path, None), Duration::from_secs(30), "{path}");
        }
    }

    #[test]
    fn streaming_and_process_rpcs_get_the_long_running_ceiling() {
        for path in [
            "/terminus.kernel.v1.ProcessService/Start",
            "/terminus.kernel.v1.JobService/Stream",
            "/terminus.kernel.v1.ConnectorService/ExecuteStream",
            "/terminus.kernel.v1.ExtensionRuntimeService/Invoke",
            "/terminus.kernel.v1.CodeIntelligenceService/Map",
            "/terminus.kernel.v1.PatchService/Apply",
            "/terminus.kernel.v1.ArtifactIngestService/Ingest",
        ] {
            assert_eq!(classify_path(path), RpcDeadlineClass::LongRunning, "{path}");
            assert_eq!(
                budget_for(path, None),
                Duration::from_secs(30 * 60),
                "{path}"
            );
        }
    }

    #[test]
    fn an_unknown_service_falls_back_to_the_short_budget() {
        assert_eq!(
            classify_path("/some.other.Service/Method"),
            RpcDeadlineClass::Unary
        );
        assert_eq!(classify_path(""), RpcDeadlineClass::Unary);
    }

    #[test]
    fn a_shorter_client_timeout_wins_and_a_longer_one_is_clamped() {
        let long = "/terminus.kernel.v1.JobService/Stream";
        assert_eq!(
            budget_for(long, Some(Duration::from_secs(5))),
            Duration::from_secs(5)
        );
        assert_eq!(
            budget_for(long, Some(Duration::from_secs(7_200))),
            Duration::from_secs(30 * 60)
        );
        let unary = "/terminus.kernel.v1.PolicyService/Evaluate";
        assert_eq!(
            budget_for(unary, Some(Duration::from_secs(600))),
            Duration::from_secs(30)
        );
    }

    /// Minimal body used to prove the layer wraps and bounds a real stream.
    struct NeverEndingBody;

    impl Body for NeverEndingBody {
        type Data = bytes::Bytes;
        type Error = Status;

        fn poll_frame(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
            Poll::Pending
        }
    }

    #[tokio::test]
    async fn a_wedged_handler_is_cut_off_at_the_deadline() {
        // The client-supplied `grpc-timeout` is honored when shorter than the
        // class budget, which lets this exercise the production path in
        // milliseconds instead of 30 seconds.
        let inner = tower::service_fn(|_req: Request<()>| async move {
            std::future::pending::<Result<Response<NeverEndingBody>, Status>>().await
        });
        let mut service = DeadlineLayer.layer(inner);
        let mut request = Request::new(());
        *request.uri_mut() = "/terminus.kernel.v1.JobService/Stream"
            .parse()
            .unwrap_or_default();
        request
            .headers_mut()
            .insert("grpc-timeout", http::HeaderValue::from_static("50m"));

        let error = tower::Service::call(&mut service, request)
            .await
            .expect_err("a wedged handler must not resolve");
        let status = error
            .downcast_ref::<Status>()
            .map(Status::code)
            .unwrap_or(tonic::Code::Unknown);
        assert_eq!(status, tonic::Code::DeadlineExceeded);
    }

    #[tokio::test]
    async fn a_wedged_response_body_is_cut_off_at_the_deadline() {
        let inner = tower::service_fn(|_req: Request<()>| async move {
            Ok::<_, Status>(Response::new(NeverEndingBody))
        });
        let mut service = DeadlineLayer.layer(inner);
        let mut request = Request::new(());
        *request.uri_mut() = "/terminus.kernel.v1.JobService/Stream"
            .parse()
            .unwrap_or_default();
        request
            .headers_mut()
            .insert("grpc-timeout", http::HeaderValue::from_static("50m"));

        let response = tower::Service::call(&mut service, request)
            .await
            .map_err(|error| error.to_string())
            .expect("the handler itself responds immediately");
        let mut body = response.into_body();
        let frame = std::future::poll_fn(|cx| Pin::new(&mut body).poll_frame(cx)).await;
        let status = match frame {
            Some(Err(status)) => status.code(),
            _ => tonic::Code::Unknown,
        };
        assert_eq!(
            status,
            tonic::Code::DeadlineExceeded,
            "a stream that never ends must be terminated at the deadline"
        );
        // And the body reports itself finished afterwards.
        assert!(body.is_end_stream());
    }

    #[test]
    fn grpc_timeout_header_units_are_parsed() {
        let cases = [
            ("100n", Duration::from_nanos(100)),
            ("250u", Duration::from_micros(250)),
            ("500m", Duration::from_millis(500)),
            ("30S", Duration::from_secs(30)),
            ("2M", Duration::from_secs(120)),
            ("1H", Duration::from_secs(3_600)),
        ];
        for (raw, expected) in cases {
            let mut headers = http::HeaderMap::new();
            headers.insert(
                "grpc-timeout",
                http::HeaderValue::from_str(raw)
                    .unwrap_or_else(|_| http::HeaderValue::from_static("invalid")),
            );
            assert_eq!(parse_grpc_timeout(&headers), Some(expected), "{raw}");
        }
        assert_eq!(parse_grpc_timeout(&http::HeaderMap::new()), None);
        let mut bad = http::HeaderMap::new();
        bad.insert("grpc-timeout", http::HeaderValue::from_static("abcX"));
        assert_eq!(parse_grpc_timeout(&bad), None);
    }
}
