//! Shared API envelope types used by handlers.

use terminus_kernel_protocol::{EffectIntent, RequestContext};
use serde::{Deserialize, Serialize};

use crate::auth::ValidatedCapabilityToken;

/// The envelope every POST request body MUST conform to. `request_context`
/// and `effect_intent` are required by the SPEC §31 contract; the payload
/// fields are flattened alongside.
#[derive(Debug, Clone, Deserialize)]
pub struct Envelope {
    #[serde(default = "default_request_context")]
    pub request_context: RequestContext,
    #[serde(default)]
    pub effect_intent: EffectIntent,
}

fn default_request_context() -> RequestContext {
    RequestContext::new(uuid::Uuid::now_v7().to_string())
}

impl Envelope {
    /// Extract an `Envelope` from a `serde_json::Value`, filling in defaults.
    pub fn from_value(v: &serde_json::Value) -> Result<Self, serde_json::Error> {
        serde_json::from_value(v.clone())
    }

    /// Inject the validated capability-token string (set by the auth
    /// middleware on request extensions) into `request_context.capability_token`.
    /// This lets the kernel's own §31.3 step-3 capability validation
    /// re-verify the token against the requested operation class + scope.
    ///
    /// No-op if the extension is absent (e.g. for read-only endpoints that
    /// skip the capability-token middleware).
    pub fn inject_capability_token(&mut self, token: &ValidatedCapabilityToken) {
        self.request_context.capability_token = token.0.clone();
    }
}

/// Pull a nested field from a JSON value, with a default fallback.
pub fn get_str<'a>(v: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(|s| s.as_str())
}

pub fn get_obj<'a>(v: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
    v.get(key)
}

/// Standard `{ ok: true }` response for simple mutating endpoints.
#[derive(Debug, Clone, Serialize)]
pub struct Ok {
    pub ok: bool,
}

impl Ok {
    pub fn yes() -> Self {
        Self { ok: true }
    }
}
