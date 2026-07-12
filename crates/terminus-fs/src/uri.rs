//! Workspace URI parser for `workspace://`, `session://`, `task://`,
//! `artifact://`, `secret://`, `terminus-state://`, `host://` URIs.
//!
//! This is a minimal hand-rolled parser — we intentionally avoid pulling in a
//! full URL crate to keep dependencies minimal.

use crate::error::PathError;
use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceUriKind {
    Workspace,
    Session,
    Task,
    Turn,
    Job,
    Agent,
    Memory,
    Tool,
    Rule,
    Verification,
    Artifact,
    Secret,
    ForgeState,
    Host,
}

impl WorkspaceUriKind {
    pub fn scheme(self) -> &'static str {
        match self {
            Self::Workspace => "workspace",
            Self::Session => "session",
            Self::Task => "task",
            Self::Turn => "turn",
            Self::Job => "job",
            Self::Agent => "agent",
            Self::Memory => "memory",
            Self::Tool => "tool",
            Self::Rule => "rule",
            Self::Verification => "verification",
            Self::Artifact => "artifact",
            Self::Secret => "secret",
            Self::ForgeState => "terminus-state",
            Self::Host => "host",
        }
    }

    pub fn from_scheme(scheme: &str) -> Option<Self> {
        Some(match scheme {
            "workspace" => Self::Workspace,
            "session" => Self::Session,
            "task" => Self::Task,
            "turn" => Self::Turn,
            "job" => Self::Job,
            "agent" => Self::Agent,
            "memory" => Self::Memory,
            "tool" => Self::Tool,
            "rule" => Self::Rule,
            "verification" => Self::Verification,
            "artifact" => Self::Artifact,
            "secret" => Self::Secret,
            "terminus-state" => Self::ForgeState,
            "host" => Self::Host,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceUriError(pub String);

impl fmt::Display for WorkspaceUriError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for WorkspaceUriError {}

/// A parsed Terminus internal URI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceUri {
    pub kind: WorkspaceUriKind,
    pub authority: String,
    pub path: String,
}

impl WorkspaceUri {
    pub fn parse(uri: &str) -> Result<Self, PathError> {
        let scheme_end = uri
            .find("://")
            .ok_or_else(|| PathError::Uri(format!("missing `://` scheme separator in `{uri}`")))?;
        let scheme = &uri[..scheme_end];
        let kind = WorkspaceUriKind::from_scheme(scheme)
            .ok_or_else(|| PathError::Uri(format!("unknown scheme `{scheme}`")))?;
        let rest = &uri[scheme_end + 3..];
        // authority is everything up to the next `/`
        let (authority, path) = match rest.find('/') {
            Some(idx) => (rest[..idx].to_string(), rest[idx + 1..].to_string()),
            None => (rest.to_string(), String::new()),
        };
        if authority.is_empty() && !matches!(kind, WorkspaceUriKind::Host) {
            return Err(PathError::Uri(format!("missing authority in `{uri}`")));
        }
        // Reject path traversal inside URIs.
        if path.contains("..") {
            return Err(PathError::ParentTraversal);
        }
        Ok(Self {
            kind,
            authority,
            path,
        })
    }

    pub fn workspace_path(&self) -> Option<String> {
        if self.kind == WorkspaceUriKind::Workspace {
            Some(self.path.clone())
        } else {
            None
        }
    }
}

impl fmt::Display for WorkspaceUri {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}://{}/{}",
            self.kind.scheme(),
            self.authority,
            self.path
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_workspace_uri() {
        let uri = WorkspaceUri::parse("workspace://ws-1/src/auth/token.ts").unwrap();
        assert_eq!(uri.kind, WorkspaceUriKind::Workspace);
        assert_eq!(uri.authority, "ws-1");
        assert_eq!(uri.path, "src/auth/token.ts");
    }

    #[test]
    fn parses_artifact_uri() {
        let uri = WorkspaceUri::parse("artifact://sha256/abcdef0123456789").unwrap();
        assert_eq!(uri.kind, WorkspaceUriKind::Artifact);
        assert_eq!(uri.authority, "sha256");
        assert_eq!(uri.path, "abcdef0123456789");
    }

    #[test]
    fn rejects_unknown_scheme() {
        let err = WorkspaceUri::parse("foo://bar/baz").unwrap_err();
        assert!(matches!(err, PathError::Uri(_)));
    }

    #[test]
    fn rejects_traversal_in_uri() {
        let err = WorkspaceUri::parse("workspace://ws-1/../escape").unwrap_err();
        assert_eq!(err, PathError::ParentTraversal);
    }
}
