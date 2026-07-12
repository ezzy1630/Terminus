//! Output redaction. Scans process output for known secret patterns and
//! replaces matches with `***REDACTED***`.

use serde::{Deserialize, Serialize};

/// A compiled redaction pattern. The pattern is a literal substring to
/// replace; regex support is a future task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedactionPattern {
    pub id: String,
    pub literal: String,
}

#[derive(Debug, Clone, Default)]
pub struct Redactor {
    patterns: Vec<RedactionPattern>,
}

impl Redactor {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_pattern(&mut self, pattern: RedactionPattern) {
        self.patterns.push(pattern);
    }

    pub fn add_literal(&mut self, id: impl Into<String>, literal: impl Into<String>) {
        self.patterns.push(RedactionPattern {
            id: id.into(),
            literal: literal.into(),
        });
    }

    /// Redact `input` by replacing each known literal with
    /// `***REDACTED:<id>***`. Returns the redacted bytes and the number of
    /// replacements made.
    pub fn redact(&self, input: &[u8]) -> (Vec<u8>, usize) {
        let mut text = String::from_utf8_lossy(input).to_string();
        let mut count = 0usize;
        for p in &self.patterns {
            if p.literal.is_empty() {
                continue;
            }
            while text.contains(&p.literal) {
                text = text.replacen(&p.literal, &format!("***REDACTED:{}***", p.id), 1);
                count += 1;
            }
        }
        (text.into_bytes(), count)
    }

    pub fn pattern_count(&self) -> usize {
        self.patterns.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_replaces_known_literal() {
        let mut r = Redactor::new();
        r.add_literal("github-token", "ghp_abcdefghijklmnopqrstuvwxyz");
        let (out, count) = r.redact(b"token=ghp_abcdefghijklmnopqrstuvwxyz; user=alice");
        assert_eq!(count, 1);
        let s = String::from_utf8(out).unwrap();
        assert!(s.contains("***REDACTED:github-token***"));
        assert!(!s.contains("ghp_abcdefghijklmnopqrstuvwxyz"));
        assert!(s.contains("user=alice"));
    }

    #[test]
    fn redact_handles_multiple_patterns() {
        let mut r = Redactor::new();
        r.add_literal("aws-key", "AKIAEXAMPLEKEY");
        r.add_literal("aws-secret", "wJalrXUtnFEMI/K7MDENG/bPxRfiCY");
        let (out, count) = r.redact(
            b"AWS_KEY=AKIAEXAMPLEKEY AWS_SECRET=wJalrXUtnFEMI/K7MDENG/bPxRfiCY",
        );
        assert_eq!(count, 2);
        let s = String::from_utf8(out).unwrap();
        assert!(s.contains("***REDACTED:aws-key***"));
        assert!(s.contains("***REDACTED:aws-secret***"));
    }

    #[test]
    fn redact_preserves_unmatched_content() {
        let mut r = Redactor::new();
        r.add_literal("secret", "super-secret-value");
        let (out, _) = r.redact(b"this is some text without secrets");
        let s = String::from_utf8(out).unwrap();
        assert_eq!(s, "this is some text without secrets");
    }

    #[test]
    fn redact_handles_repeated_pattern() {
        let mut r = Redactor::new();
        r.add_literal("token", "TOKEN");
        let (out, count) = r.redact(b"TOKEN TOKEN TOKEN");
        assert_eq!(count, 3);
        let s = String::from_utf8(out).unwrap();
        assert_eq!(s, "***REDACTED:token*** ***REDACTED:token*** ***REDACTED:token***");
    }

    #[test]
    fn redact_empty_pattern_is_noop() {
        let mut r = Redactor::new();
        r.add_literal("empty", "");
        let (out, count) = r.redact(b"some content");
        assert_eq!(count, 0);
        assert_eq!(out, b"some content");
    }
}
