//! Chunked artifact transfer with resumable sessions.

use crate::error::RemoteError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

/// Opaque continuation token for a partial upload/download.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ContinuationToken(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StreamSession {
    pub session_id: String,
    pub media_type: String,
    pub expected_total_bytes: Option<u64>,
    pub received_bytes: u64,
    pub next_offset: u64,
    pub closed: bool,
    pub(crate) buffer: Vec<u8>,
}

/// Manages resumable ingest sessions. Commit produces the final digest.
#[derive(Debug, Default)]
pub struct ArtifactStreamManager {
    sessions: HashMap<String, StreamSession>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChunkAppendResult {
    pub session_id: String,
    pub next_offset: u64,
    pub received_bytes: u64,
    pub continuation: ContinuationToken,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommittedArtifact {
    pub sha256: String,
    pub size_bytes: u64,
    pub media_type: String,
    pub bytes: Vec<u8>,
}

impl ArtifactStreamManager {
    pub fn begin(
        &mut self,
        media_type: impl Into<String>,
        expected_total_bytes: Option<u64>,
    ) -> StreamSession {
        let session_id = uuid::Uuid::now_v7().to_string();
        let session = StreamSession {
            session_id: session_id.clone(),
            media_type: media_type.into(),
            expected_total_bytes,
            received_bytes: 0,
            next_offset: 0,
            closed: false,
            buffer: Vec::new(),
        };
        self.sessions.insert(session_id, session.clone());
        session
    }

    pub fn append(
        &mut self,
        session_id: &str,
        offset: u64,
        chunk: &[u8],
    ) -> Result<ChunkAppendResult, RemoteError> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| RemoteError::ArtifactStream(format!("unknown session {session_id}")))?;
        if session.closed {
            return Err(RemoteError::ArtifactStream(
                "session already committed".into(),
            ));
        }
        if offset != session.next_offset {
            return Err(RemoteError::ArtifactStream(format!(
                "offset mismatch: expected {}, got {offset} (resume from continuation)",
                session.next_offset
            )));
        }
        if let Some(total) = session.expected_total_bytes {
            if session.received_bytes.saturating_add(chunk.len() as u64) > total {
                return Err(RemoteError::ArtifactStream(
                    "chunk exceeds declared total bytes".into(),
                ));
            }
        }
        session.buffer.extend_from_slice(chunk);
        session.received_bytes = session.received_bytes.saturating_add(chunk.len() as u64);
        session.next_offset = session.received_bytes;
        Ok(ChunkAppendResult {
            session_id: session.session_id.clone(),
            next_offset: session.next_offset,
            received_bytes: session.received_bytes,
            continuation: ContinuationToken(format!(
                "{}:{}",
                session.session_id, session.next_offset
            )),
        })
    }

    pub fn resume_offset(token: &ContinuationToken) -> Result<(String, u64), RemoteError> {
        let Some((session_id, offset_str)) = token.0.rsplit_once(':') else {
            return Err(RemoteError::ArtifactStream(
                "malformed continuation token".into(),
            ));
        };
        let offset: u64 = offset_str
            .parse()
            .map_err(|_| RemoteError::ArtifactStream("malformed continuation offset".into()))?;
        Ok((session_id.to_string(), offset))
    }

    pub fn commit(&mut self, session_id: &str) -> Result<CommittedArtifact, RemoteError> {
        let mut session = self
            .sessions
            .remove(session_id)
            .ok_or_else(|| RemoteError::ArtifactStream(format!("unknown session {session_id}")))?;
        if session.closed {
            return Err(RemoteError::ArtifactStream("already committed".into()));
        }
        if let Some(total) = session.expected_total_bytes {
            if session.received_bytes != total {
                // Put back so caller can resume.
                let incomplete = RemoteError::ArtifactStream(format!(
                    "incomplete upload: got {} of {total} bytes",
                    session.received_bytes
                ));
                self.sessions.insert(session_id.to_string(), session);
                return Err(incomplete);
            }
        }
        session.closed = true;
        let mut hasher = Sha256::new();
        hasher.update(&session.buffer);
        let digest = format!("sha256:{}", hex::encode(hasher.finalize()));
        Ok(CommittedArtifact {
            sha256: digest,
            size_bytes: session.received_bytes,
            media_type: session.media_type,
            bytes: session.buffer,
        })
    }

    /// Range read helper for resumable downloads.
    pub fn slice_range(
        bytes: &[u8],
        offset: u64,
        max_len: u64,
    ) -> Result<(Vec<u8>, bool), RemoteError> {
        if offset as usize > bytes.len() {
            return Err(RemoteError::ArtifactStream("range offset past end".into()));
        }
        let start = offset as usize;
        let end = (start + max_len as usize).min(bytes.len());
        let truncated = end < bytes.len();
        Ok((bytes[start..end].to_vec(), truncated))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunked_ingest_with_resume() {
        let mut mgr = ArtifactStreamManager::default();
        let session = mgr.begin("application/octet-stream", Some(5));
        let r1 = mgr.append(&session.session_id, 0, b"hel").expect("c1");
        assert!(mgr.append(&session.session_id, 0, b"x").is_err());
        let (sid, off) = ArtifactStreamManager::resume_offset(&r1.continuation).expect("tok");
        assert_eq!(sid, session.session_id);
        assert_eq!(off, 3);
        mgr.append(&session.session_id, off, b"lo").expect("c2");
        let committed = mgr.commit(&session.session_id).expect("commit");
        assert_eq!(committed.size_bytes, 5);
        assert!(committed.sha256.starts_with("sha256:"));
    }

    #[test]
    fn range_reports_truncation() {
        let (chunk, truncated) =
            ArtifactStreamManager::slice_range(b"abcdef", 2, 2).expect("slice");
        assert_eq!(chunk, b"cd");
        assert!(truncated);
    }
}
