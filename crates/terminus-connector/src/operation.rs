//! Canonical L7 operation: the exact request the connector will perform.

use serde::{Deserialize, Serialize};

/// One concrete external operation. Every field participates in
/// exact-operation binding and in the receipt hashes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CanonicalOperation {
    /// Uppercase HTTP method.
    pub method: String,
    pub scheme: String,
    pub host: String,
    pub port: u16,
    /// Concrete path, e.g. `/repos/acme/widget/pulls`.
    pub path: String,
    /// Raw query string without `?` (may be empty).
    pub query: String,
    /// Bounded request body bytes (may be empty).
    pub body: Vec<u8>,
}

impl CanonicalOperation {
    pub fn destination(&self) -> (&str, u16, &str) {
        (&self.host, self.port, &self.scheme)
    }

    pub fn operation_class(&self) -> (&str, &str) {
        (&self.method, &self.path)
    }
}

/// Match a concrete path against a grant's pinned path class.
///
/// A class segment equal to `{...}` (any `{`-delimited token) is a wildcard
/// for exactly one non-empty segment; every other segment must match
/// literally. The class must consume the whole path.
pub fn path_matches_class(class: &str, path: &str) -> bool {
    let class_segments: Vec<&str> = class.trim_matches('/').split('/').collect();
    let path_segments: Vec<&str> = path.trim_matches('/').split('/').collect();
    if class_segments.len() != path_segments.len() {
        return false;
    }
    for (c, p) in class_segments.iter().zip(path_segments.iter()) {
        let is_wildcard = c.starts_with('{') && c.ends_with('}');
        if is_wildcard {
            if p.is_empty() {
                return false;
            }
        } else if c != p {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literal_class_requires_exact_match() {
        assert!(path_matches_class("/repos/o/r/pulls", "/repos/o/r/pulls"));
        assert!(!path_matches_class("/repos/o/r/pulls", "/repos/o/other/pulls"));
    }

    #[test]
    fn wildcard_segment_binds_shape_not_ids() {
        assert!(path_matches_class(
            "/repos/{owner}/{repo}/pulls",
            "/repos/acme/widget/pulls"
        ));
        assert!(!path_matches_class(
            "/repos/{owner}/{repo}/pulls",
            "/repos/acme/pulls"
        ));
        assert!(!path_matches_class(
            "/repos/{owner}/{repo}/pulls",
            "/repos/acme/widget/issues"
        ));
    }

    #[test]
    fn empty_wildcard_rejected() {
        assert!(!path_matches_class(
            "/repos/{owner}/x",
            "/repos//x"
        ));
    }

    #[test]
    fn leading_trailing_slashes_ignored() {
        assert!(path_matches_class("health", "/health/"));
    }
}
