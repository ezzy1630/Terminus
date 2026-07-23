//! Rolling control/kernel upgrade compatibility checks.

use crate::error::RemoteError;
use serde::{Deserialize, Serialize};

/// Protocol compatibility window for remote upgrades.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProtocolVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl ProtocolVersion {
    pub fn parse(raw: &str) -> Result<Self, RemoteError> {
        // Accept `terminus.kernel.v1` style or semver `1.2.3`.
        if let Some(rest) = raw.strip_prefix("terminus.kernel.v") {
            let major: u32 = rest.parse().map_err(|_| {
                RemoteError::InvalidEnvironment(format!("bad protocol version: {raw}"))
            })?;
            return Ok(Self {
                major,
                minor: 0,
                patch: 0,
            });
        }
        let parts: Vec<_> = raw.split('.').collect();
        if parts.len() != 3 {
            return Err(RemoteError::InvalidEnvironment(format!(
                "bad protocol version: {raw}"
            )));
        }
        let major = parts[0]
            .parse()
            .map_err(|_| RemoteError::InvalidEnvironment(format!("bad protocol version: {raw}")))?;
        let minor = parts[1]
            .parse()
            .map_err(|_| RemoteError::InvalidEnvironment(format!("bad protocol version: {raw}")))?;
        let patch = parts[2]
            .parse()
            .map_err(|_| RemoteError::InvalidEnvironment(format!("bad protocol version: {raw}")))?;
        Ok(Self {
            major,
            minor,
            patch,
        })
    }
}

/// Current control talking to previous or current kernel is allowed when major matches
/// and control minor >= kernel minor within one minor of skew.
pub fn compatible(control: &ProtocolVersion, kernel: &ProtocolVersion) -> bool {
    if control.major != kernel.major {
        return false;
    }
    // Same major: allow kernel one minor behind control, or equal.
    control.minor == kernel.minor
        || (control.minor > 0 && control.minor - 1 == kernel.minor)
        || (kernel.minor > 0 && kernel.minor - 1 == control.minor)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_major_adjacent_minor_ok() {
        let c = ProtocolVersion {
            major: 1,
            minor: 2,
            patch: 0,
        };
        let k = ProtocolVersion {
            major: 1,
            minor: 1,
            patch: 9,
        };
        assert!(compatible(&c, &k));
    }

    #[test]
    fn major_mismatch_rejected() {
        let c = ProtocolVersion::parse("terminus.kernel.v1").expect("c");
        let k = ProtocolVersion {
            major: 2,
            minor: 0,
            patch: 0,
        };
        assert!(!compatible(&c, &k));
    }
}
