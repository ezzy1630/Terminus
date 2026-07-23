//! Pure unified-diff parser (SPEC §34.7, §46.4).
//!
//! Parsing is separated from application so fuzz targets and property tests
//! can exercise the decoder without touching the filesystem.

use crate::error::PatchError;
use serde::{Deserialize, Serialize};

/// One line inside a hunk, classified by prefix.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HunkLine {
    Context {
        text: String,
    },
    Delete {
        text: String,
    },
    Add {
        text: String,
    },
    /// Malformed or unrecognized line retained for fail-closed diagnostics.
    Other {
        raw: String,
    },
}

/// One `@@ ... @@` hunk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffHunk {
    pub old_start: usize,
    pub old_count: usize,
    pub new_start: usize,
    pub new_count: usize,
    pub lines: Vec<HunkLine>,
}

/// Parsed unified diff. Paths may be empty when the header is missing.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ParsedUnifiedDiff {
    pub old_path: String,
    pub new_path: String,
    pub hunks: Vec<DiffHunk>,
}

/// Parse a unified diff from UTF-8 (lossy). Never panics on arbitrary input.
pub fn parse_unified_diff(diff_utf8: &[u8]) -> Result<ParsedUnifiedDiff, PatchError> {
    let text = String::from_utf8_lossy(diff_utf8);
    let mut parsed = ParsedUnifiedDiff::default();
    let mut lines = text.lines().peekable();

    while let Some(line) = lines.next() {
        if let Some(path) = line.strip_prefix("--- a/") {
            parsed.old_path = path.to_string();
            continue;
        }
        if let Some(path) = line.strip_prefix("--- ") {
            parsed.old_path = path.trim_start_matches("a/").to_string();
            continue;
        }
        if let Some(path) = line.strip_prefix("+++ b/") {
            parsed.new_path = path.to_string();
            continue;
        }
        if let Some(path) = line.strip_prefix("+++ ") {
            parsed.new_path = path.trim_start_matches("b/").to_string();
            continue;
        }
        if line.starts_with("@@") {
            let hunk = parse_hunk_header(line)?;
            let mut body = Vec::new();
            while let Some(next) = lines.peek() {
                if next.starts_with("@@") || next.starts_with("diff ") {
                    break;
                }
                let hunk_line = lines.next().unwrap_or("");
                body.push(classify_hunk_line(hunk_line));
            }
            parsed.hunks.push(DiffHunk {
                old_start: hunk.0,
                old_count: hunk.1,
                new_start: hunk.2,
                new_count: hunk.3,
                lines: body,
            });
        }
    }

    Ok(parsed)
}

/// Preferred target path for application: `+++` wins, then `---`, else empty.
pub fn target_path(parsed: &ParsedUnifiedDiff) -> String {
    if !parsed.new_path.is_empty() && parsed.new_path != "/dev/null" {
        return parsed.new_path.clone();
    }
    if !parsed.old_path.is_empty() && parsed.old_path != "/dev/null" {
        return parsed.old_path.clone();
    }
    String::new()
}

fn parse_hunk_header(line: &str) -> Result<(usize, usize, usize, usize), PatchError> {
    // @@ -old_start,old_count +new_start,new_count @@
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 3 {
        return Err(PatchError::InvalidEdit(
            "unified diff hunk header missing ranges".into(),
        ));
    }
    let old = parse_range(parts[1].trim_start_matches('-'))?;
    let new = parse_range(parts[2].trim_start_matches('+'))?;
    Ok((old.0, old.1, new.0, new.1))
}

fn parse_range(raw: &str) -> Result<(usize, usize), PatchError> {
    let mut split = raw.split(',');
    let start = split
        .next()
        .and_then(|s| s.parse::<usize>().ok())
        .ok_or_else(|| PatchError::InvalidEdit(format!("bad hunk range '{raw}'")))?;
    let count = split
        .next()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(1);
    Ok((start, count))
}

fn classify_hunk_line(line: &str) -> HunkLine {
    if let Some(text) = line.strip_prefix('+') {
        HunkLine::Add {
            text: text.to_string(),
        }
    } else if let Some(text) = line.strip_prefix('-') {
        HunkLine::Delete {
            text: text.to_string(),
        }
    } else if let Some(text) = line.strip_prefix(' ') {
        HunkLine::Context {
            text: text.to_string(),
        }
    } else {
        HunkLine::Other {
            raw: line.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_hunk() {
        let diff = b"--- a/foo.txt\n+++ b/foo.txt\n@@ -1,2 +1,2 @@\n line1\n-old\n+new\n";
        let parsed = parse_unified_diff(diff).expect("parse");
        assert_eq!(parsed.old_path, "foo.txt");
        assert_eq!(parsed.new_path, "foo.txt");
        assert_eq!(parsed.hunks.len(), 1);
        assert_eq!(parsed.hunks[0].old_start, 1);
        assert_eq!(parsed.hunks[0].lines.len(), 3);
    }

    #[test]
    fn empty_input_ok() {
        let parsed = parse_unified_diff(b"").expect("parse");
        assert!(parsed.hunks.is_empty());
    }

    #[test]
    fn garbage_does_not_panic() {
        let _ = parse_unified_diff(&[0xff, 0x00, 0x01, b'@', b'@', b' ', b'-', b'x']);
    }
}
