//! Incremental response streaming for the connector broker.
//!
//! Two mechanisms live here, both of which the buffered path never needed:
//!
//! 1. [`StreamingRedactor`] — credential-echo redaction that runs on the
//!    wire as bytes arrive instead of on the complete body. It redacts the
//!    buffered carry FIRST (so no complete occurrence can straddle the emit
//!    point), then withholds only the trailing bytes that are still a proper
//!    prefix of some literal — at most `longest-literal-length − 1` of them —
//!    so a credential straddling two chunk boundaries is still matched when
//!    the rest arrives. It never splits a UTF-8 sequence, so the
//!    concatenation of every emitted piece is byte-identical to redacting the
//!    whole body once. When the upstream declared `text/event-stream` it
//!    additionally emits on SSE event boundaries (a blank line), holding at
//!    most one incomplete event and never more than
//!    [`MAX_PENDING_EVENT_BYTES`] of it.
//! 2. [`CancelToken`] — cooperative teardown. The dispatch loop selects on
//!    it, so cancelling drops the in-flight HTTP response (and with it the
//!    TCP/TLS connection) instead of letting the provider bill a completion
//!    nobody will read.

use crate::error::ConnectorError;
use std::sync::Arc;
use terminus_secrets::Redactor;
use tokio::sync::watch;

/// Upper bound on an unterminated SSE event held for boundary alignment.
/// Past this the redactor emits what it safely can rather than growing the
/// buffer: a pathological upstream must not turn alignment into unbounded
/// memory. Every observed provider event is orders of magnitude smaller.
pub(crate) const MAX_PENDING_EVENT_BYTES: usize = 512 * 1024;

/// Cooperative cancellation for one dispatch.
///
/// Cloneable and cheap; every clone observes the same state. `cancel()` is
/// idempotent and may be called after the dispatch already finished.
#[derive(Clone, Debug)]
pub struct CancelToken {
    sender: Arc<watch::Sender<bool>>,
}

impl Default for CancelToken {
    fn default() -> Self {
        Self::new()
    }
}

impl CancelToken {
    #[must_use]
    pub fn new() -> Self {
        let (sender, _receiver) = watch::channel(false);
        Self {
            sender: Arc::new(sender),
        }
    }

    /// Request teardown. Uses `send_replace` so the state flips even when no
    /// receiver is currently parked on it.
    pub fn cancel(&self) {
        let _previous = self.sender.send_replace(true);
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        *self.sender.borrow()
    }

    /// Resolve once cancellation has been requested. Resolves immediately
    /// when the token is already cancelled.
    pub async fn cancelled(&self) {
        let mut receiver = self.sender.subscribe();
        if *receiver.borrow_and_update() {
            return;
        }
        // `Err` means the sender is gone, which can only happen once every
        // token clone has dropped; treat that as "nothing left to cancel"
        // and let the caller's other select branch win.
        if receiver.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

/// Bound `future` by cancellation. The cancel branch is checked first so a
/// token that is already cancelled never starts new work.
pub(crate) async fn until_cancelled<T, F>(
    cancel: &CancelToken,
    future: F,
) -> Result<T, ConnectorError>
where
    F: std::future::Future<Output = Result<T, ConnectorError>>,
{
    tokio::select! {
        biased;
        () = cancel.cancelled() => Err(ConnectorError::Cancelled),
        result = future => result,
    }
}

/// The response head, handed to the sink before the first body byte so a
/// streaming consumer can classify the response (status, rate-limit and
/// routing headers such as `x-codex-turn-state`) without waiting for the
/// terminal receipt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResponseHead {
    pub status_code: u16,
    pub content_type: Option<String>,
    /// Already projected onto the connector descriptor's response-header
    /// allowlist and bounded in count and value length.
    pub headers: Vec<(String, String)>,
}

impl ResponseHead {
    /// Whether the upstream declared Server-Sent Events, which is what makes
    /// event-boundary-aligned emission worthwhile.
    #[must_use]
    pub fn is_event_stream(&self) -> bool {
        self.content_type.as_deref().is_some_and(|value| {
            value
                .split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .eq_ignore_ascii_case("text/event-stream")
        })
    }
}

/// Chunk-boundary-safe credential redaction.
///
/// The carry is redacted in place on every push, so a literal that is fully
/// present can never straddle the emit point. What is withheld is only the
/// trailing bytes that are still a *proper prefix* of a literal and might
/// therefore complete into one when the next chunk arrives.
#[derive(Debug)]
pub(crate) struct StreamingRedactor {
    redactor: Redactor,
    /// Raw literals, kept so the pending-prefix window can be measured.
    literals: Vec<Vec<u8>>,
    /// Bytes buffered across pushes. Everything up to `decoded` has already
    /// been through the redactor; the remainder is a truncated UTF-8 tail
    /// that must not be lossily decoded yet.
    carry: Vec<u8>,
    decoded: usize,
    align_events: bool,
    redactions: usize,
}

impl StreamingRedactor {
    pub(crate) fn new(literals: &[(String, String)]) -> Self {
        let mut redactor = Redactor::new();
        let mut raw = Vec::new();
        for (id, literal) in literals {
            if literal.is_empty() {
                continue;
            }
            raw.push(literal.as_bytes().to_vec());
            redactor.add_literal(id.clone(), literal.clone());
        }
        Self {
            redactor,
            literals: raw,
            carry: Vec::new(),
            decoded: 0,
            align_events: false,
            redactions: 0,
        }
    }

    /// Turn SSE event-boundary alignment on or off. Set from the response
    /// content type before the first body byte.
    pub(crate) fn align_events(&mut self, align: bool) {
        self.align_events = align;
    }

    /// Absorb one wire chunk and return the bytes that are safe to forward
    /// now. May legitimately return empty.
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Vec<u8> {
        self.carry.extend_from_slice(chunk);
        self.redact_carry();
        let split = self.emit_split();
        if split == 0 {
            return Vec::new();
        }
        self.decoded -= split;
        self.carry.drain(..split).collect()
    }

    /// Emit whatever is still held. Called once, at end of stream. The
    /// undecodable tail is resolved here exactly as a whole-body decode
    /// would resolve it.
    pub(crate) fn flush(&mut self) -> Vec<u8> {
        if self.carry.is_empty() {
            return Vec::new();
        }
        let tail = std::mem::take(&mut self.carry);
        self.decoded = 0;
        if self.literals.is_empty() {
            // Nothing to scrub: forward the tail byte-for-byte. Passing it
            // through the redactor would lossily decode it and corrupt a
            // binary body (anonymous connectors such as `web-fetch`).
            return tail;
        }
        let (out, count) = self.redactor.redact(&tail);
        self.redactions += count;
        out
    }

    /// Total literals replaced so far. Exercised by the equality property
    /// test; the receipt itself counts on the buffered pass.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn redactions(&self) -> usize {
        self.redactions
    }

    /// Replace every COMPLETE occurrence currently in the carry. Only the
    /// part that decodes without a truncated tail is touched, so a
    /// multi-byte character split across chunks never becomes U+FFFD.
    fn redact_carry(&mut self) {
        if self.literals.is_empty() {
            self.decoded = utf8_self_contained_prefix(&self.carry);
            return;
        }
        let decodable = utf8_self_contained_prefix(&self.carry);
        if decodable > self.decoded {
            let (out, count) = self.redactor.redact(&self.carry[..decodable]);
            self.redactions += count;
            let tail = self.carry[decodable..].to_vec();
            self.carry = out;
            self.decoded = self.carry.len();
            self.carry.extend_from_slice(&tail);
        } else {
            self.decoded = decodable.min(self.decoded);
        }
    }

    /// How many buffered bytes may be emitted now. Every complete literal is
    /// already replaced, so the only thing that can still change is a
    /// trailing partial match.
    fn emit_split(&self) -> usize {
        // 1. Withhold the longest suffix that is still a proper prefix of a
        //    literal: that, and only that, can complete into a credential.
        let safe = self.carry.len() - self.pending_prefix_len();
        if safe == 0 {
            return 0;
        }
        // 2. Never split a UTF-8 sequence: `Redactor` decodes lossily, and a
        //    mid-sequence split would emit U+FFFD where the whole-body
        //    result has none. This also keeps the emission inside the region
        //    that has already been through the redactor.
        let safe = utf8_self_contained_prefix(&self.carry[..safe]).min(self.decoded);
        if safe == 0 {
            return 0;
        }
        // 3. On SSE, prefer to hand the consumer whole events; the control
        //    plane splits each kernel chunk into events on its own.
        if self.align_events {
            if let Some(boundary) = last_event_boundary(&self.carry[..safe]) {
                return boundary;
            }
            if self.carry.len() <= MAX_PENDING_EVENT_BYTES {
                return 0;
            }
        }
        safe
    }

    /// Length of the longest suffix of the carry that equals a proper prefix
    /// of some literal. Bounded by `longest literal − 1`.
    fn pending_prefix_len(&self) -> usize {
        let mut hold = 0usize;
        for literal in &self.literals {
            let longest = literal.len().saturating_sub(1).min(self.carry.len());
            let mut candidate = longest;
            while candidate > hold {
                if self.carry[self.carry.len() - candidate..] == literal[..candidate] {
                    hold = candidate;
                    break;
                }
                candidate -= 1;
            }
        }
        hold
    }
}

/// Length of the longest prefix of `buf` that decodes identically whether it
/// is decoded alone or as part of a longer buffer.
///
/// `String::from_utf8_lossy` resolves errors locally (maximal-subpart rule),
/// so any prefix ending on a character boundary — or immediately after a
/// definitively invalid sequence — is self-contained. Only a *truncated*
/// sequence at the tail is ambiguous, and that is exactly what is withheld.
fn utf8_self_contained_prefix(buf: &[u8]) -> usize {
    let mut start = 0usize;
    loop {
        match std::str::from_utf8(&buf[start..]) {
            Ok(_) => return buf.len(),
            Err(error) => {
                let valid = start + error.valid_up_to();
                match error.error_len() {
                    // A real error: `from_utf8_lossy` would emit the same
                    // replacement here regardless of what follows.
                    Some(len) => start = valid + len,
                    // Truncated tail: undecidable until more bytes arrive.
                    None => return valid,
                }
            }
        }
    }
}

/// Index just past the last SSE event terminator in `buf`, if any. All three
/// blank-line forms the SSE grammar admits are recognised.
fn last_event_boundary(buf: &[u8]) -> Option<usize> {
    const TERMINATORS: [&[u8]; 3] = [b"\r\n\r\n", b"\n\n", b"\r\r"];
    let mut best: Option<usize> = None;
    for terminator in TERMINATORS {
        if let Some(position) = rfind(buf, terminator) {
            let end = position + terminator.len();
            best = Some(best.map_or(end, |current: usize| current.max(end)));
        }
    }
    best
}

fn rfind(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    (0..=haystack.len() - needle.len()).rev().find(|&index| {
        haystack
            .get(index..index + needle.len())
            .is_some_and(|window| window == needle)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const CREDENTIAL: &str = "Bearer canary-ghp_ABCDEF_1234567890";

    fn literals() -> Vec<(String, String)> {
        let bare = CREDENTIAL.trim_start_matches("Bearer ").to_string();
        vec![
            ("connector-credential".to_string(), CREDENTIAL.to_string()),
            ("connector-credential-bare".to_string(), bare),
        ]
    }

    /// Reference implementation: redact the whole body at once, exactly as
    /// the buffered path does.
    fn whole_body(body: &[u8]) -> (Vec<u8>, usize) {
        let mut redactor = Redactor::new();
        for (id, literal) in literals() {
            redactor.add_literal(id, literal);
        }
        redactor.redact(body)
    }

    fn stream_with_chunks(body: &[u8], chunks: &[usize], align: bool) -> (Vec<u8>, usize) {
        let mut streaming = StreamingRedactor::new(&literals());
        streaming.align_events(align);
        let mut out = Vec::new();
        let mut offset = 0usize;
        for size in chunks {
            let end = (offset + size).min(body.len());
            out.extend_from_slice(&streaming.push(&body[offset..end]));
            offset = end;
        }
        if offset < body.len() {
            out.extend_from_slice(&streaming.push(&body[offset..]));
        }
        out.extend_from_slice(&streaming.flush());
        (out, streaming.redactions())
    }

    #[test]
    fn a_credential_split_across_every_boundary_is_still_redacted() {
        let body = format!("data: {{\"echo\":\"{CREDENTIAL}\"}}\n\ndata: [DONE]\n\n").into_bytes();
        for split in 0..=body.len() {
            let mut streaming = StreamingRedactor::new(&literals());
            let mut out = streaming.push(&body[..split]);
            out.extend_from_slice(&streaming.push(&body[split..]));
            out.extend_from_slice(&streaming.flush());
            let text = String::from_utf8_lossy(&out).to_string();
            assert!(
                !text.contains("canary-ghp_ABCDEF_1234567890"),
                "credential leaked when the body was split at byte {split}: {text}"
            );
            assert!(
                text.contains("***REDACTED:connector-credential***"),
                "no redaction marker for split {split}: {text}"
            );
        }
    }

    #[test]
    fn streamed_output_equals_the_buffered_result_for_random_chunkings() {
        let body = format!(
            "event: message_start\ndata: {{\"token\":\"{CREDENTIAL}\"}}\n\n\
             event: delta\ndata: {{\"text\":\"héllo — wörld 🌍\"}}\n\n\
             event: delta\ndata: {{\"text\":\"{CREDENTIAL}\"}}\n\n\
             event: done\ndata: [DONE]\n\n"
        )
        .into_bytes();
        let (expected, expected_count) = whole_body(&body);
        // Deterministic LCG so a failure is reproducible.
        let mut state = 0x2545_F491_4F6C_DD1Du64;
        for iteration in 0..256 {
            let mut chunks = Vec::new();
            let mut remaining = body.len();
            while remaining > 0 {
                state = state
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1_442_695_040_888_963_407);
                let size = usize::try_from((state >> 33) % 37).unwrap_or(1).max(1);
                let size = size.min(remaining);
                chunks.push(size);
                remaining -= size;
            }
            for align in [false, true] {
                let (actual, count) = stream_with_chunks(&body, &chunks, align);
                assert_eq!(
                    actual, expected,
                    "iteration {iteration} (align={align}) diverged from the buffered result"
                );
                assert_eq!(count, expected_count, "redaction count diverged");
            }
        }
    }

    #[test]
    fn multibyte_characters_are_never_split_mid_sequence() {
        let body = "data: 🌍🌏🌎 — ünïcödé\n\n".as_bytes().to_vec();
        let (expected, _) = whole_body(&body);
        for split in 0..=body.len() {
            let mut streaming = StreamingRedactor::new(&literals());
            let mut out = streaming.push(&body[..split]);
            out.extend_from_slice(&streaming.push(&body[split..]));
            out.extend_from_slice(&streaming.flush());
            assert_eq!(out, expected, "split at {split} corrupted a UTF-8 sequence");
        }
    }

    #[test]
    fn sse_alignment_emits_only_whole_events() {
        let body = b"event: a\ndata: 1\n\nevent: b\ndata: 2\n\nevent: c\ndata: 3\n\n".to_vec();
        let mut streaming = StreamingRedactor::new(&literals());
        streaming.align_events(true);
        let mut emitted = Vec::new();
        for byte in &body {
            let out = streaming.push(std::slice::from_ref(byte));
            if !out.is_empty() {
                emitted.push(out);
            }
        }
        let tail = streaming.flush();
        for piece in &emitted {
            assert!(
                piece.ends_with(b"\n\n"),
                "an aligned emission did not end on an event boundary: {:?}",
                String::from_utf8_lossy(piece)
            );
        }
        let mut joined = emitted.concat();
        joined.extend_from_slice(&tail);
        assert_eq!(joined, body);
    }

    #[test]
    fn an_oversized_incomplete_event_is_flushed_rather_than_buffered() {
        let mut streaming = StreamingRedactor::new(&literals());
        streaming.align_events(true);
        let filler = vec![b'x'; MAX_PENDING_EVENT_BYTES + 4096];
        let out = streaming.push(&filler);
        assert!(
            !out.is_empty(),
            "alignment must yield to the pending-event bound instead of growing without limit"
        );
    }

    #[test]
    fn a_body_without_event_boundaries_still_streams_when_not_sse() {
        let mut streaming = StreamingRedactor::new(&literals());
        streaming.align_events(false);
        let out = streaming.push(b"{\"error\":{\"message\":\"rate limited\"}}");
        assert!(
            !out.is_empty(),
            "a non-SSE body must not be held back for event alignment"
        );
    }

    #[test]
    fn utf8_self_contained_prefix_withholds_only_a_truncated_tail() {
        assert_eq!(utf8_self_contained_prefix(b"abc"), 3);
        // "é" is two bytes; a lone lead byte is truncated.
        assert_eq!(utf8_self_contained_prefix(&[b'a', 0xC3]), 1);
        assert_eq!(utf8_self_contained_prefix(&[b'a', 0xC3, 0xA9]), 3);
        // A definitively invalid byte is self-contained.
        assert_eq!(utf8_self_contained_prefix(&[b'a', 0xFF, b'b']), 3);
    }

    #[tokio::test]
    async fn a_cancel_token_resolves_before_and_after_cancellation() {
        let token = CancelToken::new();
        assert!(!token.is_cancelled());
        let waiter = token.clone();
        let handle = tokio::spawn(async move { waiter.cancelled().await });
        token.cancel();
        assert!(token.is_cancelled());
        handle.await.expect("waiter observed the cancellation");
        // Already cancelled: resolves immediately.
        token.cancelled().await;
    }

    #[tokio::test]
    async fn until_cancelled_prefers_the_cancel_branch() {
        let token = CancelToken::new();
        token.cancel();
        let result: Result<(), ConnectorError> = until_cancelled(&token, async {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            Ok(())
        })
        .await;
        assert!(matches!(result, Err(ConnectorError::Cancelled)));
    }
}
