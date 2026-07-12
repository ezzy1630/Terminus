//! Shared API envelope types used by handlers.

use forge_kernel_protocol::{EffectIntent, RequestContext};
use serde::{Deserialize, Serialize};

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
